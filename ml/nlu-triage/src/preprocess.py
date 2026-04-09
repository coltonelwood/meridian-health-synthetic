"""
Text preprocessing for patient message triage.

Handles:
- Medical abbreviation expansion
- De-identification of PHI (Protected Health Information)
- Text normalization
- Tokenization prep

Author: @achen
Note: The de-identification here is a best-effort preprocessing step.
      It does NOT replace proper PHI handling per HIPAA requirements.
      The actual PHI pipeline runs upstream in the data platform.
"""

import re
import logging
from typing import List, Optional

logger = logging.getLogger(__name__)


# Medical abbreviation expansions
# This dict has grown organically and is probably missing things.
# Sourced from:
#   - Stedman's Medical Abbreviations
#   - Common abbreviations seen in our patient portal messages
#   - Additions from clinical team review sessions
#
# TODO: move this to a config file or database table
# TODO: handle context-dependent abbreviations (e.g., "pt" = patient vs physical therapy)
MEDICAL_ABBREVIATIONS = {
    # Vitals & Measurements
    "bp": "blood pressure",
    "hr": "heart rate",
    "temp": "temperature",
    "bpm": "beats per minute",
    "lbs": "pounds",
    "kg": "kilograms",
    "mmhg": "millimeters of mercury",

    # Common conditions
    "htn": "hypertension",
    "dm": "diabetes mellitus",
    "dm2": "type 2 diabetes mellitus",
    "t2dm": "type 2 diabetes mellitus",
    "chf": "congestive heart failure",
    "copd": "chronic obstructive pulmonary disease",
    "ckd": "chronic kidney disease",
    "mi": "myocardial infarction",
    "cva": "cerebrovascular accident",
    "dvt": "deep vein thrombosis",
    "pe": "pulmonary embolism",
    "uti": "urinary tract infection",
    "uri": "upper respiratory infection",
    "gerd": "gastroesophageal reflux disease",
    "afib": "atrial fibrillation",
    "a-fib": "atrial fibrillation",
    "ra": "rheumatoid arthritis",
    "oa": "osteoarthritis",
    "ms": "multiple sclerosis",
    "als": "amyotrophic lateral sclerosis",
    "ibs": "irritable bowel syndrome",
    "ibd": "inflammatory bowel disease",

    # Symptoms
    "sob": "shortness of breath",
    "cp": "chest pain",
    "ha": "headache",
    "n/v": "nausea and vomiting",
    "n&v": "nausea and vomiting",
    "abd": "abdominal",
    "bilat": "bilateral",
    "lt": "left",
    "rt": "right",
    "r/o": "rule out",

    # Medications
    "rx": "prescription",
    "otc": "over the counter",
    "abx": "antibiotics",
    "nsaid": "nonsteroidal anti-inflammatory drug",
    "nsaids": "nonsteroidal anti-inflammatory drugs",
    "ppi": "proton pump inhibitor",
    "ssri": "selective serotonin reuptake inhibitor",
    "ace": "angiotensin converting enzyme",
    "arb": "angiotensin receptor blocker",
    "bb": "beta blocker",
    "ccb": "calcium channel blocker",
    "hctz": "hydrochlorothiazide",

    # Timing
    "prn": "as needed",
    "bid": "twice daily",
    "tid": "three times daily",
    "qid": "four times daily",
    "qd": "once daily",
    "qhs": "at bedtime",
    "ac": "before meals",
    "pc": "after meals",
    "po": "by mouth",
    "sq": "subcutaneous",
    "im": "intramuscular",
    "iv": "intravenous",

    # Procedures & Tests
    "ct": "computed tomography",
    "mri": "magnetic resonance imaging",
    "xr": "x-ray",
    "ekg": "electrocardiogram",
    "ecg": "electrocardiogram",
    "echo": "echocardiogram",
    "cbc": "complete blood count",
    "bmp": "basic metabolic panel",
    "cmp": "comprehensive metabolic panel",
    "hba1c": "hemoglobin a1c",
    "a1c": "hemoglobin a1c",
    "tsh": "thyroid stimulating hormone",
    "bnp": "brain natriuretic peptide",
    "psa": "prostate specific antigen",
    "bmi": "body mass index",

    # Departments & Roles
    "er": "emergency room",
    "ed": "emergency department",
    "icu": "intensive care unit",
    "or": "operating room",
    "pcp": "primary care provider",
    "np": "nurse practitioner",
    "pa": "physician assistant",
    "rn": "registered nurse",
    "pt": "physical therapy",  # ambiguous with "patient"
    "ot": "occupational therapy",
    "snf": "skilled nursing facility",

    # Common patient portal language
    "appt": "appointment",
    "f/u": "follow up",
    "fu": "follow up",
    "hx": "history",
    "sx": "symptoms",
    "dx": "diagnosis",
    "tx": "treatment",
    "w/": "with",
    "w/o": "without",
    "yo": "year old",
    "y/o": "year old",
    "lmp": "last menstrual period",
    "pmh": "past medical history",
}

# Regex patterns for PHI de-identification
# These are catch-all patterns. Real PHI scrubbing should use
# a proper NER model (like Philter or Scrubadub).
PHI_PATTERNS = [
    # SSN
    (r"\b\d{3}-\d{2}-\d{4}\b", "[SSN]"),
    # Phone numbers
    (r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b", "[PHONE]"),
    # Email
    (r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", "[EMAIL]"),
    # MRN (our format: MRN followed by 6-10 digits)
    (r"\bMRN\s*:?\s*\d{6,10}\b", "[MRN]"),
    # Dates (MM/DD/YYYY or MM-DD-YYYY)
    (r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", "[DATE]"),
    # Age with identifiers
    (r"\b\d{1,3}\s*(?:year|yr|y\.?o\.?)\s*old\b", "[AGE]"),
    # ZIP codes (5 digit, not preceded by $)
    (r"(?<!\$)\b\d{5}(?:-\d{4})?\b", "[ZIP]"),
    # Street addresses (simplified)
    (r"\b\d{1,5}\s+(?:N|S|E|W|North|South|East|West)?\s*\w+\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Ct|Court|Way|Pl|Place)\b", "[ADDRESS]"),
]

# Compile patterns for performance
_COMPILED_PHI_PATTERNS = [(re.compile(p, re.IGNORECASE), r) for p, r in PHI_PATTERNS]


def expand_abbreviations(text: str) -> str:
    """Expand medical abbreviations in text.

    Uses word boundary matching to avoid partial replacements.
    E.g., "dm" should expand but "dumb" should not.
    """
    words = text.split()
    expanded = []
    for word in words:
        # Strip punctuation for lookup but preserve it
        clean = word.lower().strip(".,;:!?()")
        prefix = word[:len(word) - len(word.lstrip(".,;:!?()"))]
        suffix = word[len(clean) + len(prefix):]

        if clean in MEDICAL_ABBREVIATIONS:
            expanded.append(prefix + MEDICAL_ABBREVIATIONS[clean] + suffix)
        else:
            expanded.append(word)

    return " ".join(expanded)


def deidentify_text(text: str) -> str:
    """Remove/mask potential PHI from text.

    This is a best-effort regex approach. It will miss some PHI
    and occasionally mask non-PHI text. For production use,
    rely on the upstream PHI pipeline.
    """
    result = text
    for pattern, replacement in _COMPILED_PHI_PATTERNS:
        result = pattern.sub(replacement, result)
    return result


def normalize_text(text: str) -> str:
    """Basic text normalization."""
    # Lowercase
    text = text.lower()

    # Normalize whitespace
    text = re.sub(r"\s+", " ", text).strip()

    # Remove excessive punctuation (common in panicked messages)
    text = re.sub(r"([!?.]){3,}", r"\1\1", text)

    # Normalize common misspellings in patient messages
    # (these come up surprisingly often)
    COMMON_MISSPELLINGS = {
        "perscription": "prescription",
        "perscriptions": "prescriptions",
        "medecine": "medicine",
        "medecation": "medication",
        "symtoms": "symptoms",
        "symtpoms": "symptoms",
        "stomache": "stomach",
        "headake": "headache",
        "diarea": "diarrhea",
        "diahrrea": "diarrhea",
        "nausious": "nauseous",
        "nasuea": "nausea",
        "pregnent": "pregnant",
        "diebetes": "diabetes",
        "diabetis": "diabetes",
        "presure": "pressure",
        "docter": "doctor",
        "hospitol": "hospital",
        "surgury": "surgery",
        "alergic": "allergic",
        "alergies": "allergies",
        "sweling": "swelling",
        "brething": "breathing",
        "numbnes": "numbness",
    }

    for wrong, right in COMMON_MISSPELLINGS.items():
        text = re.sub(r"\b" + wrong + r"\b", right, text)

    return text


def preprocess_message(
    text: str,
    expand_abbrevs: bool = True,
    deidentify: bool = True,
    normalize: bool = True,
) -> str:
    """Full preprocessing pipeline for patient messages.

    Order matters:
    1. De-identify first (before lowercasing destroys case patterns)
    2. Normalize
    3. Expand abbreviations last (after normalization)
    """
    if not text or not isinstance(text, str):
        return ""

    if deidentify:
        text = deidentify_text(text)

    if normalize:
        text = normalize_text(text)

    if expand_abbrevs:
        text = expand_abbreviations(text)

    return text


def preprocess_batch(
    texts: List[str],
    expand_abbrevs: bool = True,
    deidentify: bool = True,
    normalize: bool = True,
) -> List[str]:
    """Preprocess a batch of messages."""
    return [
        preprocess_message(t, expand_abbrevs, deidentify, normalize)
        for t in texts
    ]
