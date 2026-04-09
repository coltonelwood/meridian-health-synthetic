import { WebClient } from '@slack/web-api';
import { Logger } from 'winston';

/**
 * Slack notification service.
 *
 * Has basic rate limiting to avoid hitting Slack's API limits.
 * Slack allows ~1 message per second per channel, but we occasionally
 * burst during incidents so we queue messages and drain them with a delay.
 *
 * Known issue: if the process crashes while messages are queued, they're lost.
 * This hasn't been a problem in practice because crash = restart = new incident
 * notifications anyway.
 */
export class SlackNotifier {
  private client: WebClient;
  private channel: string;
  private logger: Logger;
  private messageQueue: { text: string; channel?: string; resolve: Function; reject: Function }[] = [];
  private isProcessing = false;

  // Rate limit: minimum ms between messages
  private readonly RATE_LIMIT_MS = 1200; // slightly more than 1 per second to be safe
  private lastMessageTime = 0;

  constructor(token: string, channel: string, logger: Logger) {
    this.client = new WebClient(token);
    this.channel = channel;
    this.logger = logger;
  }

  /**
   * Post a message to the oncall channel.
   */
  async postMessage(text: string, channel?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({
        text,
        channel: channel || this.channel,
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  /**
   * Post a DM to a specific user.
   */
  async sendDM(userId: string, text: string): Promise<void> {
    try {
      // open DM channel first
      const result = await this.client.conversations.open({
        users: userId,
      });

      if (result.channel?.id) {
        await this.postMessage(text, result.channel.id);
      }
    } catch (err) {
      this.logger.error('Failed to send Slack DM', { userId, error: err });
      // don't throw - DM failures shouldn't break the calling code
    }
  }

  /**
   * Post the weekly rotation update.
   */
  async postRotationUpdate(): Promise<void> {
    // this is called from the cron job after rotation
    // we format a nice message about who's on call this week
    // TODO: include the full schedule for the next 4 weeks
    await this.postMessage(
      `:calendar: *Oncall Rotation Update*\n` +
      `The oncall schedule has been updated. Use \`/oncall schedule\` to see the full schedule.`
    );
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;

      // rate limiting
      const now = Date.now();
      const timeSinceLastMessage = now - this.lastMessageTime;
      if (timeSinceLastMessage < this.RATE_LIMIT_MS) {
        await this.sleep(this.RATE_LIMIT_MS - timeSinceLastMessage);
      }

      try {
        await this.client.chat.postMessage({
          channel: msg.channel || this.channel,
          text: msg.text,
          // use mrkdwn formatting
          mrkdwn: true,
          // don't unfurl links - we post a lot of internal URLs
          unfurl_links: false,
          unfurl_media: false,
        });
        this.lastMessageTime = Date.now();
        msg.resolve();
      } catch (err: any) {
        this.logger.error('Failed to post Slack message', {
          error: err.message,
          channel: msg.channel,
        });

        // if rate limited, back off and retry
        if (err.data?.error === 'ratelimited') {
          const retryAfter = parseInt(err.data.response_headers?.['retry-after'] || '30');
          this.logger.warn(`Slack rate limited, retrying after ${retryAfter}s`);
          await this.sleep(retryAfter * 1000);
          // put the message back at the front of the queue
          this.messageQueue.unshift(msg);
        } else if (err.data?.error === 'channel_not_found') {
          this.logger.error('Slack channel not found, skipping message', {
            channel: msg.channel,
          });
          msg.reject(err);
        } else {
          // for other errors, just fail the message
          // TODO: should we retry on network errors? Currently we don't.
          msg.reject(err);
        }
      }
    }

    this.isProcessing = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
