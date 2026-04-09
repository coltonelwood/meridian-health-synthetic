/**
 * Prototype Chat Server - Patient-Provider Messaging
 * =====================================================
 *
 * Author: Amanda Jiang (ajiang@meridianhealth.io)
 * Created: 2025-08-15
 * Last Modified: 2025-10-02 by ajiang
 *
 * WebSocket-based chat server for real-time messaging between patients and
 * providers. This is a PROTOTYPE - do not deploy to production without:
 *
 * 1. [ ] Message persistence (currently messages are only in-memory!)
 * 2. [ ] Authentication / authorization (currently trusts client-provided userId)
 * 3. [ ] Rate limiting
 * 4. [ ] Message encryption at rest
 * 5. [ ] Audit logging (HIPAA requirement)
 * 6. [ ] Horizontal scaling (need Redis pub/sub for multi-instance)
 * 7. [ ] File upload handling (see upload-handler.ts, not written yet)
 * 8. [x] Basic message types (text, image, document)
 * 9. [ ] Read receipts
 * 10. [ ] Typing indicators
 * 11. [ ] Conversation management (create, close, transfer)
 *
 * Run:
 *   npx tsx experiments/prototype-chat/chat-server.ts
 *   (listens on ws://localhost:8080)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import type {
  Message,
  WSEvent,
  SendMessageRequest,
  Conversation,
  Participant,
  MessagePayload,
  ParticipantRole,
  NewMessageEvent,
  TypingEvent,
  MessageReadEvent,
} from './message-types';

const PORT = parseInt(process.env.CHAT_PORT || '8080');

// -- In-memory state (replace with database!) --------------------------------

// This is obviously terrible for production. Messages disappear on restart.
// But it's fine for prototyping the WebSocket flow and UI interactions.
const conversations: Map<string, Conversation> = new Map();
const messagesByConversation: Map<string, Message[]> = new Map();

// Track connected clients
interface ConnectedClient {
  ws: WebSocket;
  userId: string;
  displayName: string;
  role: ParticipantRole;
  conversationIds: Set<string>;
}

const clients: Map<string, ConnectedClient> = new Map();

// -- WebSocket Server --------------------------------------------------------

const wss = new WebSocketServer({ port: PORT });

console.log(`Chat server starting on ws://localhost:${PORT}`);

wss.on('connection', (ws: WebSocket, req) => {
  // In production, we'd validate the auth token from the URL or headers
  // For now, client sends their identity in the first message
  let client: ConnectedClient | null = null;

  ws.on('message', (raw: Buffer) => {
    try {
      const message = JSON.parse(raw.toString());
      handleMessage(ws, client, message).then(updatedClient => {
        if (updatedClient) client = updatedClient;
      }).catch(err => {
        console.error('Error handling message:', err);
        sendError(ws, 'INTERNAL_ERROR', 'An error occurred processing your message');
      });
    } catch (err) {
      sendError(ws, 'PARSE_ERROR', 'Invalid JSON');
    }
  });

  ws.on('close', () => {
    if (client) {
      console.log(`Client disconnected: ${client.userId} (${client.displayName})`);
      clients.delete(client.userId);

      // Notify other participants in their conversations
      for (const convId of client.conversationIds) {
        broadcastToConversation(convId, {
          type: 'participant.offline',
          conversationId: convId,
          timestamp: new Date().toISOString(),
          data: { userId: client.userId, isOnline: false },
        }, client.userId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// -- Message Handling --------------------------------------------------------

async function handleMessage(
  ws: WebSocket,
  client: ConnectedClient | null,
  message: Record<string, unknown>
): Promise<ConnectedClient | null> {
  const action = message.action as string;

  switch (action) {
    case 'identify': {
      // Client identifies themselves
      // In production: validate JWT, look up user in DB
      const userId = message.userId as string;
      const displayName = message.displayName as string;
      const role = (message.role as ParticipantRole) || 'patient';

      if (!userId || !displayName) {
        sendError(ws, 'INVALID_IDENTIFY', 'userId and displayName are required');
        return null;
      }

      const newClient: ConnectedClient = {
        ws,
        userId,
        displayName,
        role,
        conversationIds: new Set(),
      };

      clients.set(userId, newClient);
      console.log(`Client identified: ${userId} (${displayName}, ${role})`);

      ws.send(JSON.stringify({
        action: 'identified',
        userId,
        displayName,
        role,
      }));

      return newClient;
    }

    case 'join_conversation': {
      if (!client) {
        sendError(ws, 'NOT_IDENTIFIED', 'Send identify action first');
        return null;
      }

      const conversationId = message.conversationId as string;

      // Get or create conversation
      let conversation = conversations.get(conversationId);
      if (!conversation) {
        // Auto-create conversation (in production, this would be a separate API call)
        conversation = {
          id: conversationId,
          patientId: client.role === 'patient' ? client.userId : '',
          organizationId: 'org-001',  // hardcoded for prototype
          status: 'active',
          participants: [],
          unreadCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        conversations.set(conversationId, conversation);
        messagesByConversation.set(conversationId, []);
      }

      // Add participant if not already in conversation
      if (!conversation.participants.find(p => p.userId === client.userId)) {
        const participant: Participant = {
          userId: client.userId,
          role: client.role,
          displayName: client.displayName,
          joinedAt: new Date().toISOString(),
          isOnline: true,
        };
        conversation.participants.push(participant);
      }

      client.conversationIds.add(conversationId);

      // Send recent messages
      const recentMessages = (messagesByConversation.get(conversationId) || []).slice(-50);

      ws.send(JSON.stringify({
        action: 'conversation_joined',
        conversationId,
        conversation,
        recentMessages,
      }));

      // Notify others
      broadcastToConversation(conversationId, {
        type: 'participant.online',
        conversationId,
        timestamp: new Date().toISOString(),
        data: { userId: client.userId, isOnline: true },
      }, client.userId);

      return client;
    }

    case 'send_message': {
      if (!client) {
        sendError(ws, 'NOT_IDENTIFIED', 'Send identify action first');
        return null;
      }

      const req = message as unknown as SendMessageRequest & { action: string };
      const conversationId = req.conversationId;

      if (!client.conversationIds.has(conversationId)) {
        sendError(ws, 'NOT_IN_CONVERSATION', 'Join the conversation first');
        return null;
      }

      // Create message
      const newMessage: Message = {
        id: randomUUID(),
        conversationId,
        senderId: client.userId,
        senderRole: client.role,
        senderName: client.displayName,
        payload: req.payload,
        status: 'sent',
        sentAt: new Date().toISOString(),
        clientMessageId: req.clientMessageId || randomUUID(),
        replyToMessageId: req.replyToMessageId,
      };

      // Store message (in-memory only!)
      const messages = messagesByConversation.get(conversationId) || [];
      messages.push(newMessage);
      messagesByConversation.set(conversationId, messages);

      // Update conversation
      const conv = conversations.get(conversationId);
      if (conv) {
        conv.lastMessage = newMessage;
        conv.updatedAt = new Date().toISOString();
      }

      // Confirm to sender
      ws.send(JSON.stringify({
        action: 'message_sent',
        message: newMessage,
      }));

      // Broadcast to other participants
      broadcastToConversation(conversationId, {
        type: 'message.new',
        conversationId,
        timestamp: new Date().toISOString(),
        data: { message: newMessage } as NewMessageEvent,
      }, client.userId);

      return client;
    }

    case 'typing_start': {
      if (!client) return null;
      const convId = message.conversationId as string;
      broadcastToConversation(convId, {
        type: 'typing.start',
        conversationId: convId,
        timestamp: new Date().toISOString(),
        data: { userId: client.userId, displayName: client.displayName } as TypingEvent,
      }, client.userId);
      return client;
    }

    case 'typing_stop': {
      if (!client) return null;
      const convId2 = message.conversationId as string;
      broadcastToConversation(convId2, {
        type: 'typing.stop',
        conversationId: convId2,
        timestamp: new Date().toISOString(),
        data: { userId: client.userId, displayName: client.displayName } as TypingEvent,
      }, client.userId);
      return client;
    }

    case 'mark_read': {
      if (!client) return null;
      const convId3 = message.conversationId as string;
      const messageId = message.messageId as string;

      // Update the message status (in production, this updates the DB)
      const msgs = messagesByConversation.get(convId3) || [];
      const msg = msgs.find(m => m.id === messageId);
      if (msg) {
        msg.status = 'read';
        msg.readAt = new Date().toISOString();
      }

      // Update participant's last read
      const conv2 = conversations.get(convId3);
      if (conv2) {
        const participant = conv2.participants.find(p => p.userId === client.userId);
        if (participant) {
          participant.lastReadMessageId = messageId;
          participant.lastReadAt = new Date().toISOString();
        }
      }

      broadcastToConversation(convId3, {
        type: 'message.read',
        conversationId: convId3,
        timestamp: new Date().toISOString(),
        data: {
          messageId,
          readBy: client.userId,
          readAt: new Date().toISOString(),
        } as MessageReadEvent,
      }, client.userId);

      return client;
    }

    default:
      sendError(ws, 'UNKNOWN_ACTION', `Unknown action: ${action}`);
      return client;
  }
}

// -- Helpers -----------------------------------------------------------------

function broadcastToConversation(
  conversationId: string,
  event: WSEvent,
  excludeUserId?: string
): void {
  const conversation = conversations.get(conversationId);
  if (!conversation) return;

  for (const participant of conversation.participants) {
    if (participant.userId === excludeUserId) continue;

    const client = clients.get(participant.userId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(event));
    }
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'error',
      conversationId: '',
      timestamp: new Date().toISOString(),
      data: { code, message },
    }));
  }
}

// -- Startup -----------------------------------------------------------------

console.log(`Chat server listening on ws://localhost:${PORT}`);
console.log('');
console.log('This is a PROTOTYPE. Do not use in production.');
console.log('Messages are stored in memory only and will be lost on restart.');
console.log('');
console.log('Quick test with wscat:');
console.log(`  npx wscat -c ws://localhost:${PORT}`);
console.log('  > {"action":"identify","userId":"user-1","displayName":"Dr. Smith","role":"provider"}');
console.log('  > {"action":"join_conversation","conversationId":"conv-1"}');
console.log('  > {"action":"send_message","conversationId":"conv-1","payload":{"type":"text","text":"Hello!"},"clientMessageId":"msg-1"}');
