"""
Model evaluation for readmission prediction.

Generates comprehensive metrics and plots for model assessment.
Results are logged to MLflow for tracking across experiments.
"""

import logging
import tempfile
from pathlib import Path
from typing import Dict, Tuple

import matplotlib
matplotlib.use("Agg")  # non-interactive backend for server
import matplotlib.pyplot as plt
import mlflow
import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    classification_report,
    confusion_matrix,
    f1_score,
    log_loss,
    precision_recall_curve,
    precision_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)

logger = logging.getLogger(__name__)

# Operating threshold - used for binary predictions
# This is separate from the risk categories in predict.py
# Chosen to balance precision and recall for clinical workflow
OPERATING_THRESHOLD = 0.25  # tuned on 2025-Q3 validation set


def evaluate_model(model, X_test, y_test, threshold=OPERATING_THRESHOLD):
    """Run comprehensive model evaluation.

    Returns:
        metrics: Dict of scalar metrics
        artifacts: Dict of matplotlib figures and data artifacts
    """
    y_pred_proba = model.predict_proba(X_test)[:, 1]
    y_pred = (y_pred_proba >= threshold).astype(int)

    # --- Scalar Metrics ---
    metrics = {
        "roc_auc": roc_auc_score(y_test, y_pred_proba),
        "avg_precision": average_precision_score(y_test, y_pred_proba),
        "brier_score": brier_score_loss(y_test, y_pred_proba),
        "log_loss": log_loss(y_test, y_pred_proba),
        "accuracy": accuracy_score(y_test, y_pred),
        "precision": precision_score(y_test, y_pred),
        "recall": recall_score(y_test, y_pred),
        "f1": f1_score(y_test, y_pred),
        "threshold": threshold,
        "n_test": len(y_test),
        "prevalence": y_test.mean(),
    }

    # Number needed to screen
    # (how many patients flagged to catch one true readmission)
    if metrics["precision"] > 0:
        metrics["nns"] = 1.0 / metrics["precision"]
    else:
        metrics["nns"] = float("inf")

    logger.info(f"ROC-AUC: {metrics['roc_auc']:.4f}")
    logger.info(f"PR-AUC: {metrics['avg_precision']:.4f}")
    logger.info(f"Precision@{threshold}: {metrics['precision']:.4f}")
    logger.info(f"Recall@{threshold}: {metrics['recall']:.4f}")

    # --- Artifacts ---
    artifacts = {}

    # ROC curve
    fpr, tpr, _ = roc_curve(y_test, y_pred_proba)
    fig_roc, ax = plt.subplots(figsize=(8, 6))
    ax.plot(fpr, tpr, label=f"XGBoost (AUC={metrics['roc_auc']:.3f})")
    ax.plot([0, 1], [0, 1], "k--", alpha=0.5)
    ax.set_xlabel("False Positive Rate")
    ax.set_ylabel("True Positive Rate")
    ax.set_title("ROC Curve - 30-Day Readmission")
    ax.legend()
    ax.grid(True, alpha=0.3)
    artifacts["roc_curve"] = fig_roc

    # Precision-Recall curve
    precision_arr, recall_arr, thresholds_pr = precision_recall_curve(y_test, y_pred_proba)
    fig_pr, ax = plt.subplots(figsize=(8, 6))
    ax.plot(recall_arr, precision_arr, label=f"XGBoost (AP={metrics['avg_precision']:.3f})")
    ax.axhline(y=y_test.mean(), color="k", linestyle="--", alpha=0.5, label="Prevalence")
    ax.set_xlabel("Recall")
    ax.set_ylabel("Precision")
    ax.set_title("Precision-Recall Curve - 30-Day Readmission")
    ax.legend()
    ax.grid(True, alpha=0.3)
    artifacts["pr_curve"] = fig_pr

    # Calibration plot
    prob_true, prob_pred = calibration_curve(y_test, y_pred_proba, n_bins=10, strategy="uniform")
    fig_cal, ax = plt.subplots(figsize=(8, 6))
    ax.plot(prob_pred, prob_true, "o-", label="Model")
    ax.plot([0, 1], [0, 1], "k--", label="Perfect calibration")
    ax.set_xlabel("Mean predicted probability")
    ax.set_ylabel("Fraction of positives")
    ax.set_title("Calibration Plot - 30-Day Readmission")
    ax.legend()
    ax.grid(True, alpha=0.3)
    artifacts["calibration_plot"] = fig_cal

    # Score distribution
    fig_dist, ax = plt.subplots(figsize=(8, 6))
    ax.hist(y_pred_proba[y_test == 0], bins=50, alpha=0.5, label="Not readmitted", density=True)
    ax.hist(y_pred_proba[y_test == 1], bins=50, alpha=0.5, label="Readmitted", density=True)
    ax.axvline(x=threshold, color="r", linestyle="--", label=f"Threshold={threshold}")
    ax.set_xlabel("Predicted probability")
    ax.set_ylabel("Density")
    ax.set_title("Score Distribution by Outcome")
    ax.legend()
    artifacts["score_distribution"] = fig_dist

    # Confusion matrix
    cm = confusion_matrix(y_test, y_pred)
    artifacts["confusion_matrix"] = cm

    # Classification report
    report = classification_report(y_test, y_pred, output_dict=True)
    artifacts["classification_report"] = report

    plt.close("all")

    return metrics, artifacts


def log_evaluation_to_mlflow(metrics: Dict, artifacts: Dict):
    """Log evaluation results to MLflow."""

    # Log scalar metrics
    for name, value in metrics.items():
        if isinstance(value, (int, float)):
            mlflow.log_metric(name, value)

    # Log figures
    with tempfile.TemporaryDirectory() as tmpdir:
        for name, fig in artifacts.items():
            if isinstance(fig, plt.Figure):
                path = Path(tmpdir) / f"{name}.png"
                fig.savefig(path, dpi=150, bbox_inches="tight")
                mlflow.log_artifact(str(path), "evaluation_plots")

        # Log confusion matrix
        if "confusion_matrix" in artifacts:
            cm_path = Path(tmpdir) / "confusion_matrix.csv"
            pd.DataFrame(
                artifacts["confusion_matrix"],
                columns=["pred_neg", "pred_pos"],
                index=["actual_neg", "actual_pos"],
            ).to_csv(cm_path)
            mlflow.log_artifact(str(cm_path))

        # Log classification report
        if "classification_report" in artifacts:
            report_path = Path(tmpdir) / "classification_report.json"
            import json
            with open(report_path, "w") as f:
                json.dump(artifacts["classification_report"], f, indent=2)
            mlflow.log_artifact(str(report_path))

    logger.info("Evaluation results logged to MLflow")


def compute_fairness_metrics(
    model, X_test, y_test, sensitive_features: pd.DataFrame
) -> Dict:
    """Compute fairness metrics across demographic groups.

    We check for disparities in model performance across:
    - Age groups
    - Insurance types
    - (Race/ethnicity tracked but model doesn't use as features)

    This is required by our AI ethics policy before any model
    can be promoted to production.
    """
    y_pred_proba = model.predict_proba(X_test)[:, 1]
    y_pred = (y_pred_proba >= OPERATING_THRESHOLD).astype(int)

    fairness_results = {}

    for col in sensitive_features.columns:
        groups = sensitive_features[col].unique()
        group_metrics = {}

        for group in groups:
            mask = sensitive_features[col] == group
            if mask.sum() < 50:  # skip small groups
                continue

            group_metrics[str(group)] = {
                "n": int(mask.sum()),
                "prevalence": float(y_test[mask].mean()),
                "auc": float(roc_auc_score(y_test[mask], y_pred_proba[mask]))
                if y_test[mask].nunique() > 1
                else None,
                "precision": float(precision_score(y_test[mask], y_pred[mask], zero_division=0)),
                "recall": float(recall_score(y_test[mask], y_pred[mask], zero_division=0)),
                "fpr": float(
                    (y_pred[mask] == 1)[y_test[mask] == 0].mean()
                ) if (y_test[mask] == 0).sum() > 0 else None,
            }

        fairness_results[col] = group_metrics

    return fairness_results
