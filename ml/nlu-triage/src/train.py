"""
Training script for triage classification model.

Fine-tunes Bio_ClinicalBERT on labeled patient portal messages.
Uses HuggingFace Trainer for training loop.

Usage:
    python -m src.train \
        --train-data data/train.csv \
        --val-data data/val.csv \
        --output-dir models/triage-bert-v2 \
        --epochs 5

Author: @achen
"""

import argparse
import logging
import os
import json
from pathlib import Path

import mlflow
import numpy as np
import pandas as pd
import torch
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    f1_score,
    precision_score,
    recall_score,
)
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
)
from torch.utils.data import Dataset

from src.model import BASE_MODEL, CLASS_WEIGHTS, LABEL2ID, ID2LABEL, MAX_LENGTH
from src.preprocess import preprocess_batch

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# wandb experiment tracking
# import wandb
# wandb.init(project="meridian-triage", entity="meridian-ml")
# Switched to MLflow because the team already uses it for other models
# and wandb was an extra cost. Keeping the import here in case we switch back.

MLFLOW_TRACKING_URI = os.environ.get(
    "MLFLOW_TRACKING_URI", "http://mlflow.meridian-internal.net:5000"
)


class TriageDataset(Dataset):
    """PyTorch dataset for triage classification."""

    def __init__(self, texts, labels, tokenizer, max_length=MAX_LENGTH):
        self.encodings = tokenizer(
            texts,
            truncation=True,
            padding=True,
            max_length=max_length,
            return_tensors="pt",
        )
        self.labels = torch.tensor(labels, dtype=torch.long)

    def __getitem__(self, idx):
        item = {k: v[idx] for k, v in self.encodings.items()}
        item["labels"] = self.labels[idx]
        return item

    def __len__(self):
        return len(self.labels)


def load_data(data_path: str) -> tuple:
    """Load and preprocess training/validation data.

    Expected CSV format: text,label
    Where label is one of: EMERGENCY, URGENT, ROUTINE, INFO_ONLY
    """
    df = pd.read_csv(data_path)

    if "text" not in df.columns or "label" not in df.columns:
        raise ValueError(f"Expected columns 'text' and 'label', got: {df.columns.tolist()}")

    # Drop rows with missing text or label
    n_before = len(df)
    df = df.dropna(subset=["text", "label"])
    if len(df) < n_before:
        logger.warning(f"Dropped {n_before - len(df)} rows with missing data")

    # Validate labels
    invalid_labels = set(df["label"]) - set(LABEL2ID.keys())
    if invalid_labels:
        raise ValueError(f"Invalid labels found: {invalid_labels}")

    # Preprocess texts
    texts = preprocess_batch(df["text"].tolist())
    labels = [LABEL2ID[l] for l in df["label"]]

    # Log class distribution
    label_counts = df["label"].value_counts()
    logger.info(f"Class distribution:\n{label_counts}")

    return texts, labels


def compute_metrics(eval_pred):
    """Compute metrics for HuggingFace Trainer evaluation."""
    logits, labels = eval_pred
    predictions = np.argmax(logits, axis=-1)

    return {
        "accuracy": accuracy_score(labels, predictions),
        "f1_macro": f1_score(labels, predictions, average="macro"),
        "f1_weighted": f1_score(labels, predictions, average="weighted"),
        "precision_macro": precision_score(labels, predictions, average="macro"),
        "recall_macro": recall_score(labels, predictions, average="macro"),
        # Per-class recall (important for EMERGENCY)
        "recall_emergency": recall_score(
            labels, predictions, labels=[0], average="micro", zero_division=0
        ),
        "recall_urgent": recall_score(
            labels, predictions, labels=[1], average="micro", zero_division=0
        ),
    }


class WeightedLossTrainer(Trainer):
    """Custom Trainer that uses class weights for the loss function.

    This helps with the severe class imbalance (EMERGENCY is ~3%).
    Without this, the model basically never predicts EMERGENCY.
    """

    def compute_loss(self, model, inputs, return_outputs=False, **kwargs):
        labels = inputs.pop("labels")
        outputs = model(**inputs)
        logits = outputs.logits

        weight = CLASS_WEIGHTS.to(logits.device)
        loss_fn = torch.nn.CrossEntropyLoss(weight=weight)
        loss = loss_fn(logits, labels)

        return (loss, outputs) if return_outputs else loss


def main():
    parser = argparse.ArgumentParser(description="Train triage classifier")
    parser.add_argument("--train-data", required=True, help="Path to training CSV")
    parser.add_argument("--val-data", required=True, help="Path to validation CSV")
    parser.add_argument("--output-dir", default="models/triage-bert-v2")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=2e-5)
    parser.add_argument("--warmup-steps", type=int, default=500)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--no-mlflow", action="store_true")
    args = parser.parse_args()

    # Load data
    logger.info("Loading training data...")
    train_texts, train_labels = load_data(args.train_data)
    logger.info("Loading validation data...")
    val_texts, val_labels = load_data(args.val_data)

    logger.info(f"Training samples: {len(train_texts)}")
    logger.info(f"Validation samples: {len(val_texts)}")

    # Load tokenizer and model
    logger.info(f"Loading base model: {BASE_MODEL}")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForSequenceClassification.from_pretrained(
        BASE_MODEL,
        num_labels=len(LABEL2ID),
        id2label=ID2LABEL,
        label2id=LABEL2ID,
    )

    # Create datasets
    train_dataset = TriageDataset(train_texts, train_labels, tokenizer)
    val_dataset = TriageDataset(val_texts, val_labels, tokenizer)

    # Training arguments
    training_args = TrainingArguments(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size * 2,
        learning_rate=args.learning_rate,
        warmup_steps=args.warmup_steps,
        weight_decay=args.weight_decay,
        eval_strategy="steps",
        eval_steps=200,
        save_strategy="steps",
        save_steps=200,
        save_total_limit=3,
        load_best_model_at_end=True,
        metric_for_best_model="f1_macro",
        greater_is_better=True,
        logging_steps=50,
        logging_dir=os.path.join(args.output_dir, "logs"),
        fp16=torch.cuda.is_available(),  # mixed precision on GPU
        dataloader_num_workers=4,
        # report_to="wandb",  # disabled
        report_to="none",
        seed=42,
    )

    # Trainer
    trainer = WeightedLossTrainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        compute_metrics=compute_metrics,
        callbacks=[
            EarlyStoppingCallback(early_stopping_patience=3),
        ],
    )

    # MLflow tracking
    if not args.no_mlflow:
        mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
        mlflow.set_experiment("nlu-triage-v2")
        mlflow.start_run()
        mlflow.log_params({
            "base_model": BASE_MODEL,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "warmup_steps": args.warmup_steps,
            "weight_decay": args.weight_decay,
            "max_length": MAX_LENGTH,
            "n_train": len(train_texts),
            "n_val": len(val_texts),
        })

    # Train
    logger.info("Starting training...")
    train_result = trainer.train()

    # Final evaluation
    logger.info("Running final evaluation...")
    eval_result = trainer.evaluate()
    logger.info(f"Eval results: {eval_result}")

    # Detailed classification report
    val_preds = trainer.predict(val_dataset)
    y_pred = np.argmax(val_preds.predictions, axis=-1)
    y_true = val_preds.label_ids

    report = classification_report(
        y_true, y_pred,
        target_names=list(LABEL2ID.keys()),
        output_dict=True,
    )
    logger.info(f"\n{classification_report(y_true, y_pred, target_names=list(LABEL2ID.keys()))}")

    # Save model
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)

    # Save metadata
    metadata = {
        "base_model": BASE_MODEL,
        "label2id": LABEL2ID,
        "id2label": {str(k): v for k, v in ID2LABEL.items()},
        "max_length": MAX_LENGTH,
        "class_weights": CLASS_WEIGHTS.tolist(),
        "eval_metrics": eval_result,
        "classification_report": report,
    }
    with open(os.path.join(args.output_dir, "model_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    # Log to MLflow
    if not args.no_mlflow:
        for k, v in eval_result.items():
            if isinstance(v, (int, float)):
                mlflow.log_metric(k, v)
        mlflow.log_artifact(os.path.join(args.output_dir, "model_metadata.json"))
        mlflow.end_run()

    logger.info(f"Model saved to {args.output_dir}")
    logger.info("Training complete!")


if __name__ == "__main__":
    main()
