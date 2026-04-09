"""
Scoring service for claims anomaly detection.

Scores incoming claims for anomaly probability.
Used by the claims processing pipeline to flag suspicious claims
for review by the Special Investigations Unit (SIU).

Author: @mrodriguez
"""

import logging
import os
import pickle
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from src.features import build_anomaly_features
from src.rules_engine import apply_rules

logger = logging.getLogger(__name__)

# Model paths
MODEL_PATH = os.environ.get(
    "ANOMALY_MODEL_PATH",
    "/opt/ml/models/claims_anomaly_20251028_091544.pkl",
)

# Anomaly thresholds
# Claims above HIGH threshold go directly to SIU queue
# Claims between MEDIUM and HIGH get automated secondary review
# These were tuned with SIU team on 2025-10-15
# They wanted ~5% flag rate for medium, ~1% for high
ANOMALY_THRESHOLD_HIGH = -0.15    # roughly top 1% of anomaly scores
ANOMALY_THRESHOLD_MEDIUM = -0.08  # roughly top 5%

# Combine ML score and rules score
# Rules get higher weight because SIU trusts them more
# and false positives from rules are easier to explain
ML_WEIGHT = 0.4
RULES_WEIGHT = 0.6


class AnomalyScorer:
    """Claims anomaly scoring service."""

    def __init__(self, model_path: str = None):
        self.model_path = model_path or MODEL_PATH
        self.model = None
        self.scaler = None
        self.feature_names = None
        self._load_model()

    def _load_model(self):
        """Load trained model artifacts."""
        if not Path(self.model_path).exists():
            raise FileNotFoundError(
                f"Model not found: {self.model_path}. "
                f"Run train.py first or set ANOMALY_MODEL_PATH."
            )

        with open(self.model_path, "rb") as f:
            artifacts = pickle.load(f)

        self.model = artifacts["isolation_forest"]
        self.scaler = artifacts["scaler"]
        self.feature_names = artifacts["feature_names"]
        logger.info(f"Loaded model from {self.model_path}")

    def score_claims(self, claims_df: pd.DataFrame) -> pd.DataFrame:
        """Score claims for anomaly probability.

        Args:
            claims_df: Raw claims data

        Returns:
            DataFrame with anomaly scores and categories
        """
        # Build features
        features = build_anomaly_features(claims_df)

        # Align features with training set
        for col in self.feature_names:
            if col not in features.columns:
                features[col] = 0
        features = features[self.feature_names]

        # Scale
        X_scaled = self.scaler.transform(features)

        # Get anomaly scores from Isolation Forest
        # decision_function returns negative values for anomalies
        ml_scores = self.model.decision_function(X_scaled)

        # Normalize to 0-1 range (1 = most anomalous)
        ml_scores_norm = 1 - (ml_scores - ml_scores.min()) / (ml_scores.max() - ml_scores.min() + 1e-10)

        # Apply rules engine
        rules_results = apply_rules(claims_df)
        rules_scores = rules_results["rules_score"]

        # Ensemble score
        ensemble_score = ML_WEIGHT * ml_scores_norm + RULES_WEIGHT * rules_scores

        # Categorize
        def categorize(score, ml_raw):
            if score >= 0.8 or ml_raw < ANOMALY_THRESHOLD_HIGH:
                return "HIGH"
            elif score >= 0.5 or ml_raw < ANOMALY_THRESHOLD_MEDIUM:
                return "MEDIUM"
            else:
                return "LOW"

        categories = [
            categorize(s, ml) for s, ml in zip(ensemble_score, ml_scores)
        ]

        result = pd.DataFrame({
            "claim_id": claims_df["claim_id"],
            "anomaly_score": ensemble_score,
            "ml_score": ml_scores_norm,
            "rules_score": rules_scores,
            "anomaly_category": categories,
            "triggered_rules": rules_results["triggered_rules"],
        })

        n_high = (result["anomaly_category"] == "HIGH").sum()
        n_medium = (result["anomaly_category"] == "MEDIUM").sum()
        logger.info(
            f"Scored {len(claims_df)} claims: "
            f"{n_high} HIGH ({n_high/len(claims_df)*100:.1f}%), "
            f"{n_medium} MEDIUM ({n_medium/len(claims_df)*100:.1f}%)"
        )

        return result

    def score_single(self, claim: dict) -> Dict:
        """Score a single claim. Convenience for API usage."""
        df = pd.DataFrame([claim])
        result = self.score_claims(df)
        return result.iloc[0].to_dict()


# Singleton
_scorer = None


def get_scorer() -> AnomalyScorer:
    global _scorer
    if _scorer is None:
        _scorer = AnomalyScorer()
    return _scorer
