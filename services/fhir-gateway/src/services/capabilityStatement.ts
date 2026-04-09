import { Request } from 'express';
import { SUPPORTED_RESOURCE_TYPES } from '../models/ResourceMapping';

/**
 * FHIR CapabilityStatement
 *
 * This is the "metadata" endpoint that FHIR clients use to discover
 * what the server supports. It's like a Swagger doc but for FHIR.
 *
 * Per the spec, this should be available at /fhir/metadata and should
 * accurately describe the server's capabilities.
 *
 * Ours is... mostly accurate. Some things are aspirational rather than
 * fully implemented. The FHIR validator at https://validator.fhir.org
 * gives us a few warnings but no errors.
 *
 * This is largely hardcoded. If we add new resource types or search
 * parameters, we need to update this manually. There's no auto-discovery.
 */

export function getCapabilityStatement(req: Request): any {
  const baseUrl = `${req.protocol}://${req.get('host')}/fhir`;

  return {
    resourceType: 'CapabilityStatement',
    id: 'meridian-fhir-gateway',
    url: `${baseUrl}/metadata`,
    version: '1.3.0',
    name: 'MeridianHealthFHIRGateway',
    title: 'Meridian Health Technologies FHIR Gateway',
    status: 'active',
    experimental: false, // well... kind of
    date: '2024-12-01',
    publisher: 'Meridian Health Technologies',
    contact: [{
      name: 'Interoperability Team',
      telecom: [{
        system: 'email',
        value: 'fhir-support@meridianhealth.com',
      }],
    }],
    description: 'FHIR R4 Gateway for Meridian Health Platform. Provides read, search, and write access to clinical data.',
    kind: 'instance',
    fhirVersion: '4.0.1',
    format: ['application/fhir+json', 'application/json'],

    // SMART on FHIR authorization
    // TODO: actually implement SMART on FHIR auth
    // Right now we just pass through the JWT from the API gateway
    // Some EHR integrations (like Epic) require full SMART compliance
    // Ticket: PLAT-8800
    // rest[0].security would go here

    implementation: {
      description: 'Meridian Health FHIR Gateway (Production)',
      url: baseUrl,
    },

    rest: [{
      mode: 'server',
      documentation: 'FHIR R4 REST API. Supports Patient, Practitioner, Condition, Observation, and Encounter resources.',

      security: {
        cors: true,
        service: [{
          coding: [{
            system: 'http://terminology.hl7.org/CodeSystem/restful-security-service',
            code: 'SMART-on-FHIR',
            display: 'SMART on FHIR',
          }],
          text: 'OAuth2 using SMART on FHIR profile (see security extension for token endpoint)',
        }],
        description: 'Authentication via OAuth2/SMART on FHIR. Contact fhir-support@meridianhealth.com for client registration.',
        // The SMART configuration would normally be here
        // extension: [{ url: "http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris", ... }]
      },

      resource: [
        // Patient
        {
          type: 'Patient',
          profile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient',
          interaction: [
            { code: 'read' },
            { code: 'search-type' },
            { code: 'create' },
            { code: 'update' },
          ],
          searchParam: [
            { name: 'name', type: 'string', documentation: 'A portion of either family or given name' },
            { name: 'family', type: 'string' },
            { name: 'given', type: 'string' },
            { name: 'birthdate', type: 'date' },
            { name: 'gender', type: 'token' },
            { name: 'identifier', type: 'token', documentation: 'MRN or other identifier (system|value)' },
            { name: 'telecom', type: 'token' },
            { name: '_id', type: 'token' },
          ],
          versioning: 'versioned',
          readHistory: false,
          updateCreate: false,
          conditionalCreate: false,
          conditionalRead: 'not-supported',
          conditionalUpdate: false,
          conditionalDelete: 'not-supported',
        },

        // Practitioner
        {
          type: 'Practitioner',
          profile: 'http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner',
          interaction: [
            { code: 'read' },
            { code: 'search-type' },
            { code: 'create' },
            { code: 'update' },
          ],
          searchParam: [
            { name: 'name', type: 'string' },
            { name: 'family', type: 'string' },
            { name: 'given', type: 'string' },
            { name: 'identifier', type: 'token', documentation: 'NPI or other identifier' },
            { name: 'specialty', type: 'string' },
          ],
        },

        // Condition
        {
          type: 'Condition',
          interaction: [
            { code: 'read' },
            { code: 'search-type' },
            { code: 'create' },
          ],
          searchParam: [
            { name: 'patient', type: 'reference', documentation: 'Required. Patient reference.' },
            { name: 'code', type: 'token' },
            { name: 'category', type: 'token' },
            { name: 'clinical-status', type: 'token' },
          ],
        },

        // Observation
        {
          type: 'Observation',
          interaction: [
            { code: 'read' },
            { code: 'search-type' },
            { code: 'create' },
          ],
          searchParam: [
            { name: 'patient', type: 'reference', documentation: 'Required. Patient reference.' },
            { name: 'code', type: 'token' },
            { name: 'category', type: 'token' },
            { name: 'date', type: 'date' },
          ],
        },

        // Encounter
        {
          type: 'Encounter',
          interaction: [
            { code: 'read' },
            { code: 'search-type' },
          ],
          searchParam: [
            { name: 'patient', type: 'reference' },
            { name: 'date', type: 'date' },
            { name: 'status', type: 'token' },
            { name: 'class', type: 'token' },
          ],
        },
      ],

      // System-level operations
      operation: [
        {
          name: 'export',
          definition: 'http://hl7.org/fhir/uv/bulkdata/OperationDefinition/export',
          documentation: 'Bulk data export (partially implemented)',
        },
      ],
    }],
  };
}
