"""
Patient feature engineering for similarity computation.

Builds a comprehensive patient feature vector from:
- Demographics (age, sex)
- Diagnoses (ICD-10 codes)
- Procedures (CPT codes)
- Medications (RxNorm codes)
- Lab results (key values)

Features are normalized and combined into a single vector per patient.

Author: @jpark
"""

import logging
from typing import Dict, List, Optional

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler, MinMaxScaler

logger = logging.getLogger(__name__)

# Feature weights for combining different domains
# These control how much each domain contributes to similarity
# Tuned based on clinical team feedback - they care most about
# diagnosis similarity, then meds, then labs
DOMAIN_WEIGHTS = {
    "demographics": 0.10,
    "diagnoses": 0.35,
    "procedures": 0.15,
    "medications": 0.25,
    "labs": 0.15,
}

# Top ICD-10 categories to include (3-character level)
# Using the most common ones in our population
# Full ICD-10 has ~70,000 codes, we aggregate to ~300 categories
TOP_ICD10_CATEGORIES = 300  # use top N by frequency

# Top medications by RxNorm ingredient
TOP_MEDICATIONS = 200

# Key lab tests to include (LOINC codes)
KEY_LABS = {
    "2345-7": "glucose",
    "2160-0": "creatinine",
    "17856-6": "hemoglobin_a1c",
    "2951-2": "sodium",
    "2823-3": "potassium",
    "718-7": "hemoglobin",
    "787-2": "mcv",
    "4548-4": "hba1c",      # duplicate with 17856-6, different LOINC
    "14959-1": "microalbumin",
    "2093-3": "total_cholesterol",
    "2571-8": "triglycerides",
    "2085-9": "hdl",
    "13457-7": "ldl_calculated",
    "33914-3": "egfr",
    "1742-6": "alt",
    "1920-8": "ast",
    "6299-2": "bun",
    "1751-7": "albumin",
    "2028-9": "co2",
    "2075-0": "chloride",
    "789-8": "rbc",
    "6690-2": "wbc",
    "777-3": "platelets",
    "2532-0": "tsh",
    "3016-3": "t4_free",
    "30313-1": "hemoglobin",  # different assay
}


def compute_demographic_features(patients_df: pd.DataFrame) -> np.ndarray:
    """Compute demographic features.

    Returns:
        Array of shape (n_patients, n_demographic_features)
    """
    features = pd.DataFrame(index=patients_df.index)

    # Age (normalized)
    if "date_of_birth" in patients_df.columns:
        dob = pd.to_datetime(patients_df["date_of_birth"])
        age = (pd.Timestamp.now() - dob).dt.days / 365.25
        features["age"] = age
    elif "age" in patients_df.columns:
        features["age"] = patients_df["age"]

    # Sex (binary)
    features["is_male"] = (patients_df["sex"] == "M").astype(float)

    # Normalize
    scaler = StandardScaler()
    result = scaler.fit_transform(features.fillna(0))

    return result


def compute_diagnosis_features(
    patients_df: pd.DataFrame,
    diagnoses_df: pd.DataFrame,
    n_categories: int = TOP_ICD10_CATEGORIES,
) -> np.ndarray:
    """Compute diagnosis features using ICD-10 category frequencies.

    Each patient gets a vector of counts/flags for their ICD-10 categories.
    We use the 3-character level (e.g., E11 for Type 2 DM) to reduce
    dimensionality while preserving clinical meaning.

    Returns:
        Array of shape (n_patients, n_categories)
    """
    # Extract 3-char ICD-10 category
    diagnoses_df = diagnoses_df.copy()
    diagnoses_df["icd_category"] = diagnoses_df["diagnosis_code"].str[:3]

    # Find top categories
    top_cats = (
        diagnoses_df["icd_category"]
        .value_counts()
        .head(n_categories)
        .index.tolist()
    )

    # Build patient x category matrix
    patient_ids = patients_df["patient_id"].tolist()
    cat_to_idx = {cat: i for i, cat in enumerate(top_cats)}

    matrix = np.zeros((len(patient_ids), len(top_cats)))
    pid_to_idx = {pid: i for i, pid in enumerate(patient_ids)}

    for _, row in diagnoses_df.iterrows():
        pid = row["patient_id"]
        cat = row["icd_category"]
        if pid in pid_to_idx and cat in cat_to_idx:
            matrix[pid_to_idx[pid], cat_to_idx[cat]] = 1  # binary presence

    # Could also use count or TF-IDF weighting
    # matrix[pid_to_idx[pid], cat_to_idx[cat]] += 1  # count-based

    logger.info(f"Diagnosis features: {matrix.shape}, density: {matrix.mean():.4f}")
    return matrix


def compute_medication_features(
    patients_df: pd.DataFrame,
    medications_df: pd.DataFrame,
    n_medications: int = TOP_MEDICATIONS,
) -> np.ndarray:
    """Compute medication features.

    Uses active medications (binary presence/absence for top N meds).
    """
    # Get active medications only
    if "status" in medications_df.columns:
        medications_df = medications_df[medications_df["status"] == "ACTIVE"]

    # Use ingredient level (rxnorm_ingredient) if available,
    # otherwise fall back to medication_name
    med_col = "rxnorm_ingredient" if "rxnorm_ingredient" in medications_df.columns else "medication_name"

    top_meds = (
        medications_df[med_col]
        .value_counts()
        .head(n_medications)
        .index.tolist()
    )

    patient_ids = patients_df["patient_id"].tolist()
    med_to_idx = {med: i for i, med in enumerate(top_meds)}
    pid_to_idx = {pid: i for i, pid in enumerate(patient_ids)}

    matrix = np.zeros((len(patient_ids), len(top_meds)))

    for _, row in medications_df.iterrows():
        pid = row["patient_id"]
        med = row[med_col]
        if pid in pid_to_idx and med in med_to_idx:
            matrix[pid_to_idx[pid], med_to_idx[med]] = 1

    logger.info(f"Medication features: {matrix.shape}, density: {matrix.mean():.4f}")
    return matrix


def compute_lab_features(
    patients_df: pd.DataFrame,
    labs_df: pd.DataFrame,
) -> np.ndarray:
    """Compute lab result features.

    Uses the most recent value for each key lab test.
    Normalized by population mean/std.
    """
    patient_ids = patients_df["patient_id"].tolist()
    pid_to_idx = {pid: i for i, pid in enumerate(patient_ids)}

    lab_names = list(KEY_LABS.values())
    # deduplicate (some LOINC codes map to same lab)
    lab_names = list(dict.fromkeys(lab_names))

    matrix = np.full((len(patient_ids), len(lab_names)), np.nan)
    lab_to_idx = {name: i for i, name in enumerate(lab_names)}

    # Get most recent lab value per patient per test
    if "loinc_code" in labs_df.columns:
        labs_df = labs_df.copy()
        labs_df["lab_name"] = labs_df["loinc_code"].map(KEY_LABS)
        labs_df = labs_df.dropna(subset=["lab_name"])
    elif "lab_name" in labs_df.columns:
        pass  # already has lab_name
    else:
        logger.warning("No loinc_code or lab_name in labs data, returning zeros")
        return np.zeros((len(patient_ids), len(lab_names)))

    # Sort by date and take last per patient+lab
    if "result_date" in labs_df.columns:
        labs_df = labs_df.sort_values("result_date")
    most_recent = labs_df.groupby(["patient_id", "lab_name"]).last().reset_index()

    for _, row in most_recent.iterrows():
        pid = row["patient_id"]
        lab = row["lab_name"]
        if pid in pid_to_idx and lab in lab_to_idx:
            try:
                value = float(row["result_value"])
                matrix[pid_to_idx[pid], lab_to_idx[lab]] = value
            except (ValueError, TypeError):
                pass  # non-numeric result, skip

    # Impute missing with column median, then standardize
    col_medians = np.nanmedian(matrix, axis=0)
    for j in range(matrix.shape[1]):
        mask = np.isnan(matrix[:, j])
        matrix[mask, j] = col_medians[j] if not np.isnan(col_medians[j]) else 0

    scaler = StandardScaler()
    matrix = scaler.fit_transform(matrix)

    logger.info(f"Lab features: {matrix.shape}")
    return matrix


def compute_procedure_features(
    patients_df: pd.DataFrame,
    procedures_df: pd.DataFrame,
    n_procedures: int = 150,
) -> np.ndarray:
    """Compute procedure history features (CPT-based)."""
    # Group CPT codes into categories (first 2 digits)
    procedures_df = procedures_df.copy()
    procedures_df["cpt_category"] = procedures_df["cpt_code"].str[:3]

    top_procs = (
        procedures_df["cpt_category"]
        .value_counts()
        .head(n_procedures)
        .index.tolist()
    )

    patient_ids = patients_df["patient_id"].tolist()
    proc_to_idx = {proc: i for i, proc in enumerate(top_procs)}
    pid_to_idx = {pid: i for i, pid in enumerate(patient_ids)}

    matrix = np.zeros((len(patient_ids), len(top_procs)))

    for _, row in procedures_df.iterrows():
        pid = row["patient_id"]
        proc = row["cpt_category"]
        if pid in pid_to_idx and proc in proc_to_idx:
            matrix[pid_to_idx[pid], proc_to_idx[proc]] += 1  # count-based

    # Log-transform counts (some patients have many procedures)
    matrix = np.log1p(matrix)

    logger.info(f"Procedure features: {matrix.shape}, density: {(matrix > 0).mean():.4f}")
    return matrix


def build_patient_features(
    patients_df: pd.DataFrame,
    diagnoses_df: pd.DataFrame,
    medications_df: pd.DataFrame,
    labs_df: pd.DataFrame,
    procedures_df: pd.DataFrame,
    weights: Optional[Dict[str, float]] = None,
) -> np.ndarray:
    """Build combined patient feature matrix.

    Each domain is computed separately, normalized, weighted,
    then concatenated into a single vector per patient.

    Args:
        patients_df: Patient demographics
        diagnoses_df: Patient diagnoses (ICD-10)
        medications_df: Patient medications
        labs_df: Lab results
        procedures_df: Procedure history
        weights: Domain weights (overrides DOMAIN_WEIGHTS)

    Returns:
        Feature matrix of shape (n_patients, total_features)
    """
    weights = weights or DOMAIN_WEIGHTS

    logger.info(f"Building features for {len(patients_df)} patients")

    demo_feats = compute_demographic_features(patients_df)
    diag_feats = compute_diagnosis_features(patients_df, diagnoses_df)
    med_feats = compute_medication_features(patients_df, medications_df)
    lab_feats = compute_lab_features(patients_df, labs_df)
    proc_feats = compute_procedure_features(patients_df, procedures_df)

    # Apply domain weights
    # Each domain is already normalized, so we just scale by weight
    demo_feats *= weights["demographics"]
    diag_feats *= weights["diagnoses"]
    med_feats *= weights["medications"]
    lab_feats *= weights["labs"]
    proc_feats *= weights["procedures"]

    # Concatenate
    combined = np.hstack([demo_feats, diag_feats, med_feats, lab_feats, proc_feats])

    logger.info(f"Combined feature matrix: {combined.shape}")
    logger.info(f"  Demographics: {demo_feats.shape[1]} features")
    logger.info(f"  Diagnoses: {diag_feats.shape[1]} features")
    logger.info(f"  Medications: {med_feats.shape[1]} features")
    logger.info(f"  Labs: {lab_feats.shape[1]} features")
    logger.info(f"  Procedures: {proc_feats.shape[1]} features")

    return combined
