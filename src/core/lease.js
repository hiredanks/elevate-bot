import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { db } from './db.js';
import { logger } from './logger.js';
import { sleep } from './util.js';

const OWNER = randomUUID();
const TTL_MS = 90_000;
const HEARTBEAT_MS = 30_000;

/** The first part of a bot token is the bot's ID, so two different bots never wait on each other. */
function botId() {
  try {
    return Buffer.from(String(config.token).split('.')[0], 'base64').toString('utf8');
  } catch {
    return 'bot';
  }
}
const LEASE_KEY = `gateway_lease:${botId()}`;
let heartbeat = null;

async function tryAcquire() {
  const now = Date.now();
  const value = JSON.stringify({ owner: OWNER, until: now + TTL_MS });
  const row = await db.one(
    `INSERT INTO meta(key_name, value) VALUES ($1, $2)
     ON CONFLICT (key_name) DO UPDATE SET value = excluded.value
     WHERE (meta.value::jsonb->>'until')::bigint < $3 OR meta.value::jsonb->>'owner' = $4
     RETURNING value`,
    [LEASE_KEY, value, now, OWNER],
  );
  return row !== null;
}

/**
 * Render starts the new instance before stopping the old one. Only the lease holder connects to
 * Discord, so a deploy never runs two bots at once (no double welcomes, XP or giveaway picks).
 */
export async function acquireLease() {
  let announced = false;
  while (!(await tryAcquire())) {
    if (!announced) logger.info('Another instance is running. Waiting for it to stop...');
    announced = true;
    await sleep(2000);
  }
  heartbeat = setInterval(() => tryAcquire().catch((err) => logger.warn('Lease heartbeat failed:', err.message)), HEARTBEAT_MS);
  heartbeat.unref?.();
}

export async function releaseLease() {
  clearInterval(heartbeat);
  await db.run("DELETE FROM meta WHERE key_name = $1 AND value::jsonb->>'owner' = $2", [LEASE_KEY, OWNER]);
}
