import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { config } from '../config.js';
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { getSettings } from '../core/settings.js';
import { cmd, COLOR, EPHEMERAL, fail, okPrivate, respond } from '../core/ui.js';
import { noop } from '../core/util.js';

const STATE_MS = 10 * 60_000;
const STATE_RE = /^[\w-]{20,64}$/;
// Epic display names are 3 to 16 characters.
const NAME_RE = /^[\p{L}\p{N} ._-]{3,16}$/u;
const EPIC_API = 'https://api.epicgames.dev';

export class LinkError extends Error {}

/** True once the Epic Games login keys are set on Render. Without them, members type their Epic name instead. */
export const epicLoginReady = () => Boolean(config.epicClientId && config.epicClientSecret);
const redirectUri = () => `${config.publicUrl}/epic/callback`;

export const getEpicLink = (userId) => db.one('SELECT * FROM epic_links WHERE user_id = $1', [userId]);

export async function saveLink(userId, { epicId = null, epicName, verified }) {
  // One Epic account per Discord account, so nobody can register twice for a scrim.
  const taken = epicId
    ? await db.one('SELECT user_id FROM epic_links WHERE epic_id = $1 AND user_id <> $2', [epicId, userId])
    : await db.one('SELECT user_id FROM epic_links WHERE LOWER(epic_name) = LOWER($1) AND user_id <> $2', [epicName, userId]);
  if (taken) {
    throw new LinkError(epicId
      ? 'That Epic Games account is already linked to another Discord account. Unlink it there first with /epic unlink.'
      : 'Another member already linked that Epic name. If it is yours, ask a staff member for help.');
  }
  await db.run(
    `INSERT INTO epic_links(user_id, epic_id, epic_name, verified, linked_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET epic_id = excluded.epic_id, epic_name = excluded.epic_name, verified = excluded.verified, linked_at = excluded.linked_at`,
    [userId, epicId, epicName, verified, Date.now()],
  );
}

async function setLinkedRole(guild, userId, give) {
  const roleId = getSettings(guild.id).epic.linkedRole;
  if (!roleId || !guild.roles.cache.has(roleId)) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  await (give ? member.roles.add(roleId, 'Linked Epic Games account') : member.roles.remove(roleId, 'Unlinked Epic Games account')).catch(noop);
}

export async function unlink(guild, userId) {
  const removed = await db.run('DELETE FROM epic_links WHERE user_id = $1', [userId]);
  if (removed) await setLinkedRole(guild, userId, false);
  return removed;
}

async function epicLoginUrl(userId, guildId) {
  const state = randomBytes(24).toString('base64url');
  await db.run('DELETE FROM epic_link_states WHERE expires_at < $1', [Date.now()]);
  await db.run('INSERT INTO epic_link_states(state, user_id, guild_id, expires_at) VALUES ($1, $2, $3, $4)', [state, userId, guildId, Date.now() + STATE_MS]);
  const params = new URLSearchParams({ client_id: config.epicClientId, response_type: 'code', scope: 'basic_profile', redirect_uri: redirectUri(), state });
  return `https://www.epicgames.com/id/authorize?${params}`;
}

const nameModal = () => new ModalBuilder().setCustomId('epic:name').setTitle('Link your Epic Games account').addComponents(
  new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Your Epic Games display name')
    .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(16)),
);

export const linkButton = () => new ButtonBuilder().setCustomId('epic:link').setLabel('Link Epic account').setEmoji('🔗').setStyle(ButtonStyle.Secondary);

/** Shows a personal "Log in with Epic Games" button, or a box to type the name when Epic login is not set up. */
export async function startLink(i) {
  if (!epicLoginReady()) return i.showModal(nameModal());
  const url = await epicLoginUrl(i.user.id, i.guildId);
  return respond(i, {
    embeds: [new EmbedBuilder().setColor(COLOR.brand).setDescription('Log in with Epic Games to link your account. Only your Epic name and account ID are shared, never your password.\n\nThis button is only for you and works for 10 minutes.')],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Log in with Epic Games').setURL(url))],
    flags: EPHEMERAL,
  });
}

async function postJson(url, body) {
  const auth = Buffer.from(`${config.epicClientId}:${config.epicClientSecret}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Epic token exchange failed with ${res.status}`);
  return res.json();
}

async function getJson(url, accessToken) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  return res?.ok ? res.json() : null;
}

/** Trades the login code for the Epic account ID and display name. The Epic token itself is not kept. */
async function exchangeEpicCode(code) {
  const token = await postJson(`${EPIC_API}/epic/oauth/v2/token`, { grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const accountId = token.account_id;
  const accounts = await getJson(`${EPIC_API}/epic/id/v2/accounts?accountId=${encodeURIComponent(accountId)}`, token.access_token);
  let name = Array.isArray(accounts) ? accounts.find((a) => a.accountId === accountId)?.displayName : null;
  if (!name) name = (await getJson(`${EPIC_API}/epic/oauth/v2/userInfo`, token.access_token))?.preferred_username;
  if (!accountId || !name) throw new Error('Epic did not return the account name');
  return { id: accountId, name };
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function resultPage(status, title, text) {
  return {
    status,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>`
      + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#110e22;color:#ece9ff;font:17px/1.55 system-ui,sans-serif}'
      + 'main{max-width:28rem;padding:2rem}h1{font-size:1.6rem;margin:0 0 .5rem;color:#b8affe}</style></head>'
      + `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`,
  };
}

/** Where Epic sends members back after they log in. Answers with a small page they can close. */
export async function epicCallback(client, url) {
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code');
  if (!STATE_RE.test(state)) return resultPage(400, 'This link is not valid', 'Press Link Epic account in Discord to get a new one.');
  // Deleted on first use, so a login link only ever works once.
  const pending = await db.one('DELETE FROM epic_link_states WHERE state = $1 RETURNING *', [state]);
  if (!pending || pending.expires_at < Date.now()) return resultPage(400, 'This link expired', 'Press Link Epic account in Discord to get a new one.');
  if (!code) return resultPage(400, 'Nothing was linked', 'The Epic login was cancelled. Press Link Epic account in Discord to try again.');
  if (!epicLoginReady()) return resultPage(503, 'Epic login is off', 'Epic Games login is not set up on the bot.');
  try {
    const profile = await exchangeEpicCode(code);
    await saveLink(pending.user_id, { epicId: profile.id, epicName: profile.name, verified: true });
    const guild = client.guilds.cache.get(pending.guild_id);
    if (guild) await setLinkedRole(guild, pending.user_id, true);
    return resultPage(200, `Linked to ${profile.name}`, 'Your Epic Games account is linked. You can close this tab and go back to Discord.');
  } catch (err) {
    if (err instanceof LinkError) return resultPage(409, 'Could not link', err.message);
    logger.warn(`Epic link failed: ${err.message}`);
    return resultPage(502, 'Epic Games did not answer', 'Nothing was linked. Try again in a minute.');
  }
}

export async function postLinkPanel(guild) {
  const channel = guild.channels.cache.get(getSettings(guild.id).epic.panelChannel);
  if (!channel?.isTextBased()) throw new Error('Pick a channel for the panel first.');
  await channel.send({
    embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle('🎮 Link your Epic Games account')
      .setDescription('Link your Epic account to register for scrims. Hosts see your Epic name next to your Discord name.')],
    components: [new ActionRowBuilder().addComponents(linkButton())],
  });
  return `Panel posted in #${channel.name}.`;
}

export default {
  name: 'epic',
  label: '🔗 Epic Games Linking',
  defaults: { panelChannel: null, linkedRole: null },
  form: {
    title: 'Epic Games linking',
    description: 'Members link their Epic Games account so scrim hosts know who is who. With EPIC_CLIENT_ID and EPIC_CLIENT_SECRET set on Render, members log in with Epic and the link is proven. Without them, members type their Epic name.',
    fields: [
      { key: 'panelChannel', type: 'channel', label: 'Channel for the link panel' },
      { key: 'linkedRole', type: 'role', label: 'Role for linked members', assignable: true, help: 'Given after linking and removed on unlink. Optional.' },
    ],
    actions: [{ id: 'panel', label: 'Post link panel' }],
  },
  actions: { panel: (guild) => postLinkPanel(guild) },

  collections: {
    epiclinks: {
      title: 'Linked Epic accounts',
      description: 'Members of this server who linked an Epic Games account. "Epic login" means the link is proven; "Typed" means the member typed the name. Removing one unlinks it.',
      idKey: 'user_id',
      removeLabel: 'Unlink',
      columns: [
        { key: 'member', label: 'Member', type: 'text', readOnly: true },
        { key: 'epic_name', label: 'Epic name', type: 'text', readOnly: true },
        { key: 'how', label: 'Linked by', type: 'text', readOnly: true },
      ],
      async list(guildId, guild) {
        const rows = await db.all('SELECT * FROM epic_links ORDER BY linked_at DESC');
        return rows.filter((r) => guild?.members.cache.has(r.user_id)).map((r) => ({
          user_id: r.user_id, member: guild.members.cache.get(r.user_id).displayName, epic_name: r.epic_name, how: r.verified ? 'Epic login' : 'Typed',
        }));
      },
      remove: (guild, userId) => unlink(guild, userId),
    },
  },

  commands: [{
    data: cmd('epic', 'Link your Epic Games account')
      .addSubcommand((s) => s.setName('link').setDescription('Link your Epic Games account'))
      .addSubcommand((s) => s.setName('unlink').setDescription('Remove your Epic Games link'))
      .addSubcommand((s) => s.setName('whois').setDescription("See a member's linked Epic account")
        .addUserOption((o) => o.setName('member').setDescription('Defaults to you'))),
    async run(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'link') return startLink(i);
      if (sub === 'unlink') return okPrivate(i, (await unlink(i.guild, i.user.id)) ? 'Your Epic Games account is unlinked.' : 'You had nothing linked.');
      const user = i.options.getUser('member') ?? i.user;
      const link = await getEpicLink(user.id);
      if (!link) return okPrivate(i, `${user} has not linked an Epic Games account.`);
      return okPrivate(i, `${user} is **${link.epic_name}** on Epic Games (${link.verified ? 'proven with Epic login' : 'typed by them'}).`);
    },
  }],

  components: {
    'epic:link': (i) => startLink(i),
    async 'epic:name'(i) {
      const name = i.fields.getTextInputValue('name').trim();
      if (!NAME_RE.test(name)) return fail(i, 'Epic names are 3 to 16 letters, numbers, spaces, dots, dashes or underscores.');
      try {
        await saveLink(i.user.id, { epicName: name, verified: false });
      } catch (err) {
        if (err instanceof LinkError) return fail(i, err.message);
        throw err;
      }
      await setLinkedRole(i.guild, i.user.id, true);
      return okPrivate(i, `Linked to **${name}**. Scrim hosts will see this name next to yours.`);
    },
  },
};
