import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';
import { logger } from './logger.js';

const INT8_OID = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key_name TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS guild_settings (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS counters (guild_id TEXT NOT NULL, name TEXT NOT NULL, value BIGINT NOT NULL, PRIMARY KEY (guild_id, name));

CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY, type TEXT NOT NULL, guild_id TEXT, run_at BIGINT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}', job_key TEXT, attempts INT NOT NULL DEFAULT 0, locked_until BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(run_at);
CREATE INDEX IF NOT EXISTS jobs_key ON jobs(type, guild_id, job_key);

CREATE TABLE IF NOT EXISTS cases (
  guild_id TEXT NOT NULL, case_id BIGINT NOT NULL, type TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT,
  mod_id TEXT NOT NULL, reason TEXT, duration BIGINT, created_at BIGINT NOT NULL, active BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (guild_id, case_id)
);
CREATE INDEX IF NOT EXISTS cases_user ON cases(guild_id, user_id);

CREATE TABLE IF NOT EXISTS members (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT,
  xp BIGINT NOT NULL DEFAULT 0, voice_xp BIGINT NOT NULL DEFAULT 0, voice_minutes BIGINT NOT NULL DEFAULT 0,
  credits BIGINT NOT NULL DEFAULT 0, last_daily BIGINT NOT NULL DEFAULT 0, streak INT NOT NULL DEFAULT 0,
  last_work BIGINT NOT NULL DEFAULT 0, rep INT NOT NULL DEFAULT 0, last_rep BIGINT NOT NULL DEFAULT 0, bio TEXT,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_xp ON members(guild_id, xp DESC);
CREATE INDEX IF NOT EXISTS members_credits ON members(guild_id, credits DESC);

CREATE TABLE IF NOT EXISTS shop_items (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, role_id TEXT NOT NULL, price BIGINT NOT NULL, UNIQUE (guild_id, role_id)
);
CREATE TABLE IF NOT EXISTS sticky_roles (guild_id TEXT, user_id TEXT, role_ids JSONB NOT NULL, PRIMARY KEY (guild_id, user_id));

CREATE TABLE IF NOT EXISTS reaction_roles (
  guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL,
  emoji_display TEXT NOT NULL, role_id TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'normal', PRIMARY KEY (message_id, emoji)
);
CREATE TABLE IF NOT EXISTS role_panels (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, title TEXT NOT NULL,
  description TEXT, style TEXT NOT NULL DEFAULT 'buttons', mode TEXT NOT NULL DEFAULT 'multi', roles JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS tags (
  guild_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL, owner_id TEXT NOT NULL,
  uses INT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, PRIMARY KEY (guild_id, name)
);
CREATE TABLE IF NOT EXISTS custom_commands (
  guild_id TEXT NOT NULL, name TEXT NOT NULL, response TEXT NOT NULL, delete_trigger BOOLEAN NOT NULL DEFAULT FALSE,
  role_id TEXT, PRIMARY KEY (guild_id, name)
);
CREATE TABLE IF NOT EXISTS autoresponders (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, trigger_text TEXT NOT NULL, response TEXT NOT NULL, match_type TEXT NOT NULL DEFAULT 'contains'
);

CREATE TABLE IF NOT EXISTS starboard (message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, star_message_id TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS giveaways (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, host_id TEXT NOT NULL,
  prize TEXT NOT NULL, description TEXT, winners INT NOT NULL DEFAULT 1, ends_at BIGINT, ended BOOLEAN NOT NULL DEFAULT FALSE,
  drop_mode BOOLEAN NOT NULL DEFAULT FALSE, requirements JSONB NOT NULL DEFAULT '{}', winner_ids JSONB NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id BIGINT NOT NULL, user_id TEXT NOT NULL, weight INT NOT NULL DEFAULT 1, PRIMARY KEY (giveaway_id, user_id)
);

CREATE TABLE IF NOT EXISTS stats_daily (
  guild_id TEXT NOT NULL, day TEXT NOT NULL, joins INT NOT NULL DEFAULT 0, leaves INT NOT NULL DEFAULT 0,
  messages INT NOT NULL DEFAULT 0, voice_minutes INT NOT NULL DEFAULT 0, member_count INT, PRIMARY KEY (guild_id, day)
);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, number BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, subject TEXT, created_at BIGINT NOT NULL, closed_at BIGINT
);
CREATE INDEX IF NOT EXISTS tickets_channel ON tickets(channel_id);

CREATE TABLE IF NOT EXISTS suggestions (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, user_id TEXT NOT NULL,
  content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestion_votes (
  suggestion_id BIGINT NOT NULL, user_id TEXT NOT NULL, vote INT NOT NULL, PRIMARY KEY (suggestion_id, user_id)
);

CREATE TABLE IF NOT EXISTS invite_log (
  guild_id TEXT NOT NULL, user_id TEXT NOT NULL, inviter_id TEXT, code TEXT, joined_at BIGINT NOT NULL,
  fake BOOLEAN NOT NULL DEFAULT FALSE, left_at BIGINT, PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS invite_inviter ON invite_log(guild_id, inviter_id);

CREATE TABLE IF NOT EXISTS afk (guild_id TEXT, user_id TEXT, reason TEXT, since BIGINT, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS stickies (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, content TEXT NOT NULL, last_message_id TEXT);
CREATE TABLE IF NOT EXISTS birthdays (guild_id TEXT, user_id TEXT, month INT, day INT, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS temp_voice (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS guild_images (guild_id TEXT NOT NULL, slot TEXT NOT NULL, image BYTEA NOT NULL, type TEXT NOT NULL, PRIMARY KEY (guild_id, slot));
CREATE TABLE IF NOT EXISTS broadcasts (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', sent INT NOT NULL DEFAULT 0, failed INT NOT NULL DEFAULT 0, total INT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS broadcast_recipients (broadcast_id BIGINT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (broadcast_id, user_id));
CREATE TABLE IF NOT EXISTS broadcast_subscribers (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS webhook_messages (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, webhook_id TEXT NOT NULL,
  username TEXT, content TEXT, author_id TEXT NOT NULL, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS radio_stations (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stream_alerts (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, platform TEXT NOT NULL, account TEXT NOT NULL, platform_id TEXT NOT NULL,
  display_name TEXT, avatar_url TEXT, channel_id TEXT NOT NULL, message TEXT, ping TEXT NOT NULL DEFAULT 'everyone',
  image TEXT NOT NULL DEFAULT 'avatar', live BOOLEAN NOT NULL DEFAULT FALSE, last_stream_id TEXT
);
CREATE INDEX IF NOT EXISTS stream_alerts_platform ON stream_alerts(platform);
ALTER TABLE stream_alerts ADD COLUMN IF NOT EXISTS picture_url TEXT;
ALTER TABLE stream_alerts ADD COLUMN IF NOT EXISTS manual_at BIGINT;
CREATE TABLE IF NOT EXISTS epic_links (
  user_id TEXT PRIMARY KEY, epic_id TEXT, epic_name TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE, linked_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS epic_links_epic_id ON epic_links(epic_id);
CREATE TABLE IF NOT EXISTS epic_link_states (
  state TEXT PRIMARY KEY, user_id TEXT NOT NULL, guild_id TEXT NOT NULL, expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS scrims (
  id BIGSERIAL PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, host_id TEXT NOT NULL, title TEXT NOT NULL,
  mode TEXT NOT NULL, build TEXT NOT NULL, region TEXT NOT NULL, key_code TEXT NOT NULL, max_players INT NOT NULL, starts_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', game INT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS scrim_players (
  scrim_id BIGINT NOT NULL, user_id TEXT NOT NULL, epic_name TEXT, joined_at BIGINT NOT NULL, key_game INT NOT NULL DEFAULT 0,
  PRIMARY KEY (scrim_id, user_id)
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT, guilds JSONB NOT NULL DEFAULT '[]', expires_at BIGINT NOT NULL
);
`;

/** Hosted databases need TLS, but a same-network or local address has none to offer. */
function tlsOption() {
  const url = new URL(config.databaseUrl);
  const isLocal = ['localhost', '127.0.0.1'].includes(url.hostname) || !url.hostname.includes('.');
  // An explicit ?sslmode= in the address always wins. Otherwise encrypt without pinning the
  // provider's certificate, because Supabase's chain is not in Node's trust store.
  return isLocal || url.searchParams.has('sslmode') ? undefined : { rejectUnauthorized: false };
}

/** Turns a failed first connection into a plain instruction. Only the host is ever shown, never the password. */
export function explainDatabaseError(err, databaseUrl) {
  let host;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return 'DATABASE_URL is not a valid address. In Supabase press Connect, choose "Session pooler", and copy that address again.';
  }
  if (/^db\.[a-z0-9]+\.supabase\.co$/i.test(host)) {
    return `DATABASE_URL uses Supabase's "Direct connection" (${host}). It only works over IPv6, which Render cannot use. In Supabase press Connect, choose "Session pooler", and paste that address on Render instead. Its host ends in pooler.supabase.com.`;
  }
  const detail = `${err.code ?? ''} ${err.message ?? ''}`;
  if (err.code === '28P01' || /password authentication failed/i.test(detail)) {
    return 'The password in DATABASE_URL is wrong. In Supabase, reset it under Project Settings > Database, then paste the new address on Render.';
  }
  if (/tenant or user not found/i.test(detail)) {
    return 'Supabase did not recognise the user in DATABASE_URL. Copy the "Session pooler" address again: its user looks like postgres.abcdefghijkl, not just postgres.';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(detail)) return `The database host ${host} does not exist. Copy DATABASE_URL again from Supabase.`;
  if (/timeout|ETIMEDOUT|ENETUNREACH|ECONNREFUSED|EHOSTUNREACH/i.test(detail)) {
    return `Could not reach the database at ${host}. Check DATABASE_URL on Render, and that the Supabase project is not paused.`;
  }
  return `The database refused to connect: ${err.message}`;
}

function pgDriver() {
  pg.types.setTypeParser(INT8_OID, Number);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl, ssl: tlsOption(), max: Number(process.env.PG_POOL_MAX) || 8, idleTimeoutMillis: 30_000,
    // Fail in seconds with a clear message instead of hanging until Render gives up.
    connectionTimeoutMillis: 20_000,
  });
  // Hosted Postgres closes idle connections; without this listener that would crash the process.
  pool.on('error', (err) => logger.warn('Postgres idle connection error:', err.message));
  const wrap = (runner) => async (sql, params = []) => {
    const res = await runner.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? 0 };
  };
  return {
    query: wrap(pool),
    script: (sql) => pool.query(sql),
    close: () => pool.end(),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/** Embedded Postgres for running on your own PC and for the test suite. */
async function liteDriver() {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const memory = config.dataDir === ':memory:';
  if (!memory) fs.mkdirSync(path.resolve(config.dataDir), { recursive: true });
  const lite = new PGlite(memory ? undefined : path.resolve(config.dataDir, 'pg'), { parsers: { [types.INT8]: Number } });
  await lite.waitReady;
  const wrap = (runner) => async (sql, params = []) => {
    const res = await runner.query(sql, params);
    return { rows: res.rows, rowCount: res.affectedRows || res.rows.length };
  };
  return {
    query: wrap(lite),
    script: (sql) => lite.exec(sql),
    close: () => lite.close(),
    transaction: (fn) => lite.transaction((tx) => fn(wrap(tx))),
  };
}

let driver = null;

export async function connectDatabase() {
  if (driver) return;
  if (!config.databaseUrl && config.onRender) {
    throw new Error('DATABASE_URL is not set. Render erases local files on every deploy, so a hosted Postgres database is required.');
  }
  if (!config.databaseUrl) {
    driver = await liteDriver();
    await driver.script(SCHEMA);
    return;
  }
  let host = 'an invalid address';
  try {
    host = new URL(config.databaseUrl).hostname;
  } catch { /* explained below */ }
  logger.info(`Connecting to the database at ${host}...`);
  driver = pgDriver();
  try {
    await driver.script(SCHEMA);
  } catch (err) {
    await driver.close().catch(() => {});
    driver = null;
    throw new Error(explainDatabaseError(err, config.databaseUrl));
  }
}

export async function closeDatabase() {
  await driver?.close();
  driver = null;
}

const helpers = (query) => ({
  all: async (sql, params) => (await query(sql, params)).rows,
  one: async (sql, params) => (await query(sql, params)).rows[0] ?? null,
  run: async (sql, params) => (await query(sql, params)).rowCount,
});

export const db = {
  ...helpers((sql, params) => driver.query(sql, params)),
  tx: (fn) => driver.transaction((query) => fn(helpers(query))),
};

export const getMeta = async (key) => (await db.one('SELECT value FROM meta WHERE key_name = $1', [key]))?.value ?? null;
export const setMeta = (key, value) =>
  db.run('INSERT INTO meta(key_name, value) VALUES ($1, $2) ON CONFLICT(key_name) DO UPDATE SET value = excluded.value', [key, value]);

/** Atomic per-server sequence, used for case and ticket numbers. */
export async function nextCounter(guildId, name) {
  const row = await db.one(
    `INSERT INTO counters(guild_id, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (guild_id, name) DO UPDATE SET value = counters.value + 1 RETURNING value`,
    [guildId, name],
  );
  return row.value;
}
