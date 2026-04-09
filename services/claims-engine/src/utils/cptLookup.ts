/**
 * CPT Code lookup and validation utility.
 *
 * TODO: This should be backed by a real database table (or Redis cache)
 * loaded from the AMA CPT data files. Right now it's a hardcoded subset
 * of the most common codes we see. We added codes as customers requested
 * them which is why the coverage is so uneven - lots of E&M codes, some
 * surgical, almost no radiology or lab.
 *
 * The AMA license costs $$$ so we've been kicking the can. Meanwhile
 * claims with codes not in this list just... get validated as "unknown"
 * and we let the payer reject them if they want.
 *
 * Ticket: CLAIMS-223 (open since 2023-07)
 */

export interface CptCodeInfo {
  code: string;
  shortDescription: string;
  longDescription?: string;
  category: string;
  rvu?: number;            // Relative Value Unit - used for pricing
  facilityRvu?: number;
  nonFacilityRvu?: number;
  malpracticeRvu?: number;
  globalDays?: string;     // XXX, YYY, ZZZ, 000, 010, 090
  statusCode?: string;     // A=active, D=deleted, R=revised
  effectiveDate?: string;
  terminationDate?: string;
}

// This is embarrassing but it works
const CPT_CODES: Record<string, CptCodeInfo> = {
  // E&M - Office/Outpatient (2021+ codes)
  '99202': { code: '99202', shortDescription: 'Office visit, new patient, low complexity', category: 'E&M', rvu: 0.93, globalDays: 'XXX' },
  '99203': { code: '99203', shortDescription: 'Office visit, new patient, moderate complexity', category: 'E&M', rvu: 1.60, globalDays: 'XXX' },
  '99204': { code: '99204', shortDescription: 'Office visit, new patient, moderate-high complexity', category: 'E&M', rvu: 2.60, globalDays: 'XXX' },
  '99205': { code: '99205', shortDescription: 'Office visit, new patient, high complexity', category: 'E&M', rvu: 3.50, globalDays: 'XXX' },
  '99211': { code: '99211', shortDescription: 'Office visit, established patient, minimal', category: 'E&M', rvu: 0.18, globalDays: 'XXX' },
  '99212': { code: '99212', shortDescription: 'Office visit, established patient, straightforward', category: 'E&M', rvu: 0.70, globalDays: 'XXX' },
  '99213': { code: '99213', shortDescription: 'Office visit, established patient, low complexity', category: 'E&M', rvu: 1.30, globalDays: 'XXX' },
  '99214': { code: '99214', shortDescription: 'Office visit, established patient, moderate complexity', category: 'E&M', rvu: 1.92, globalDays: 'XXX' },
  '99215': { code: '99215', shortDescription: 'Office visit, established patient, high complexity', category: 'E&M', rvu: 2.80, globalDays: 'XXX' },

  // E&M - Hospital
  '99221': { code: '99221', shortDescription: 'Initial hospital care, low complexity', category: 'E&M', rvu: 1.92 },
  '99222': { code: '99222', shortDescription: 'Initial hospital care, moderate complexity', category: 'E&M', rvu: 2.61 },
  '99223': { code: '99223', shortDescription: 'Initial hospital care, high complexity', category: 'E&M', rvu: 3.86 },
  '99231': { code: '99231', shortDescription: 'Subsequent hospital care, straightforward', category: 'E&M', rvu: 0.76 },
  '99232': { code: '99232', shortDescription: 'Subsequent hospital care, moderate complexity', category: 'E&M', rvu: 1.39 },
  '99233': { code: '99233', shortDescription: 'Subsequent hospital care, high complexity', category: 'E&M', rvu: 2.00 },

  // E&M - Emergency Department
  '99281': { code: '99281', shortDescription: 'ED visit, self-limited/minor problem', category: 'E&M', rvu: 0.50 },
  '99282': { code: '99282', shortDescription: 'ED visit, low-moderate severity', category: 'E&M', rvu: 0.93 },
  '99283': { code: '99283', shortDescription: 'ED visit, moderate severity', category: 'E&M', rvu: 1.42 },
  '99284': { code: '99284', shortDescription: 'ED visit, high severity', category: 'E&M', rvu: 2.56 },
  '99285': { code: '99285', shortDescription: 'ED visit, immediate significant threat', category: 'E&M', rvu: 3.80 },

  // Behavioral Health
  '90791': { code: '90791', shortDescription: 'Psychiatric diagnostic evaluation', category: 'Psychiatry', rvu: 3.00 },
  '90792': { code: '90792', shortDescription: 'Psychiatric diagnostic evaluation with medical services', category: 'Psychiatry', rvu: 3.50 },
  '90832': { code: '90832', shortDescription: 'Psychotherapy, 16-37 minutes', category: 'Psychiatry', rvu: 1.10 },
  '90834': { code: '90834', shortDescription: 'Psychotherapy, 38-52 minutes', category: 'Psychiatry', rvu: 1.50 },
  '90837': { code: '90837', shortDescription: 'Psychotherapy, 53+ minutes', category: 'Psychiatry', rvu: 2.10 },
  '90847': { code: '90847', shortDescription: 'Family psychotherapy with patient present', category: 'Psychiatry', rvu: 1.80 },

  // Surgery - common
  '10060': { code: '10060', shortDescription: 'Incision and drainage of abscess, simple', category: 'Surgery', rvu: 2.20, globalDays: '010' },
  '20610': { code: '20610', shortDescription: 'Arthrocentesis, major joint', category: 'Surgery', rvu: 1.52, globalDays: '000' },
  '27447': { code: '27447', shortDescription: 'Total knee arthroplasty', category: 'Surgery', rvu: 20.77, globalDays: '090' },
  '27130': { code: '27130', shortDescription: 'Total hip arthroplasty', category: 'Surgery', rvu: 20.37, globalDays: '090' },
  '29881': { code: '29881', shortDescription: 'Knee arthroscopy, meniscectomy', category: 'Surgery', rvu: 7.91, globalDays: '090' },

  // Vaccines / Immunization
  '90460': { code: '90460', shortDescription: 'Immunization admin, first vaccine', category: 'Immunization', rvu: 0.17 },
  '90471': { code: '90471', shortDescription: 'Immunization admin, injection', category: 'Immunization', rvu: 0.17 },
  '90472': { code: '90472', shortDescription: 'Immunization admin, each additional', category: 'Immunization', rvu: 0.15 },
  '90658': { code: '90658', shortDescription: 'Influenza virus vaccine, trivalent', category: 'Vaccine', rvu: 0.00 },
  '90681': { code: '90681', shortDescription: 'Rotavirus vaccine, human, 2 dose', category: 'Vaccine', rvu: 0.00 },

  // Lab / Pathology (very incomplete)
  '80053': { code: '80053', shortDescription: 'Comprehensive metabolic panel', category: 'Lab', rvu: 0.00 },
  '85025': { code: '85025', shortDescription: 'Complete blood count with differential', category: 'Lab', rvu: 0.00 },
  '87086': { code: '87086', shortDescription: 'Urine culture', category: 'Lab', rvu: 0.00 },
  '81001': { code: '81001', shortDescription: 'Urinalysis with microscopy', category: 'Lab', rvu: 0.00 },

  // Radiology (very incomplete)
  '71046': { code: '71046', shortDescription: 'Chest X-ray, 2 views', category: 'Radiology', rvu: 0.22 },
  '73030': { code: '73030', shortDescription: 'Shoulder X-ray, complete', category: 'Radiology', rvu: 0.21 },
  '72148': { code: '72148', shortDescription: 'MRI lumbar spine without contrast', category: 'Radiology', rvu: 1.52 },

  // Preventive
  '99381': { code: '99381', shortDescription: 'Preventive visit, new patient, infant', category: 'Preventive', rvu: 1.50 },
  '99391': { code: '99391', shortDescription: 'Preventive visit, established patient, infant', category: 'Preventive', rvu: 1.22 },
  '99385': { code: '99385', shortDescription: 'Preventive visit, new patient, 18-39', category: 'Preventive', rvu: 1.50 },
  '99386': { code: '99386', shortDescription: 'Preventive visit, new patient, 40-64', category: 'Preventive', rvu: 1.80 },
  '99395': { code: '99395', shortDescription: 'Preventive visit, established patient, 18-39', category: 'Preventive', rvu: 1.30 },
  '99396': { code: '99396', shortDescription: 'Preventive visit, established patient, 40-64', category: 'Preventive', rvu: 1.50 },
};

/**
 * Look up a CPT code. Returns undefined if not in our (very limited) database.
 */
export function lookupCptCode(code: string): CptCodeInfo | undefined {
  return CPT_CODES[code?.trim()];
}

/**
 * Validate a CPT code format (5 alphanumeric characters).
 * Does NOT check if the code actually exists - we'd need a real DB for that.
 */
export function isValidCptFormat(code: string): boolean {
  if (!code) return false;
  // CPT codes are 5 chars: either 5 digits or 4 digits + letter (Category II/III)
  // Category I: 00100-99499 (numeric)
  // Category II: 0001F-9999F (ends in F)
  // Category III: 0001T-9999T (ends in T)
  return /^[0-9]{4}[0-9A-Z]$/.test(code.trim());
}

/**
 * Check if a CPT code is in our lookup table.
 */
export function isKnownCptCode(code: string): boolean {
  return code?.trim() in CPT_CODES;
}

/**
 * Get the category for a CPT code range.
 * This is a rough approximation - the real CPT structure is more nuanced.
 */
export function getCptCategory(code: string): string {
  const numeric = parseInt(code, 10);
  if (isNaN(numeric)) return 'Unknown';

  if (numeric >= 99201 && numeric <= 99499) return 'E&M';
  if (numeric >= 00100 && numeric <= 01999) return 'Anesthesia';
  if (numeric >= 10004 && numeric <= 69990) return 'Surgery';
  if (numeric >= 70010 && numeric <= 79999) return 'Radiology';
  if (numeric >= 80047 && numeric <= 89398) return 'Pathology/Lab';
  if (numeric >= 90281 && numeric <= 99199) return 'Medicine';
  if (numeric >= 99500 && numeric <= 99607) return 'Home Services';

  return 'Unknown';
}

/**
 * Get all known codes (for debugging/admin UI).
 * Don't use this in production request paths - it returns the entire map.
 */
export function getAllKnownCodes(): CptCodeInfo[] {
  return Object.values(CPT_CODES);
}

/**
 * Search CPT codes by description keyword.
 * This is a terrible O(n) search but with <100 codes who cares.
 * Will need to be rewritten when we load the full CPT database.
 */
export function searchCptCodes(query: string): CptCodeInfo[] {
  if (!query || query.trim().length < 2) return [];
  const lowerQuery = query.toLowerCase();
  return Object.values(CPT_CODES).filter(
    (c) =>
      c.shortDescription.toLowerCase().includes(lowerQuery) ||
      c.code.includes(query.trim())
  );
}
