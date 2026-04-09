"""
Feature engineering for claims anomaly detection.

Computes claim-level features that capture unusual patterns in:
- Charge amounts relative to CPT/procedure averages
- Provider billing behavior
- Diagnosis-procedure consistency
- Temporal patterns

Author: @mrodriguez
"""

import logging
from typing import Dict, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# CPT code statistics - precomputed from historical claims
# These get refreshed monthly by the data pipeline
# TODO: load these from a database table instead of computing inline
# The inline computation is slow (~10 min for full claims table)
_cpt_stats_cache: Optional[pd.DataFrame] = None


def _load_cpt_stats(claims_df: pd.DataFrame) -> pd.DataFrame:
    """Compute CPT code statistics from claims data.

    Ideally this would come from a precomputed table, but we don't
    have that pipeline set up yet.
    """
    global _cpt_stats_cache
    if _cpt_stats_cache is not None:
        return _cpt_stats_cache

    stats = claims_df.groupby("cpt_code").agg(
        mean_charge=("charge_amount", "mean"),
        median_charge=("charge_amount", "median"),
        std_charge=("charge_amount", "std"),
        p25_charge=("charge_amount", lambda x: x.quantile(0.25)),
        p75_charge=("charge_amount", lambda x: x.quantile(0.75)),
        p95_charge=("charge_amount", lambda x: x.quantile(0.95)),
        p99_charge=("charge_amount", lambda x: x.quantile(0.99)),
        claim_count=("claim_id", "count"),
    ).reset_index()

    # fill std for CPT codes with only 1 claim
    stats["std_charge"] = stats["std_charge"].fillna(0)

    _cpt_stats_cache = stats
    return stats


def compute_charge_features(claims_df: pd.DataFrame) -> pd.DataFrame:
    """Features comparing claim charges to CPT averages."""

    cpt_stats = _load_cpt_stats(claims_df)
    df = claims_df.merge(cpt_stats, on="cpt_code", how="left", suffixes=("", "_cpt"))

    result = pd.DataFrame(index=df.index)

    # ratio of charge to average for this CPT
    result["charge_vs_avg_ratio"] = df["charge_amount"] / df["mean_charge"].clip(lower=1)

    # z-score of charge relative to CPT distribution
    result["charge_zscore"] = (
        (df["charge_amount"] - df["mean_charge"]) / df["std_charge"].clip(lower=0.01)
    )

    # is charge above 95th percentile for this CPT?
    result["charge_above_p95"] = (df["charge_amount"] > df["p95_charge"]).astype(int)
    result["charge_above_p99"] = (df["charge_amount"] > df["p99_charge"]).astype(int)

    # absolute charge amount (raw)
    result["charge_amount"] = df["charge_amount"]
    result["charge_log"] = np.log1p(df["charge_amount"])

    # IQR-based outlier flag
    iqr = df["p75_charge"] - df["p25_charge"]
    result["charge_iqr_outlier"] = (
        df["charge_amount"] > (df["p75_charge"] + 1.5 * iqr)
    ).astype(int)

    return result


def compute_provider_features(claims_df: pd.DataFrame) -> pd.DataFrame:
    """Features capturing provider billing patterns."""

    result = pd.DataFrame(index=claims_df.index)

    # Provider claim volume (rolling 30-day window would be ideal but too slow)
    provider_volume = claims_df.groupby("billing_provider_id")["claim_id"].transform("count")
    result["provider_claim_volume"] = provider_volume

    # Provider's average charge for this CPT
    provider_cpt_avg = claims_df.groupby(
        ["billing_provider_id", "cpt_code"]
    )["charge_amount"].transform("mean")
    result["provider_cpt_avg_charge"] = provider_cpt_avg

    # How different is this claim from the provider's own average?
    result["charge_vs_provider_avg"] = (
        claims_df["charge_amount"] / provider_cpt_avg.clip(lower=1)
    )

    # Number of unique CPT codes billed by this provider
    provider_cpt_diversity = claims_df.groupby("billing_provider_id")["cpt_code"].transform("nunique")
    result["provider_cpt_diversity"] = provider_cpt_diversity

    # Provider specialty mismatch features would go here
    # TODO: need provider specialty data from credentialing system

    return result


def compute_diagnosis_features(claims_df: pd.DataFrame) -> pd.DataFrame:
    """Features related to diagnosis codes and patterns."""

    result = pd.DataFrame(index=claims_df.index)

    # Number of diagnosis codes on the claim
    # (some claims have dx1-dx12 columns)
    dx_cols = [c for c in claims_df.columns if c.startswith("diagnosis_code_")]
    if dx_cols:
        result["n_diagnosis_codes"] = claims_df[dx_cols].notna().sum(axis=1)
    else:
        # fallback for flat diagnosis data
        result["n_diagnosis_codes"] = 1

    # Unusual diagnosis-CPT pair detection
    # A rare pair of (dx, cpt) might indicate upcoding or errors
    if "diagnosis_code_1" in claims_df.columns:
        pair_counts = claims_df.groupby(
            ["diagnosis_code_1", "cpt_code"]
        )["claim_id"].transform("count")
        result["dx_cpt_pair_count"] = pair_counts
        result["dx_cpt_pair_rare"] = (pair_counts <= 5).astype(int)  # magic number, sorry

    # Primary diagnosis category
    if "diagnosis_code_1" in claims_df.columns:
        result["dx_category"] = claims_df["diagnosis_code_1"].str[:3]

    return result


def compute_temporal_features(claims_df: pd.DataFrame) -> pd.DataFrame:
    """Time-based features that might indicate anomalous patterns."""

    result = pd.DataFrame(index=claims_df.index)

    service_date = pd.to_datetime(claims_df["service_date"])

    result["day_of_week"] = service_date.dt.dayofweek
    result["is_weekend"] = result["day_of_week"].isin([5, 6]).astype(int)
    result["month"] = service_date.dt.month

    # Claims filed on holidays are suspicious
    # (this is a simplified check, real holidays vary by year)
    # fmt: off
    HOLIDAYS_MMDD = [
        "01-01", "07-04", "12-25", "12-31",
        "11-28", "11-29",  # approximate Thanksgiving
    ]
    # fmt: on
    result["is_holiday"] = service_date.dt.strftime("%m-%d").isin(HOLIDAYS_MMDD).astype(int)

    # Time between service date and claim submission
    if "submission_date" in claims_df.columns:
        submit_date = pd.to_datetime(claims_df["submission_date"])
        result["days_to_submit"] = (submit_date - service_date).dt.days
        result["late_submission"] = (result["days_to_submit"] > 90).astype(int)

    return result


def compute_patient_features(claims_df: pd.DataFrame) -> pd.DataFrame:
    """Patient-level features relevant to anomaly detection."""

    result = pd.DataFrame(index=claims_df.index)

    # Number of claims per patient in the dataset
    patient_volume = claims_df.groupby("patient_id")["claim_id"].transform("count")
    result["patient_claim_volume"] = patient_volume

    # Patient's average claim charge
    patient_avg_charge = claims_df.groupby("patient_id")["charge_amount"].transform("mean")
    result["patient_avg_charge"] = patient_avg_charge

    # Is this charge unusual for this patient?
    result["charge_vs_patient_avg"] = (
        claims_df["charge_amount"] / patient_avg_charge.clip(lower=1)
    )

    return result


def build_anomaly_features(claims_df: pd.DataFrame) -> pd.DataFrame:
    """Build full feature matrix for anomaly detection.

    Args:
        claims_df: Raw claims data with columns:
            claim_id, patient_id, billing_provider_id, cpt_code,
            charge_amount, service_date, diagnosis_code_1, ...

    Returns:
        Feature matrix for anomaly detection model
    """
    logger.info(f"Building anomaly features for {len(claims_df)} claims")

    charge_feats = compute_charge_features(claims_df)
    provider_feats = compute_provider_features(claims_df)
    diagnosis_feats = compute_diagnosis_features(claims_df)
    temporal_feats = compute_temporal_features(claims_df)
    patient_feats = compute_patient_features(claims_df)

    features = pd.concat(
        [charge_feats, provider_feats, diagnosis_feats, temporal_feats, patient_feats],
        axis=1,
    )

    # Drop non-numeric columns (categories were for grouping only)
    non_numeric = features.select_dtypes(include=["object", "category"]).columns
    features = features.drop(columns=non_numeric)

    # Fill NaN with 0 for features where missing = no signal
    features = features.fillna(0)

    # Replace infinities (can happen with ratio features)
    features = features.replace([np.inf, -np.inf], 0)

    logger.info(f"Feature matrix: {features.shape}")
    return features
