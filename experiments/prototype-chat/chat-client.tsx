/**
 * Prototype Chat Client - Patient-Provider Messaging
 * =====================================================
 *
 * Author: Amanda Jiang (ajiang@meridianhealth.io)
 * Created: 2025-08-20
 * Last Modified: 2025-10-10 by ajiang
 *
 * React component for the chat UI. Basic but functional.
 * Connects to the WebSocket server and displays messages in real-time.
 *
 * TODO: Add typing indicators (need server-side support first)
 * TODO: Add read receipts (show blue checkmarks like WhatsApp)
 * TODO: Add file upload with drag-and-drop
 * TODO: Add emoji picker
 * TODO: Add message search
 * TODO: Accessibility audit (screen reader support, keyboard nav)
 * TODO: Mobile responsive layout
 *
 * Usage:
 *   Import this component into the patient portal or provider dashboard:
 *   <ChatWindow conversationId="conv-123" userId="user-456" />
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type {
  Message,
  Conversation,
  MessagePayload,
  WSEvent,
  NewMessageEvent,
  TypingEvent,
  ParticipantRole,
} from './message-types';

// -- Props -------------------------------------------------------------------

interface ChatWindowProps {
  conversationId: string;
  userId: string;
  displayName: string;
  role: ParticipantRole;
  wsUrl?: string;
}

// -- Styles ------------------------------------------------------------------
// Using inline styles for the prototype. In production we'd use CSS modules
// or tailwind. Don't judge me.

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    maxHeight: '600px',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: '#ffffff',
  },
  header: {
    padding: '12px 16px',
    backgroundColor: '#1a73a7',  // Meridian brand blue
    color: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: '16px',
    fontWeight: 600 as const,
    margin: 0,
  },
  headerSubtitle: {
    fontSize: '12px',
    opacity: 0.8,
    margin: 0,
  },
  messageList: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    backgroundColor: '#f5f7fa',
  },
  messageBubble: (isOwn: boolean) => ({
    maxWidth: '70%',
    padding: '8px 12px',
    borderRadius: isOwn ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
    backgroundColor: isOwn ? '#1a73a7' : '#ffffff',
    color: isOwn ? '#ffffff' : '#333333',
    alignSelf: isOwn ? 'flex-end' as const : 'flex-start' as const,
    boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
  }),
  senderName: {
    fontSize: '11px',
    fontWeight: 600 as const,
    marginBottom: '2px',
    opacity: 0.7,
  },
  messageText: {
    fontSize: '14px',
    lineHeight: 1.4,
    margin: 0,
    wordBreak: 'break-word' as const,
  },
  messageTime: {
    fontSize: '10px',
    opacity: 0.6,
    marginTop: '4px',
    textAlign: 'right' as const,
  },
  inputArea: {
    display: 'flex',
    padding: '12px',
    borderTop: '1px solid #e0e0e0',
    backgroundColor: '#ffffff',
    gap: '8px',
  },
  textInput: {
    flex: 1,
    padding: '8px 12px',
    border: '1px solid #d0d0d0',
    borderRadius: '20px',
    fontSize: '14px',
    outline: 'none',
    resize: 'none' as const,
    fontFamily: 'inherit',
    maxHeight: '100px',
  },
  sendButton: {
    padding: '8px 16px',
    backgroundColor: '#1a73a7',
    color: '#ffffff',
    border: 'none',
    borderRadius: '20px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 600 as const,
    whiteSpace: 'nowrap' as const,
  },
  systemMessage: {
    textAlign: 'center' as const,
    fontSize: '12px',
    color: '#888',
    padding: '4px 0',
  },
  typingIndicator: {
    fontSize: '12px',
    color: '#888',
    fontStyle: 'italic' as const,
    padding: '0 16px 8px',
  },
  connectionStatus: {
    fontSize: '11px',
    padding: '4px 8px',
    textAlign: 'center' as const,
  },
  documentAttachment: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px',
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: '6px',
    marginTop: '4px',
  },
  imageAttachment: {
    maxWidth: '200px',
    maxHeight: '200px',
    borderRadius: '6px',
    marginTop: '4px',
  },
};

// -- Component ---------------------------------------------------------------

export function ChatWindow({
  conversationId,
  userId,
  displayName,
  role,
  wsUrl = 'ws://localhost:8080',
}: ChatWindowProps): React.ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = useCallback(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // WebSocket connection
  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);

      // Identify ourselves
      ws.send(JSON.stringify({
        action: 'identify',
        userId,
        displayName,
        role,
      }));

      // Join conversation
      ws.send(JSON.stringify({
        action: 'join_conversation',
        conversationId,
      }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.action === 'conversation_joined') {
          setConversation(data.conversation);
          setMessages(data.recentMessages || []);
          return;
        }

        if (data.action === 'message_sent') {
          // Our own message was confirmed
          return;
        }

        // Handle WSEvent-style messages
        const wsEvent = data as WSEvent;

        switch (wsEvent.type) {
          case 'message.new': {
            const newMsg = (wsEvent.data as NewMessageEvent).message;
            setMessages(prev => [...prev, newMsg]);
            break;
          }

          case 'typing.start': {
            const typingData = wsEvent.data as TypingEvent;
            setTypingUsers(prev => {
              const next = new Map(prev);
              next.set(typingData.userId, typingData.displayName);
              return next;
            });

            // Clear typing indicator after 3 seconds
            const existingTimeout = typingTimeoutRef.current.get(typingData.userId);
            if (existingTimeout) clearTimeout(existingTimeout);
            typingTimeoutRef.current.set(
              typingData.userId,
              setTimeout(() => {
                setTypingUsers(prev => {
                  const next = new Map(prev);
                  next.delete(typingData.userId);
                  return next;
                });
              }, 3000)
            );
            break;
          }

          case 'typing.stop': {
            const stopData = wsEvent.data as TypingEvent;
            setTypingUsers(prev => {
              const next = new Map(prev);
              next.delete(stopData.userId);
              return next;
            });
            break;
          }

          case 'error':
            console.error('Server error:', wsEvent.data);
            break;
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);

      // TODO: Implement reconnection with exponential backoff
      // For now, the user has to refresh the page
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    return () => {
      ws.close();
    };
  }, [wsUrl, conversationId, userId, displayName, role]);

  // Send message
  const sendMessage = useCallback(() => {
    if (!inputText.trim() || !wsRef.current || !isConnected) return;

    const clientMessageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const payload: MessagePayload = {
      type: 'text',
      text: inputText.trim(),
    };

    // Send via WebSocket
    wsRef.current.send(JSON.stringify({
      action: 'send_message',
      conversationId,
      payload,
      clientMessageId,
    }));

    // Optimistically add to local state
    const optimisticMessage: Message = {
      id: clientMessageId,  // temporary, will be replaced by server ID
      conversationId,
      senderId: userId,
      senderRole: role,
      senderName: displayName,
      payload,
      status: 'sending',
      sentAt: new Date().toISOString(),
      clientMessageId,
    };

    setMessages(prev => [...prev, optimisticMessage]);
    setInputText('');

    // Stop typing indicator
    wsRef.current.send(JSON.stringify({
      action: 'typing_stop',
      conversationId,
    }));
  }, [inputText, isConnected, conversationId, userId, role, displayName]);

  // Handle input changes (with typing indicator)
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputText(e.target.value);

    if (wsRef.current && isConnected && e.target.value.trim()) {
      wsRef.current.send(JSON.stringify({
        action: 'typing_start',
        conversationId,
      }));
    }
  }, [isConnected, conversationId]);

  // Handle Enter key
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }, [sendMessage]);

  // Format timestamp
  const formatTime = (isoString: string): string => {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Render message content based on type
  const renderPayload = (payload: MessagePayload, isOwn: boolean) => {
    switch (payload.type) {
      case 'text':
        return <p style={styles.messageText}>{payload.text}</p>;

      case 'image':
        return (
          <div>
            <img
              src={payload.thumbnailUrl || payload.url}
              alt={payload.altText || 'Image attachment'}
              style={styles.imageAttachment}
              onClick={() => window.open(payload.url, '_blank')}
            />
          </div>
        );

      case 'document':
        return (
          <div style={styles.documentAttachment}>
            <span>{'📄'}</span>
            <div>
              <a
                href={payload.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: isOwn ? '#ffffff' : '#1a73a7', textDecoration: 'none' }}
              >
                {payload.fileName}
              </a>
              <div style={{ fontSize: '11px', opacity: 0.7 }}>
                {(payload.sizeBytes / 1024).toFixed(0)} KB
                {payload.documentType && ` - ${payload.documentType.replace('_', ' ')}`}
              </div>
            </div>
          </div>
        );

      case 'system':
        return null;  // system messages rendered differently

      case 'appointment_link':
        return (
          <div>
            <p style={styles.messageText}>
              {'📅'} Appointment: {payload.appointmentType} with {payload.providerName}
            </p>
            <p style={{ ...styles.messageText, fontSize: '12px', marginTop: '4px' }}>
              {new Date(payload.appointmentDate).toLocaleDateString()} at{' '}
              {new Date(payload.appointmentDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </p>
            <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
              {payload.actions.map((action, idx) => (
                <button
                  key={idx}
                  onClick={() => window.open(action.url, '_blank')}
                  style={{
                    padding: '4px 12px',
                    borderRadius: '12px',
                    border: `1px solid ${isOwn ? 'rgba(255,255,255,0.5)' : '#1a73a7'}`,
                    backgroundColor: 'transparent',
                    color: isOwn ? '#ffffff' : '#1a73a7',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        );

      default:
        return <p style={styles.messageText}>[Unsupported message type]</p>;
    }
  };

  // -- Render ----------------------------------------------------------------

  const onlineParticipants = conversation?.participants.filter(
    p => p.userId !== userId && p.isOnline
  ) || [];

  const typingNames = Array.from(typingUsers.values()).filter(name => name !== displayName);

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h3 style={styles.headerTitle}>
            {conversation?.subject || 'Messages'}
          </h3>
          <p style={styles.headerSubtitle}>
            {onlineParticipants.length > 0
              ? `${onlineParticipants.map(p => p.displayName).join(', ')} online`
              : 'No one else online'}
          </p>
        </div>
        <div style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: isConnected ? '#4caf50' : '#ff5722',
        }} />
      </div>

      {/* Connection status banner */}
      {!isConnected && (
        <div style={{ ...styles.connectionStatus, backgroundColor: '#fff3cd', color: '#856404' }}>
          Disconnected. Trying to reconnect...
        </div>
      )}

      {/* Message list */}
      <div style={styles.messageList} ref={messageListRef}>
        {messages.map((message) => {
          const isOwn = message.senderId === userId;

          if (message.payload.type === 'system') {
            return (
              <div key={message.id} style={styles.systemMessage}>
                {(message.payload as { text: string }).text}
              </div>
            );
          }

          return (
            <div key={message.id} style={{ display: 'flex', flexDirection: 'column' }}>
              {!isOwn && (
                <div style={{
                  ...styles.senderName,
                  alignSelf: 'flex-start',
                  color: '#666',
                }}>
                  {message.senderName}
                  {message.senderRole === 'provider' && ' (Provider)'}
                </div>
              )}
              <div style={styles.messageBubble(isOwn)}>
                {renderPayload(message.payload, isOwn)}
                <div style={styles.messageTime}>
                  {formatTime(message.sentAt)}
                  {isOwn && message.status === 'sending' && ' ...'}
                  {isOwn && message.status === 'read' && ' ✓✓'}
                </div>
              </div>
            </div>
          );
        })}

        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#999', padding: '40px 0' }}>
            No messages yet. Start the conversation!
          </div>
        )}
      </div>

      {/* Typing indicator */}
      {typingNames.length > 0 && (
        <div style={styles.typingIndicator}>
          {typingNames.join(', ')} {typingNames.length === 1 ? 'is' : 'are'} typing...
        </div>
      )}

      {/* Input area */}
      <div style={styles.inputArea}>
        {/* TODO: Add file upload button here */}
        <textarea
          style={styles.textInput}
          value={inputText}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          disabled={!isConnected}
        />
        <button
          style={{
            ...styles.sendButton,
            opacity: !inputText.trim() || !isConnected ? 0.5 : 1,
          }}
          onClick={sendMessage}
          disabled={!inputText.trim() || !isConnected}
        >
          Send
        </button>
      </div>
    </div>
  );
}

export default ChatWindow;
