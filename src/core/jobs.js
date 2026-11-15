import { db } from './db.js';
import { logger } from './logger.js';

const handlers = new Map();
const MAX_ATTEMPTS = 5;
const CLAIM_MS = 120_000;
const REFRESH_MS = 60_000;
let running = false;
let timer = null;
// The soonest job we know of. Lets the 3-second loop stay off the database until something is due.
let nextDue = 0;
let nextRefresh = 0;

/** Persistent timers: temp bans, reminders and giveaways all survive a restart or redeploy. */
export const jobs = {
  register(type, handler) {
    handlers.set(type, handler);
  },

  async schedule(type, guildId, runAt, payload = {}, key = null) {
    if (key) await jobs.cancel(type, guildId, key);
    const row = await db.one(
      'INSERT INTO jobs(type, guild_id, run_at, payload, job_key) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [type, guildId, runAt, JSON.stringify(payload), key],
    );
    nextDue = Math.min(nextDue || Infinity, runAt);
    return row.id;
  },

  cancel: (type, guildId, key) => db.run('DELETE FROM jobs WHERE type = $1 AND guild_id = $2 AND job_key = $3', [type, guildId, key]),

  list: (type, guildId, keyPrefix = '') => db.all(
    "SELECT * FROM jobs WHERE type = $1 AND guild_id = $2 AND COALESCE(job_key, '') LIKE $3 ORDER BY run_at",
    [type, guildId, `${keyPrefix}%`],
  ),

  /** Runs everything due. A handler may return { rescheduleAt } to repeat. */
  async tick(client, now = Date.now()) {
    if (running || (nextDue && now < nextDue && now < nextRefresh)) return;
    running = true;
    try {
      // Claiming atomically means a job can never fire twice, even if two instances overlap.
      const due = await db.all(
        `UPDATE jobs SET locked_until = $2 WHERE id IN (
           SELECT id FROM jobs WHERE run_at <= $1 AND locked_until <= $1 ORDER BY run_at LIMIT 100 FOR UPDATE SKIP LOCKED
         ) RETURNING *`,
        [now, now + CLAIM_MS],
      );
      for (const job of due) {
        try {
          const result = await handlers.get(job.type)?.(client, job.payload, job);
          if (result?.rescheduleAt) await db.run('UPDATE jobs SET run_at = $1, attempts = 0, locked_until = 0 WHERE id = $2', [result.rescheduleAt, job.id]);
          else await db.run('DELETE FROM jobs WHERE id = $1', [job.id]);
        } catch (err) {
          logger.error(`Job ${job.type}#${job.id} failed`, err);
          if (job.attempts + 1 >= MAX_ATTEMPTS) await db.run('DELETE FROM jobs WHERE id = $1', [job.id]);
          else await db.run('UPDATE jobs SET attempts = attempts + 1, run_at = $1, locked_until = 0 WHERE id = $2', [now + 60_000 * (job.attempts + 1), job.id]);
        }
      }
      const soonest = await db.one('SELECT MIN(run_at) AS next FROM jobs');
      nextDue = soonest.next ?? Infinity;
      nextRefresh = now + REFRESH_MS;
    } finally {
      running = false;
    }
  },

  start(client) {
    timer = setInterval(() => jobs.tick(client).catch((err) => logger.error('Job tick failed', err)), 3000);
    timer.unref?.();
  },

  stop() {
    clearInterval(timer);
  },
};
