/**
 * X12 EDI Transaction Parser/Generator
 *
 * Handles parsing and generating X12 837 (claim submission) and
 * 835 (remittance advice) EDI transactions.
 *
 * X12 is a positional/delimited format from the 1970s that the US
 * healthcare industry still uses for everything. Each transaction
 * is a series of "segments" separated by ~ (tilde), with fields
 * within segments separated by * (asterisk).
 *
 * ---------------------------------------------------------------
 *  HERE BE DRAGONS
 *
 *  This parser was written under extreme time pressure during the
 *  initial launch. It handles the "happy path" of 837P transactions
 *  reasonably well but has known issues with:
 *  - 837I (institutional) claims
 *  - Claims with COB (coordination of benefits)
 *  - Multi-transaction batches
 *  - Non-standard delimiters (some payers use ^ instead of *)
 *  - ISA/GS envelope validation
 *
 *  We tried using the x12-parser npm package but it couldn't handle
 *  the weird formatting from some clearinghouses, so we wrote our own.
 *  That was a mistake, but here we are.
 *
 *  If you're modifying this file, please add test cases to
 *  tests/x12Parser.test.ts. And maybe pray a little.
 * ---------------------------------------------------------------
 */

import { Claim, ClaimType, FilingIndicator } from '../models/Claim';
import { ClaimLine, getModifiers } from '../models/ClaimLine';
import { ParsedRemittance, ParsedRemittanceClaim, RemittanceAdjustment, RemittanceServiceLine } from '../models/Remittance';

// Default delimiters - can be overridden by ISA segment
const DEFAULT_SEGMENT_TERMINATOR = '~';
const DEFAULT_ELEMENT_SEPARATOR = '*';
const DEFAULT_SUBELEMENT_SEPARATOR = ':';
const DEFAULT_REPETITION_SEPARATOR = '^';

interface X12Envelope {
  senderId: string;
  receiverId: string;
  date: string;
  time: string;
  controlNumber: string;
  versionId: string;
  segmentTerminator: string;
  elementSeparator: string;
  subelementSeparator: string;
}

/**
 * Generate an X12 837P (Professional) transaction from a claim.
 * Returns the raw EDI string.
 *
 * This is NOT a complete 837P implementation. It covers the most common
 * segments we need for commercial claims. Institutional (837I) is not
 * supported yet (we submit those through the clearinghouse portal manually).
 */
export function generateX12_837(claim: Claim, lines: ClaimLine[]): string {
  if (claim.claimType === ClaimType.INSTITUTIONAL) {
    // We generate a very simplified 837I - it's missing several required
    // segments for institutional claims but the clearinghouse fills them in.
    // (This is technically not compliant but it works with our clearinghouse.)
    return generateX12_837I_simplified(claim, lines);
  }

  const segments: string[] = [];
  const sep = DEFAULT_ELEMENT_SEPARATOR;
  const term = DEFAULT_SEGMENT_TERMINATOR;
  const controlNumber = generateControlNumber();
  const now = new Date();
  const dateStr = formatX12Date(now);
  const timeStr = formatX12Time(now);

  // ISA - Interchange Control Header
  // Every field is fixed width. ISA is always exactly 106 characters.
  segments.push([
    'ISA', '00', pad('', 10), '00', pad('', 10),
    'ZZ', pad('MERIDIAN', 15),
    'ZZ', pad(claim.payer.payerId || '', 15),
    dateStr.substring(2),  // YYMMDD
    timeStr,
    DEFAULT_REPETITION_SEPARATOR,
    '00501',
    pad(controlNumber, 9, '0'),
    '0',  // acknowledgment requested
    process.env.NODE_ENV === 'production' ? 'P' : 'T',  // P=production, T=test
    DEFAULT_SUBELEMENT_SEPARATOR,
  ].join(sep) + term);

  // GS - Functional Group Header
  segments.push([
    'GS', 'HC',  // HC = Health Care
    'MERIDIAN',
    claim.payer.payerId || '',
    dateStr,
    timeStr,
    controlNumber,
    'X',
    '005010X222A1',
  ].join(sep) + term);

  // ST - Transaction Set Header
  segments.push(`ST${sep}837${sep}${controlNumber}${sep}005010X222A1${term}`);

  // BHT - Beginning of Hierarchical Transaction
  segments.push([
    'BHT', '0019', '00',  // 00 = original
    claim.claimNumber || controlNumber,
    dateStr, timeStr, 'CH',  // CH = chargeable
  ].join(sep) + term);

  // 1000A - Submitter Name
  segments.push(`NM1${sep}41${sep}2${sep}MERIDIAN HEALTH TECHNOLOGIES${sep}${sep}${sep}${sep}${sep}46${sep}MERIDIANHT${term}`);
  segments.push(`PER${sep}IC${sep}CLAIMS DEPT${sep}TE${sep}8005551234${sep}EM${sep}claims@meridianhealth.example.com${term}`);

  // 1000B - Receiver Name
  segments.push(`NM1${sep}40${sep}2${sep}${claim.payer.payerName || claim.payer.payerId}${sep}${sep}${sep}${sep}${sep}46${sep}${claim.payer.payerId}${term}`);

  // 2000A - Billing Provider HL
  segments.push(`HL${sep}1${sep}${sep}20${sep}1${term}`);

  // Billing provider taxonomy - hardcoded because we don't track it
  // TODO: Look up actual taxonomy from provider database (CLAIMS-778)
  segments.push(`PRV${sep}BI${sep}PXC${sep}207Q00000X${term}`);

  // 2010AA - Billing Provider Name
  segments.push([
    'NM1', '85', '2',
    claim.provider.billingProviderName || 'MERIDIAN HEALTH SERVICES',
    '', '', '', '',
    'XX', claim.provider.billingProviderNpi,
  ].join(sep) + term);

  // Billing provider address (using dummy address - real one comes from provider DB)
  segments.push(`N3${sep}123 MAIN STREET${sep}SUITE 100${term}`);
  segments.push(`N4${sep}TAMPA${sep}FL${sep}336012345${term}`);

  // REF - billing provider tax ID
  if (claim.provider.billingProviderTaxId) {
    segments.push(`REF${sep}EI${sep}${claim.provider.billingProviderTaxId}${term}`);
  }

  // 2000B - Subscriber HL
  segments.push(`HL${sep}2${sep}1${sep}22${sep}${claim.patient.relationshipToSubscriber === '18' ? '0' : '1'}${term}`);

  // SBR - Subscriber Information
  const isSubscriber = claim.patient.relationshipToSubscriber === '18';
  segments.push([
    'SBR',
    claim.coordinationOfBenefits?.isSecondaryClaim ? 'S' : 'P',  // P=primary, S=secondary
    isSubscriber ? '18' : claim.patient.relationshipToSubscriber || '18',
    claim.payer.groupNumber || '',
    claim.payer.payerName || '',
    '',
    '',
    '',
    '',
    filingIndicatorToX12(claim.filingIndicator),
  ].join(sep) + term);

  // 2010BA - Subscriber Name
  segments.push([
    'NM1', 'IL', '1',
    claim.patient.lastName || '',
    claim.patient.firstName || '',
    '', '', '',
    'MI', claim.subscriberId,
  ].join(sep) + term);

  // Subscriber address
  if (claim.patient.addressLine1) {
    segments.push(`N3${sep}${claim.patient.addressLine1}${sep}${claim.patient.addressLine2 || ''}${term}`);
    segments.push(`N4${sep}${claim.patient.city || ''}${sep}${claim.patient.state || ''}${sep}${claim.patient.zip || ''}${term}`);
  }

  // Subscriber demographics
  if (claim.patient.dateOfBirth) {
    segments.push(`DMG${sep}D8${sep}${claim.patient.dateOfBirth.replace(/-/g, '')}${sep}${claim.patient.gender || 'U'}${term}`);
  }

  // 2010BB - Payer Name
  segments.push([
    'NM1', 'PR', '2',
    claim.payer.payerName || 'UNKNOWN PAYER',
    '', '', '', '',
    'PI', claim.payer.payerId,
  ].join(sep) + term);

  // 2300 - Claim Information
  segments.push([
    'CLM',
    claim.claimNumber,
    claim.totalChargeAmount.toFixed(2),
    '',
    '',
    `${claim.provider.placeOfService || '11'}${DEFAULT_SUBELEMENT_SEPARATOR}B${DEFAULT_SUBELEMENT_SEPARATOR}1`,
    'Y',  // provider signature on file
    'A',  // assignment of benefits
    'Y',  // release of information
    'I',  // patient signature source
  ].join(sep) + term);

  // DTP - Service dates
  if (claim.serviceDateFrom) {
    const fromDate = claim.serviceDateFrom.replace(/-/g, '');
    const toDate = claim.serviceDateTo ? claim.serviceDateTo.replace(/-/g, '') : fromDate;
    if (fromDate === toDate) {
      segments.push(`DTP${sep}472${sep}D8${sep}${fromDate}${term}`);
    } else {
      segments.push(`DTP${sep}472${sep}RD8${sep}${fromDate}-${toDate}${term}`);
    }
  }

  // Prior authorization
  if (claim.payer.priorAuthNumber) {
    segments.push(`REF${sep}G1${sep}${claim.payer.priorAuthNumber}${term}`);
  }

  // Diagnosis codes
  const dxQualifier = claim.diagnosisCodeType === 'ABF' ? 'ABF' : 'ABK';
  const dxSegment = ['HI'];
  for (let i = 0; i < Math.min(claim.diagnosisCodes.length, 12); i++) {
    const prefix = i === 0 ? dxQualifier : dxQualifier;
    dxSegment.push(`${prefix}${DEFAULT_SUBELEMENT_SEPARATOR}${claim.diagnosisCodes[i].replace('.', '')}`);
  }
  segments.push(dxSegment.join(sep) + term);

  // Referring provider (if present)
  if (claim.provider.referringProviderNpi) {
    segments.push([
      'NM1', 'DN', '1',
      '', '', '', '', '',
      'XX', claim.provider.referringProviderNpi,
    ].join(sep) + term);
  }

  // Rendering provider (if different from billing)
  if (claim.provider.renderingProviderNpi && claim.provider.renderingProviderNpi !== claim.provider.billingProviderNpi) {
    segments.push([
      'NM1', '82', '1',
      '', '', '', '', '',
      'XX', claim.provider.renderingProviderNpi,
    ].join(sep) + term);
  }

  // 2400 - Service Lines
  for (const line of lines) {
    const mods = getModifiers(line);
    const modStr = mods.concat(Array(4 - mods.length).fill('')).slice(0, 4);

    // SV1 - Professional Service
    const sv1 = [
      'SV1',
      `HC${DEFAULT_SUBELEMENT_SEPARATOR}${line.cptCode}${modStr.map(m => m ? DEFAULT_SUBELEMENT_SEPARATOR + m : '').join('')}`,
      line.chargeAmount.toFixed(2),
      line.unitType || 'UN',
      line.units.toString(),
      line.placeOfService || claim.provider.placeOfService || '11',
      '',
      line.diagnosisPointer.join(DEFAULT_SUBELEMENT_SEPARATOR),
    ];
    segments.push(sv1.join(sep) + term);

    // DTP - Line service date
    const lineFromDate = (line.serviceDateFrom || claim.serviceDateFrom || '').replace(/-/g, '');
    if (lineFromDate) {
      segments.push(`DTP${sep}472${sep}D8${sep}${lineFromDate}${term}`);
    }

    // NDC code for drug claims
    if (line.ndcCode) {
      segments.push(`LIN${sep}${sep}N4${sep}${line.ndcCode}${term}`);
    }

    // Line-level rendering provider override
    if (line.renderingProviderNpi && line.renderingProviderNpi !== claim.provider.renderingProviderNpi) {
      segments.push([
        'NM1', '82', '1', '', '', '', '', '',
        'XX', line.renderingProviderNpi,
      ].join(sep) + term);
    }
  }

  // SE - Transaction Set Trailer
  const segmentCount = segments.length + 1;  // +1 for the SE itself
  segments.push(`SE${sep}${segmentCount}${sep}${controlNumber}${term}`);

  // GE - Functional Group Trailer
  segments.push(`GE${sep}1${sep}${controlNumber}${term}`);

  // IEA - Interchange Control Trailer
  segments.push(`IEA${sep}1${sep}${pad(controlNumber, 9, '0')}${term}`);

  return segments.join('\n');
}

/**
 * Simplified 837I generator - this is a hack.
 * Real institutional claims need UB-04 data (revenue codes, condition codes,
 * value codes, occurrence codes, etc.) that we don't fully support.
 */
function generateX12_837I_simplified(claim: Claim, lines: ClaimLine[]): string {
  // Just generate an 837P with a comment that it should be 837I
  // The clearinghouse will reject this about 30% of the time and
  // our ops team has to resubmit via the portal.
  // TODO: Implement proper 837I generation (CLAIMS-334)
  return generateX12_837({ ...claim, claimType: ClaimType.PROFESSIONAL } as Claim, lines);
}

/**
 * Parse an X12 835 (Electronic Remittance Advice) transaction.
 * Returns structured remittance data that can be matched to claims.
 *
 * This parser handles the basic/common 835 structure. It does NOT handle:
 * - PLB (Provider Level Adjustments) properly
 * - Multiple payees in one 835
 * - Non-standard delimiters
 * - Continuation (~\n vs ~) segment terminators
 */
export function parseX12_835(rawEdi: string): ParsedRemittance {
  if (!rawEdi || rawEdi.trim().length === 0) {
    throw new Error('Empty EDI content');
  }

  // Detect delimiters from ISA segment
  // ISA is always 106 chars with fixed positions
  let elementSep = DEFAULT_ELEMENT_SEPARATOR;
  let segmentTerm = DEFAULT_SEGMENT_TERMINATOR;
  let subelementSep = DEFAULT_SUBELEMENT_SEPARATOR;

  if (rawEdi.startsWith('ISA')) {
    elementSep = rawEdi[3]; // character after "ISA"
    // Segment terminator is at position 105
    // But some EDIs have \n or \r\n after the terminator, so we need to handle that
    const isaEnd = rawEdi.indexOf('\n');
    if (isaEnd > 100 && isaEnd < 110) {
      segmentTerm = rawEdi[isaEnd - 1] === '\r' ? rawEdi[isaEnd - 2] : rawEdi[isaEnd - 1];
    } else {
      // Try to find it by looking at the end of the ISA
      segmentTerm = rawEdi[105] || DEFAULT_SEGMENT_TERMINATOR;
    }
    // Subelement separator is at position 104
    subelementSep = rawEdi[104] || DEFAULT_SUBELEMENT_SEPARATOR;
  }

  // Split into segments - handle both \n and no \n between segments
  const cleaned = rawEdi
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '')
    .trim();

  const segments = cleaned.split(segmentTerm).filter((s) => s.trim().length > 0);

  // Parse segments into structure
  const result: ParsedRemittance = {
    payerId: '',
    claims: [],
  };

  let currentClaim: ParsedRemittanceClaim | null = null;
  let currentServiceLine: RemittanceServiceLine | null = null;

  for (const rawSegment of segments) {
    const elements = rawSegment.trim().split(elementSep);
    const segmentId = elements[0];

    switch (segmentId) {
      case 'ISA':
        // Interchange header - mostly envelope info
        break;

      case 'GS':
        // Functional group header
        break;

      case 'ST':
        // Transaction set header - should be 835
        if (elements[1] !== '835') {
          throw new Error(`Expected 835 transaction set, got ${elements[1]}`);
        }
        break;

      case 'BPR':
        // Financial Information
        result.paymentMethod = elements[4] || undefined;
        result.paymentAmount = elements[2] ? parseFloat(elements[2]) : undefined;
        result.paymentDate = parseX12Date(elements[16]);
        break;

      case 'TRN':
        // Trace Number
        result.traceNumber = elements[2] || undefined;
        result.checkNumber = elements[3] || undefined;
        break;

      case 'N1':
        // Name segments - PR = payer, PE = payee
        if (elements[1] === 'PR') {
          result.payerName = elements[2] || undefined;
          if (elements[3] === 'PI' || elements[3] === 'XV') {
            result.payerId = elements[4] || '';
          }
        } else if (elements[1] === 'PE') {
          result.payeeName = elements[2] || undefined;
          if (elements[3] === 'XX') {
            result.payeeNpi = elements[4] || undefined;
          } else if (elements[3] === 'FI') {
            result.payeeTaxId = elements[4] || undefined;
          }
        }
        break;

      case 'CLP':
        // Claim Level Payment
        // Save previous claim if exists
        if (currentClaim) {
          if (currentServiceLine) {
            currentClaim.serviceLines.push(currentServiceLine);
            currentServiceLine = null;
          }
          result.claims.push(currentClaim);
        }

        currentClaim = {
          patientControlNumber: elements[1] || '',
          claimStatusCode: elements[2] || undefined,
          chargeAmount: parseFloat(elements[3]) || 0,
          paidAmount: parseFloat(elements[4]) || 0,
          patientResponsibilityAmount: elements[5] ? parseFloat(elements[5]) : undefined,
          payerClaimNumber: elements[7] || undefined,
          adjustments: [],
          serviceLines: [],
        };
        break;

      case 'CAS':
        // Claim Adjustment Segment - can appear at claim or service level
        if (elements.length >= 4) {
          const groupCode = elements[1] as RemittanceAdjustment['groupCode'];
          // CAS can have up to 6 adjustment groups (reason + amount + quantity, repeated)
          for (let i = 2; i < elements.length - 1; i += 3) {
            if (elements[i] && elements[i + 1]) {
              const adj: RemittanceAdjustment = {
                groupCode,
                reasonCode: elements[i],
                amount: parseFloat(elements[i + 1]) || 0,
                quantity: elements[i + 2] ? parseInt(elements[i + 2], 10) : undefined,
              };

              if (currentServiceLine) {
                currentServiceLine.adjustments.push(adj);
              } else if (currentClaim) {
                currentClaim.adjustments.push(adj);
              }
            }
          }
        }
        break;

      case 'NM1':
        // Patient name within claim context
        if (currentClaim && elements[1] === 'QC') {
          currentClaim.patientLastName = elements[3] || undefined;
          currentClaim.patientFirstName = elements[4] || undefined;
          if (elements[8] === 'MI') {
            currentClaim.subscriberId = elements[9] || undefined;
          }
        }
        break;

      case 'SVC':
        // Service line
        if (currentServiceLine && currentClaim) {
          currentClaim.serviceLines.push(currentServiceLine);
        }

        const procedureInfo = (elements[1] || '').split(subelementSep);
        currentServiceLine = {
          procedureCode: procedureInfo[1] || '',
          modifiers: procedureInfo.slice(2).filter((m) => m),
          chargeAmount: parseFloat(elements[2]) || 0,
          paidAmount: parseFloat(elements[3]) || 0,
          units: elements[5] ? parseInt(elements[5], 10) : 1,
          adjustments: [],
          remarkCodes: [],
        };
        break;

      case 'LQ':
        // Remark codes
        if (currentServiceLine && elements[1] === 'HE') {
          currentServiceLine.remarkCodes = currentServiceLine.remarkCodes || [];
          currentServiceLine.remarkCodes.push(elements[2]);
        }
        break;

      case 'DTM':
        // Date/Time Reference
        if (currentServiceLine && elements[1] === '472') {
          // Service date
          currentServiceLine.serviceDateFrom = parseX12Date(elements[3]);
        }
        break;

      case 'SE':
      case 'GE':
      case 'IEA':
        // Trailers - finalize current claim/service line
        if (currentServiceLine && currentClaim) {
          currentClaim.serviceLines.push(currentServiceLine);
          currentServiceLine = null;
        }
        if (currentClaim) {
          result.claims.push(currentClaim);
          currentClaim = null;
        }
        break;

      default:
        // Unknown segment - skip
        // There are many optional segments we don't parse
        break;
    }
  }

  // Handle case where last claim wasn't pushed (no trailer)
  if (currentServiceLine && currentClaim) {
    currentClaim.serviceLines.push(currentServiceLine);
  }
  if (currentClaim) {
    result.claims.push(currentClaim);
  }

  return result;
}

// ---- Utility functions ----

function generateControlNumber(): string {
  // 9-character numeric control number
  return Date.now().toString().substring(4); // last 9 digits of timestamp
}

function formatX12Date(date: Date): string {
  const y = date.getFullYear().toString();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}${m}${d}`;
}

function formatX12Time(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}${m}`;
}

function parseX12Date(dateStr?: string): string | undefined {
  if (!dateStr || dateStr.length < 8) return undefined;
  // X12 dates are CCYYMMDD
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  return `${year}-${month}-${day}`;
}

function pad(str: string, length: number, char: string = ' '): string {
  return str.padEnd(length, char).substring(0, length);
}

function filingIndicatorToX12(indicator: FilingIndicator): string {
  switch (indicator) {
    case FilingIndicator.COMMERCIAL: return 'CI';
    case FilingIndicator.MEDICARE_A: return 'MA';
    case FilingIndicator.MEDICARE_B: return 'MB';
    case FilingIndicator.MEDICAID: return 'MC';
    case FilingIndicator.TRICARE: return 'CH';
    case FilingIndicator.CHAMPVA: return 'CH';
    case FilingIndicator.GROUP_HEALTH: return 'BL';
    case FilingIndicator.FECA: return 'FI';
    default: return 'CI';
  }
}
