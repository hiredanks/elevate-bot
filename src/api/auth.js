import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../core/db.js';

const DISCORD = 'https://discord.com/api/v10';
const MANAGE_GUILD = 0x20n;
const SESSION_MS = 7 * 864e5;
const CACHE_MS = 60_000;
const cache = new Map();

// Only a hash is stored, so a leaked database cannot be used to log in as anyone.
const hashOf = (token) => createHash('sha256').update(token).digest('hex');
const redirectUri = () => `${config.publicUrl}/auth/callback`;

export const authConfigured = () => Boolean(config.clientSecret && config.dashboardUrl);

export function authorizeUrl(clientId, state) {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'identify guilds', state, prompt: 'none' });
  return `https://discord.com/oauth2/authorize?${params}`;
}

async function discordJson(path, accessToken) {
  const res = await fetch(`${DISCORD}${path}`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Discord returned ${res.status} for ${path}`);
  return res.json();
}

/** Trades a login code for the person's identity and server list. The Discord token is not kept. */
export async function exchangeCode(clientId, code) {
  const res = await fetch(`${DISCORD}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Token exchange failed with ${res.status}`);
  const { access_token: accessToken } = await res.json();
  const [user, guilds] = await Promise.all([discordJson('/users/@me', accessToken), discordJson('/users/@me/guilds', accessToken)]);
  return {
    userId: user.id,
    username: user.global_name ?? user.username,
    guilds: guilds
      .filter((g) => g.owner || (BigInt(g.permissions) & MANAGE_GUILD) === MANAGE_GUILD)
      .map((g) => ({ id: g.id, name: g.name, icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null })),
  };
}

export async function createSession({ userId, username, guilds }, lifetimeMs = SESSION_MS) {
  const token = randomBytes(32).toString('base64url');
  await db.run('DELETE FROM web_sessions WHERE expires_at < $1', [Date.now()]);
  await db.run(
    'INSERT INTO web_sessions(token_hash, user_id, username, guilds, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [hashOf(token), userId, username, JSON.stringify(guilds), Date.now() + lifetimeMs],
  );
  return token;
}

export async function findSession(token) {
  const key = hashOf(token);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.checkedAt > now - CACHE_MS && cached.session.expiresAt > now) return cached.session;
  cache.delete(key);
  const row = await db.one('SELECT * FROM web_sessions WHERE token_hash = $1 AND expires_at > $2', [key, now]);
  if (!row) return null;
  const session = { userId: row.user_id, username: row.username, guilds: row.guilds, expiresAt: row.expires_at };
  if (cache.size > 2000) cache.clear();
  cache.set(key, { session, checkedAt: now });
  return session;
}

export async function destroySession(token) {
  const key = hashOf(token);
  cache.delete(key);
  await db.run('DELETE FROM web_sessions WHERE token_hash = $1', [key]);
}
