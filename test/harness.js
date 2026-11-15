// Runs the real discord.js library and the real bot code against a simulated Discord REST API
// and an in-memory Postgres. Nothing here talks to the network.
process.env.DATA_DIR = ':memory:';
// TEST_DATABASE_URL runs the suite through the production Postgres driver instead of the embedded one.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;
delete process.env.RENDER;
process.env.DASHBOARD_URL ??= 'https://dash.example';
process.env.DISCORD_CLIENT_SECRET ??= 'test-client-secret';
process.env.PUBLIC_URL ??= 'https://bot.example';
process.env.GROQ_API_KEY ??= 'test-groq-key';

const {
  AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, ClientUser, Events, GuildAuditLogsEntry,
  ModalSubmitInteraction, PermissionFlagsBits: P, StringSelectMenuInteraction,
} = await import('discord.js');
const { createBot } = await import('../src/bot.js');
const { connectDatabase } = await import('../src/core/db.js');
const { logger } = await import('../src/core/logger.js');
const { handleInteraction } = await import('../src/core/registry.js');

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export const ID = {
  guild: '100000000000000001', owner: '200000000000000001', admin: '200000000000000002', mod: '200000000000000003',
  member: '200000000000000004', other: '200000000000000005', bot: '200000000000000009', stranger: '200000000000000008',
  general: '300000000000000001', logs: '300000000000000002', voice: '300000000000000003', category: '300000000000000004', extra: '300000000000000005',
  roleBot: '400000000000000001', roleAdmin: '400000000000000002', roleMod: '400000000000000003', roleMember: '400000000000000004', roleVip: '400000000000000005',
};

const bits = (...flags) => flags.reduce((a, b) => a | b, 0n).toString();
const rawUser = (id, username, bot = false) => ({ id, username, discriminator: '0', global_name: username, avatar: null, bot });
const rawRole = (id, name, position, permissions) => ({
  id, name, position, permissions, color: 0, hoist: false, managed: false, mentionable: false, flags: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
});
const rawMember = (user, roles, joined = '2024-01-01T00:00:00.000Z') => ({ user, roles, joined_at: joined, deaf: false, mute: false, nick: null, flags: 0, pending: false });
const rawChannel = (id, name, type, extra = {}) => ({ id, name, type, guild_id: ID.guild, position: 0, permission_overwrites: [], parent_id: null, nsfw: false, ...extra });

let nextId = 900000000000000000n;
export const newId = () => (nextId += 1n).toString();

export function createDiscord() {
  const calls = [];
  const users = new Map();
  const members = new Map();
  const channels = new Map();
  const messages = new Map();
  const bans = new Map();
  const roles = new Map();
  const webhooks = new Map();

  const addUser = (id, name, roleIds, bot = false) => {
    const user = rawUser(id, name, bot);
    users.set(id, user);
    members.set(id, rawMember(user, roleIds));
    return user;
  };
  addUser(ID.owner, 'owner', []);
  addUser(ID.admin, 'admin', [ID.roleAdmin]);
  addUser(ID.mod, 'mod', [ID.roleMod]);
  addUser(ID.member, 'member', [ID.roleMember]);
  addUser(ID.other, 'other', [ID.roleMember]);
  addUser(ID.bot, 'omnibot', [ID.roleBot], true);
  users.set(ID.stranger, rawUser(ID.stranger, 'stranger'));

  const R = [
    rawRole(ID.guild, '@everyone', 0, bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory)),
    rawRole(ID.roleMember, 'Member', 1, bits(P.ViewChannel, P.SendMessages)),
    rawRole(ID.roleVip, 'VIP', 2, bits(P.ViewChannel, P.SendMessages)),
    rawRole(ID.roleMod, 'Mod', 3, bits(P.BanMembers, P.KickMembers, P.ModerateMembers, P.ManageMessages, P.ManageNicknames, P.ManageRoles, P.ManageChannels)),
    rawRole(ID.roleAdmin, 'Admin', 4, bits(P.Administrator)),
    rawRole(ID.roleBot, 'OmniBot', 10, bits(P.Administrator)),
  ];
  R.forEach((r) => roles.set(r.id, r));
  [
    rawChannel(ID.general, 'general', 0), rawChannel(ID.logs, 'logs', 0), rawChannel(ID.extra, 'extra', 0),
    rawChannel(ID.voice, 'voice', 2, { bitrate: 64000, user_limit: 0 }), rawChannel(ID.category, 'Stuff', 4),
  ].forEach((c) => channels.set(c.id, c));

  const makeMessage = (channelId, body = {}, author = users.get(ID.bot)) => {
    const id = newId();
    const raw = {
      id, channel_id: channelId, guild_id: ID.guild, author, content: body.content ?? '', timestamp: new Date().toISOString(), edited_timestamp: null,
      tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: body.embeds ?? [], components: body.components ?? [], pinned: false, type: 0,
    };
    messages.set(id, raw);
    return raw;
  };

  function notFound(code = 10008) {
    const err = new Error('Unknown');
    err.code = code;
    err.status = 404;
    return err;
  }

  function handle(method, route, body) {
    let m;
    const is = (verb, re) => method === verb && (m = route.match(re));

    if (is('POST', /^\/interactions\/\d+\/[^/]+\/callback/)) return undefined;
    if (is('PATCH', /^\/webhooks\/\d+\/[^/]+\/messages\//)) return makeMessage(ID.general, body);
    if (is('POST', /^\/webhooks\/\d+\/[^/]+/)) return makeMessage(ID.general, body);
    if (is('GET', /^\/webhooks\/\d+\/[^/]+\/messages\//)) return makeMessage(ID.general, {});
    if (is('DELETE', /^\/webhooks\//)) return undefined;

    if (is('PUT', /^\/channels\/\d+\/messages\/\d+\/reactions\//)) return undefined;
    if (is('DELETE', /^\/channels\/\d+\/messages\/\d+\/reactions\//)) return undefined;
    if (is('GET', /^\/channels\/\d+\/messages\/\d+\/reactions\//)) return [users.get(ID.member)];
    if (is('POST', /^\/channels\/\d+\/messages\/bulk-delete/)) return undefined;
    if (is('POST', /^\/channels\/(\d+)\/messages$/)) return makeMessage(m[1], body);
    if (is('GET', /^\/channels\/\d+\/messages\/(\d+)$/)) { if (!messages.has(m[1])) throw notFound(); return messages.get(m[1]); }
    if (is('PATCH', /^\/channels\/\d+\/messages\/(\d+)$/)) { if (!messages.has(m[1])) throw notFound(); return Object.assign(messages.get(m[1]), body); }
    if (is('DELETE', /^\/channels\/\d+\/messages\/(\d+)$/)) { messages.delete(m[1]); return undefined; }
    if (is('GET', /^\/channels\/(\d+)\/messages/)) return [...messages.values()].filter((x) => x.channel_id === m[1]).slice(-100).reverse();
    if (is('PUT', /^\/channels\/\d+\/permissions\//)) return undefined;
    if (is('DELETE', /^\/channels\/\d+\/permissions\//)) return undefined;
    if (is('PATCH', /^\/channels\/(\d+)$/)) { if (!channels.has(m[1])) throw notFound(10003); return Object.assign(channels.get(m[1]), body); }
    if (is('DELETE', /^\/channels\/(\d+)$/)) { const c = channels.get(m[1]); channels.delete(m[1]); return c; }

    if (is('POST', /^\/guilds\/\d+\/channels$/)) {
      const c = rawChannel(newId(), body.name, body.type ?? 0, { parent_id: body.parent_id ?? null, permission_overwrites: body.permission_overwrites ?? [], user_limit: body.user_limit ?? 0 });
      channels.set(c.id, c);
      return c;
    }
    if (is('PATCH', /^\/guilds\/\d+\/channels$/)) return undefined;
    if (is('POST', /^\/guilds\/\d+\/roles$/)) { const r = rawRole(newId(), body.name, 1, body.permissions ?? '0'); roles.set(r.id, r); return r; }
    if (is('PATCH', /^\/guilds\/\d+\/roles$/)) return [...roles.values()];
    if (is('PATCH', /^\/guilds\/\d+\/roles\/(\d+)$/)) return Object.assign(roles.get(m[1]), body);
    if (is('DELETE', /^\/guilds\/\d+\/roles\/(\d+)$/)) { roles.delete(m[1]); return undefined; }
    if (is('GET', /^\/guilds\/\d+\/invites$/)) return [];
    if (is('GET', /^\/guilds\/\d+\/bans\/(\d+)$/)) { if (!bans.has(m[1])) throw notFound(10026); return { user: users.get(m[1]), reason: 'x' }; }
    if (is('PUT', /^\/guilds\/\d+\/bans\/(\d+)$/)) { bans.set(m[1], true); return undefined; }
    if (is('DELETE', /^\/guilds\/\d+\/bans\/(\d+)$/)) { bans.delete(m[1]); return undefined; }
    if (is('GET', /^\/guilds\/\d+\/members\/(\d+)$/)) { if (!members.has(m[1])) throw notFound(10007); return members.get(m[1]); }
    if (is('PATCH', /^\/guilds\/\d+\/members\/(\d+)$/)) return Object.assign(members.get(m[1]), body);
    if (is('DELETE', /^\/guilds\/\d+\/members\/(\d+)$/)) { members.delete(m[1]); return undefined; }
    if (is('PUT', /^\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/)) { const x = members.get(m[1]); if (!x.roles.includes(m[2])) x.roles.push(m[2]); return undefined; }
    if (is('DELETE', /^\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/)) { const x = members.get(m[1]); x.roles = x.roles.filter((r) => r !== m[2]); return undefined; }
    if (is('PATCH', /^\/guilds\/\d+$/)) return { id: ID.guild, name: 'Test', owner_id: ID.owner, roles: [...roles.values()], emojis: [], stickers: [], features: [], ...body };
    if (is('GET', /^\/users\/(\d+)$/)) { if (!users.has(m[1])) throw notFound(10013); return users.get(m[1]); }
    if (is('POST', /^\/users\/@me\/channels$/)) return { id: '500000000000000000', type: 1, recipients: [users.get(body.recipient_id)] };
    if (is('POST', /^\/channels\/500000000000000000\/messages$/)) return makeMessage('500000000000000000', body);
    if (is('PUT', /^\/applications\/\d+\/commands/)) return [];
    if (is('GET', /^\/channels\/(\d+)\/webhooks$/)) return [...webhooks.values()].filter((w) => w.channel_id === m[1]);
    if (is('POST', /^\/channels\/(\d+)\/webhooks$/)) {
      const hook = { id: newId(), type: 1, token: 'hooktoken', channel_id: m[1], guild_id: ID.guild, name: body.name, avatar: null, application_id: ID.bot, user: users.get(ID.bot) };
      webhooks.set(hook.id, hook);
      return hook;
    }
    if (is('GET', /^\/webhooks\/(\d+)$/)) { if (!webhooks.has(m[1])) throw notFound(10015); return webhooks.get(m[1]); }
    throw new Error(`Simulated Discord has no route for ${method} ${route}`);
  }

  const initial = { members: structuredClone([...members]), channels: structuredClone([...channels]) };
  const restore = () => {
    members.clear();
    initial.members.forEach(([k, v]) => members.set(k, structuredClone(v)));
    channels.clear();
    initial.channels.forEach(([k, v]) => channels.set(k, structuredClone(v)));
    bans.clear();
  };
  const state = { calls, users, members, channels, messages, bans, roles, makeMessage, restore };
  state.request = (options) => {
    const method = options.method.toUpperCase();
    // Round-tripped like a real HTTP body: undefined fields vanish.
    const body = options.body ? JSON.parse(JSON.stringify(options.body)) : null;
    calls.push({ method, route: options.fullRoute, body, files: options.files ?? null });
    return handle(method, options.fullRoute, body);
  };
  return state;
}

function mockFetch() {
  globalThis.fetch = async () => new Response(PNG_1PX, { status: 200, headers: { 'content-type': 'image/png' } });
}

export async function createWorld() {
  mockFetch();
  logger.quiet = true;
  await connectDatabase();
  const client = createBot();
  const discord = createDiscord();
  client.rest.request = async (options) => discord.request(options);
  client.antinukeRecoveryDelay = 0;
  client.ticketCloseDelay = 0;
  client.stickyDelay = 0;
  client.voiceRejoinDelay = 0;
  client.isReady = () => true;
  // Stands in for the gateway connection, so voice join requests can be inspected.
  const gatewayPayloads = [];
  client.ws.shards.set(0, { id: 0, status: 0, ping: 0, send: (payload) => gatewayPayloads.push(payload) });

  client.user = new ClientUser(client, discord.users.get(ID.bot));
  client.users.cache.set(ID.bot, client.user);
  client.application = { id: ID.bot, commands: { set: async () => [] } };
  const guild = client.guilds._add({
    id: ID.guild, shardId: 0, name: 'Test Server', icon: null, owner_id: ID.owner, member_count: 6, roles: [...discord.roles.values()], emojis: [], stickers: [], features: [],
    channels: [...discord.channels.values()], members: [...discord.members.values()], voice_states: [], presences: [], verification_level: 1, premium_tier: 0, premium_subscription_count: 0,
    afk_channel_id: null, system_channel_flags: 0, nsfw_level: 0, mfa_level: 0, default_message_notifications: 0, explicit_content_filter: 0, preferred_locale: 'en-US',
  });

  const member = (id) => discord.members.get(id);

  function interactionBase(userId, channelId, type) {
    const raw = member(userId);
    const permissions = guild.members.cache.get(userId)?.permissions.bitfield.toString() ?? '0';
    return {
      id: newId(), application_id: ID.bot, type, token: 'tok', version: 1, guild_id: ID.guild, channel_id: channelId,
      channel: { ...discord.channels.get(channelId) }, member: { ...raw, permissions }, app_permissions: bits(P.Administrator), locale: 'en-US', guild_locale: 'en-US',
      entitlements: [], authorizing_integration_owners: {}, context: 0,
    };
  }

  const responses = (from) => discord.calls.slice(from).filter((c) => /interactions\/\d+|\/webhooks\//.test(c.route));
  const textOf = (call) => JSON.stringify(call.body ?? {});

  async function run(makeInteraction) {
    const from = discord.calls.length;
    await handleInteraction(makeInteraction());
    const sent = responses(from);
    return { calls: discord.calls.slice(from), responses: sent, text: sent.map(textOf).join('\n') };
  }

  /** Sends a slash command. `options` is { name: value }, resolved against the command's schema. */
  function command(name, { sub = null, options = {}, as = ID.owner, channel = ID.general, schema } = {}) {
    const resolved = { users: {}, members: {}, roles: {}, channels: {}, attachments: {} };
    const toOption = (opt) => {
      const value = options[opt.name];
      if (opt.type === 6) {
        resolved.users[value] = discord.users.get(value);
        const m = member(value);
        if (m) resolved.members[value] = { roles: m.roles, joined_at: m.joined_at, deaf: false, mute: false, flags: 0, permissions: guild.members.cache.get(value)?.permissions.bitfield.toString() ?? '0' };
      }
      if (opt.type === 7) resolved.channels[value] = { ...discord.channels.get(value), permissions: '8' };
      if (opt.type === 8) resolved.roles[value] = discord.roles.get(value);
      if (opt.type === 11) resolved.attachments[value] = { id: value, filename: 'x.png', size: 100, url: 'https://cdn.discordapp.com/x.png', proxy_url: 'https://x', content_type: 'image/png' };
      return { name: opt.name, type: opt.type, value };
    };
    const provided = (list) => (list ?? []).filter((o) => options[o.name] !== undefined).map(toOption);
    const subSchema = sub ? schema.options.find((o) => o.name === sub) : schema;
    const dataOptions = sub ? [{ name: sub, type: 1, options: provided(subSchema.options) }] : provided(schema.options);
    return run(() => new ChatInputCommandInteraction(client, {
      ...interactionBase(as, channel, 2),
      data: { id: newId(), name, type: 1, guild_id: ID.guild, options: dataOptions, resolved },
    }));
  }

  const button = (customId, { as = ID.member, channel = ID.general, message } = {}) => run(() => new ButtonInteraction(client, {
    ...interactionBase(as, channel, 3), message: message ?? discord.makeMessage(channel), data: { custom_id: customId, component_type: 2 },
  }));
  const select = (customId, values, { as = ID.member, channel = ID.general } = {}) => run(() => new StringSelectMenuInteraction(client, {
    ...interactionBase(as, channel, 3), message: discord.makeMessage(channel), data: { custom_id: customId, component_type: 3, values },
  }));
  const modal = (customId, fields, { as = ID.member, channel = ID.general } = {}) => run(() => new ModalSubmitInteraction(client, {
    ...interactionBase(as, channel, 5),
    data: { custom_id: customId, components: Object.entries(fields).map(([id, value]) => ({ type: 1, components: [{ type: 4, custom_id: id, value }] })) },
  }));
  const autocomplete = (name, focused, { schema, as = ID.owner } = {}) => run(() => new AutocompleteInteraction(client, {
    ...interactionBase(as, ID.general, 4),
    data: { id: newId(), name, type: 1, guild_id: ID.guild, options: focused(schema) },
  }));

  /** Delivers a gateway event and waits for every module's handler to finish. */
  async function emit(event, ...args) {
    const listeners = client.rawListeners(event);
    await Promise.all(listeners.map((fn) => fn.apply(client, args)));
  }

  function message(content, { as = ID.member, channel = ID.general, ...extra } = {}) {
    const raw = discord.makeMessage(channel, { content }, discord.users.get(as));
    const chan = guild.channels.cache.get(channel);
    return chan.messages._add({ ...raw, member: { ...member(as) }, ...extra });
  }

  function auditEntry(action, executorId, targetId, changes = []) {
    return new GuildAuditLogsEntry(guild, { id: newId(), user_id: executorId, target_id: targetId, action_type: action, changes }, {
      applicationCommands: new Map(), autoModerationRules: new Map(), guildScheduledEvents: new Map(), integrations: new Map(), threads: new Map(), users: new Map(), webhooks: new Map(),
    });
  }

  /** Puts members, channels and bans back, so one test's kick does not affect the next. */
  function reset() {
    discord.restore();
    for (const raw of discord.channels.values()) if (!guild.channels.cache.has(raw.id)) client.channels._add(raw, guild);
    for (const raw of discord.members.values()) guild.members._add(raw);
  }

  return { client, guild, discord, command, button, select, modal, autocomplete, emit, message, auditEntry, reset, logger, Events, gatewayPayloads };
}
