"""
Prediction service for 30-day readmission model.

Loads model from MLflow model registry and provides prediction interface.
Used by the risk scoring pipeline and the clinical dashboard API.

Author: @jpark, @slee
"""

import logging
import os
from pathlib import Path
from typing import Dict, List, Optional, Union

import mlflow
import numpy as np
import pandas as pd
import xgboost as xgb

from src.features import build_feature_matrix

logger = logging.getLogger(__name__)

# MLflow model registry
MLFLOW_TRACKING_URI = os.environ.get(
    "MLFLOW_TRACKING_URI", "http://mlflow.meridian-internal.net:5000"
)
MODEL_NAME = "readmission-30d-xgboost"
MODEL_STAGE = os.environ.get("MODEL_STAGE", "Production")

# Fallback model path when MLflow is unavailable
# This happens more often than you'd think, especially in dev
DEFAULT_MODEL_PATH = os.environ.get(
    "READMISSION_MODEL_PATH",
    "/opt/ml/models/readmission_xgb_20250915_143022.json",  # last known good model
)
DEFAULT_FEATURES_PATH = os.environ.get(
    "READMISSION_FEATURES_PATH",
    "/opt/ml/models/feature_names_20250915_143022.txt",
)

# Risk thresholds - these determine the risk category in the UI
# Tuned to achieve ~80% sensitivity at the HIGH threshold
# and ~90% PPV at the VERY_HIGH threshold
# Last calibrated: 2025-10-15
RISK_THRESHOLDS = {
    "LOW": 0.0,
    "MODERATE": 0.15,
    "HIGH": 0.30,
    "VERY_HIGH": 0.55,
}


class ReadmissionPredictor:
    """Readmission risk prediction service."""

    def __init__(self, use_mlflow: bool = True):
        self.model = None
        self.feature_names = None
        self._load_model(use_mlflow)

    def _load_model(self, use_mlflow: bool):
        """Load model from MLflow or fallback to local file."""
        if use_mlflow:
            try:
                mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
                model_uri = f"models:/{MODEL_NAME}/{MODEL_STAGE}"
                self.model = mlflow.xgboost.load_model(model_uri)
                logger.info(f"Loaded model from MLflow: {model_uri}")

                # Get feature names from model artifact
                # This is a bit hacky but MLflow doesn't have a clean way
                # to store metadata with the model
                run_id = mlflow.active_run().info.run_id if mlflow.active_run() else None
                if run_id:
                    artifact_path = mlflow.artifacts.download_artifacts(
                        run_id=run_id, artifact_path="feature_names.txt"
                    )
                    with open(artifact_path) as f:
                        self.feature_names = f.read().strip().split("\n")

                return
            except Exception as e:
                logger.warning(f"Failed to load from MLflow: {e}. Falling back to local model.")

        # Fallback to local model
        if not Path(DEFAULT_MODEL_PATH).exists():
            raise FileNotFoundError(
                f"Model file not found: {DEFAULT_MODEL_PATH}. "
                f"Set READMISSION_MODEL_PATH env var or fix MLflow connection."
            )

        self.model = xgb.XGBClassifier()
        self.model.load_model(DEFAULT_MODEL_PATH)
        logger.info(f"Loaded model from local file: {DEFAULT_MODEL_PATH}")

        # Load feature names
        if Path(DEFAULT_FEATURES_PATH).exists():
            with open(DEFAULT_FEATURES_PATH) as f:
                self.feature_names = f.read().strip().split("\n")
        else:
            logger.warning("Feature names file not found, will use model's internal feature names")

    def predict(self, encounter_data: pd.DataFrame) -> pd.DataFrame:
        """Generate readmission risk predictions for encounters.

        Args:
            encounter_data: DataFrame with raw encounter data
                (same schema as data_loader output, minus the label)

        Returns:
            DataFrame with columns:
                - encounter_id
                - readmission_probability
                - risk_category
        """
        # Build features
        features = build_feature_matrix(encounter_data)

        # Align features with training feature set
        if self.feature_names is not None:
            missing = set(self.feature_names) - set(features.columns)
            if missing:
                logger.warning(f"Missing features (will be zero-filled): {missing}")
                for col in missing:
                    features[col] = 0
            features = features[self.feature_names]

        # Predict
        probabilities = self.model.predict_proba(features)[:, 1]

        # Build result
        result = pd.DataFrame({
            "encounter_id": encounter_data["encounter_id"],
            "readmission_probability": probabilities,
            "risk_category": pd.cut(
                probabilities,
                bins=[
                    RISK_THRESHOLDS["LOW"],
                    RISK_THRESHOLDS["MODERATE"],
                    RISK_THRESHOLDS["HIGH"],
                    RISK_THRESHOLDS["VERY_HIGH"],
                    1.0,
                ],
                labels=["LOW", "MODERATE", "HIGH", "VERY_HIGH"],
                include_lowest=True,
            ),
        })

        return result

    def predict_single(self, encounter_data: dict) -> Dict:
        """Predict for a single encounter.

        Convenience method for API usage.
        """
        df = pd.DataFrame([encounter_data])
        result = self.predict(df)
        return {
            "encounter_id": result["encounter_id"].iloc[0],
            "readmission_probability": float(result["readmission_probability"].iloc[0]),
            "risk_category": result["risk_category"].iloc[0],
        }

    def explain(self, encounter_data: pd.DataFrame) -> Dict:
        """Generate SHAP explanations for predictions.

        Returns top contributing features for each prediction.
        """
        try:
            import shap
        except ImportError:
            logger.warning("shap not installed, cannot generate explanations")
            return {}

        features = build_feature_matrix(encounter_data)
        if self.feature_names is not None:
            for col in set(self.feature_names) - set(features.columns):
                features[col] = 0
            features = features[self.feature_names]

        explainer = shap.TreeExplainer(self.model)
        shap_values = explainer.shap_values(features)

        # Get top 5 features per prediction
        explanations = []
        for i in range(len(features)):
            feature_importance = list(zip(features.columns, shap_values[i]))
            feature_importance.sort(key=lambda x: abs(x[1]), reverse=True)
            top_features = [
                {"feature": name, "impact": float(value)}
                for name, value in feature_importance[:5]
            ]
            explanations.append({
                "encounter_id": encounter_data["encounter_id"].iloc[i],
                "top_features": top_features,
            })

        return explanations


# Singleton for use in API
_predictor = None


def get_predictor() -> ReadmissionPredictor:
    global _predictor
    if _predictor is None:
        _predictor = ReadmissionPredictor()
    return _predictor
