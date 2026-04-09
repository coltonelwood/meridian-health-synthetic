/**
 * Payer-specific rules and configuration.
 *
 * Every insurance payer has their own quirks, requirements, and interpretations
 * of the X12 spec. This file captures the rules we've discovered through
 * trial, error, and many rejected claims.
 *
 * THIS SHOULD BE IN A DATABASE OR CONFIG FILE, NOT CODE.
 * But here we are. Every time sales closes a new payer, someone adds
 * another case to the switch statement and we pray it doesn't break
 * anything else.
 *
 * Ticket to move this to config: CLAIMS-156 (blocked by CLAIMS-155)
 * Opened: 2023-04-03
 * Last updated: never
 */

import { ClaimType, FilingIndicator } from '../models/Claim';

export interface PayerConfig {
  payerId: string;
  payerName: string;
  clearinghouseId: string;
  submissionMethod: 'EDI' | 'API' | 'PORTAL' | 'FAX';  // yes, some payers still require fax
  supportedClaimTypes: ClaimType[];
  filingIndicator: FilingIndicator;

  // Timely filing limits (days from date of service)
  timelyFilingDays: number;
  appealTimelyFilingDays: number;

  // EDI-specific
  receiverId?: string;
  ediVersion?: string;
  requiresRefPhysician?: boolean;
  requiresPriorAuth?: boolean;  // for all claims, not just specific services
  requiresNpi?: boolean;

  // Adjudication
  autoAdjudicateEligible?: boolean;
  maxUnitsPerLine?: number;
  maxLinesPerClaim?: number;

  // Special rules (this is the messy part)
  rules: PayerRule[];
}

export interface PayerRule {
  id: string;
  description: string;
  type: 'VALIDATION' | 'MODIFIER' | 'BUNDLING' | 'AUTHORIZATION' | 'FREQUENCY' | 'OTHER';
  // This is evaluated at runtime... in a very hacky way
  condition?: string;
  action?: string;
  metadata?: Record<string, any>;
}

/**
 * Get payer configuration by payer ID.
 *
 * I hate this function. - Derek
 * I also hate this function. - Lisa
 * Join the club. - Priya
 */
export function getPayerConfig(payerId: string): PayerConfig | undefined {
  switch (payerId) {
    case 'BCBS_FL':
    case 'BCBSFL':
    case '00590':  // their EDI payer ID
      return {
        payerId: '00590',
        payerName: 'BlueCross BlueShield of Florida',
        clearinghouseId: 'CHNG_001',
        submissionMethod: 'EDI',
        supportedClaimTypes: [ClaimType.PROFESSIONAL, ClaimType.INSTITUTIONAL],
        filingIndicator: FilingIndicator.COMMERCIAL,
        timelyFilingDays: 365,
        appealTimelyFilingDays: 180,
        receiverId: '00590',
        ediVersion: '005010X222A1',
        requiresRefPhysician: false,
        requiresPriorAuth: false,
        requiresNpi: true,
        autoAdjudicateEligible: true,
        maxUnitsPerLine: 999,
        maxLinesPerClaim: 50,
        rules: [
          {
            id: 'BCBS_FL_001',
            description: 'BCBS FL requires modifier 25 on E&M when billed with procedure',
            type: 'MODIFIER',
            condition: 'hasEMWithProcedure',
            action: 'requireModifier25',
          },
          {
            id: 'BCBS_FL_002',
            description: 'BCBS FL does not accept place of service 02 (telehealth) for new patients',
            type: 'VALIDATION',
            // this was relaxed during COVID but they brought it back in 2024
            condition: 'isTelehealthNewPatient',
            action: 'deny',
          },
        ],
      };

    case 'AETNA':
    case '60054':
      return {
        payerId: '60054',
        payerName: 'Aetna',
        clearinghouseId: 'CHNG_001',
        submissionMethod: 'EDI',
        supportedClaimTypes: [ClaimType.PROFESSIONAL, ClaimType.INSTITUTIONAL],
        filingIndicator: FilingIndicator.COMMERCIAL,
        timelyFilingDays: 365,
        appealTimelyFilingDays: 180,
        receiverId: '60054',
        ediVersion: '005010X222A1',
        requiresRefPhysician: true,  // Aetna requires referring physician on specialist visits
        requiresPriorAuth: false,
        requiresNpi: true,
        autoAdjudicateEligible: true,
        maxUnitsPerLine: 999,
        maxLinesPerClaim: 999,
        rules: [
          {
            id: 'AETNA_001',
            description: 'Aetna requires referring provider NPI for specialist visits',
            type: 'VALIDATION',
            condition: 'isSpecialistVisit',
            action: 'requireReferringProvider',
          },
          {
            id: 'AETNA_002',
            description: 'Aetna bundles 99213 + 99214 on same DOS',
            type: 'BUNDLING',
            condition: 'hasDuplicateEM',
            action: 'bundleToHigher',
          },
        ],
      };

    case 'CIGNA':
    case '62308':
      return {
        payerId: '62308',
        payerName: 'Cigna',
        clearinghouseId: 'CHNG_001',
        submissionMethod: 'EDI',
        supportedClaimTypes: [ClaimType.PROFESSIONAL, ClaimType.INSTITUTIONAL],
        filingIndicator: FilingIndicator.COMMERCIAL,
        timelyFilingDays: 365,
        appealTimelyFilingDays: 180,
        receiverId: '62308',
        ediVersion: '005010X222A1',
        requiresRefPhysician: false,
        requiresPriorAuth: false,
        requiresNpi: true,
        autoAdjudicateEligible: true,
        maxUnitsPerLine: 99,  // Cigna has a lower unit limit than most
        maxLinesPerClaim: 50,
        rules: [
          {
            id: 'CIGNA_001',
            description: 'Cigna requires taxonomy code in the provider segment',
            type: 'VALIDATION',
            condition: 'missingTaxonomy',
            action: 'addDefaultTaxonomy',
          },
        ],
      };

    case 'UHC':
    case 'UNITED':
    case '87726':
      return {
        payerId: '87726',
        payerName: 'UnitedHealthcare',
        clearinghouseId: 'OPTUM_001',  // they use their own clearinghouse, obviously
        submissionMethod: 'EDI',
        supportedClaimTypes: [ClaimType.PROFESSIONAL, ClaimType.INSTITUTIONAL],
        filingIndicator: FilingIndicator.COMMERCIAL,
        timelyFilingDays: 365,
        appealTimelyFilingDays: 180,
        receiverId: '87726',
        ediVersion: '005010X222A1',
        requiresRefPhysician: false,
        requiresPriorAuth: false,
        requiresNpi: true,
        autoAdjudicateEligible: true,
        maxUnitsPerLine: 999,
        maxLinesPerClaim: 50,
        rules: [
          {
            id: 'UHC_001',
            description: 'UHC requires rendering provider on all claims, even if same as billing',
            type: 'VALIDATION',
            condition: 'missingRenderingProvider',
            action: 'copyBillingToRendering',
          },
          {
            id: 'UHC_002',
            description: 'UHC modifier 59 vs XE/XS/XP/XU - use distinct modifiers when possible',
            type: 'MODIFIER',
            condition: 'usesModifier59',
            action: 'suggestDistinctModifier',
          },
          {
            id: 'UHC_003',
            description: 'UHC does not cover more than 1 preventive visit per 365 days',
            type: 'FREQUENCY',
            condition: 'preventiveVisitFrequency',
            action: 'denyDuplicate',
            metadata: { frequencyDays: 365, cptRange: ['99381', '99397'] },
          },
        ],
      };

    case 'HUMANA':
    case '61101':
      return {
        payerId: '61101',
        payerName: 'Humana',
        clearinghouseId: 'CHNG_001',
        submissionMethod: 'EDI',
        supportedClaimTypes: [ClaimType.PROFESSIONAL, ClaimType.INSTITUTIONAL],
        filingIndicator: FilingIndicator.COMMERCIAL,
        timelyFilingDays: 365,
        appealTimelyFilingDays: 120,  // Humana is stingy with appeal windows
        requiresNpi: true,
        autoAdjudicateEligible: false, // their adjudication rules are weird, don't auto-adjudicate
        maxUnitsPerLine: 99,
        maxLinesPerClaim: 50,
        rules: [],
      };

    case 'MEDICARE_B':
    case 'CMS':
    case '00882':
      return {
        payerId: '00882',
        payerName: 'Medicare Part B (Palmetto GBA)',  // our MAC
        clearinghouseId: 'CHNG_001',
        submissionMethod: 'EDI',
        supportedClaimTypes: [ClaimType.PROFESSIONAL],
        filingIndicator: FilingIndicator.MEDICARE_B,
        timelyFilingDays: 365,
        appealTimelyFilingDays: 120,
        receiverId: '00882',
        ediVersion: '005010X222A1',
        requiresRefPhysician: true,
        requiresPriorAuth: false,
        requiresNpi: true,
        autoAdjudicateEligible: false,  // Medicare has too many LCD/NCD rules
        maxUnitsPerLine: 999,
        maxLinesPerClaim: 999,
        rules: [
          {
            id: 'MCR_001',
            description: 'Medicare requires CLIA number for lab services',
            type: 'VALIDATION',
            condition: 'isLabService',
            action: 'requireClia',
          },
          {
            id: 'MCR_002',
            description: 'Medicare requires ABN for non-covered services',
            type: 'VALIDATION',
            condition: 'isNonCoveredService',
            action: 'requireAbn',
          },
          {
            id: 'MCR_003',
            description: 'Medicare modifier 25 requires documentation',
            type: 'MODIFIER',
            condition: 'hasModifier25',
            action: 'flagForReview',
          },
        ],
      };

    case 'MEDICAID_FL':
    case '77027':
      return {
        payerId: '77027',
        payerName: 'Florida Medicaid',
        clearinghouseId: 'CHNG_001',
        submissionMethod: 'EDI',
        supportedClaimTypes: [ClaimType.PROFESSIONAL, ClaimType.INSTITUTIONAL],
        filingIndicator: FilingIndicator.MEDICAID,
        timelyFilingDays: 365,
        appealTimelyFilingDays: 90,
        receiverId: '77027',
        ediVersion: '005010X222A1',
        requiresRefPhysician: true,
        requiresPriorAuth: true,  // Medicaid requires prior auth on basically everything
        requiresNpi: true,
        autoAdjudicateEligible: false,
        maxUnitsPerLine: 99,
        maxLinesPerClaim: 25,
        rules: [
          {
            id: 'MCAID_FL_001',
            description: 'FL Medicaid requires prior authorization for all surgical procedures',
            type: 'AUTHORIZATION',
            condition: 'isSurgicalProcedure',
            action: 'requirePriorAuth',
          },
          {
            id: 'MCAID_FL_002',
            description: 'FL Medicaid caps E&M at 24 visits per year',
            type: 'FREQUENCY',
            condition: 'emVisitCount',
            action: 'denyOverLimit',
            metadata: { maxPerYear: 24, cptRange: ['99201', '99215'] },
          },
        ],
      };

    // Fallback for unknown payers - we get a surprising number of these
    // from smaller regional plans and TPAs
    default:
      return undefined;
  }
}

/**
 * Check if a payer requires prior authorization for a specific CPT code.
 * This is a simplified check - real prior auth requirements are way more
 * complex (depends on diagnosis, place of service, patient age, etc.)
 */
export function requiresPriorAuth(payerId: string, cptCode: string): boolean {
  const config = getPayerConfig(payerId);
  if (!config) return false;

  // If the payer requires prior auth on everything, short circuit
  if (config.requiresPriorAuth) return true;

  // Otherwise check specific rules
  const authRules = config.rules.filter((r) => r.type === 'AUTHORIZATION');
  if (authRules.length === 0) return false;

  // Check if CPT is a surgical procedure (10000-69999)
  const numeric = parseInt(cptCode, 10);
  if (!isNaN(numeric) && numeric >= 10000 && numeric <= 69999) {
    return authRules.some((r) => r.condition === 'isSurgicalProcedure');
  }

  return false;
}

/**
 * Get the timely filing deadline for a claim.
 * Returns the number of days from date of service within which the claim must be filed.
 */
export function getTimelyFilingDays(payerId: string): number {
  const config = getPayerConfig(payerId);
  return config?.timelyFilingDays || 365; // default to 1 year if unknown
}

/**
 * Get all configured payer IDs.
 * Used by the admin API to list supported payers.
 */
export function getSupportedPayerIds(): string[] {
  // Hardcoded because we can't iterate a switch statement... another reason
  // to move this to a database.
  return ['00590', '60054', '62308', '87726', '61101', '00882', '77027'];
}

/**
 * Normalize a payer ID to our internal format.
 * Different systems send different IDs for the same payer.
 */
export function normalizePayerId(payerId: string): string {
  const upper = payerId?.toUpperCase()?.trim();
  // This is getting ridiculous but every integration sends something different
  const aliases: Record<string, string> = {
    'BCBS_FL': '00590',
    'BCBSFL': '00590',
    'BCBS-FL': '00590',
    'BLUECROSS_FL': '00590',
    'AETNA': '60054',
    'AET': '60054',
    'CIGNA': '62308',
    'CIG': '62308',
    'UHC': '87726',
    'UNITED': '87726',
    'UNITEDHEALTHCARE': '87726',
    'UNITEDHEALTH': '87726',
    'HUMANA': '61101',
    'HUM': '61101',
    'MEDICARE': '00882',
    'MEDICARE_B': '00882',
    'CMS': '00882',
    'MEDICAID_FL': '77027',
    'FL_MEDICAID': '77027',
    'FLORIDA_MEDICAID': '77027',
  };
  return aliases[upper] || payerId;
}
