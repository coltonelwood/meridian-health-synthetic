"""
Rule-based anomaly detection for claims.

These rules run alongside the ML model and capture known
fraud/waste/abuse patterns. They were defined with the SIU team.

TODO: move these rules to a config file (YAML or JSON) so SIU can
update them without code changes. This is a recurring request.
@mrodriguez has a branch for this but it's been in review for 3 weeks.

Author: @mrodriguez, with input from SIU team
"""

import logging
from typing import Dict, List

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


# --- HARDCODED RULES ---
# Each rule returns True if the claim is suspicious
# TODO: these thresholds should be in a config file

def rule_excessive_charge(claim: pd.Series, cpt_stats: dict) -> bool:
    """Flag if charge is > 10x the average for the CPT code."""
    cpt = claim.get("cpt_code")
    charge = claim.get("charge_amount", 0)
    if cpt and cpt in cpt_stats:
        avg = cpt_stats[cpt]["mean_charge"]
        if avg > 0 and charge > 10 * avg:
            return True
    return False


def rule_duplicate_claim(claim: pd.Series, recent_claims: pd.DataFrame) -> bool:
    """Flag if same patient+CPT+date combination exists.

    This catches duplicate submissions, which are sometimes innocent
    (resubmission after denial) but often indicate a billing error.
    """
    dupes = recent_claims[
        (recent_claims["patient_id"] == claim["patient_id"])
        & (recent_claims["cpt_code"] == claim["cpt_code"])
        & (recent_claims["service_date"] == claim["service_date"])
        & (recent_claims["claim_id"] != claim["claim_id"])
    ]
    return len(dupes) > 0


def rule_impossible_combo(claim: pd.Series) -> bool:
    """Flag mutually exclusive procedure combinations.

    Some procedure codes can't logically happen on the same patient
    on the same day. E.g., bilateral and unilateral versions of
    the same procedure.
    """
    # Simplified version - real implementation would use a lookup table
    # from CMS NCCI edits
    IMPOSSIBLE_PAIRS = {
        ("27447", "27446"),  # bilateral vs unilateral knee replacement
        ("43239", "43235"),  # EGD with biopsy vs diagnostic EGD
        ("99213", "99214"),  # two different E&M levels same day
        ("99214", "99215"),
    }
    # Would need to check against other claims on same patient+date
    # Currently just a placeholder
    return False


def rule_unbundling(claim: pd.Series) -> bool:
    """Detect potential unbundling - billing separate procedures
    that should be billed as a single bundled code.

    This is one of the most common billing fraud patterns.
    """
    # CCI (Correct Coding Initiative) edits would go here
    # We don't have the full CCI table loaded yet
    # TODO: load CCI edits from CMS quarterly release
    return False


def rule_weekend_surgery(claim: pd.Series) -> bool:
    """Flag major surgical procedures on weekends.

    While emergency surgeries happen on weekends, elective
    procedures generally don't. A high volume of weekend
    surgeries from a provider is suspicious.
    """
    service_date = pd.to_datetime(claim.get("service_date"))
    cpt = str(claim.get("cpt_code", ""))

    # Surgical CPT codes are in 10000-69999 range
    if cpt.isdigit() and 10000 <= int(cpt) <= 69999:
        if service_date.dayofweek in [5, 6]:  # Saturday or Sunday
            return True
    return False


def rule_high_volume_provider(claim: pd.Series, provider_daily_counts: dict) -> bool:
    """Flag providers with impossibly high daily claim volumes.

    No physician can reasonably see more than ~40 patients per day.
    Volumes above this suggest fraud or billing errors.
    """
    provider = claim.get("billing_provider_id")
    date = claim.get("service_date")
    key = (provider, date)

    if key in provider_daily_counts:
        if provider_daily_counts[key] > 40:  # magic number from SIU guidance
            return True
    return False


def rule_deceased_patient(claim: pd.Series, deceased_patients: set) -> bool:
    """Flag claims for patients who are deceased.

    Services after death date (unless it's a death-related service)
    are always fraudulent.
    """
    patient = claim.get("patient_id")
    return patient in deceased_patients


def rule_out_of_state(claim: pd.Series) -> bool:
    """Flag claims where patient and provider are in different states
    and the service isn't telehealth.

    Not always fraud, but worth investigating for high-dollar claims.
    """
    # Would need address data for both patient and provider
    # TODO: join with provider credentialing data
    return False


def apply_rules(claims_df: pd.DataFrame) -> pd.DataFrame:
    """Apply all rules to a batch of claims.

    Returns a DataFrame with:
        - rules_score: 0-1 score based on number/severity of triggered rules
        - triggered_rules: list of rule names that fired
    """
    logger.info(f"Applying rules engine to {len(claims_df)} claims")

    # Precompute data needed by rules
    cpt_stats = {}
    if "cpt_code" in claims_df.columns and "charge_amount" in claims_df.columns:
        cpt_groups = claims_df.groupby("cpt_code")["charge_amount"].agg(["mean", "std", "count"])
        for cpt, row in cpt_groups.iterrows():
            cpt_stats[cpt] = {"mean_charge": row["mean"], "std_charge": row["std"]}

    # Provider daily counts
    provider_daily = {}
    if "billing_provider_id" in claims_df.columns and "service_date" in claims_df.columns:
        daily_counts = claims_df.groupby(
            ["billing_provider_id", "service_date"]
        )["claim_id"].count()
        for (provider, date), count in daily_counts.items():
            provider_daily[(provider, date)] = count

    # Apply rules to each claim
    results = []
    for idx, claim in claims_df.iterrows():
        triggered = []

        if rule_excessive_charge(claim, cpt_stats):
            triggered.append("excessive_charge")

        if rule_duplicate_claim(claim, claims_df):
            triggered.append("duplicate_claim")

        if rule_weekend_surgery(claim):
            triggered.append("weekend_surgery")

        if rule_high_volume_provider(claim, provider_daily):
            triggered.append("high_volume_provider")

        # Rules that need external data (currently no-ops)
        # if rule_unbundling(claim):
        #     triggered.append("unbundling")
        # if rule_deceased_patient(claim, deceased_set):
        #     triggered.append("deceased_patient")

        # Score: weighted sum of triggered rules
        # Different rules have different severity weights
        RULE_WEIGHTS = {
            "excessive_charge": 0.4,
            "duplicate_claim": 0.3,
            "weekend_surgery": 0.1,
            "high_volume_provider": 0.3,
            "unbundling": 0.5,
            "deceased_patient": 1.0,
        }

        score = sum(RULE_WEIGHTS.get(r, 0.1) for r in triggered)
        score = min(score, 1.0)  # cap at 1.0

        results.append({
            "rules_score": score,
            "triggered_rules": triggered if triggered else [],
            "n_rules_triggered": len(triggered),
        })

    result_df = pd.DataFrame(results, index=claims_df.index)

    n_flagged = (result_df["n_rules_triggered"] > 0).sum()
    logger.info(f"Rules flagged {n_flagged} claims ({n_flagged/len(claims_df)*100:.1f}%)")

    return result_df
