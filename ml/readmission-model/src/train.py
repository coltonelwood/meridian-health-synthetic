"""
Training script for 30-day readmission prediction model.

Usage:
    python -m src.train --train-start 2023-01-01 --train-end 2024-06-30 \
                        --test-start 2024-07-01 --test-end 2024-12-31

Model: XGBoost classifier
Target: readmitted_30d (binary)

Author: @jpark
"""

import argparse
import logging
import os
import sys
import warnings
from datetime import datetime
from pathlib import Path

import mlflow
import mlflow.xgboost
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import StratifiedKFold

from src.data_loader import load_admissions, load_comorbidities
from src.features import build_feature_matrix
from src.evaluate import evaluate_model, log_evaluation_to_mlflow

warnings.filterwarnings("ignore", category=FutureWarning)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# MLflow tracking
MLFLOW_TRACKING_URI = os.environ.get(
    "MLFLOW_TRACKING_URI", "http://mlflow.meridian-internal.net:5000"
)
EXPERIMENT_NAME = "readmission-30d-v2"

# --- Hyperparameters ---
# TODO: these were found by manual grid search on 2025-08 data
# We should really use Optuna for proper hyperparameter tuning
# See: https://optuna.readthedocs.io/
# @jpark tried it briefly but the search space was too large and
# the runs were taking 6+ hours on the current infra

XGBOOST_PARAMS = {
    "objective": "binary:logistic",
    "eval_metric": ["auc", "logloss"],
    "max_depth": 6,
    "learning_rate": 0.05,
    "n_estimators": 500,
    "min_child_weight": 5,
    "subsample": 0.8,
    "colsample_bytree": 0.8,
    "gamma": 0.1,
    "reg_alpha": 0.1,      # L1 regularization
    "reg_lambda": 1.0,      # L2 regularization
    "scale_pos_weight": 3.5,  # ~22% readmission rate -> 78/22 = 3.5
    "random_state": 42,
    "n_jobs": -1,
    "tree_method": "hist",  # faster than default
}

# early stopping
EARLY_STOPPING_ROUNDS = 50

# Cross-validation
N_CV_FOLDS = 5


def prepare_data(
    train_start: str,
    train_end: str,
    test_start: str,
    test_end: str,
    feature_config: str = "data/feature_config.yaml",
) -> tuple:
    """Load and prepare training and test data."""

    logger.info("Loading training data...")
    train_raw = load_admissions(train_start, train_end)

    logger.info("Loading test data...")
    test_raw = load_admissions(test_start, test_end)

    # Load comorbidities
    all_patients = list(
        set(train_raw["patient_id"].tolist() + test_raw["patient_id"].tolist())
    )
    logger.info(f"Loading comorbidities for {len(all_patients)} patients...")
    comorbidities = load_comorbidities(all_patients)

    # Merge comorbidities
    train_raw = train_raw.merge(comorbidities, on=["encounter_id", "patient_id"], how="left")
    test_raw = test_raw.merge(comorbidities, on=["encounter_id", "patient_id"], how="left")

    # Build features
    X_train = build_feature_matrix(train_raw, feature_config)
    X_test = build_feature_matrix(test_raw, feature_config)

    y_train = train_raw["readmitted_30d"]
    y_test = test_raw["readmitted_30d"]

    # Align columns (test may have different dummy columns)
    X_train, X_test = X_train.align(X_test, join="left", axis=1, fill_value=0)

    logger.info(f"Training set: {X_train.shape[0]} samples, {X_train.shape[1]} features")
    logger.info(f"Test set: {X_test.shape[0]} samples, {X_test.shape[1]} features")
    logger.info(f"Train readmission rate: {y_train.mean():.3f}")
    logger.info(f"Test readmission rate: {y_test.mean():.3f}")

    return X_train, X_test, y_train, y_test, train_raw, test_raw


def train_model(X_train, y_train, X_test, y_test):
    """Train XGBoost model with early stopping."""

    logger.info("Training XGBoost model...")

    model = xgb.XGBClassifier(**XGBOOST_PARAMS)

    model.fit(
        X_train,
        y_train,
        eval_set=[(X_train, y_train), (X_test, y_test)],
        verbose=50,
    )

    # Get best iteration
    # best_iteration = model.best_iteration
    # logger.info(f"Best iteration: {best_iteration}")

    return model


def cross_validate(X_train, y_train):
    """Run stratified cross-validation to estimate generalization."""

    logger.info(f"Running {N_CV_FOLDS}-fold cross-validation...")

    skf = StratifiedKFold(n_splits=N_CV_FOLDS, shuffle=True, random_state=42)

    cv_scores = {"auc": [], "logloss": []}

    for fold, (train_idx, val_idx) in enumerate(skf.split(X_train, y_train)):
        X_tr, X_val = X_train.iloc[train_idx], X_train.iloc[val_idx]
        y_tr, y_val = y_train.iloc[train_idx], y_train.iloc[val_idx]

        model = xgb.XGBClassifier(**XGBOOST_PARAMS)
        model.fit(
            X_tr,
            y_tr,
            eval_set=[(X_val, y_val)],
            verbose=0,
        )

        from sklearn.metrics import roc_auc_score, log_loss

        y_pred_proba = model.predict_proba(X_val)[:, 1]
        auc = roc_auc_score(y_val, y_pred_proba)
        ll = log_loss(y_val, y_pred_proba)

        cv_scores["auc"].append(auc)
        cv_scores["logloss"].append(ll)
        logger.info(f"  Fold {fold + 1}: AUC={auc:.4f}, LogLoss={ll:.4f}")

    mean_auc = np.mean(cv_scores["auc"])
    std_auc = np.std(cv_scores["auc"])
    logger.info(f"CV AUC: {mean_auc:.4f} +/- {std_auc:.4f}")

    return cv_scores


def main():
    parser = argparse.ArgumentParser(description="Train readmission model")
    parser.add_argument("--train-start", default="2023-01-01")
    parser.add_argument("--train-end", default="2024-06-30")
    parser.add_argument("--test-start", default="2024-07-01")
    parser.add_argument("--test-end", default="2024-12-31")
    parser.add_argument("--feature-config", default="data/feature_config.yaml")
    parser.add_argument("--skip-cv", action="store_true", help="Skip cross-validation")
    parser.add_argument("--no-mlflow", action="store_true", help="Disable MLflow logging")
    args = parser.parse_args()

    # Setup MLflow
    if not args.no_mlflow:
        mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
        mlflow.set_experiment(EXPERIMENT_NAME)

    # Load data
    X_train, X_test, y_train, y_test, train_raw, test_raw = prepare_data(
        args.train_start, args.train_end,
        args.test_start, args.test_end,
        args.feature_config,
    )

    with mlflow.start_run() if not args.no_mlflow else nullcontext():
        # Log params
        if not args.no_mlflow:
            mlflow.log_params(XGBOOST_PARAMS)
            mlflow.log_param("train_start", args.train_start)
            mlflow.log_param("train_end", args.train_end)
            mlflow.log_param("test_start", args.test_start)
            mlflow.log_param("test_end", args.test_end)
            mlflow.log_param("n_train", len(X_train))
            mlflow.log_param("n_test", len(X_test))
            mlflow.log_param("n_features", X_train.shape[1])

        # Cross-validation
        if not args.skip_cv:
            cv_scores = cross_validate(X_train, y_train)
            if not args.no_mlflow:
                mlflow.log_metric("cv_auc_mean", np.mean(cv_scores["auc"]))
                mlflow.log_metric("cv_auc_std", np.std(cv_scores["auc"]))

        # Train final model on all training data
        model = train_model(X_train, y_train, X_test, y_test)

        # Evaluate
        metrics, artifacts = evaluate_model(model, X_test, y_test)
        logger.info(f"Test metrics: {metrics}")

        if not args.no_mlflow:
            log_evaluation_to_mlflow(metrics, artifacts)
            mlflow.xgboost.log_model(model, "model")
            logger.info(f"Model logged to MLflow run: {mlflow.active_run().info.run_id}")

        # Also save locally as backup
        model_dir = Path("models")
        model_dir.mkdir(exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        model_path = model_dir / f"readmission_xgb_{timestamp}.json"
        model.save_model(str(model_path))
        logger.info(f"Model saved to {model_path}")

        # Save feature names for inference
        feature_names_path = model_dir / f"feature_names_{timestamp}.txt"
        with open(feature_names_path, "w") as f:
            f.write("\n".join(X_train.columns.tolist()))

    logger.info("Training complete!")


# lazy import for contextmanager
from contextlib import nullcontext

if __name__ == "__main__":
    main()

# --- OLD EXPERIMENTS ---
# Tried LightGBM, performed similarly to XGBoost (AUC diff < 0.005)
# Keeping XGBoost because the team is more familiar with it
# and our SHAP pipeline is already set up for it.

# Also tried logistic regression as a baseline:
#   from sklearn.linear_model import LogisticRegression
#   lr = LogisticRegression(C=0.1, class_weight='balanced', max_iter=1000)
#   # AUC was 0.72 vs XGBoost 0.78 - significant gap
