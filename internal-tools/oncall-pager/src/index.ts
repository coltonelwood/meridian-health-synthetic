import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { Pool } from 'pg';
import { createLogger, transports, format } from 'winston';
import { oncallRouter } from './routes/oncall';
import { RotationService } from './services/rotationService';
import { EscalationService } from './services/escalationService';
import { SlackNotifier } from './services/slackNotifier';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.json()
  ),
  transports: [
    new transports.Console(),
    // TODO: add file transport for production
    // new transports.File({ filename: 'oncall.log' }),
  ],
});

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'meridian_oncall',
  user: process.env.DB_USER || 'oncall_svc',
  password: process.env.DB_PASSWORD,
  max: 10,
});

const slackNotifier = new SlackNotifier(
  process.env.SLACK_BOT_TOKEN || '',
  process.env.SLACK_ONCALL_CHANNEL || '#oncall',
  logger
);

const rotationService = new RotationService(pool, logger);
const escalationService = new EscalationService(pool, slackNotifier, logger);

const app = express();
app.use(cors());
app.use(express.json());

// health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.9.2' });
});

// oncall routes
app.use('/api/oncall', oncallRouter(pool, rotationService, escalationService, slackNotifier));

// --- Cron jobs ---

// Rotate oncall every Monday at 9am ET
// BUG: this uses server timezone, not ET specifically. Works because
// our servers are in us-east-1 but would break if we ever move regions.
// See rotationService for more timezone issues.
cron.schedule('0 9 * * 1', async () => {
  logger.info('Running weekly oncall rotation');
  try {
    await rotationService.rotateWeekly();
    await slackNotifier.postRotationUpdate();
  } catch (err) {
    logger.error('Rotation cron failed', { error: err });
    // TODO: alert someone that the rotation failed
    // but who do we alert if the alerting system is what failed? lol
  }
});

// Check for stale incidents every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  try {
    const staleIncidents = await escalationService.checkStaleIncidents();
    for (const incident of staleIncidents) {
      logger.warn('Escalating stale incident', { incidentId: incident.id });
      await escalationService.escalate(incident.id);
    }
  } catch (err) {
    logger.error('Stale incident check failed', { error: err });
  }
});

// Post daily standup reminder at 8:55am
cron.schedule('55 8 * * 1-5', async () => {
  try {
    const currentOncall = await rotationService.getCurrentOncall();
    if (currentOncall) {
      await slackNotifier.postMessage(
        `Good morning! Today's oncall: <@${currentOncall.slackId}>. ` +
        `Don't forget to post your handoff notes if your shift is ending.`
      );
    }
  } catch (err) {
    logger.error('Standup reminder failed', { error: err });
  }
});

const PORT = parseInt(process.env.PORT || '3002');
app.listen(PORT, () => {
  logger.info(`Oncall pager service running on port ${PORT}`);
});

export { app };
