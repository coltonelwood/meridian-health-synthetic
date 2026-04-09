"""
Triage classification model.

Fine-tuned Bio_ClinicalBERT for classifying patient message urgency.
Classes: EMERGENCY, URGENT, ROUTINE, INFO_ONLY

The base model is emilyalsentzer/Bio_ClinicalBERT which was pre-trained
on clinical notes from MIMIC-III. We fine-tune on our labeled patient
portal messages.

Author: @achen
"""

import logging
from typing import Dict, List, Optional, Tuple

import numpy as np
import torch
import torch.nn as nn
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    PreTrainedModel,
    PreTrainedTokenizer,
)

logger = logging.getLogger(__name__)

# Label mapping
LABEL2ID = {
    "EMERGENCY": 0,
    "URGENT": 1,
    "ROUTINE": 2,
    "INFO_ONLY": 3,
}
ID2LABEL = {v: k for k, v in LABEL2ID.items()}

# Base model
BASE_MODEL = "emilyalsentzer/Bio_ClinicalBERT"

# Max sequence length
# Patient messages are usually short (median ~50 tokens)
# but some include copy-pasted lab results (up to ~300 tokens)
MAX_LENGTH = 256  # could probably go to 128 for most cases

# Class weights for imbalanced data
# Computed from training set distribution:
#   EMERGENCY:  ~3% of messages
#   URGENT:     ~12% of messages
#   ROUTINE:    ~55% of messages
#   INFO_ONLY:  ~30% of messages
#
# weights = 1 / frequency, then normalized
# These help the model not just predict ROUTINE for everything
CLASS_WEIGHTS = torch.tensor([8.5, 2.5, 0.5, 0.9])

# Confidence thresholds for each class
# EMERGENCY gets a lower threshold because we'd rather over-triage
# than miss a real emergency
CONFIDENCE_THRESHOLDS = {
    "EMERGENCY": 0.3,   # low bar - err on the side of caution
    "URGENT": 0.45,
    "ROUTINE": 0.5,
    "INFO_ONLY": 0.5,
}


class TriageClassifier:
    """Patient message triage classifier."""

    def __init__(
        self,
        model_path: Optional[str] = None,
        device: Optional[str] = None,
    ):
        """Initialize the triage classifier.

        Args:
            model_path: Path to fine-tuned model. If None, loads base model
                (which won't give good predictions without fine-tuning).
            device: 'cuda', 'cpu', or None for auto-detect.
        """
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        logger.info(f"Using device: {self.device}")

        if model_path:
            logger.info(f"Loading fine-tuned model from {model_path}")
            self.tokenizer = AutoTokenizer.from_pretrained(model_path)
            self.model = AutoModelForSequenceClassification.from_pretrained(
                model_path,
                num_labels=len(LABEL2ID),
                id2label=ID2LABEL,
                label2id=LABEL2ID,
            )
        else:
            logger.warning("No model_path provided, loading base model (not fine-tuned!)")
            self.tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
            self.model = AutoModelForSequenceClassification.from_pretrained(
                BASE_MODEL,
                num_labels=len(LABEL2ID),
                id2label=ID2LABEL,
                label2id=LABEL2ID,
            )

        self.model.to(self.device)
        self.model.eval()

    def predict(
        self,
        text: str,
        return_all_scores: bool = False,
    ) -> Dict:
        """Classify a single message.

        Args:
            text: Patient message text (already preprocessed)
            return_all_scores: If True, return probabilities for all classes

        Returns:
            Dict with predicted label, confidence, and optionally all scores
        """
        inputs = self.tokenizer(
            text,
            return_tensors="pt",
            max_length=MAX_LENGTH,
            truncation=True,
            padding=True,
        ).to(self.device)

        with torch.no_grad():
            outputs = self.model(**inputs)
            logits = outputs.logits
            probs = torch.softmax(logits, dim=-1).cpu().numpy()[0]

        predicted_idx = int(np.argmax(probs))
        predicted_label = ID2LABEL[predicted_idx]
        confidence = float(probs[predicted_idx])

        # Apply confidence thresholds
        # If the top prediction doesn't meet its threshold,
        # escalate to the next higher urgency level
        effective_label = predicted_label
        if confidence < CONFIDENCE_THRESHOLDS.get(predicted_label, 0.5):
            # Escalate: if we're not confident enough, assume higher urgency
            # This is conservative but appropriate for healthcare
            if predicted_label == "INFO_ONLY":
                effective_label = "ROUTINE"
            elif predicted_label == "ROUTINE":
                effective_label = "URGENT"
            # URGENT and EMERGENCY stay as-is even with low confidence
            logger.debug(
                f"Low confidence ({confidence:.2f}) for {predicted_label}, "
                f"escalating to {effective_label}"
            )

        result = {
            "predicted_label": effective_label,
            "raw_label": predicted_label,
            "confidence": confidence,
        }

        if return_all_scores:
            result["scores"] = {
                ID2LABEL[i]: float(p) for i, p in enumerate(probs)
            }

        return result

    def predict_batch(
        self,
        texts: List[str],
        batch_size: int = 32,
        return_all_scores: bool = False,
    ) -> List[Dict]:
        """Classify a batch of messages.

        More efficient than calling predict() in a loop because
        we batch the tokenization and inference.
        """
        results = []

        for i in range(0, len(texts), batch_size):
            batch_texts = texts[i : i + batch_size]

            inputs = self.tokenizer(
                batch_texts,
                return_tensors="pt",
                max_length=MAX_LENGTH,
                truncation=True,
                padding=True,
            ).to(self.device)

            with torch.no_grad():
                outputs = self.model(**inputs)
                logits = outputs.logits
                probs = torch.softmax(logits, dim=-1).cpu().numpy()

            for j, prob in enumerate(probs):
                predicted_idx = int(np.argmax(prob))
                predicted_label = ID2LABEL[predicted_idx]
                confidence = float(prob[predicted_idx])

                # Apply same escalation logic as single predict
                effective_label = predicted_label
                if confidence < CONFIDENCE_THRESHOLDS.get(predicted_label, 0.5):
                    if predicted_label == "INFO_ONLY":
                        effective_label = "ROUTINE"
                    elif predicted_label == "ROUTINE":
                        effective_label = "URGENT"

                result = {
                    "predicted_label": effective_label,
                    "raw_label": predicted_label,
                    "confidence": confidence,
                }

                if return_all_scores:
                    result["scores"] = {
                        ID2LABEL[k]: float(p) for k, p in enumerate(prob)
                    }

                results.append(result)

        return results


# Singleton
_classifier = None


def get_classifier(model_path: Optional[str] = None) -> TriageClassifier:
    global _classifier
    if _classifier is None:
        import os
        path = model_path or os.environ.get(
            "TRIAGE_MODEL_PATH",
            "/opt/ml/models/triage-bert-v2",
        )
        _classifier = TriageClassifier(model_path=path)
    return _classifier
