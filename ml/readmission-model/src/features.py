"""
Feature engineering for 30-day readmission prediction.

Features are computed from encounter-level data and patient history.
See data/feature_config.yaml for feature definitions and toggles.

Author: @jpark, @mrodriguez
Last major refactor: 2025-09-20
"""

import logging
from datetime import datetime
from typing import List, Optional

import numpy as np
import pandas as pd
import yaml

logger = logging.getLogger(__name__)

# Age bins - based on clinical literature for readmission risk
# Source: Donze et al., JAMA Internal Medicine 2013
AGE_BINS = [0, 18, 30, 45, 55, 65, 75, 85, 200]
AGE_LABELS = ["pediatric", "18-29", "30-44", "45-54", "55-64", "65-74", "75-84", "85+"]

# High-risk DRGs for readmission (top 20 by historical rate)
# pulled from our 2024 Q3 analysis
HIGH_RISK_DRGS = [
    291, 292, 293,  # heart failure
    689, 690,       # kidney/UTI
    871, 872,       # sepsis
    177, 178, 179,  # respiratory infections
    638, 639, 640,  # diabetes
    682, 683,       # renal failure
    280, 281, 282,  # AMI
    190, 191, 192,  # COPD
]

# TODO: these weights were hand-tuned, should validate with clinical team
COMORBIDITY_WEIGHTS = {
    "has_chf": 3,
    "has_copd": 2,
    "has_ckd": 2,
    "has_diabetes": 1,
    "has_depression": 1,
    "has_hypertension": 1,
}


def compute_age(df: pd.DataFrame) -> pd.Series:
    """Compute patient age at time of admission."""
    dob = pd.to_datetime(df["date_of_birth"])
    admit = pd.to_datetime(df["admit_date"])
    age = (admit - dob).dt.days / 365.25
    return age.round(1)


def compute_comorbidity_score(df: pd.DataFrame) -> pd.Series:
    """Weighted comorbidity score.

    This is a simplified version of Elixhauser.
    The real Elixhauser has 31 categories but we only have
    6 mapped right now.
    """
    score = pd.Series(0, index=df.index)
    for col, weight in COMORBIDITY_WEIGHTS.items():
        if col in df.columns:
            score += df[col].fillna(0) * weight
    return score


def compute_los_features(df: pd.DataFrame) -> pd.DataFrame:
    """Length of stay features."""
    result = pd.DataFrame(index=df.index)
    result["los_days"] = df["los_days"]
    result["los_log"] = np.log1p(df["los_days"])
    result["los_gt_7"] = (df["los_days"] > 7).astype(int)
    result["los_gt_14"] = (df["los_days"] > 14).astype(int)

    # TODO: this is potential data leakage if los_days includes
    # time after the prediction point. Currently we predict at
    # discharge so it should be fine, but if we move to earlier
    # prediction this needs to change.
    # Confirmed OK for v1 with @chen 2025-10-01

    return result


def compute_prior_utilization(df: pd.DataFrame) -> pd.DataFrame:
    """Prior utilization features from admission history.

    WARNING: prior_admissions_6mo has a known issue where it may
    undercount if the patient had admissions at a different facility
    in our network. Cross-facility matching is TODO.
    """
    result = pd.DataFrame(index=df.index)

    if "prior_admissions_6mo" in df.columns:
        result["prior_admissions_6mo"] = df["prior_admissions_6mo"].fillna(0)
    else:
        logger.warning("prior_admissions_6mo not in data, defaulting to 0")
        result["prior_admissions_6mo"] = 0

    if "prior_admissions_all" in df.columns:
        result["prior_admissions_all"] = df["prior_admissions_all"].fillna(0)
    else:
        result["prior_admissions_all"] = 0

    result["is_frequent_flyer"] = (result["prior_admissions_6mo"] >= 2).astype(int)

    # prior ED visits - not available yet
    # result["prior_ed_visits_6mo"] = df.get("prior_ed_visits_6mo", 0)

    return result


def compute_discharge_features(df: pd.DataFrame) -> pd.DataFrame:
    """Features related to discharge."""
    result = pd.DataFrame(index=df.index)

    # one-hot encode discharge disposition
    discharge_dummies = pd.get_dummies(
        df["discharge_disposition"], prefix="disch"
    )
    result = pd.concat([result, discharge_dummies], axis=1)

    # weekend discharge (known risk factor)
    discharge_dt = pd.to_datetime(df["discharge_date"])
    result["discharged_weekend"] = discharge_dt.dt.dayofweek.isin([5, 6]).astype(int)

    # discharge month (for seasonality)
    result["discharge_month"] = discharge_dt.dt.month

    # TODO: add time-of-day discharge (after hours discharge = higher risk)
    # Needs discharge_time field which isn't in the current extract

    return result


def compute_demographic_features(df: pd.DataFrame) -> pd.DataFrame:
    """Demographic features.

    NOTE on fairness: age and insurance_type are included because
    they are strong predictors. Race and ethnicity are NOT used
    as model features per our AI ethics policy (see /wiki/ai-ethics).
    They are retained in the dataset for bias auditing only.
    """
    result = pd.DataFrame(index=df.index)

    result["age"] = compute_age(df)
    result["age_bin"] = pd.cut(result["age"], bins=AGE_BINS, labels=AGE_LABELS)

    # one-hot encode insurance type
    insurance_dummies = pd.get_dummies(
        df["primary_insurance_type"], prefix="insurance"
    )
    result = pd.concat([result, insurance_dummies], axis=1)

    # sex
    result["is_male"] = (df["sex"] == "M").astype(int)

    return result


def compute_clinical_features(df: pd.DataFrame) -> pd.DataFrame:
    """Clinical features from the encounter."""
    result = pd.DataFrame(index=df.index)

    # DRG features
    result["drg_code"] = df["drg_code"]
    result["is_high_risk_drg"] = df["drg_code"].isin(HIGH_RISK_DRGS).astype(int)

    # primary diagnosis category (first 3 chars of ICD-10)
    result["dx_category"] = df["primary_diagnosis_code"].str[:3]

    # admit type
    result["is_emergency_admit"] = (df["admit_type"] == "EMERGENCY").astype(int)

    # comorbidity score
    result["comorbidity_score"] = compute_comorbidity_score(df)
    result["n_diagnoses"] = df.get("n_diagnoses", pd.Series(0, index=df.index))

    return result


def build_feature_matrix(
    df: pd.DataFrame,
    feature_config_path: Optional[str] = None,
) -> pd.DataFrame:
    """Build the full feature matrix from raw admission data.

    Args:
        df: Raw admission DataFrame from data_loader
        feature_config_path: Path to feature_config.yaml (optional)

    Returns:
        Feature matrix ready for model training/inference
    """
    logger.info(f"Building features for {len(df)} encounters")

    # Compute all feature groups
    demographic_feats = compute_demographic_features(df)
    clinical_feats = compute_clinical_features(df)
    los_feats = compute_los_features(df)
    utilization_feats = compute_prior_utilization(df)
    discharge_feats = compute_discharge_features(df)

    # Combine
    features = pd.concat(
        [demographic_feats, clinical_feats, los_feats, utilization_feats, discharge_feats],
        axis=1,
    )

    # Load feature config to filter
    if feature_config_path:
        with open(feature_config_path) as f:
            config = yaml.safe_load(f)
        enabled = [f["name"] for f in config.get("features", []) if f.get("enabled", True)]
        available = [c for c in enabled if c in features.columns]
        features = features[available]
        logger.info(f"Filtered to {len(available)} enabled features from config")

    # Handle categoricals - convert to numeric for XGBoost
    cat_cols = features.select_dtypes(include=["category", "object"]).columns
    for col in cat_cols:
        features[col] = features[col].astype("category").cat.codes

    # Log feature summary
    logger.info(f"Feature matrix shape: {features.shape}")
    logger.info(f"Null counts:\n{features.isnull().sum()[features.isnull().sum() > 0]}")

    return features


# --- DEPRECATED FEATURES ---
# keeping these around in case we want to revisit

# def compute_lab_features(df):
#     """Lab value features - requires joining to lab results table.
#     This was adding ~2 minutes to feature computation and only
#     improved AUC by 0.003. Not worth it for v1.
#     """
#     # last hemoglobin before discharge
#     # last creatinine before discharge
#     # last sodium before discharge
#     # any critical lab value in last 24h
#     pass

# def compute_medication_features(df):
#     """Medication features - polypharmacy, high-risk meds.
#     Blocked on getting medication data into the warehouse.
#     ETA: Q1 2026 per data engineering.
#     """
#     pass
