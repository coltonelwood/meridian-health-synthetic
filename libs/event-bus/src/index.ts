/**
 * @meridian/event-bus
 *
 * RabbitMQ-based event bus for asynchronous communication between
 * Meridian Health microservices. Provides publish/subscribe with:
 * - Automatic serialization/deserialization
 * - Dead letter queue handling for failed messages
 * - Retry logic with exponential backoff
 * - Connection recovery
 *
 * Architecture:
 * - Each event type maps to an exchange (topic exchange)
 * - Each consuming service has its own queue bound to the exchange
 * - Failed messages go to a dead letter exchange/queue for investigation
 *
 * IMPORTANT: Event payloads should never contain raw PHI.
 * Use resource IDs (patientId, claimId) and let the consumer
 * fetch the full data from the appropriate service.
 */

import amqplib, { Connection, Channel, ConsumeMessage } from 'amqplib';
import { HIPAALogger } from '@meridian/hipaa-logger';
import { DomainEvent, EventMetadata } from './types';
import { RetryPolicy, defaultRetryPolicy } from './retry';

const logger = new HIPAALogger({ service: 'event-bus' });

// --- Types -------------------------------------------------------------------

export interface EventBusConfig {
  url: string;
  serviceName: string; // Used as consumer tag and queue prefix
  exchangePrefix?: string;
  retryPolicy?: RetryPolicy;
  prefetchCount?: number;
  reconnectDelay?: number;
}

type EventHandler<T = any> = (event: T, metadata: EventMetadata) => Promise<void>;

// --- Event Bus ---------------------------------------------------------------

export class EventBus {
  private connection: Connection | null = null;
  private publishChannel: Channel | null = null;
  private consumeChannel: Channel | null = null;
  private config: EventBusConfig;
  private handlers: Map<string, EventHandler[]> = new Map();
  private isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config?: Partial<EventBusConfig>) {
    this.config = {
      url: config?.url || process.env.EVENT_BUS_URL || 'amqp://localhost:5672',
      serviceName: config?.serviceName || process.env.SERVICE_NAME || 'unknown-service',
      exchangePrefix: config?.exchangePrefix || 'meridian',
      retryPolicy: config?.retryPolicy || defaultRetryPolicy,
      prefetchCount: config?.prefetchCount || 10,
      reconnectDelay: config?.reconnectDelay || 5000,
    };
  }

  /**
   * Connect to RabbitMQ and set up channels.
   */
  async connect(): Promise<void> {
    try {
      this.connection = await amqplib.connect(this.config.url);
      this.publishChannel = await this.connection.createChannel();
      this.consumeChannel = await this.connection.createConfirmChannel();

      // Set prefetch count for flow control
      await this.consumeChannel.prefetch(this.config.prefetchCount!);

      this.isConnected = true;

      // Handle connection errors
      this.connection.on('error', (err) => {
        logger.error('RabbitMQ connection error', {
          action: 'EVENT_BUS_ERROR',
          error: err.message,
        });
        this.handleDisconnect();
      });

      this.connection.on('close', () => {
        logger.warn('RabbitMQ connection closed', {
          action: 'EVENT_BUS_CLOSED',
        });
        this.handleDisconnect();
      });

      logger.info('Event bus connected', {
        action: 'EVENT_BUS_CONNECTED',
        serviceName: this.config.serviceName,
      });
    } catch (error: any) {
      logger.error('Failed to connect to event bus', {
        action: 'EVENT_BUS_CONNECT_FAILED',
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Publish an event to the bus.
   *
   * Events are published to a topic exchange named after the event type.
   * The routing key is the event type itself.
   */
  async publish<T extends DomainEvent>(
    eventType: string,
    payload: T,
    options?: { persistent?: boolean; priority?: number }
  ): Promise<void> {
    if (!this.publishChannel) {
      throw new Error('Event bus not connected. Call connect() first.');
    }

    const exchangeName = `${this.config.exchangePrefix}.events`;

    // Ensure the exchange exists
    await this.publishChannel.assertExchange(exchangeName, 'topic', {
      durable: true,
    });

    const metadata: EventMetadata = {
      eventId: generateEventId(),
      eventType,
      timestamp: new Date().toISOString(),
      source: this.config.serviceName,
      correlationId: (payload as any).correlationId || generateEventId(),
    };

    const message = {
      payload,
      metadata,
    };

    const buffer = Buffer.from(JSON.stringify(message));

    this.publishChannel.publish(exchangeName, eventType, buffer, {
      persistent: options?.persistent !== false, // Persist by default
      contentType: 'application/json',
      messageId: metadata.eventId,
      timestamp: Date.now(),
      headers: {
        'x-event-type': eventType,
        'x-source': this.config.serviceName,
      },
      priority: options?.priority,
    });

    logger.debug('Event published', {
      action: 'EVENT_PUBLISHED',
      eventType,
      eventId: metadata.eventId,
    });
  }

  /**
   * Subscribe to events of a specific type.
   *
   * Each service gets its own queue for each event type, so multiple
   * services can independently consume the same events.
   */
  async subscribe<T extends DomainEvent>(
    eventType: string,
    handler: EventHandler<T>
  ): Promise<void> {
    if (!this.consumeChannel) {
      throw new Error('Event bus not connected. Call connect() first.');
    }

    const exchangeName = `${this.config.exchangePrefix}.events`;
    const queueName = `${this.config.serviceName}.${eventType}`;
    const dlxExchange = `${this.config.exchangePrefix}.dead-letter`;
    const dlqName = `${queueName}.dlq`;

    // Set up dead letter exchange and queue
    await this.consumeChannel.assertExchange(dlxExchange, 'topic', { durable: true });
    await this.consumeChannel.assertQueue(dlqName, {
      durable: true,
      arguments: {
        // DLQ messages expire after 7 days
        'x-message-ttl': 7 * 24 * 60 * 60 * 1000,
      },
    });
    await this.consumeChannel.bindQueue(dlqName, dlxExchange, eventType);

    // Set up the main exchange and queue
    await this.consumeChannel.assertExchange(exchangeName, 'topic', { durable: true });
    await this.consumeChannel.assertQueue(queueName, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': dlxExchange,
        'x-dead-letter-routing-key': eventType,
      },
    });
    await this.consumeChannel.bindQueue(queueName, exchangeName, eventType);

    // Store the handler
    const handlers = this.handlers.get(eventType) || [];
    handlers.push(handler as EventHandler);
    this.handlers.set(eventType, handlers);

    // Start consuming
    await this.consumeChannel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) return;

      try {
        const parsed = JSON.parse(msg.content.toString());
        const { payload, metadata } = parsed;

        logger.debug('Processing event', {
          action: 'EVENT_PROCESSING',
          eventType,
          eventId: metadata?.eventId,
        });

        await handler(payload as T, metadata);

        // Acknowledge successful processing
        this.consumeChannel!.ack(msg);

        logger.debug('Event processed successfully', {
          action: 'EVENT_PROCESSED',
          eventType,
          eventId: metadata?.eventId,
        });
      } catch (error: any) {
        const retryCount = (msg.properties.headers?.['x-retry-count'] || 0) as number;
        const maxRetries = this.config.retryPolicy!.maxRetries;

        if (retryCount < maxRetries) {
          // Requeue with retry count
          logger.warn('Event processing failed, requeueing', {
            action: 'EVENT_RETRY',
            eventType,
            retryCount: retryCount + 1,
            maxRetries,
            error: error.message,
          });

          // Reject and requeue after a delay
          this.consumeChannel!.nack(msg, false, false);

          // Republish with incremented retry count
          // (The delay is handled by the retry module)
          const delay = this.config.retryPolicy!.getDelay(retryCount);
          setTimeout(() => {
            this.publishChannel?.publish(
              exchangeName,
              eventType,
              msg.content,
              {
                ...msg.properties,
                headers: {
                  ...msg.properties.headers,
                  'x-retry-count': retryCount + 1,
                  'x-last-error': error.message,
                },
              }
            );
          }, delay);
        } else {
          // Max retries exceeded - send to DLQ
          logger.error('Event processing failed, sending to DLQ', {
            action: 'EVENT_DLQ',
            eventType,
            retryCount,
            error: error.message,
          });

          this.consumeChannel!.nack(msg, false, false);
        }
      }
    }, {
      consumerTag: `${this.config.serviceName}-${eventType}`,
    });

    logger.info('Subscribed to event', {
      action: 'EVENT_SUBSCRIBED',
      eventType,
      queueName,
    });
  }

  /**
   * Close the connection.
   */
  async close(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.publishChannel) {
      await this.publishChannel.close();
    }
    if (this.consumeChannel) {
      await this.consumeChannel.close();
    }
    if (this.connection) {
      await this.connection.close();
    }

    this.isConnected = false;
    logger.info('Event bus disconnected', { action: 'EVENT_BUS_DISCONNECTED' });
  }

  // --- Private ---------------------------------------------------------------

  private handleDisconnect(): void {
    this.isConnected = false;
    this.publishChannel = null;
    this.consumeChannel = null;

    // Attempt reconnection
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(async () => {
        this.reconnectTimer = null;
        try {
          logger.info('Attempting event bus reconnection', {
            action: 'EVENT_BUS_RECONNECTING',
          });
          await this.connect();

          // Re-subscribe to all previously subscribed events
          for (const [eventType, handlers] of this.handlers) {
            for (const handler of handlers) {
              await this.subscribe(eventType, handler);
            }
          }
        } catch (error: any) {
          logger.error('Event bus reconnection failed', {
            action: 'EVENT_BUS_RECONNECT_FAILED',
            error: error.message,
          });
          this.handleDisconnect(); // Try again
        }
      }, this.config.reconnectDelay);
    }
  }
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

// Re-exports
export * from './types';
export { RetryPolicy, defaultRetryPolicy } from './retry';
