import { db } from './db.js';
import { keyedQueue } from './util.js';

const defaults = {};
const cache = new Map();
const writeQueue = keyedQueue();

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, stored) {
  if (!isPlain(base) || !isPlain(stored)) return stored === undefined ? structuredClone(base) : stored;
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(stored)])) {
    out[key] = key in base ? merge(base[key], stored[key]) : stored[key];
  }
  return out;
}

export function registerDefaults(moduleName, value) {
  defaults[moduleName] = value;
}

/** Called once at boot. Settings then live in memory, so per-message checks never touch the database. */
export async function loadAllSettings() {
  const rows = await db.all('SELECT guild_id, data FROM guild_settings');
  for (const row of rows) cache.set(row.guild_id, merge(defaults, row.data));
  return rows.length;
}

export function getSettings(guildId) {
  let settings = cache.get(guildId);
  if (!settings) {
    settings = merge(defaults, {});
    cache.set(guildId, settings);
  }
  return settings;
}

export async function updateSettings(guildId, mutate) {
  const settings = getSettings(guildId);
  mutate(settings);
  // Queued per server and serialised at write time, so a slow write can never overwrite a newer one.
  await writeQueue(guildId, () => db.run(
    'INSERT INTO guild_settings(guild_id, data) VALUES ($1, $2) ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data',
    [guildId, JSON.stringify(settings)],
  ));
  return settings;
}
