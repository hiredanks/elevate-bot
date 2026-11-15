import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { db } from '../core/db.js';
import { jobs } from '../core/jobs.js';
import { getSettings } from '../core/settings.js';
import { cmd, COLOR, embed, EPHEMERAL, fail, ok, okPrivate, respond } from '../core/ui.js';
import { noop, parseDuration, truncate, ts } from '../core/util.js';
import { getEpicLink, linkButton } from './epic.js';

export const MODES = ['Solo', 'Duos', 'Trios', 'Squads'];
export const BUILDS = ['Build', 'Zero Build'];
export const REGIONS = ['Europe', 'NA East', 'NA Central', 'NA West', 'Brazil', 'Asia', 'Oceania', 'Middle East'];
const KEY_RE = /^[A-Za-z0-9_-]{3,32}$/;
const KEY_HELP = 'Custom keys are 3 to 32 letters, numbers, dashes or underscores.';
const MAX_START_MS = 14 * 864e5;
const MAX_OPEN = 10;
// Clears player roles if a host forgets /scrim end.
const AUTO_END_MS = 6 * 36e5;
const LIVE_COLOR = 0x57f287;
const ENDED_COLOR = 0x747f8d;
const refreshing = new Set();

export class ScrimError extends Error {}

export const getScrim = (guildId, id) => db.one('SELECT * FROM scrims WHERE guild_id = $1 AND id = $2', [guildId, id]);
const isOpen = (s) => s?.status === 'scheduled' || s?.status === 'live';
const playlist = (s) => `${s.build === 'Zero Build' ? 'Zero Build ' : ''}${s.mode}`;

export function parseStart(text) {
  const value = String(text ?? '').trim().toLowerCase();
  if (value === 'now') return 0;
  const ms = parseDuration(value);
  if (!ms || ms > MAX_START_MS) throw new ScrimError('Start time must be "now" or look like 10m, 1h or 2d, and at most 14 days away.');
  return ms;
}

async function counts(s) {
  const row = await db.one(
    'SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE key_game = $2 AND key_game > 0) AS k FROM scrim_players WHERE scrim_id = $1',
    [s.id, s.game],
  );
  return { players: Number(row.n), withKey: Number(row.k) };
}

function scrimMessage(s, { players, withKey }) {
  const live = s.status === 'live';
  const over = !isOpen(s);
  const full = players >= s.max_players;
  const lines = [`Hosted by <@${s.host_id}>`];
  if (!over) {
    lines.push('', live
      ? 'The scrim is live. Registered players: press **Get key**, enter it as your **Custom Matchmaking Key** in the Fortnite lobby, then ready up.'
      : 'Press **Register** to play. When it starts, registered players press **Get key** to see the custom key.');
  }
  const e = new EmbedBuilder().setColor(over ? ENDED_COLOR : live ? LIVE_COLOR : COLOR.brand).setTitle(`🎮 ${s.title}`).setDescription(lines.join('\n'))
    .addFields(
      { name: 'Mode', value: `${s.mode} · ${s.build}`, inline: true },
      { name: 'Region', value: s.region, inline: true },
      { name: live || over ? 'Status' : 'Starts', value: over ? 'Ended' : live ? `🟢 Live · game ${s.game}` : `${ts(s.starts_at, 'f')}\n${ts(s.starts_at)}`, inline: true },
      {
        name: 'Players',
        value: live ? `${players}/${s.max_players} registered · ${withKey} have the key` : `${players}/${s.max_players} registered · ${Math.max(0, s.max_players - players)} spots left`,
      },
    )
    .setFooter({ text: `Scrim #${s.id}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`scrim:join:${s.id}`).setLabel(full && !over ? 'Full' : 'Register').setStyle(ButtonStyle.Success).setDisabled(over || full),
    new ButtonBuilder().setCustomId(`scrim:leave:${s.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary).setDisabled(over),
    new ButtonBuilder().setCustomId(`scrim:key:${s.id}`).setLabel('Get key').setEmoji('🔑').setStyle(ButtonStyle.Primary).setDisabled(!live),
    linkButton().setDisabled(over),
  );
  return { embeds: [e], components: [row], allowedMentions: { parse: [] } };
}

async function refreshPost(guild, s) {
  const channel = guild.channels.cache.get(s.channel_id);
  const message = s.message_id ? await channel?.messages.fetch(s.message_id).catch(() => null) : null;
  if (message) await message.edit(scrimMessage(s, await counts(s))).catch(noop);
}

function scheduleRefresh(guild, id) {
  if (refreshing.has(id)) return;
  refreshing.add(id);
  // Batches a rush of sign-ups into one edit, so the bot stays under Discord's rate limits.
  setTimeout(async () => {
    refreshing.delete(id);
    const s = await getScrim(guild.id, id).catch(() => null);
    if (s) await refreshPost(guild, s);
  }, guild.client.scrimRefreshDelay ?? 3000).unref?.();
}

async function setPlayerRole(guild, userId, give) {
  const roleId = getSettings(guild.id).scrim.playerRole;
  if (!roleId || !guild.roles.cache.has(roleId)) return;
  const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
  if (member) await (give ? member.roles.add(roleId, 'Registered for a scrim') : member.roles.remove(roleId, 'Scrim ended')).catch(noop);
}

async function announceGame(guild, s) {
  const channel = guild.channels.cache.get(s.channel_id);
  if (!channel?.isTextBased()) return;
  const roleId = getSettings(guild.id).scrim.playerRole;
  const ping = roleId && guild.roles.cache.has(roleId) ? roleId : null;
  await channel.send({
    content: `${ping ? `<@&${ping}> ` : ''}🟢 **${s.title}**: game ${s.game} is starting!`,
    embeds: [embed([
      '1. Press **Get key** below. Only registered players can see it.',
      '2. In the Fortnite lobby, open **Custom Matchmaking Key** and enter the key.',
      `3. Pick **${playlist(s)}** and ready up.`,
    ].join('\n'), LIVE_COLOR)],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`scrim:key:${s.id}`).setLabel('Get key').setEmoji('🔑').setStyle(ButtonStyle.Primary))],
    allowedMentions: { roles: ping ? [ping] : [] },
  });
}

export async function startScrim(guild, id) {
  // Flipping the status atomically means the timer and /scrim start cannot both start it.
  const s = await db.one("UPDATE scrims SET status = 'live', game = 1 WHERE guild_id = $1 AND id = $2 AND status = 'scheduled' RETURNING *", [guild.id, id]);
  if (!s) return null;
  await jobs.cancel('scrim:start', guild.id, String(s.id));
  await jobs.schedule('scrim:end', guild.id, Date.now() + AUTO_END_MS, { id: s.id }, String(s.id));
  await announceGame(guild, s);
  await refreshPost(guild, s);
  return s;
}

export async function nextGame(guild, id, key = null) {
  if (key && !KEY_RE.test(key)) throw new ScrimError(KEY_HELP);
  const s = await db.one(
    "UPDATE scrims SET game = game + 1, key_code = COALESCE($3, key_code) WHERE guild_id = $1 AND id = $2 AND status = 'live' RETURNING *",
    [guild.id, id, key || null],
  );
  if (!s) throw new ScrimError('That scrim is not live. Start it first with /scrim start.');
  await jobs.schedule('scrim:end', guild.id, Date.now() + AUTO_END_MS, { id: s.id }, String(s.id));
  await announceGame(guild, s);
  await refreshPost(guild, s);
  return s;
}

async function removePlayerRoles(guild, id) {
  const players = await db.all('SELECT user_id FROM scrim_players WHERE scrim_id = $1', [id]);
  for (const p of players) await setPlayerRole(guild, p.user_id, false);
}

export async function endScrim(guild, id) {
  const s = await db.one("UPDATE scrims SET status = 'ended' WHERE guild_id = $1 AND id = $2 AND status IN ('scheduled', 'live') RETURNING *", [guild.id, id]);
  if (!s) return null;
  await jobs.cancel('scrim:start', guild.id, String(s.id));
  await jobs.cancel('scrim:end', guild.id, String(s.id));
  await removePlayerRoles(guild, s.id);
  await refreshPost(guild, s);
  return s;
}

export async function cancelScrim(guild, id) {
  const s = await getScrim(guild.id, id);
  if (!s) return 0;
  await jobs.cancel('scrim:start', guild.id, String(s.id));
  await jobs.cancel('scrim:end', guild.id, String(s.id));
  await removePlayerRoles(guild, s.id);
  if (s.message_id) await guild.channels.cache.get(s.channel_id)?.messages.delete(s.message_id).catch(noop);
  await db.run('DELETE FROM scrim_players WHERE scrim_id = $1', [s.id]);
  return db.run('DELETE FROM scrims WHERE id = $1', [s.id]);
}

export async function createScrim(guild, { channel, hostId, title, mode, build, region, key, startsInMs, maxPlayers = 100 }) {
  if (!KEY_RE.test(key ?? '')) throw new ScrimError(KEY_HELP);
  if (!MODES.includes(mode) || !BUILDS.includes(build) || !REGIONS.includes(region)) throw new ScrimError('Pick a mode, build type and region from the list.');
  if (!channel?.isTextBased()) throw new ScrimError('Pick a text channel for the scrim.');
  const open = await db.one("SELECT COUNT(*) AS n FROM scrims WHERE guild_id = $1 AND status IN ('scheduled', 'live')", [guild.id]);
  if (Number(open.n) >= MAX_OPEN) throw new ScrimError(`You can have up to ${MAX_OPEN} scrims open at once. End one first.`);
  const s = await db.one(
    `INSERT INTO scrims(guild_id, channel_id, host_id, title, mode, build, region, key_code, max_players, starts_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [guild.id, channel.id, hostId, title?.trim() || `${playlist({ mode, build })} Scrim`, mode, build, region, key, maxPlayers, Date.now() + startsInMs, Date.now()],
  );
  const pingRole = getSettings(guild.id).scrim.pingRole;
  const ping = pingRole && guild.roles.cache.has(pingRole) ? pingRole : null;
  const message = await channel.send({ ...scrimMessage(s, { players: 0, withKey: 0 }), content: ping ? `<@&${ping}> New scrim!` : undefined, allowedMentions: { roles: ping ? [ping] : [] } });
  await db.run('UPDATE scrims SET message_id = $1 WHERE id = $2', [message.id, s.id]);
  s.message_id = message.id;
  if (startsInMs <= 0) return (await startScrim(guild, s.id)) ?? s;
  await jobs.schedule('scrim:start', guild.id, s.starts_at, { id: s.id }, String(s.id));
  return s;
}

/** The key is only ever shown in a private reply, never in the channel. */
async function sendKey(i, s, intro = null) {
  await db.run('UPDATE scrim_players SET key_game = $1 WHERE scrim_id = $2 AND user_id = $3', [s.game, s.id, i.user.id]);
  scheduleRefresh(i.guild, s.id);
  const text = [
    intro, `# \`${s.key_code}\``,
    `Enter it as your **Custom Matchmaking Key** in the Fortnite lobby, pick **${playlist(s)}** and ready up. Do not share it.`,
  ].filter(Boolean).join('\n');
  return respond(i, { embeds: [embed(text, LIVE_COLOR).setTitle(`🔑 ${s.title}: game ${s.game} key`)], flags: EPHEMERAL });
}

const isRegistered = (s, userId) => db.one('SELECT key_game FROM scrim_players WHERE scrim_id = $1 AND user_id = $2', [s.id, userId]);
const idOption = (o) => o.setName('id').setDescription('Scrim number (in the footer of the scrim post)').setRequired(true).setMinValue(1);
const keyOption = (o, required) => o.setName('key').setDescription('Custom matchmaking key. Only registered players will see it').setRequired(required).setMinLength(3).setMaxLength(32);

export default {
  name: 'scrim',
  label: '🎮 Scrims',
  defaults: { requireEpic: true, pingRole: null, playerRole: null },
  form: {
    title: 'Scrim settings',
    description: 'How Fortnite scrims work in this server. Post scrims on the Scrims page or with /scrim create.',
    fields: [
      { key: 'requireEpic', type: 'bool', label: 'Players must link their Epic Games account to register' },
      { key: 'pingRole', type: 'role', label: 'Role to ping when a scrim is posted', help: 'Optional. Leave empty to post without a ping.' },
      { key: 'playerRole', type: 'role', label: 'Role for registered players', assignable: true, help: 'Given on register and removed when the scrim ends. Use it for a players-only chat. Optional.' },
    ],
  },

  collections: {
    scrims: {
      title: 'Scrims',
      description: 'Host Fortnite scrims. The bot posts the scrim with a Register button. When it starts, registered players press Get key and see the custom key privately, so it never appears in the channel. Stopping a scrim that has not started deletes its post.',
      submitLabel: 'Post scrim',
      removeLabel: 'Stop',
      columns: [
        { key: 'title', label: 'Title', type: 'text', max: 80, placeholder: 'Friday Night Scrims' },
        { key: 'mode', label: 'Mode', type: 'select', options: MODES },
        { key: 'build', label: 'Build', type: 'select', options: BUILDS },
        { key: 'region', label: 'Region', type: 'select', options: REGIONS },
        { key: 'channel_id', label: 'Post in', type: 'channel', required: true },
        { key: 'key_code', label: 'Custom key', type: 'text', max: 32, required: true, pattern: KEY_RE.source, placeholder: 'Only registered players see it', hideInList: true },
        { key: 'starts_in', label: 'Starts in', type: 'text', max: 10, required: true, placeholder: '15m, 2h or now', createOnly: true, hideInList: true },
        { key: 'max_players', label: 'Max players', type: 'int', min: 2, max: 100, default: 100, hideInList: true },
        { key: 'starts_at', label: 'Starts', type: 'text', readOnly: true, format: 'time' },
        { key: 'players', label: 'Players', type: 'text', readOnly: true },
        { key: 'status', label: 'Status', type: 'text', readOnly: true },
      ],
      async list(guildId) {
        const rows = await db.all(
          `SELECT s.*, (SELECT COUNT(*) FROM scrim_players p WHERE p.scrim_id = s.id) AS n FROM scrims s
           WHERE s.guild_id = $1 AND s.status IN ('scheduled', 'live') ORDER BY s.starts_at`,
          [guildId],
        );
        // The key is left out on purpose: the website never needs to show it again.
        return rows.map((s) => ({
          id: s.id, title: s.title, mode: s.mode, build: s.build, region: s.region, channel_id: s.channel_id, starts_at: s.starts_at,
          players: `${Number(s.n)}/${s.max_players}`, status: s.status === 'live' ? `Live, game ${s.game}` : 'Scheduled',
        }));
      },
      async create(guild, row, userId) {
        await createScrim(guild, {
          channel: guild.channels.cache.get(row.channel_id), hostId: userId, title: row.title, mode: row.mode, build: row.build, region: row.region,
          key: row.key_code, startsInMs: parseStart(row.starts_in), maxPlayers: row.max_players ?? 100,
        });
      },
      async remove(guild, id) {
        const s = await getScrim(guild.id, id);
        if (s?.status === 'live') return endScrim(guild, s.id);
        return cancelScrim(guild, id);
      },
    },
  },

  commands: [{
    data: cmd('scrim', 'Host Fortnite scrims with a private custom key', P.ManageEvents)
      .addSubcommand((s) => s.setName('create').setDescription('Post a scrim with a Register button')
        .addStringOption((o) => o.setName('mode').setDescription('Team size').setRequired(true).addChoices(...MODES.map((m) => ({ name: m, value: m }))))
        .addStringOption((o) => o.setName('build').setDescription('Build or Zero Build').setRequired(true).addChoices(...BUILDS.map((b) => ({ name: b, value: b }))))
        .addStringOption((o) => o.setName('region').setDescription('Server region').setRequired(true).addChoices(...REGIONS.map((r) => ({ name: r, value: r }))))
        .addStringOption((o) => keyOption(o, true))
        .addStringOption((o) => o.setName('starts_in').setDescription('For example 15m, 1h, or now. Defaults to 10m').setMaxLength(10))
        .addStringOption((o) => o.setName('title').setDescription('Defaults to the mode, like "Zero Build Trios Scrim"').setMaxLength(80))
        .addIntegerOption((o) => o.setName('max_players').setDescription('Defaults to 100').setMinValue(2).setMaxValue(100))
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to here').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
      .addSubcommand((s) => s.setName('start').setDescription('Start now and give registered players the key').addIntegerOption(idOption))
      .addSubcommand((s) => s.setName('next').setDescription('Start the next game, with a new key if you like').addIntegerOption(idOption)
        .addStringOption((o) => keyOption(o, false)))
      .addSubcommand((s) => s.setName('end').setDescription('End a scrim and remove player roles').addIntegerOption(idOption))
      .addSubcommand((s) => s.setName('cancel').setDescription('Delete a scrim and its post').addIntegerOption(idOption))
      .addSubcommand((s) => s.setName('players').setDescription('See who registered, with their Epic names').addIntegerOption(idOption))
      .addSubcommand((s) => s.setName('list').setDescription('List open scrims')),
    botPerms: [P.SendMessages, P.EmbedLinks],
    async run(i) {
      const sub = i.options.getSubcommand();
      try {
        if (sub === 'list') {
          const rows = await db.all("SELECT * FROM scrims WHERE guild_id = $1 AND status IN ('scheduled', 'live') ORDER BY starts_at", [i.guildId]);
          return okPrivate(i, rows.map((s) => `**#${s.id}** ${s.title} (${playlist(s)}, ${s.region}) in <#${s.channel_id}>: ${s.status === 'live' ? `live, game ${s.game}` : `starts ${ts(s.starts_at)}`}`).join('\n') || 'No scrims open.');
        }
        if (sub === 'create') {
          const s = await createScrim(i.guild, {
            channel: i.options.getChannel('channel') ?? i.channel, hostId: i.user.id, title: i.options.getString('title'),
            mode: i.options.getString('mode', true), build: i.options.getString('build', true), region: i.options.getString('region', true),
            key: i.options.getString('key', true).trim(), startsInMs: parseStart(i.options.getString('starts_in') ?? '10m'), maxPlayers: i.options.getInteger('max_players') ?? 100,
          });
          return ok(i, `Scrim **#${s.id}** posted in <#${s.channel_id}>${s.status === 'live' ? ' and started' : `. It starts ${ts(s.starts_at)}`}. The key stays private until then.`, { flags: EPHEMERAL });
        }
        const s = await getScrim(i.guildId, i.options.getInteger('id', true));
        if (!s) return fail(i, 'No scrim with that number.');
        if (sub === 'players') {
          const rows = await db.all('SELECT * FROM scrim_players WHERE scrim_id = $1 ORDER BY joined_at', [s.id]);
          const lines = rows.map((p, n) => `${n + 1}. <@${p.user_id}> · ${p.epic_name ?? 'no Epic link'}${s.status === 'live' && p.key_game === s.game ? ' 🔑' : ''}`);
          const title = `**${s.title}**: ${rows.length}/${s.max_players} players${s.status === 'live' ? ' (🔑 = has the key for this game)' : ''}`;
          return respond(i, { embeds: [embed(truncate([title, '', ...lines].join('\n'), 4000))], flags: EPHEMERAL, allowedMentions: { parse: [] } });
        }
        if (sub === 'cancel') {
          await cancelScrim(i.guild, s.id);
          return ok(i, `Scrim #${s.id} cancelled and its post deleted.`, { flags: EPHEMERAL });
        }
        if (!isOpen(s)) return fail(i, 'That scrim already ended.');
        if (sub === 'start') {
          if (s.status === 'live') return fail(i, 'That scrim is already live. Use /scrim next for the next game.');
          await startScrim(i.guild, s.id);
          return ok(i, `Scrim #${s.id} started. Registered players can press **Get key** now.`, { flags: EPHEMERAL });
        }
        if (sub === 'next') {
          const next = await nextGame(i.guild, s.id, i.options.getString('key')?.trim());
          return ok(i, `Game ${next.game} of scrim #${s.id} announced${i.options.getString('key') ? ' with the new key' : ''}.`, { flags: EPHEMERAL });
        }
        await endScrim(i.guild, s.id);
        return ok(i, `Scrim #${s.id} ended.`, { flags: EPHEMERAL });
      } catch (err) {
        if (!(err instanceof ScrimError)) throw err;
        return fail(i, err.message);
      }
    },
  }],

  components: {
    async 'scrim:join'(i, [id]) {
      const s = await getScrim(i.guildId, id);
      if (!isOpen(s)) return fail(i, 'This scrim is over.');
      const link = await getEpicLink(i.user.id);
      if (getSettings(i.guildId).scrim.requireEpic && !link) {
        return respond(i, {
          embeds: [embed('🔗 Link your Epic Games account first, then press **Register** again.', COLOR.warn)],
          components: [new ActionRowBuilder().addComponents(linkButton())],
          flags: EPHEMERAL,
        });
      }
      // The count check and insert are one statement, so a rush of clicks cannot overfill the scrim.
      const added = await db.one(
        `INSERT INTO scrim_players(scrim_id, user_id, epic_name, joined_at)
         SELECT $1::bigint, $2::text, $3::text, $4::bigint WHERE (SELECT COUNT(*) FROM scrim_players WHERE scrim_id = $1::bigint) < $5::int
         ON CONFLICT DO NOTHING RETURNING user_id`,
        [s.id, i.user.id, link?.epic_name ?? null, Date.now(), s.max_players],
      );
      if (!added) {
        if (!(await isRegistered(s, i.user.id))) return fail(i, 'This scrim is full.');
        if (s.status === 'live') return sendKey(i, s, 'You are already registered. Here is the key:');
        return okPrivate(i, `You are already registered. Come back ${ts(s.starts_at)} and press **Get key**.`);
      }
      await setPlayerRole(i.guild, i.user.id, true);
      scheduleRefresh(i.guild, s.id);
      if (s.status === 'live') return sendKey(i, s, 'You are registered. Here is the key:');
      return okPrivate(i, `You are registered${link ? ` as **${link.epic_name}**` : ''}. Come back ${ts(s.starts_at)} and press **Get key**.`);
    },
    async 'scrim:leave'(i, [id]) {
      const s = await getScrim(i.guildId, id);
      const removed = s ? await db.run('DELETE FROM scrim_players WHERE scrim_id = $1 AND user_id = $2', [s.id, i.user.id]) : 0;
      if (!removed) return okPrivate(i, 'You were not registered.');
      await setPlayerRole(i.guild, i.user.id, false);
      scheduleRefresh(i.guild, s.id);
      return okPrivate(i, 'You left the scrim.');
    },
    async 'scrim:key'(i, [id]) {
      const s = await getScrim(i.guildId, id);
      if (!isOpen(s)) return fail(i, 'This scrim is over.');
      const registered = await isRegistered(s, i.user.id);
      const staff = i.memberPermissions.has(P.ManageEvents);
      if (!registered && !staff) return fail(i, 'Only registered players get the key. Press **Register** on the scrim post first.');
      if (s.status !== 'live') return okPrivate(i, `The scrim starts ${ts(s.starts_at)}. The key appears here then.`);
      return sendKey(i, s);
    },
  },

  jobs: {
    async 'scrim:start'(client, { id }, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      if (guild) await startScrim(guild, id);
    },
    async 'scrim:end'(client, { id }, job) {
      const guild = client.guilds.cache.get(job.guild_id);
      if (guild) await endScrim(guild, id);
    },
  },
};
