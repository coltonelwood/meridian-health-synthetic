/**
 * Message Type Definitions - Patient-Provider Chat Prototype
 *
 * Author: Amanda Jiang (ajiang@meridianhealth.io)
 * Created: 2025-08-15
 *
 * Type definitions for the real-time chat system between patients and
 * providers. Supports text messages, image attachments, and document
 * sharing (lab results, prescriptions, etc.).
 *
 * NOTE: This is a prototype. Types may change significantly before
 * production. Don't depend on these from other services yet.
 */

// -- Core Types --------------------------------------------------------------

export type MessageType = 'text' | 'image' | 'document' | 'system' | 'appointment_link';

export type ParticipantRole = 'patient' | 'provider' | 'nurse' | 'front_desk' | 'system';

export type ConversationStatus = 'active' | 'archived' | 'closed' | 'pending_review';

export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

// -- Message Payloads --------------------------------------------------------

export interface TextPayload {
  type: 'text';
  text: string;
  // Support basic formatting (subset of markdown)
  // Bold: **text**, Italic: *text*, Links: [text](url)
  formatted?: boolean;
}

export interface ImagePayload {
  type: 'image';
  url: string;           // MinIO presigned URL
  thumbnailUrl: string;  // 200x200 thumbnail
  mimeType: string;      // image/jpeg, image/png, etc.
  width: number;
  height: number;
  sizeBytes: number;
  altText?: string;
  // Images in healthcare context might be wound photos, rashes, etc.
  // These are PHI and must be stored encrypted
  isPhiContent: boolean;
}

export interface DocumentPayload {
  type: 'document';
  url: string;            // MinIO presigned URL (expires in 1 hour)
  fileName: string;
  mimeType: string;       // application/pdf, etc.
  sizeBytes: number;
  documentType?: 'lab_result' | 'prescription' | 'referral' | 'insurance_card' | 'other';
  // If this document is linked to an existing document record
  documentId?: string;
}

export interface SystemPayload {
  type: 'system';
  text: string;
  action?: string;  // e.g., 'participant_joined', 'participant_left', 'conversation_transferred'
}

export interface AppointmentLinkPayload {
  type: 'appointment_link';
  appointmentId: string;
  appointmentDate: string;  // ISO 8601
  providerName: string;
  appointmentType: string;
  // Allows patient to confirm/reschedule directly from chat
  actions: Array<{
    label: string;
    action: 'confirm' | 'reschedule' | 'cancel';
    url: string;
  }>;
}

export type MessagePayload =
  | TextPayload
  | ImagePayload
  | DocumentPayload
  | SystemPayload
  | AppointmentLinkPayload;

// -- Message -----------------------------------------------------------------

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  senderRole: ParticipantRole;
  senderName: string;  // display name (e.g., "Dr. Smith" or "John D.")
  payload: MessagePayload;
  status: MessageStatus;
  sentAt: string;       // ISO 8601
  deliveredAt?: string;
  readAt?: string;
  // For messages that reply to another message
  replyToMessageId?: string;
  // Client-generated ID for deduplication
  clientMessageId: string;
  // Metadata
  metadata?: Record<string, unknown>;
}

// -- Conversation ------------------------------------------------------------

export interface Participant {
  userId: string;
  role: ParticipantRole;
  displayName: string;
  avatarUrl?: string;
  joinedAt: string;
  lastReadMessageId?: string;
  lastReadAt?: string;
  isOnline: boolean;
  // TODO: add typing indicator state here? or keep it separate?
}

export interface Conversation {
  id: string;
  patientId: string;
  organizationId: string;
  subject?: string;
  status: ConversationStatus;
  participants: Participant[];
  lastMessage?: Message;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
  // If this conversation was initiated from a specific context
  context?: {
    type: 'appointment' | 'claim' | 'prescription' | 'general';
    referenceId?: string;
  };
}

// -- WebSocket Events --------------------------------------------------------

export type WSEventType =
  | 'message.new'
  | 'message.updated'
  | 'message.deleted'
  | 'message.read'
  | 'typing.start'
  | 'typing.stop'
  | 'participant.online'
  | 'participant.offline'
  | 'conversation.updated'
  | 'error';

export interface WSEvent<T = unknown> {
  type: WSEventType;
  conversationId: string;
  timestamp: string;
  data: T;
}

export interface NewMessageEvent {
  message: Message;
}

export interface MessageReadEvent {
  messageId: string;
  readBy: string;
  readAt: string;
}

export interface TypingEvent {
  userId: string;
  displayName: string;
}

export interface ParticipantStatusEvent {
  userId: string;
  isOnline: boolean;
}

export interface ErrorEvent {
  code: string;
  message: string;
  details?: unknown;
}

// -- API Types ---------------------------------------------------------------

export interface SendMessageRequest {
  conversationId: string;
  payload: MessagePayload;
  clientMessageId: string;
  replyToMessageId?: string;
}

export interface SendMessageResponse {
  message: Message;
}

export interface GetConversationsRequest {
  patientId?: string;
  providerId?: string;
  status?: ConversationStatus;
  limit?: number;
  cursor?: string;
}

export interface GetConversationsResponse {
  conversations: Conversation[];
  nextCursor?: string;
  totalCount: number;
}

export interface GetMessagesRequest {
  conversationId: string;
  limit?: number;
  before?: string;  // message ID for cursor-based pagination
}

export interface GetMessagesResponse {
  messages: Message[];
  hasMore: boolean;
}

// -- Upload Types ------------------------------------------------------------

export interface UploadRequest {
  conversationId: string;
  file: {
    name: string;
    mimeType: string;
    sizeBytes: number;
  };
}

export interface UploadResponse {
  uploadUrl: string;      // presigned PUT URL
  downloadUrl: string;    // presigned GET URL (for message payload)
  thumbnailUrl?: string;  // for images
  expiresAt: string;
}
