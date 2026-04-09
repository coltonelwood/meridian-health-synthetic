import { parseString } from 'xml2js';

const getLogger = () => (global as any).__logger;

/**
 * C-CDA (Consolidated Clinical Document Architecture) Parser
 *
 * Parses C-CDA XML documents to extract structured clinical data.
 * C-CDA is the standard format for clinical document exchange in the US
 * (required by ONC for Meaningful Use / Promoting Interoperability).
 *
 * C-CDA documents can contain:
 * - Patient demographics
 * - Problems/conditions
 * - Medications
 * - Allergies
 * - Immunizations
 * - Vital signs
 * - Lab results
 * - Procedures
 *
 * This parser is... not great. C-CDA is a complex XML format based on
 * HL7 CDA R2, and different EHR systems generate wildly different
 * C-CDA documents. Some technically-valid issues we've encountered:
 *
 * - Epic generates C-CDAs with custom extensions that break standard parsers
 * - Cerner uses different OIDs for the same concepts
 * - Some systems use NullFlavor for everything, making the data useless
 * - Date formats are inconsistent (YYYYMMDD vs YYYY-MM-DD vs full HL7 timestamp)
 * - Text/narrative sections sometimes don't match structured data
 *
 * We've been patching this parser on a case-by-case basis as we
 * onboard new EHR partners. It's a house of cards but it handles
 * about 90% of the C-CDAs we receive.
 *
 * If you're thinking "we should use a proper C-CDA library" - yes,
 * we should. We looked at Blue Button (CMS), but it's Python.
 * There isn't a great Node.js C-CDA parser. We considered the Java
 * MDHT library but running Java just for C-CDA parsing seems excessive.
 *
 * TODO: evaluate https://github.com/amida-tech/blue-button for Node
 * TODO: handle more section templates
 * TODO: better error handling for malformed documents
 * TODO: validate against C-CDA schema
 */

interface CCDAData {
  documentType: string;
  patientName?: string;
  patientDOB?: string;
  patientGender?: string;
  problems: CCDAProblem[];
  medications: CCDAMedication[];
  allergies: CCDAAllergy[];
  vitalSigns: CCDAVitalSign[];
  // TODO: immunizations, procedures, lab results
  rawSections: Record<string, any>;
}

interface CCDAProblem {
  code: string;
  codeSystem: string;
  displayName: string;
  status: string;
  onsetDate?: string;
}

interface CCDAMedication {
  name: string;
  code?: string;
  codeSystem?: string;
  dose?: string;
  route?: string;
  frequency?: string;
  status: string;
}

interface CCDAAllergy {
  substance: string;
  code?: string;
  reaction?: string;
  severity?: string;
  status: string;
}

interface CCDAVitalSign {
  code: string;
  displayName: string;
  value: string;
  unit: string;
  date?: string;
}

// Known C-CDA template OIDs
const TEMPLATE_OIDS = {
  CCD: '2.16.840.1.113883.10.20.22.1.2', // Continuity of Care Document
  DISCHARGE_SUMMARY: '2.16.840.1.113883.10.20.22.1.8',
  CONSULTATION_NOTE: '2.16.840.1.113883.10.20.22.1.4',
  HISTORY_AND_PHYSICAL: '2.16.840.1.113883.10.20.22.1.3',
  PROGRESS_NOTE: '2.16.840.1.113883.10.20.22.1.9',
  REFERRAL_NOTE: '2.16.840.1.113883.10.20.22.1.14',
};

// Section template OIDs
const SECTION_OIDS = {
  PROBLEMS: '2.16.840.1.113883.10.20.22.2.5.1',
  MEDICATIONS: '2.16.840.1.113883.10.20.22.2.1.1',
  ALLERGIES: '2.16.840.1.113883.10.20.22.2.6.1',
  VITAL_SIGNS: '2.16.840.1.113883.10.20.22.2.4.1',
  RESULTS: '2.16.840.1.113883.10.20.22.2.3.1',
  PROCEDURES: '2.16.840.1.113883.10.20.22.2.7.1',
  IMMUNIZATIONS: '2.16.840.1.113883.10.20.22.2.2.1',
  SOCIAL_HISTORY: '2.16.840.1.113883.10.20.22.2.17',
  PLAN_OF_TREATMENT: '2.16.840.1.113883.10.20.22.2.10',
};

/**
 * Parse a C-CDA XML document.
 */
export async function parseCCDA(xmlContent: string): Promise<CCDAData> {
  const logger = getLogger();

  const parsed = await parseXML(xmlContent);

  if (!parsed.ClinicalDocument && !parsed.clinicaldocument) {
    throw new Error('Not a valid C-CDA document - missing ClinicalDocument root element');
  }

  // Handle namespace variations
  const doc = parsed.ClinicalDocument || parsed.clinicaldocument ||
    parsed['ns2:ClinicalDocument'] || parsed['cda:ClinicalDocument'];

  if (!doc) {
    throw new Error('Could not find ClinicalDocument element');
  }

  const result: CCDAData = {
    documentType: detectDocumentType(doc),
    problems: [],
    medications: [],
    allergies: [],
    vitalSigns: [],
    rawSections: {},
  };

  // Parse patient demographics
  try {
    const patient = extractPatient(doc);
    result.patientName = patient.name;
    result.patientDOB = patient.dob;
    result.patientGender = patient.gender;
  } catch (err: any) {
    logger.warn('Failed to extract patient from C-CDA', { error: err.message });
  }

  // Parse sections
  const sections = extractSections(doc);

  for (const section of sections) {
    const templateId = getTemplateId(section);

    try {
      switch (templateId) {
        case SECTION_OIDS.PROBLEMS:
          result.problems = parseProblemsSection(section);
          break;
        case SECTION_OIDS.MEDICATIONS:
          result.medications = parseMedicationsSection(section);
          break;
        case SECTION_OIDS.ALLERGIES:
          result.allergies = parseAllergiesSection(section);
          break;
        case SECTION_OIDS.VITAL_SIGNS:
          result.vitalSigns = parseVitalSignsSection(section);
          break;
        default:
          // Store raw section data for later
          if (templateId) {
            result.rawSections[templateId] = section;
          }
          break;
      }
    } catch (err: any) {
      logger.warn('Failed to parse C-CDA section', {
        templateId,
        error: err.message,
      });
    }
  }

  logger.info('C-CDA parsed', {
    documentType: result.documentType,
    problems: result.problems.length,
    medications: result.medications.length,
    allergies: result.allergies.length,
    vitalSigns: result.vitalSigns.length,
  });

  return result;
}

function parseXML(xml: string): Promise<any> {
  return new Promise((resolve, reject) => {
    parseString(xml, {
      explicitArray: false,
      ignoreAttrs: false,
      tagNameProcessors: [],
      // strip namespace prefixes because they vary between EHR systems
      // this is technically wrong but makes the code much simpler
      // xmlns: true, // nope, this makes it worse
    }, (err: any, result: any) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function detectDocumentType(doc: any): string {
  const templateIds = getNestedArray(doc, 'templateId');

  for (const tmpl of templateIds) {
    const root = tmpl?.$?.root;
    if (!root) continue;

    for (const [name, oid] of Object.entries(TEMPLATE_OIDS)) {
      if (root === oid) return name;
    }
  }

  // Try to detect from title
  const title = getNestedText(doc, 'title');
  if (title) {
    const titleLower = title.toLowerCase();
    if (titleLower.includes('discharge')) return 'DISCHARGE_SUMMARY';
    if (titleLower.includes('consultation')) return 'CONSULTATION_NOTE';
    if (titleLower.includes('history and physical') || titleLower.includes('h&p')) return 'HISTORY_AND_PHYSICAL';
    if (titleLower.includes('progress')) return 'PROGRESS_NOTE';
    if (titleLower.includes('continuity of care') || titleLower.includes('ccd')) return 'CCD';
    if (titleLower.includes('referral')) return 'REFERRAL_NOTE';
  }

  return 'UNKNOWN';
}

function extractPatient(doc: any): { name?: string; dob?: string; gender?: string } {
  const recordTarget = getNestedValue(doc, 'recordTarget');
  if (!recordTarget) return {};

  const patientRole = getNestedValue(recordTarget, 'patientRole');
  if (!patientRole) return {};

  const patient = getNestedValue(patientRole, 'patient');
  if (!patient) return {};

  // Name
  let name: string | undefined;
  const nameNode = getNestedValue(patient, 'name');
  if (nameNode) {
    const given = getNestedText(nameNode, 'given');
    const family = getNestedText(nameNode, 'family');
    if (given && family) {
      name = `${given} ${family}`;
    } else if (typeof nameNode === 'string') {
      name = nameNode;
    }
  }

  // DOB
  const birthTime = getNestedValue(patient, 'birthTime');
  const dob = birthTime?.$?.value ? formatHL7Date(birthTime.$.value) : undefined;

  // Gender
  const genderCode = getNestedValue(patient, 'administrativeGenderCode');
  const gender = genderCode?.$?.code;

  return { name, dob, gender };
}

function extractSections(doc: any): any[] {
  const component = getNestedValue(doc, 'component');
  if (!component) return [];

  const structuredBody = getNestedValue(component, 'structuredBody');
  if (!structuredBody) return [];

  const components = getNestedArray(structuredBody, 'component');
  return components.map((comp: any) => getNestedValue(comp, 'section')).filter(Boolean);
}

function getTemplateId(section: any): string | null {
  if (!section) return null;

  const templateIds = getNestedArray(section, 'templateId');
  for (const tmpl of templateIds) {
    const root = tmpl?.$?.root;
    if (root) return root;
  }
  return null;
}

function parseProblemsSection(section: any): CCDAProblem[] {
  const problems: CCDAProblem[] = [];
  const entries = getNestedArray(section, 'entry');

  for (const entry of entries) {
    try {
      const act = getNestedValue(entry, 'act');
      if (!act) continue;

      const entryRelationship = getNestedValue(act, 'entryRelationship');
      if (!entryRelationship) continue;

      const observation = getNestedValue(entryRelationship, 'observation');
      if (!observation) continue;

      const value = getNestedValue(observation, 'value');
      if (!value?.$) continue;

      problems.push({
        code: value.$.code || '',
        codeSystem: value.$.codeSystem || '',
        displayName: value.$.displayName || value._ || '',
        status: getObservationStatus(observation),
        onsetDate: getEffectiveDate(observation),
      });
    } catch {
      // Skip malformed entries
    }
  }

  return problems;
}

function parseMedicationsSection(section: any): CCDAMedication[] {
  const medications: CCDAMedication[] = [];
  const entries = getNestedArray(section, 'entry');

  for (const entry of entries) {
    try {
      const substanceAdmin = getNestedValue(entry, 'substanceAdministration');
      if (!substanceAdmin) continue;

      const consumable = getNestedValue(substanceAdmin, 'consumable');
      const manufacturedProduct = getNestedValue(consumable, 'manufacturedProduct');
      const manufacturedMaterial = getNestedValue(manufacturedProduct, 'manufacturedMaterial');

      if (!manufacturedMaterial) continue;

      const code = getNestedValue(manufacturedMaterial, 'code');

      medications.push({
        name: code?.$?.displayName || getNestedText(manufacturedMaterial, 'name') || 'Unknown',
        code: code?.$?.code,
        codeSystem: code?.$?.codeSystem,
        dose: getDoseQuantity(substanceAdmin),
        route: getRouteCode(substanceAdmin),
        status: 'active', // TODO: parse actual status
      });
    } catch {
      // Skip malformed entries
    }
  }

  return medications;
}

function parseAllergiesSection(section: any): CCDAAllergy[] {
  const allergies: CCDAAllergy[] = [];
  const entries = getNestedArray(section, 'entry');

  for (const entry of entries) {
    try {
      const act = getNestedValue(entry, 'act');
      if (!act) continue;

      const entryRelationship = getNestedValue(act, 'entryRelationship');
      if (!entryRelationship) continue;

      const observation = getNestedValue(entryRelationship, 'observation');
      if (!observation) continue;

      const participant = getNestedValue(observation, 'participant');
      const participantRole = getNestedValue(participant, 'participantRole');
      const playingEntity = getNestedValue(participantRole, 'playingEntity');
      const code = getNestedValue(playingEntity, 'code');

      allergies.push({
        substance: code?.$?.displayName || getNestedText(playingEntity, 'name') || 'Unknown',
        code: code?.$?.code,
        reaction: getReaction(observation),
        severity: getSeverity(observation),
        status: getObservationStatus(observation),
      });
    } catch {
      // Skip malformed entries
    }
  }

  return allergies;
}

function parseVitalSignsSection(section: any): CCDAVitalSign[] {
  const vitalSigns: CCDAVitalSign[] = [];
  const entries = getNestedArray(section, 'entry');

  for (const entry of entries) {
    try {
      const organizer = getNestedValue(entry, 'organizer');
      if (!organizer) continue;

      const components = getNestedArray(organizer, 'component');
      for (const comp of components) {
        const observation = getNestedValue(comp, 'observation');
        if (!observation) continue;

        const code = getNestedValue(observation, 'code');
        const value = getNestedValue(observation, 'value');

        if (!code?.$ || !value?.$) continue;

        vitalSigns.push({
          code: code.$.code || '',
          displayName: code.$.displayName || '',
          value: value.$.value || '',
          unit: value.$.unit || '',
          date: getEffectiveDate(observation),
        });
      }
    } catch {
      // Skip malformed entries
    }
  }

  return vitalSigns;
}

// ============================================================
// HELPER FUNCTIONS (the messy part)
// ============================================================

// These helper functions exist because xml2js output is deeply nested
// and inconsistent. Sometimes a value is a string, sometimes an object,
// sometimes an array. These helpers try to handle all cases.

function getNestedValue(obj: any, key: string): any {
  if (!obj) return null;
  if (obj[key] !== undefined) return obj[key];
  // Try with namespace prefix (ugh)
  for (const k of Object.keys(obj)) {
    if (k.endsWith(`:${key}`) || k === key) return obj[k];
  }
  return null;
}

function getNestedArray(obj: any, key: string): any[] {
  const value = getNestedValue(obj, key);
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getNestedText(obj: any, key: string): string | undefined {
  const value = getNestedValue(obj, key);
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (value._) return value._;
  if (value.$?.value) return value.$.value;
  return undefined;
}

function formatHL7Date(hl7Date: string): string {
  if (!hl7Date) return '';
  // HL7 dates are like YYYYMMDD or YYYYMMDDHHmmss
  // We want YYYY-MM-DD
  const cleaned = hl7Date.replace(/[-T:Z]/g, '');
  if (cleaned.length >= 8) {
    return `${cleaned.substring(0, 4)}-${cleaned.substring(4, 6)}-${cleaned.substring(6, 8)}`;
  }
  return hl7Date; // return as-is if we can't parse it
}

function getEffectiveDate(observation: any): string | undefined {
  const effectiveTime = getNestedValue(observation, 'effectiveTime');
  if (!effectiveTime) return undefined;
  if (effectiveTime.$?.value) return formatHL7Date(effectiveTime.$.value);
  const low = getNestedValue(effectiveTime, 'low');
  if (low?.$?.value) return formatHL7Date(low.$.value);
  return undefined;
}

function getObservationStatus(observation: any): string {
  const statusCode = getNestedValue(observation, 'statusCode');
  return statusCode?.$?.code || 'active';
}

function getDoseQuantity(substanceAdmin: any): string | undefined {
  const doseQuantity = getNestedValue(substanceAdmin, 'doseQuantity');
  if (!doseQuantity?.$) return undefined;
  return `${doseQuantity.$.value || ''} ${doseQuantity.$.unit || ''}`.trim();
}

function getRouteCode(substanceAdmin: any): string | undefined {
  const routeCode = getNestedValue(substanceAdmin, 'routeCode');
  return routeCode?.$?.displayName || routeCode?.$?.code;
}

function getReaction(observation: any): string | undefined {
  try {
    const entryRelationship = getNestedValue(observation, 'entryRelationship');
    if (!entryRelationship) return undefined;
    const reactionObs = getNestedValue(
      Array.isArray(entryRelationship) ? entryRelationship[0] : entryRelationship,
      'observation'
    );
    const value = getNestedValue(reactionObs, 'value');
    return value?.$?.displayName;
  } catch {
    return undefined;
  }
}

function getSeverity(observation: any): string | undefined {
  try {
    const relationships = getNestedArray(observation, 'entryRelationship');
    for (const rel of relationships) {
      const obs = getNestedValue(rel, 'observation');
      const code = getNestedValue(obs, 'code');
      if (code?.$?.code === 'SEV') {
        const value = getNestedValue(obs, 'value');
        return value?.$?.displayName;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
