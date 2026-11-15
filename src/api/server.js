import http from 'node:http';
import { EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { config } from '../config.js';
import { db } from '../core/db.js';
import { filledSlots, getImage, IMAGE_SLOTS, removeImage, saveImage } from '../core/images.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { COLOR, isDangerousRole, sendTo } from '../core/ui.js';
import { epicCallback } from '../modules/epic.js';
import { leaderboard, levelFromXp } from '../modules/leveling.js';
import { dailyStats } from '../modules/stats.js';
import { authConfigured, authorizeUrl, createSession, destroySession, exchangeCode, findSession } from './auth.js';
import { getPath, HttpError, setPath, validateField } from './validate.js';

const MAX_BODY = 256 * 1024;
// A 5 MB picture is about 6.7 MB once base64 encoded.
const MAX_IMAGE_BODY = 7 * 1024 * 1024;
const PAGE_SIZE = 25;
const STATE_RE = /^[\w-]{16,128}$/;
const TOKEN_RE = /^Bearer ([\w-]{20,200})$/;

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(json);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

/** Lets only your website's address read responses from the browser. */
function applyCors(req, res) {
  if (!config.dashboardUrl || req.headers.origin !== new URL(config.dashboardUrl).origin) return;
  res.setHeader('access-control-allow-origin', req.headers.origin);
  res.setHeader('vary', 'origin');
}

export function createApi(client, modules) {
  const forms = modules.filter((m) => m.form).map((m) => ({ module: m.name, ...m.form }));
  const collections = new Map(modules.flatMap((m) => Object.entries(m.collections ?? {})));
  const moduleByName = new Map(modules.map((m) => [m.name, m]));

  const inviteUrl = (guildId) => `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands${guildId ? `&guild_id=${guildId}&disable_guild_select=true` : ''}`;

  async function sessionOf(req) {
    if (req.session) return req.session;
    if (!authConfigured()) throw new HttpError(503, 'Website login is not set up on the bot yet.');
    const token = (req.headers.authorization ?? '').match(TOKEN_RE)?.[1];
    const session = token ? await findSession(token) : null;
    if (!session) throw new HttpError(401, 'Your login expired. Log in again.');
    req.session = { ...session, token };
    return req.session;
  }

  /** Logging in proves who someone is; the bot decides live what they may do in each server. */
  async function access(req, guildId) {
    const { userId } = await sessionOf(req);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new HttpError(404, 'The bot is not in that server.');
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member?.permissions.has(P.ManageGuild)) throw new HttpError(403, 'You need Manage Server in that server.');
    const canSecurity = userId === guild.ownerId || getSettings(guild.id).antinuke.trusted.includes(userId);
    return { guild, member, userId, canSecurity };
  }

  function requireForm(moduleName, ctx) {
    const form = forms.find((f) => f.module === moduleName);
    if (!form) throw new HttpError(404, 'Unknown module.');
    if (form.ownerOnly && !ctx.canSecurity) throw new HttpError(403, 'Only the server owner or trusted users can change this.');
    return form;
  }

  function requireCollection(name, ctx) {
    const collection = collections.get(name);
    if (!collection) throw new HttpError(404, 'Unknown collection.');
    if (collection.ownerOnly && !ctx.canSecurity) throw new HttpError(403, 'Only the server owner or trusted users can use this.');
    return collection;
  }

  const requireSlot = (slot) => {
    if (!(slot in IMAGE_SLOTS)) throw new HttpError(404, 'Unknown picture slot.');
    return slot;
  };

  function audit(ctx, description) {
    const { server } = getSettings(ctx.guild.id).logging.channels;
    return sendTo(ctx.guild, server, {
      embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle('Dashboard change').setDescription(`<@${ctx.userId}> ${description}`).setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  function formValues(form, guildId) {
    const settings = getSettings(guildId)[form.module];
    return Object.fromEntries(form.fields.map((f) => [f.key, getPath(settings, f.key)]));
  }

  const nameOf = (guild, userId) => guild.members.cache.get(userId)?.displayName ?? userId;

  function guildSummary(guild) {
    return { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }), memberCount: guild.memberCount };
  }

  async function overview(ctx) {
    const { guild } = ctx;
    const me = guild.members.me;
    const [stats, caseCount] = await Promise.all([
      dailyStats(guild.id, 30),
      db.one('SELECT COUNT(*) AS n FROM cases WHERE guild_id = $1', [guild.id]),
    ]);
    return {
      guild: { ...guildSummary(guild), ownerId: guild.ownerId, boosts: guild.premiumSubscriptionCount ?? 0 },
      canSecurity: ctx.canSecurity,
      botRoleHighest: me.roles.highest.position === Math.max(...guild.roles.cache.map((r) => r.position)),
      channels: [...guild.channels.cache.values()].sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId })),
      roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position).map((r) => ({
        id: r.id, name: r.name, color: r.hexColor, managed: r.managed, dangerous: isDangerousRole(r), belowBot: r.position < me.roles.highest.position,
      })),
      stats,
      caseCount: caseCount.n,
      enabled: Object.fromEntries(forms.filter((f) => f.fields.some((x) => x.key === 'enabled')).map((f) => [f.module, getSettings(guild.id)[f.module].enabled])),
    };
  }

  const routes = [
    ['GET', /^\/api\/schema$/, () => ({
      forms,
      collections: [...collections].map(([name, c]) => ({
        name, title: c.title, description: c.description, columns: c.columns, idKey: c.idKey ?? 'id', canCreate: Boolean(c.create),
        ownerOnly: Boolean(c.ownerOnly), submitLabel: c.submitLabel, confirmLabel: c.confirmLabel, removeLabel: c.removeLabel,
      })),
    })],

    // The server list comes from the Discord login; the bot checks live which ones can be managed.
    ['GET', /^\/api\/me$/, async (req) => {
      const session = await sessionOf(req);
      const managed = [];
      const others = [];
      for (const entry of session.guilds) {
        const guild = client.guilds.cache.get(entry.id);
        if (!guild) {
          others.push({ ...entry, inviteUrl: inviteUrl(entry.id) });
          continue;
        }
        const member = await guild.members.fetch(session.userId).catch(() => null);
        if (member?.permissions.has(P.ManageGuild)) managed.push(guildSummary(guild));
      }
      return { user: { id: session.userId, username: session.username }, managed, others };
    }],

    ['GET', /^\/api\/guilds\/(\d+)$/, async (req, [guildId]) => overview(await access(req, guildId))],

    ['GET', /^\/api\/guilds\/(\d+)\/settings\/(\w+)$/, async (req, [guildId, moduleName]) => {
      const ctx = await access(req, guildId);
      const form = requireForm(moduleName, ctx);
      return { values: formValues(form, guildId) };
    }],

    ['PATCH', /^\/api\/guilds\/(\d+)\/settings\/(\w+)$/, async (req, [guildId, moduleName]) => {
      const ctx = await access(req, guildId);
      const form = requireForm(moduleName, ctx);
      const { values } = await readBody(req);
      if (values === null || typeof values !== 'object') throw new HttpError(400, 'Missing values.');
      const current = getSettings(guildId)[moduleName];
      const clean = [];
      // Only known keys are read, so a request can never touch internal state such as lockState.
      for (const field of form.fields) {
        if (!(field.key in values)) continue;
        // Unchanged values skip validation: editing one field must not fail on an old role choice.
        if (JSON.stringify(values[field.key]) === JSON.stringify(getPath(current, field.key))) continue;
        clean.push([field.key, validateField(field, values[field.key], ctx)]);
      }
      if (clean.length) {
        await updateSettings(guildId, (s) => { for (const [key, value] of clean) setPath(s[moduleName], key, value); });
        await audit(ctx, `updated **${form.title}** settings.`);
        moduleByName.get(moduleName)?.onSave?.(ctx.guild, clean.map(([key]) => key));
      }
      return { values: formValues(form, guildId) };
    }],

    ['POST', /^\/api\/guilds\/(\d+)\/actions\/(\w+)\/(\w+)$/, async (req, [guildId, moduleName, actionId]) => {
      const ctx = await access(req, guildId);
      requireForm(moduleName, ctx);
      const action = moduleByName.get(moduleName)?.actions?.[actionId];
      if (!action) throw new HttpError(404, 'Unknown action.');
      try {
        const message = await action(ctx.guild, ctx.member);
        await audit(ctx, `ran **${actionId}** on ${moduleName}.`);
        return { message };
      } catch (err) {
        if (err.code === 50013 || err.code === 50001) throw new HttpError(400, 'Discord refused: the bot lacks permission there.');
        if (err.code) throw err;
        throw new HttpError(400, err.message);
      }
    }],

    ['GET', /^\/api\/guilds\/(\d+)\/collections\/(\w+)$/, async (req, [guildId, name]) => {
      const ctx = await access(req, guildId);
      return { rows: await requireCollection(name, ctx).list(guildId, ctx.guild) };
    }],

    ['POST', /^\/api\/guilds\/(\d+)\/collections\/(\w+)$/, async (req, [guildId, name]) => {
      const ctx = await access(req, guildId);
      const collection = requireCollection(name, ctx);
      if (!collection.create) throw new HttpError(405, 'Entries cannot be added here.');
      const { row } = await readBody(req);
      if (row === null || typeof row !== 'object') throw new HttpError(400, 'Missing row.');
      const clean = {};
      for (const column of collection.columns) {
        if (column.readOnly) continue;
        const value = row[column.key];
        if (value === undefined || value === '') {
          if (column.required) throw new HttpError(400, `${column.label} is required.`);
          continue;
        }
        clean[column.key] = validateField(column, value, ctx);
      }
      try {
        await collection.create(ctx.guild, clean, ctx.userId);
      } catch (err) {
        if (err.code) throw err;
        throw new HttpError(400, err.message);
      }
      await audit(ctx, `added an entry to **${collection.title}**.`);
      return { rows: await collection.list(guildId, ctx.guild) };
    }],

    ['DELETE', /^\/api\/guilds\/(\d+)\/collections\/(\w+)\/([^/]+)$/, async (req, [guildId, name, id]) => {
      const ctx = await access(req, guildId);
      const collection = requireCollection(name, ctx);
      await collection.remove(ctx.guild, decodeURIComponent(id));
      await audit(ctx, `removed an entry from **${collection.title}**.`);
      return { rows: await collection.list(guildId, ctx.guild) };
    }],

    ['GET', /^\/api\/guilds\/(\d+)\/images$/, async (req, [guildId]) => {
      await access(req, guildId);
      const filled = await filledSlots(guildId);
      return { slots: Object.entries(IMAGE_SLOTS).map(([id, label]) => ({ id, label, hasImage: filled.has(id) })) };
    }],

    ['GET', /^\/api\/guilds\/(\d+)\/images\/(\w+)$/, async (req, [guildId, slot]) => {
      await access(req, guildId);
      const image = await getImage(guildId, requireSlot(slot));
      if (!image) throw new HttpError(404, 'No picture there yet.');
      return { dataUrl: `data:${image.mime};base64,${image.data.toString('base64')}` };
    }],

    ['POST', /^\/api\/guilds\/(\d+)\/images\/(\w+)$/, async (req, [guildId, slot]) => {
      const ctx = await access(req, guildId);
      requireSlot(slot);
      const { data } = await readBody(req, MAX_IMAGE_BODY);
      if (typeof data !== 'string') throw new HttpError(400, 'Missing picture.');
      const problem = await saveImage(guildId, slot, Buffer.from(data, 'base64'));
      if (problem) throw new HttpError(400, problem);
      await audit(ctx, `changed the **${IMAGE_SLOTS[slot]}** picture.`);
      return { ok: true };
    }],

    ['DELETE', /^\/api\/guilds\/(\d+)\/images\/(\w+)$/, async (req, [guildId, slot]) => {
      const ctx = await access(req, guildId);
      await removeImage(guildId, requireSlot(slot));
      await audit(ctx, `removed the **${IMAGE_SLOTS[slot]}** picture.`);
      return { ok: true };
    }],

    ['GET', /^\/api\/guilds\/(\d+)\/cases$/, async (req, [guildId], url) => {
      const { guild } = await access(req, guildId);
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const rows = await db.all('SELECT * FROM cases WHERE guild_id = $1 ORDER BY case_id DESC LIMIT $2 OFFSET $3', [guildId, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
      return { rows: rows.map((r) => ({ ...r, mod_name: nameOf(guild, r.mod_id) })), page, pageSize: PAGE_SIZE };
    }],

    ['GET', /^\/api\/guilds\/(\d+)\/leaderboard$/, async (req, [guildId], url) => {
      const { guild } = await access(req, guildId);
      const type = ['xp', 'voice', 'credits'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'xp';
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const rows = await leaderboard(guildId, type, PAGE_SIZE, (page - 1) * PAGE_SIZE);
      return {
        type, page, pageSize: PAGE_SIZE, currency: getSettings(guildId).economy.currency,
        rows: rows.map((r) => ({ ...r, name: r.username ?? nameOf(guild, r.user_id), level: type === 'credits' ? null : levelFromXp(r.score) })),
      };
    }],
  ];

  async function handleAuth(req, res, url) {
    if (!authConfigured()) throw new HttpError(503, 'Website login is not set up on the bot yet.');
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      const session = await sessionOf(req);
      await destroySession(session.token);
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'GET') throw new HttpError(404, 'Not found.');
    if (!client.isReady()) throw new HttpError(503, 'The bot is starting up.');
    const state = url.searchParams.get('state') ?? '';
    if (url.pathname === '/auth/login') {
      if (!STATE_RE.test(state)) throw new HttpError(400, 'Invalid login request.');
      return redirect(res, authorizeUrl(client.user.id, state));
    }
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      // The reason lets the website say what went wrong instead of a vague "try again".
      const failed = (reason) => redirect(res, `${config.dashboardUrl}/#login_error=${reason}`);
      if (url.searchParams.get('error')) return failed('denied');
      if (!code || !STATE_RE.test(state)) return failed('other');
      try {
        const token = await createSession(await exchangeCode(client.user.id, code));
        // In the fragment, so the token is never sent to a server or written to access logs.
        return redirect(res, `${config.dashboardUrl}/#token=${token}&state=${encodeURIComponent(state)}`);
      } catch (err) {
        logger.warn(`Website login failed: ${err.message}`);
        return failed(err.reason ?? 'other');
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,PATCH,DELETE', 'access-control-allow-headers': 'authorization,content-type', 'access-control-max-age': '600' });
      return res.end();
    }
    // Render health check. Answers even while waiting for the old instance to stop.
    if (url.pathname === '/' || url.pathname === '/health') return send(res, 200, { status: 'ok', discord: client.isReady() });
    try {
      // Where Epic Games sends members back after "Log in with Epic Games". Answers with a small page.
      if (req.method === 'GET' && url.pathname === '/epic/callback') {
        const page = await epicCallback(client, url);
        res.writeHead(page.status, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        });
        return res.end(page.html);
      }
      if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url);
      if (!client.isReady()) throw new HttpError(503, 'The bot is starting up.');
      if (req.method === 'GET' && url.pathname === '/api/public') return send(res, 200, { username: client.user.username, inviteUrl: inviteUrl() });
      await sessionOf(req);
      for (const [method, pattern, handler] of routes) {
        const match = req.method === method && url.pathname.match(pattern);
        if (match) return send(res, 200, await handler(req, match.slice(1), url));
      }
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      logger.error(`API ${req.method} ${url.pathname} failed`, err);
      return send(res, 500, { error: 'Internal error.' });
    }
  });
}
