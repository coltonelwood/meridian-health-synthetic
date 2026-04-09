/**
 * Document model
 *
 * Represents a clinical document stored in the system.
 * Documents can be:
 * - Uploaded files (PDFs, images, etc.)
 * - Generated documents (clinical notes, discharge summaries)
 * - Received documents (C-CDA, HL7 messages)
 * - Scanned documents (from the document imaging system)
 *
 * Storage is in MinIO (S3-compatible), with a legacy fallback to
 * local filesystem for environments without MinIO.
 *
 * The document metadata is stored in PostgreSQL, and the actual
 * file content is in object storage. We never store file content
 * directly in the database (learned that the hard way - see
 * incident report from 2023-08 when the DB grew to 500GB).
 */

export enum DocumentType {
  // Clinical documents
  CLINICAL_NOTE = 'clinical_note',
  PROGRESS_NOTE = 'progress_note',
  HISTORY_AND_PHYSICAL = 'history_and_physical',
  DISCHARGE_SUMMARY = 'discharge_summary',
  OPERATIVE_REPORT = 'operative_report',
  CONSULTATION = 'consultation',
  PATHOLOGY_REPORT = 'pathology_report',
  RADIOLOGY_REPORT = 'radiology_report',

  // Administrative documents
  CONSENT_FORM = 'consent_form',
  INSURANCE_CARD = 'insurance_card',
  ID_DOCUMENT = 'id_document',
  AUTHORIZATION = 'authorization',
  REFERRAL = 'referral',

  // Exchange documents
  CCDA = 'ccda',
  FHIR_DOCUMENT = 'fhir_document',
  HL7_MESSAGE = 'hl7_message',

  // Lab/imaging results
  LAB_RESULT = 'lab_result',
  IMAGING = 'imaging',
  DICOM = 'dicom',

  // Patient-uploaded
  PATIENT_UPLOAD = 'patient_upload',

  // Other
  OTHER = 'other',
}

export enum DocumentStatus {
  UPLOADING = 'uploading',
  PROCESSING = 'processing',
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  DELETED = 'deleted',
  ERROR = 'error',
  // Added for documents pending review/signature
  PENDING_REVIEW = 'pending_review',
  SIGNED = 'signed',
}

export interface DocumentMetadata {
  id: string;
  patient_id: string;
  encounter_id?: string;

  // Document info
  document_type: DocumentType;
  title: string;
  description?: string;

  // File info
  original_filename: string;
  mime_type: string;
  file_size_bytes: number;
  file_extension: string;

  // Storage
  storage_backend: 'minio' | 'local' | 's3'; // which backend
  storage_key: string; // bucket/path in MinIO or filesystem path
  storage_bucket?: string;

  // Thumbnail (for images and first page of PDFs)
  thumbnail_key?: string;
  thumbnail_generated: boolean;

  // Content extraction
  text_content?: string; // extracted text from PDF/image OCR
  text_extracted: boolean;
  text_extraction_error?: string;

  // C-CDA specific
  ccda_parsed: boolean;
  ccda_document_type?: string;
  ccda_patient_name?: string;

  // Authorship
  uploaded_by: string;
  uploaded_by_name?: string;
  authored_by?: string;
  authored_date?: string;

  // Signing
  signed_by?: string;
  signed_at?: Date;
  signature_data?: string; // base64 encoded signature image

  // Tags/categories for organization
  tags: string[];
  category?: string;

  // Version tracking (for edited documents)
  version: number;
  parent_document_id?: string; // previous version
  is_latest_version: boolean;

  // Sharing/access
  is_confidential: boolean;
  restricted_to_roles?: string[];
  // Some documents should only be visible to certain providers
  restricted_to_provider_ids?: string[];

  // Metadata
  created_at: Date;
  updated_at: Date;
  status: DocumentStatus;
  deleted_at?: Date;
  deleted_by?: string;
  delete_reason?: string;

  // External references
  external_system?: string;
  external_id?: string;
}

export type CreateDocumentInput = Omit<DocumentMetadata,
  'id' | 'created_at' | 'updated_at' | 'version' | 'is_latest_version' |
  'thumbnail_generated' | 'text_extracted' | 'ccda_parsed' | 'status'
>;

export interface DocumentSearchParams {
  patient_id?: string;
  document_type?: DocumentType;
  encounter_id?: string;
  from_date?: string;
  to_date?: string;
  uploaded_by?: string;
  tags?: string[];
  q?: string; // full text search in extracted text
  status?: DocumentStatus;
  page?: number;
  page_size?: number;
  sort?: string;
}
