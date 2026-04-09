import { Pool } from 'pg';
import { Logger } from 'winston';
import { v4 as uuidv4 } from 'uuid';
import {
  startOfWeek,
  endOfWeek,
  addWeeks,
  format,
  parseISO,
  isWithinInterval,
} from 'date-fns';

// TODO: BUG - timezone handling across DST boundaries
// When DST changes happen (spring forward / fall back), the rotation
// times get messed up. A shift that's supposed to end at 9am ET on Monday
// might actually end at 8am or 10am depending on which side of DST we're on.
//
// The root cause is that we store rotation times in UTC but display them
// in ET, and the conversion breaks across DST. We need to either:
// 1. Store times in ET (bad idea, ambiguous during fall-back)
// 2. Use a proper timezone library (date-fns-tz exists but I couldn't
//    get it to work right with the cron schedule)
// 3. Just hardcode an offset and deal with the 1-hour error twice a year
//
// Currently doing option 3. It's been fine because nobody noticed yet,
// and shifts overlap by an hour anyway so the 1-hour error doesn't cause gaps.
// But it will eventually bite us. - Marcus, 2024-11

interface OnCallPerson {
  userId: string;
  name: string;
  email: string;
  slackId: string;
  phone: string;
}

interface ScheduleEntry {
  id: string;
  userId: string;
  name: string;
  weekOf: string;
  startTime: string;
  endTime: string;
}

interface SwapRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  weekOf: string;
  reason: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export class RotationService {
  private pool: Pool;
  private logger: Logger;

  constructor(pool: Pool, logger: Logger) {
    this.pool = pool;
    this.logger = logger;
  }

  async getCurrentOncall(): Promise<OnCallPerson | null> {
    const now = new Date();

    // find who's on call right now
    const result = await this.pool.query(
      `SELECT s.user_id, u.name, u.email, u.slack_id, u.phone
       FROM oncall_schedule s
       JOIN users u ON u.id = s.user_id
       WHERE s.start_time <= $1 AND s.end_time > $1
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [now.toISOString()]
    );

    if (result.rows.length === 0) {
      this.logger.warn('No oncall engineer found for current time');
      return null;
    }

    const row = result.rows[0];
    return {
      userId: row.user_id,
      name: row.name,
      email: row.email,
      slackId: row.slack_id,
      phone: row.phone,
    };
  }

  async getSchedule(weeks: number): Promise<ScheduleEntry[]> {
    const now = new Date();
    // start from the beginning of current week
    const weekStart = startOfWeek(now, { weekStartsOn: 1 }); // Monday
    const end = addWeeks(weekStart, weeks);

    const result = await this.pool.query(
      `SELECT s.id, s.user_id, u.name, s.week_of, s.start_time, s.end_time
       FROM oncall_schedule s
       JOIN users u ON u.id = s.user_id
       WHERE s.start_time >= $1 AND s.start_time < $2
       ORDER BY s.start_time`,
      [weekStart.toISOString(), end.toISOString()]
    );

    return result.rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      weekOf: row.week_of,
      startTime: row.start_time,
      endTime: row.end_time,
    }));
  }

  async rotateWeekly(): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // get the rotation order
      const rotation = await client.query(
        `SELECT id, user_id, position
         FROM oncall_rotation
         WHERE active = true
         ORDER BY position`
      );

      if (rotation.rows.length === 0) {
        this.logger.error('No engineers in oncall rotation!');
        return;
      }

      // find who was on call last
      const lastSchedule = await client.query(
        `SELECT user_id FROM oncall_schedule
         ORDER BY end_time DESC
         LIMIT 1`
      );

      let nextPosition = 0;
      if (lastSchedule.rows.length > 0) {
        const lastUserId = lastSchedule.rows[0].user_id;
        const lastIdx = rotation.rows.findIndex((r: any) => r.user_id === lastUserId);
        nextPosition = (lastIdx + 1) % rotation.rows.length;
      }

      const nextPerson = rotation.rows[nextPosition];
      const now = new Date();
      const weekStart = startOfWeek(addWeeks(now, 0), { weekStartsOn: 1 });
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });

      // HACK: adjust times to be 9am-9am instead of midnight-midnight
      // because our shifts are 9am Monday to 9am next Monday
      // This is where the DST bug lives ^
      const shiftStart = new Date(weekStart);
      shiftStart.setHours(9, 0, 0, 0); // 9am... in server timezone
      const shiftEnd = new Date(addWeeks(weekStart, 1));
      shiftEnd.setHours(9, 0, 0, 0);

      await client.query(
        `INSERT INTO oncall_schedule (id, user_id, week_of, start_time, end_time)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          uuidv4(),
          nextPerson.user_id,
          format(weekStart, 'yyyy-MM-dd'),
          shiftStart.toISOString(),
          shiftEnd.toISOString(),
        ]
      );

      // also pre-schedule the next 3 weeks if they don't exist yet
      for (let i = 1; i <= 3; i++) {
        const futureStart = addWeeks(weekStart, i);
        const existing = await client.query(
          `SELECT id FROM oncall_schedule WHERE week_of = $1`,
          [format(futureStart, 'yyyy-MM-dd')]
        );

        if (existing.rows.length === 0) {
          const futurePosition = (nextPosition + i) % rotation.rows.length;
          const futurePerson = rotation.rows[futurePosition];

          const fStart = new Date(futureStart);
          fStart.setHours(9, 0, 0, 0);
          const fEnd = new Date(addWeeks(futureStart, 1));
          fEnd.setHours(9, 0, 0, 0);

          await client.query(
            `INSERT INTO oncall_schedule (id, user_id, week_of, start_time, end_time)
             VALUES ($1, $2, $3, $4, $5)`,
            [uuidv4(), futurePerson.user_id, format(futureStart, 'yyyy-MM-dd'),
             fStart.toISOString(), fEnd.toISOString()]
          );
        }
      }

      await client.query('COMMIT');
      this.logger.info('Rotation complete', {
        nextPerson: nextPerson.user_id,
        weekOf: format(weekStart, 'yyyy-MM-dd'),
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async requestSwap(
    fromUserId: string,
    toUserId: string,
    weekOf: string,
    reason?: string
  ): Promise<SwapRequest> {
    // verify fromUser is actually scheduled for that week
    const existing = await this.pool.query(
      `SELECT id FROM oncall_schedule WHERE user_id = $1 AND week_of = $2`,
      [fromUserId, weekOf]
    );

    if (existing.rows.length === 0) {
      throw new Error(`User ${fromUserId} is not scheduled for week of ${weekOf}`);
    }

    // verify toUser is in the rotation
    const toUserExists = await this.pool.query(
      `SELECT id FROM oncall_rotation WHERE user_id = $1 AND active = true`,
      [toUserId]
    );

    if (toUserExists.rows.length === 0) {
      throw new Error(`User ${toUserId} is not in the oncall rotation`);
    }

    // check toUser isn't already scheduled that week
    const conflict = await this.pool.query(
      `SELECT id FROM oncall_schedule WHERE user_id = $1 AND week_of = $2`,
      [toUserId, weekOf]
    );

    // TODO: should we allow swaps even if there's a conflict?
    // It means someone would be oncall two weeks in a row which sucks
    // but sometimes people prefer it if they have travel the other week
    if (conflict.rows.length > 0) {
      throw new Error(`User ${toUserId} is already scheduled for week of ${weekOf}`);
    }

    const id = uuidv4();
    await this.pool.query(
      `INSERT INTO oncall_swaps (id, from_user_id, to_user_id, week_of, reason, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [id, fromUserId, toUserId, weekOf, reason || null]
    );

    return {
      id,
      fromUserId,
      toUserId,
      weekOf,
      reason: reason || '',
      status: 'pending',
    };
  }

  async acceptSwap(swapId: string): Promise<{ status: string }> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const swap = await client.query(
        `SELECT * FROM oncall_swaps WHERE id = $1 AND status = 'pending'`,
        [swapId]
      );

      if (swap.rows.length === 0) {
        throw new Error('Swap not found or already processed');
      }

      const { from_user_id, to_user_id, week_of } = swap.rows[0];

      // update the schedule
      await client.query(
        `UPDATE oncall_schedule SET user_id = $1
         WHERE user_id = $2 AND week_of = $3`,
        [to_user_id, from_user_id, week_of]
      );

      // mark swap as accepted
      await client.query(
        `UPDATE oncall_swaps SET status = 'accepted', accepted_at = NOW()
         WHERE id = $1`,
        [swapId]
      );

      await client.query('COMMIT');

      return { status: 'accepted' };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async rejectSwap(swapId: string): Promise<void> {
    await this.pool.query(
      `UPDATE oncall_swaps SET status = 'rejected' WHERE id = $1`,
      [swapId]
    );
  }
}
