import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AnalyticsEventSchema, EventBatchSchema, AnalyticsEvent } from '../models/AnalyticsEvent';
import { processEventBatch } from '../services/eventProcessor';

const router = Router();

const getLogger = () => (global as any).__logger;

/**
 * POST /api/v1/events
 * Single event ingestion
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logger = getLogger();

    // Validate
    const parseResult = AnalyticsEventSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Invalid event',
        details: parseResult.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    const event = parseResult.data;

    // Assign ID if not provided
    if (!event.event_id) {
      event.event_id = uuidv4();
    }

    // Set server timestamp
    if (!event.timestamp) {
      event.timestamp = new Date().toISOString();
    }

    // Enrich with request context
    enrichEventFromRequest(event, req);

    // Process asynchronously - return 202 immediately
    // We don't want slow ClickHouse writes to block the response
    processEventBatch([event]).catch(err => {
      logger.error('Failed to process single event', {
        eventId: event.event_id,
        error: err.message,
      });
    });

    res.status(202).json({
      accepted: true,
      event_id: event.event_id,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/events/batch
 * Batch event ingestion (up to 1000 events per request)
 */
router.post('/batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const logger = getLogger();
    const startTime = Date.now();

    // Validate batch
    const parseResult = EventBatchSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Invalid event batch',
        details: parseResult.error.issues.slice(0, 10).map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
        // Don't return all errors for large batches
        truncated: parseResult.error.issues.length > 10,
      });
    }

    const { events, context } = parseResult.data;

    // Apply shared context
    const enrichedEvents = events.map(event => {
      if (!event.event_id) event.event_id = uuidv4();
      if (!event.timestamp) event.timestamp = new Date().toISOString();

      // Apply batch-level context (event-level overrides context-level)
      if (context) {
        if (!event.user_id && context.user_id) event.user_id = context.user_id;
        if (!event.session_id && context.session_id) event.session_id = context.session_id;
        if (!event.app_name && context.app_name) event.app_name = context.app_name;
        if (!event.app_version && context.app_version) event.app_version = context.app_version;
        if (!event.org_id && context.org_id) event.org_id = context.org_id;
      }

      enrichEventFromRequest(event, req);

      return event;
    });

    // Process asynchronously
    processEventBatch(enrichedEvents).catch(err => {
      logger.error('Failed to process event batch', {
        batchSize: enrichedEvents.length,
        error: err.message,
      });
    });

    const processingTime = Date.now() - startTime;

    // Also forward to Kafka if producer is available
    const kafkaProducer = (global as any).__kafkaProducer;
    if (kafkaProducer) {
      try {
        await kafkaProducer.send({
          topic: 'analytics.events',
          messages: enrichedEvents.map((e: any) => ({
            key: e.user_id || e.anonymous_id || e.event_id,
            value: JSON.stringify(e),
          })),
        });
      } catch (kafkaErr: any) {
        // Don't fail the request if Kafka is down
        logger.warn('Failed to forward events to Kafka', {
          error: kafkaErr.message,
          batchSize: enrichedEvents.length,
        });
      }
    }

    res.status(202).json({
      accepted: true,
      count: enrichedEvents.length,
      processing_ms: processingTime,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/events/identify
 * Associate anonymous_id with user_id (for session stitching)
 * Called when a user logs in
 */
router.post('/identify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, anonymous_id, traits } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    if (!anonymous_id) {
      return res.status(400).json({ error: 'anonymous_id is required' });
    }

    // Create an identify event
    const identifyEvent: AnalyticsEvent = {
      event_id: uuidv4(),
      event_type: 'auth',
      event_name: 'identify',
      timestamp: new Date().toISOString(),
      user_id,
      anonymous_id,
      properties: {
        ...traits,
        _identify: true,
      },
    };

    enrichEventFromRequest(identifyEvent, req);

    await processEventBatch([identifyEvent]);

    // TODO: retroactively update past anonymous events with the user_id
    // This is the "session stitching" part and it's in sessionStitcher.ts
    // but it only works for events still in the buffer. For events already
    // written to ClickHouse, we'd need an UPDATE which is expensive.
    // We currently do this in a nightly batch job instead. (PLAT-7890)

    res.status(202).json({ accepted: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Enrich event with data from the HTTP request
 */
function enrichEventFromRequest(event: AnalyticsEvent, req: Request): void {
  // IP address
  if (!event.ip_address) {
    // x-forwarded-for can be a comma-separated list
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      event.ip_address = forwarded.split(',')[0].trim();
    } else {
      event.ip_address = req.ip || req.socket.remoteAddress;
    }
  }

  // User agent
  if (!event.user_agent) {
    event.user_agent = req.headers['user-agent'];
  }

  // Source
  if (!event.source) {
    event.source = req.headers['x-source-service'] as string || 'http-api';
  }
}

export default router;
