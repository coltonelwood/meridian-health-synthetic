"""
Training script for claims anomaly detection model.

Approach: Ensemble of Isolation Forest + (eventually) Autoencoder
- Isolation Forest handles the bulk of anomaly detection
- Autoencoder was supposed to catch more subtle patterns but
  hasn't been working well yet

The model is semi-supervised: we have a small set of known anomalies
(from SIU investigations) but most training is unsupervised.

Author: @mrodriguez
Last updated: 2025-10-28
"""

import argparse
import json
import logging
import os
import pickle
import warnings
from datetime import datetime
from pathlib import Path

import mlflow
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (
    precision_score,
    recall_score,
    f1_score,
    classification_report,
)

from src.features import build_anomaly_features

warnings.filterwarnings("ignore")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

MLFLOW_TRACKING_URI = os.environ.get(
    "MLFLOW_TRACKING_URI", "http://mlflow.meridian-internal.net:5000"
)
EXPERIMENT_NAME = "claims-anomaly-v1"

# Isolation Forest parameters
# contamination is set to 2% based on SIU's estimate of fraud rate
# in our claims volume. This is a rough estimate.
ISO_FOREST_PARAMS = {
    "n_estimators": 200,
    "max_samples": "auto",
    "contamination": 0.02,
    "max_features": 0.8,
    "bootstrap": False,
    "random_state": 42,
    "n_jobs": -1,
}

# Autoencoder parameters
# AUTOENCODER_PARAMS = {
#     "encoding_dim": 16,
#     "hidden_layers": [64, 32],
#     "dropout_rate": 0.2,
#     "learning_rate": 0.001,
#     "batch_size": 256,
#     "epochs": 50,
#     "validation_split": 0.1,
# }


def load_claims_data(data_path: str, known_anomalies_path: str = None):
    """Load claims data and optionally known anomalies."""
    logger.info(f"Loading claims data from {data_path}")

    if data_path.endswith(".parquet"):
        claims_df = pd.read_parquet(data_path)
    elif data_path.endswith(".csv"):
        claims_df = pd.read_csv(data_path)
    else:
        raise ValueError(f"Unsupported file format: {data_path}")

    logger.info(f"Loaded {len(claims_df)} claims")

    known_anomalies = None
    if known_anomalies_path and Path(known_anomalies_path).exists():
        known_anomalies = pd.read_csv(known_anomalies_path)
        logger.info(f"Loaded {len(known_anomalies)} known anomaly patterns")

    return claims_df, known_anomalies


def train_isolation_forest(X_train: pd.DataFrame, params: dict = None):
    """Train Isolation Forest model."""
    params = params or ISO_FOREST_PARAMS

    logger.info(f"Training Isolation Forest with params: {params}")

    # Standardize features
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X_train)

    # Train
    model = IsolationForest(**params)
    model.fit(X_scaled)

    # Get anomaly scores (lower = more anomalous)
    scores = model.decision_function(X_scaled)
    predictions = model.predict(X_scaled)  # 1 = normal, -1 = anomaly

    n_anomalies = (predictions == -1).sum()
    logger.info(f"Detected {n_anomalies} anomalies ({n_anomalies/len(X_train)*100:.1f}%)")

    return model, scaler, scores, predictions


# TODO: autoencoder not working well, revisit
# The reconstruction error distribution is too noisy to set a good threshold.
# Might need more data or different architecture.
# @mrodriguez tried this on 2025-09-15, results were worse than IF alone.
#
# def build_autoencoder(input_dim, params=None):
#     """Build autoencoder for anomaly detection."""
#     import tensorflow as tf
#     from tensorflow.keras import layers, Model
#
#     params = params or AUTOENCODER_PARAMS
#
#     # Encoder
#     inputs = layers.Input(shape=(input_dim,))
#     x = inputs
#     for units in params["hidden_layers"]:
#         x = layers.Dense(units, activation="relu")(x)
#         x = layers.Dropout(params["dropout_rate"])(x)
#     encoded = layers.Dense(params["encoding_dim"], activation="relu")(x)
#
#     # Decoder
#     x = encoded
#     for units in reversed(params["hidden_layers"]):
#         x = layers.Dense(units, activation="relu")(x)
#         x = layers.Dropout(params["dropout_rate"])(x)
#     decoded = layers.Dense(input_dim, activation="linear")(x)
#
#     autoencoder = Model(inputs, decoded)
#     autoencoder.compile(
#         optimizer=tf.keras.optimizers.Adam(learning_rate=params["learning_rate"]),
#         loss="mse",
#     )
#
#     return autoencoder
#
#
# def train_autoencoder(X_train, params=None):
#     """Train autoencoder and compute reconstruction errors."""
#     params = params or AUTOENCODER_PARAMS
#
#     scaler = StandardScaler()
#     X_scaled = scaler.fit_transform(X_train)
#
#     model = build_autoencoder(X_scaled.shape[1], params)
#
#     history = model.fit(
#         X_scaled, X_scaled,
#         epochs=params["epochs"],
#         batch_size=params["batch_size"],
#         validation_split=params["validation_split"],
#         verbose=1,
#     )
#
#     # Reconstruction error
#     X_reconstructed = model.predict(X_scaled)
#     recon_error = np.mean((X_scaled - X_reconstructed) ** 2, axis=1)
#
#     return model, scaler, recon_error, history


def evaluate_with_known_anomalies(
    claims_df: pd.DataFrame,
    scores: np.ndarray,
    predictions: np.ndarray,
    known_anomalies: pd.DataFrame,
) -> dict:
    """Evaluate anomaly detection using known anomaly cases.

    Since we have a small set of confirmed fraudulent claims from SIU,
    we can compute precision/recall at different thresholds.
    """
    # Match known anomalies to claims
    if "claim_id" in known_anomalies.columns:
        is_known_anomaly = claims_df["claim_id"].isin(known_anomalies["claim_id"])
    else:
        logger.warning("known_anomalies doesn't have claim_id, skipping evaluation")
        return {}

    n_known = is_known_anomaly.sum()
    if n_known == 0:
        logger.warning("No known anomalies found in claims data")
        return {}

    logger.info(f"Evaluating against {n_known} known anomalies")

    # Convert IF predictions (-1 = anomaly, 1 = normal) to binary (1 = anomaly)
    pred_anomaly = (predictions == -1).astype(int)
    true_anomaly = is_known_anomaly.astype(int)

    metrics = {
        "n_known_anomalies": int(n_known),
        "n_detected": int(pred_anomaly[is_known_anomaly].sum()),
        "recall_known": float(pred_anomaly[is_known_anomaly].mean()),
        "precision": float(precision_score(true_anomaly, pred_anomaly, zero_division=0)),
        "recall": float(recall_score(true_anomaly, pred_anomaly, zero_division=0)),
        "f1": float(f1_score(true_anomaly, pred_anomaly, zero_division=0)),
    }

    logger.info(f"Known anomaly recall: {metrics['recall_known']:.3f} "
                f"({metrics['n_detected']}/{metrics['n_known_anomalies']})")

    # Threshold sweep
    percentiles = [1, 2, 3, 5, 10]
    for p in percentiles:
        threshold = np.percentile(scores, p)
        flagged = (scores < threshold).astype(int)
        recall_at_p = flagged[is_known_anomaly].mean()
        metrics[f"recall_at_p{p}"] = float(recall_at_p)
        logger.info(f"  Recall at p{p} (flag {p}% of claims): {recall_at_p:.3f}")

    return metrics


def main():
    parser = argparse.ArgumentParser(description="Train claims anomaly detection model")
    parser.add_argument("--data-path", required=True, help="Path to claims data")
    parser.add_argument("--known-anomalies", default="data/known_anomalies.csv")
    parser.add_argument("--output-dir", default="models")
    parser.add_argument("--no-mlflow", action="store_true")
    args = parser.parse_args()

    # Load data
    claims_df, known_anomalies = load_claims_data(args.data_path, args.known_anomalies)

    # Build features
    features = build_anomaly_features(claims_df)

    # Setup MLflow
    if not args.no_mlflow:
        mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
        mlflow.set_experiment(EXPERIMENT_NAME)

    with mlflow.start_run() if not args.no_mlflow else _nullcontext():
        # Train Isolation Forest
        iso_model, iso_scaler, iso_scores, iso_predictions = train_isolation_forest(features)

        # TODO: train autoencoder and ensemble
        # ae_model, ae_scaler, ae_errors, ae_history = train_autoencoder(features)
        #
        # Ensemble: combine scores
        # iso_scores_norm = (iso_scores - iso_scores.min()) / (iso_scores.max() - iso_scores.min())
        # ae_scores_norm = (ae_errors - ae_errors.min()) / (ae_errors.max() - ae_errors.min())
        # ensemble_scores = 0.6 * (1 - iso_scores_norm) + 0.4 * ae_scores_norm
        # ^ those weights are arbitrary, need to tune

        # Evaluate against known anomalies
        eval_metrics = {}
        if known_anomalies is not None:
            eval_metrics = evaluate_with_known_anomalies(
                claims_df, iso_scores, iso_predictions, known_anomalies
            )

        # Log to MLflow
        if not args.no_mlflow:
            mlflow.log_params(ISO_FOREST_PARAMS)
            mlflow.log_param("n_claims", len(claims_df))
            mlflow.log_param("n_features", features.shape[1])
            for k, v in eval_metrics.items():
                mlflow.log_metric(k, v)

        # Save model artifacts
        output_dir = Path(args.output_dir)
        output_dir.mkdir(exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        model_artifacts = {
            "isolation_forest": iso_model,
            "scaler": iso_scaler,
            "feature_names": features.columns.tolist(),
            "params": ISO_FOREST_PARAMS,
        }

        artifact_path = output_dir / f"claims_anomaly_{timestamp}.pkl"
        with open(artifact_path, "wb") as f:
            pickle.dump(model_artifacts, f)

        logger.info(f"Model saved to {artifact_path}")

        # Save score distribution for threshold tuning
        score_dist = pd.DataFrame({
            "claim_id": claims_df["claim_id"],
            "anomaly_score": iso_scores,
            "is_anomaly": (iso_predictions == -1).astype(int),
        })
        score_dist.to_csv(output_dir / f"score_distribution_{timestamp}.csv", index=False)

    logger.info("Training complete!")


# TODO: use contextlib.nullcontext when we drop Python 3.6 support
# (we already require 3.9+ so this TODO is stale)
from contextlib import nullcontext as _nullcontext


if __name__ == "__main__":
    main()
