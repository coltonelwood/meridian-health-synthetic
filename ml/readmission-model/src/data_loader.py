"""
Data loader for readmission model.
Pulls encounter/admission data from the analytics warehouse.

TODO: migrate to use the shared data platform connector instead of
      raw SQL. Talk to @chen about the new dbt models.
"""

import os
import logging
from typing import Optional, Tuple

import pandas as pd
from sqlalchemy import create_engine, text

logger = logging.getLogger(__name__)

# Connection string assembly - this is ugly but works for now
# In prod this comes from Vault, in dev we use env vars
_DB_HOST = os.environ.get("WAREHOUSE_HOST", "analytics-warehouse.meridian-internal.net")
_DB_PORT = os.environ.get("WAREHOUSE_PORT", "5432")
_DB_NAME = os.environ.get("WAREHOUSE_DB", "clinical_analytics")
_DB_USER = os.environ.get("WAREHOUSE_USER", "ml_readonly")
_DB_PASS = os.environ.get("WAREHOUSE_PASS", "")  # must be set in env

# TODO: this should use connection pooling
def _get_engine():
    if not _DB_PASS:
        raise ValueError(
            "WAREHOUSE_PASS not set. Export it or check your .env file. "
            "For local dev, see confluence: /wiki/spaces/ML/pages/readmission-setup"
        )
    conn_str = f"postgresql://{_DB_USER}:{_DB_PASS}@{_DB_HOST}:{_DB_PORT}/{_DB_NAME}"
    return create_engine(conn_str, pool_pre_ping=True)


# Main query - pulls admissions with outcomes
# NOTE: the 30-day window is calculated in SQL for performance
# We had a subtle bug where we were using discharge_date instead of
# admit_date for the readmission window - fixed 2025-08-14
ADMISSIONS_QUERY = """
WITH admissions AS (
    SELECT
        a.encounter_id,
        a.patient_id,
        a.admit_date,
        a.discharge_date,
        a.discharge_disposition,
        a.admit_source,
        a.admit_type,
        a.primary_diagnosis_code,
        a.drg_code,
        a.attending_provider_id,
        a.facility_id,
        a.los_days,
        p.date_of_birth,
        p.sex,
        p.race,
        p.ethnicity,
        p.primary_insurance_type,
        p.zip_code
    FROM clinical.encounters a
    JOIN clinical.patients p ON a.patient_id = p.patient_id
    WHERE a.encounter_type = 'INPATIENT'
      AND a.discharge_date IS NOT NULL
      AND a.discharge_date >= :start_date
      AND a.discharge_date < :end_date
      -- exclude patients who died during stay
      AND a.discharge_disposition != 'EXPIRED'
      -- exclude transfers (they aren't true readmissions)
      AND a.discharge_disposition NOT IN ('TRANSFER_ACUTE', 'TRANSFER_SNF')
),
readmissions AS (
    SELECT
        a1.encounter_id,
        CASE
            WHEN EXISTS (
                SELECT 1 FROM clinical.encounters a2
                WHERE a2.patient_id = a1.patient_id
                  AND a2.encounter_type = 'INPATIENT'
                  AND a2.admit_date > a1.discharge_date
                  AND a2.admit_date <= a1.discharge_date + INTERVAL '30 days'
                  AND a2.encounter_id != a1.encounter_id
            ) THEN 1
            ELSE 0
        END AS readmitted_30d
    FROM admissions a1
)
SELECT
    a.*,
    r.readmitted_30d
FROM admissions a
JOIN readmissions r ON a.encounter_id = r.encounter_id
ORDER BY a.discharge_date
"""

# Secondary queries for feature enrichment
PRIOR_ADMISSIONS_QUERY = """
SELECT
    patient_id,
    encounter_id,
    COUNT(*) OVER (
        PARTITION BY patient_id
        ORDER BY admit_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS prior_admissions_all,
    COUNT(*) FILTER (WHERE admit_date >= discharge_date - INTERVAL '6 months') OVER (
        PARTITION BY patient_id
        ORDER BY admit_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS prior_admissions_6mo
FROM clinical.encounters
WHERE encounter_type = 'INPATIENT'
  AND patient_id IN :patient_ids
ORDER BY patient_id, admit_date
"""

# this query is slow (~45s for a year of data), might need to materialize
COMORBIDITY_QUERY = """
SELECT
    e.encounter_id,
    e.patient_id,
    COUNT(DISTINCT d.diagnosis_code) AS n_diagnoses,
    -- Elixhauser comorbidity flags (simplified)
    MAX(CASE WHEN d.diagnosis_code LIKE 'E11%' THEN 1 ELSE 0 END) AS has_diabetes,
    MAX(CASE WHEN d.diagnosis_code LIKE 'I50%' THEN 1 ELSE 0 END) AS has_chf,
    MAX(CASE WHEN d.diagnosis_code LIKE 'J44%' THEN 1 ELSE 0 END) AS has_copd,
    MAX(CASE WHEN d.diagnosis_code LIKE 'N18%' THEN 1 ELSE 0 END) AS has_ckd,
    MAX(CASE WHEN d.diagnosis_code LIKE 'F32%' OR d.diagnosis_code LIKE 'F33%' THEN 1 ELSE 0 END) AS has_depression,
    MAX(CASE WHEN d.diagnosis_code LIKE 'I10%' THEN 1 ELSE 0 END) AS has_hypertension
FROM clinical.encounters e
JOIN clinical.diagnoses d ON e.encounter_id = d.encounter_id
WHERE e.patient_id IN :patient_ids
GROUP BY e.encounter_id, e.patient_id
"""


def load_admissions(
    start_date: str,
    end_date: str,
    sample_frac: Optional[float] = None,
) -> pd.DataFrame:
    """Load admission data for readmission modeling.

    Args:
        start_date: Start of discharge date range (YYYY-MM-DD)
        end_date: End of discharge date range (YYYY-MM-DD)
        sample_frac: Optional sampling fraction for development (0.0-1.0)

    Returns:
        DataFrame with admission records and readmission labels
    """
    engine = _get_engine()

    logger.info(f"Loading admissions from {start_date} to {end_date}")

    df = pd.read_sql(
        text(ADMISSIONS_QUERY),
        engine,
        params={"start_date": start_date, "end_date": end_date},
    )

    logger.info(f"Loaded {len(df)} admissions, readmission rate: {df['readmitted_30d'].mean():.3f}")

    if sample_frac is not None and sample_frac < 1.0:
        df = df.sample(frac=sample_frac, random_state=42)
        logger.info(f"Sampled to {len(df)} records")

    return df


def load_comorbidities(patient_ids: list) -> pd.DataFrame:
    """Load comorbidity data for a list of patients."""
    engine = _get_engine()

    # chunk patient IDs to avoid query param limits
    # postgres has a limit of ~32k params
    chunk_size = 10000
    chunks = []
    for i in range(0, len(patient_ids), chunk_size):
        chunk = patient_ids[i : i + chunk_size]
        result = pd.read_sql(
            text(COMORBIDITY_QUERY),
            engine,
            params={"patient_ids": tuple(chunk)},
        )
        chunks.append(result)

    return pd.concat(chunks, ignore_index=True)


def load_train_test_split(
    train_start: str = "2023-01-01",
    train_end: str = "2024-06-30",
    test_start: str = "2024-07-01",
    test_end: str = "2024-12-31",
) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Load temporally split train and test sets.

    We split by time, not randomly, to avoid data leakage from
    temporal patterns.
    """
    train_df = load_admissions(train_start, train_end)
    test_df = load_admissions(test_start, test_end)

    # sanity check: no patient overlap in same encounter
    train_encounters = set(train_df["encounter_id"])
    test_encounters = set(test_df["encounter_id"])
    overlap = train_encounters & test_encounters
    if overlap:
        logger.warning(f"Found {len(overlap)} overlapping encounters!")

    return train_df, test_df
