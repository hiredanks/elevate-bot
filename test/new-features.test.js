import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createWorld, ID, newId } from './harness.js';
import { createSession } from '../src/api/auth.js';
import { createApi } from '../src/api/server.js';
import { config } from '../src/config.js';
import { filledSlots, imageType, saveImage, withImage } from '../src/core/images.js';
import { closeDatabase, db } from '../src/core/db.js';
import { commandJson } from '../src/core/registry.js';
import { getSettings, updateSettings } from '../src/core/settings.js';
import { broadcastStep } from '../src/modules/broadcast.js';
import { modules } from '../src/modules/index.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let world;
let server;
let base;
let harnessFetch;
const schema = (name) => commandJson().find((c) => c.name === name);
const run = (name, opts = {}) => world.command(name, { schema: schema(name), ...opts });
const posted = (channelId) => world.discord.calls.filter((c) => c.method === 'POST' && c.route.endsWith(`/channels/${channelId}/messages`));
const DM_CHANNEL = '500000000000000000';

before(async () => {
  world = await createWorld();
  harnessFetch = globalThis.fetch;
  server = createApi(world.client, modules).listen(0);
  await new Promise((resolve) => { server.once('listening', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { world.reset(); world.discord.calls.length = 0; world.gatewayPayloads.length = 0; });
after(async () => { server.close(); await closeDatabase(); });

test('pictures are recognised by content, not by claim', () => {
  assert.equal(imageType(PNG), 'png');
  assert.equal(imageType(Buffer.from('this is not an image, honest')), null);
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
});

test('oversized or fake pictures are refused', async () => {
  assert.match(await saveImage(ID.guild, 'verify', Buffer.alloc(5 * 1024 * 1024 + 1)), /5 MB/);
  assert.match(await saveImage(ID.guild, 'verify', Buffer.from('<script>alert(1)</script>xxxx')), /PNG, JPG/);
  assert.equal((await filledSlots(ID.guild)).has('verify'), false);
});

test('a message is unchanged when no picture is set', async () => {
  const payload = { content: 'x' };
  assert.deepEqual(await withImage(ID.guild, 'goodbye', payload), { content: 'x' });
});

test('/images set stores a picture that then appears on the verify and ticket panels', async () => {
  await run('images', { sub: 'set', options: { place: 'verify', image: '700000000000000001' } });
  await run('images', { sub: 'set', options: { place: 'ticket_panel', image: '700000000000000001' } });
  await run('verification', { sub: 'setup', options: { channel: ID.general, role: ID.roleVip } });
  const verifyPost = posted(ID.general).at(-1);
  assert.equal(verifyPost.files.length, 1);
  assert.match(verifyPost.body.embeds[0].image.url, /^attachment:\/\/verify\.png$/);
  await run('ticket', { sub: 'setup', options: { channel: ID.extra } });
  assert.match(posted(ID.extra).at(-1).body.embeds[0].image.url, /ticket_panel\.png/);
});

test('the welcome message carries the card and the extra picture', async () => {
  await saveImage(ID.guild, 'welcome', PNG);
  await updateSettings(ID.guild, (s) => { s.welcome.enabled = true; s.welcome.channel = ID.general; s.welcome.card = true; });
  await world.emit('guildMemberAdd', world.guild.members.cache.get(ID.other));
  assert.equal(posted(ID.general).at(-1).files.length, 2);
  await updateSettings(ID.guild, (s) => { s.welcome.enabled = false; });
});

test('a new channel is hidden from the unverified role, but not the verify channel', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.verification, { enabled: true, channel: ID.general, role: ID.roleVip, removeRole: ID.roleMember }); });
  const created = world.client.channels._add({ id: newId(), name: 'new', type: 0, guild_id: ID.guild, position: 9, permission_overwrites: [], parent_id: null }, world.guild);
  await world.emit('channelCreate', created);
  const edit = world.discord.calls.find((c) => c.method === 'PUT' && c.route.endsWith(`/channels/${created.id}/permissions/${ID.roleMember}`));
  assert.ok(edit, 'overwrite written');
  assert.equal(BigInt(edit.body.deny) & 1024n, 1024n, 'ViewChannel denied');
  world.discord.calls.length = 0;
  await world.emit('channelCreate', world.guild.channels.cache.get(ID.general));
  assert.equal(world.discord.calls.filter((c) => c.method === 'PUT').length, 0, 'verify channel left visible');
});

test('hide-channels covers every channel and opens the verify channel', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.verification, { enabled: true, channel: ID.general, role: ID.roleVip, removeRole: ID.roleMember }); });
  const res = await run('verification', { sub: 'hide-channels' });
  assert.match(res.text, /can only see #general/);
  const allow = world.discord.calls.find((c) => c.method === 'PUT' && c.route.endsWith(`/channels/${ID.general}/permissions/${ID.roleMember}`));
  assert.equal(BigInt(allow.body.allow) & 1024n, 1024n);
  for (const id of [ID.logs, ID.voice, ID.category, ID.extra]) {
    assert.ok(world.discord.calls.find((c) => c.method === 'PUT' && c.route.endsWith(`/channels/${id}/permissions/${ID.roleMember}`)), id);
  }
});

test('new members get the unverified role, and verifying removes it', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.verification, { enabled: true, channel: ID.general, role: ID.roleVip, removeRole: ID.roleAdmin, mode: 'button', kickMinutes: 0 }); });
  await world.emit('guildMemberAdd', world.guild.members.cache.get(ID.other));
  assert.ok(world.discord.calls.find((c) => c.method === 'PUT' && c.route.endsWith(`/members/${ID.other}/roles/${ID.roleAdmin}`)));
  await world.button('verify:start', { as: ID.other });
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && c.route.endsWith(`/members/${ID.other}/roles/${ID.roleAdmin}`)));
  await updateSettings(ID.guild, (s) => { s.verification.enabled = false; s.verification.removeRole = null; });
});

test('/stay join connects muted and deafened, /stay leave disconnects', async () => {
  await run('stay', { sub: 'join', options: { channel: ID.voice } });
  const join = world.gatewayPayloads.find((p) => p.op === 4 && p.d.channel_id === ID.voice);
  assert.ok(join, 'voice state update sent');
  assert.equal(join.d.guild_id, ID.guild);
  assert.equal(join.d.self_mute, true);
  assert.equal(join.d.self_deaf, true);
  assert.equal(getSettings(ID.guild).stayvoice.channel, ID.voice);
  world.gatewayPayloads.length = 0;
  await run('stay', { sub: 'leave' });
  assert.ok(world.gatewayPayloads.find((p) => p.op === 4 && p.d.channel_id === null), 'left the channel');
  assert.equal(getSettings(ID.guild).stayvoice.enabled, false);
});

function mockGroq(respond, activeModels = []) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/openai/v1/models')) return new Response(JSON.stringify({ object: 'list', data: activeModels.map((id) => ({ id, active: true })) }), { status: 200 });
    if (String(url).includes('api.groq.com')) {
      const body = JSON.parse(init.body);
      requests.push({ headers: init.headers, body });
      return respond(body);
    }
    return harnessFetch(url, init);
  };
  return requests;
}
const groqReply = (text) => () => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

test('/ai asks Groq with the key and model, and its reply cannot ping anyone', async () => {
  await updateSettings(ID.guild, (s) => { s.ai.enabled = true; });
  const requests = mockGroq(groqReply('Hello @everyone'));
  const res = await run('ai', { sub: 'ask', options: { question: 'hi there' }, as: ID.mod });
  globalThis.fetch = harnessFetch;
  assert.equal(requests[0].headers.authorization, 'Bearer test-groq-key');
  assert.equal(requests[0].body.model, 'openai/gpt-oss-120b');
  assert.match(requests[0].body.messages.at(-1).content, /mod: hi there/);
  const edit = res.responses.find((r) => r.method === 'PATCH');
  assert.equal(edit.body.content, 'Hello @everyone');
  assert.deepEqual(edit.body.allowed_mentions.parse, []);
});

test('the AI gives clear messages for a missing key, a bad key and a busy service', async () => {
  await updateSettings(ID.guild, (s) => { s.ai.enabled = true; });
  const key = config.groqKey;
  config.groqKey = null;
  assert.match((await run('ai', { sub: 'ask', options: { question: 'a' }, as: ID.admin })).text, /GROQ_API_KEY on Render/);
  config.groqKey = key;
  mockGroq(() => new Response('{}', { status: 401 }));
  await new Promise((r) => { setTimeout(r, 4100); });
  assert.match((await run('ai', { sub: 'ask', options: { question: 'b' }, as: ID.admin })).text, /rejected/);
  globalThis.fetch = harnessFetch;
});

test('the AI replies in its channel, remembers context, and skips other channels', async () => {
  await updateSettings(ID.guild, (s) => { s.ai.enabled = true; s.ai.channel = ID.extra; s.ai.mention = false; });
  const requests = mockGroq(groqReply('Sure'));
  await world.emit('messageCreate', world.message('not for the ai', { channel: ID.general }));
  assert.equal(requests.length, 0);
  await world.emit('messageCreate', world.message('first question', { channel: ID.extra, as: ID.other }));
  assert.equal(requests.length, 1);
  await world.emit('messageCreate', world.message('second question', { channel: ID.extra, as: ID.member }));
  assert.equal(requests.length, 2);
  assert.ok(requests[1].body.messages.some((m) => /first question/.test(m.content)), 'earlier message remembered');
  globalThis.fetch = harnessFetch;
  await updateSettings(ID.guild, (s) => { s.ai.enabled = false; s.ai.channel = null; });
});

test('the AI respects the daily limit', async () => {
  await updateSettings(ID.guild, (s) => { s.ai.enabled = true; s.ai.dailyLimit = 1; });
  mockGroq(groqReply('ok'));
  await new Promise((r) => { setTimeout(r, 4100); });
  await run('ai', { sub: 'ask', options: { question: 'x' }, as: ID.owner });
  await new Promise((r) => { setTimeout(r, 4100); });
  assert.match((await run('ai', { sub: 'ask', options: { question: 'y' }, as: ID.owner })).text, /used all of its AI replies/);
  globalThis.fetch = harnessFetch;
  await updateSettings(ID.guild, (s) => { s.ai.enabled = false; s.ai.dailyLimit = 300; });
});

const groqFailure = (status, code, message) => new Response(JSON.stringify({ error: { message, code } }), { status });

test('a retired model is replaced automatically and the setting is updated', async () => {
  await updateSettings(ID.guild, (s) => { s.ai.enabled = true; s.ai.model = 'llama-3.3-70b-versatile'; });
  const requests = mockGroq((body) => (body.model === 'llama-3.3-70b-versatile'
    ? groqFailure(400, 'model_decommissioned', 'The model has been decommissioned')
    : groqReply('Back online')()), ['whisper-large-v3', 'openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  const res = await run('ai', { sub: 'ask', options: { question: 'are you there' }, as: ID.member });
  globalThis.fetch = harnessFetch;
  assert.deepEqual(requests.map((r) => r.body.model), ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b']);
  assert.equal(res.responses.find((r) => r.method === 'PATCH').body.content, 'Back online');
  assert.equal(getSettings(ID.guild).ai.model, 'openai/gpt-oss-120b');
});

test('other Groq errors are reported as they are, without changing the model', async () => {
  await updateSettings(ID.guild, (s) => { s.ai.enabled = true; s.ai.model = 'openai/gpt-oss-120b'; });
  const requests = mockGroq(() => groqFailure(400, 'invalid_request_error', 'messages is too long'), ['openai/gpt-oss-20b']);
  const res = await run('ai', { sub: 'ask', options: { question: 'hello' }, as: ID.other });
  globalThis.fetch = harnessFetch;
  assert.equal(requests.length, 1);
  assert.match(res.text, /messages is too long/);
  assert.equal(getSettings(ID.guild).ai.model, 'openai/gpt-oss-120b');
});

test('the should-say and never-say rules are sent to the AI', async () => {
  await updateSettings(ID.guild, (s) => { s.ai.enabled = true; s.ai.say = 'Recommend the VIP rank'; s.ai.neverSay = 'Never mention other servers'; });
  const requests = mockGroq(groqReply('Sure'));
  await run('ai', { sub: 'ask', options: { question: 'what should I buy' }, as: ID.mod });
  globalThis.fetch = harnessFetch;
  const system = requests[0].body.messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /Recommend the VIP rank/);
  assert.match(system.content, /Never say or do any of the following[\s\S]*Never mention other servers/);
  await updateSettings(ID.guild, (s) => { s.ai.say = ''; s.ai.neverSay = ''; });
});

test('a reply containing a blocked word is never posted', async () => {
  await updateSettings(ID.guild, (s) => { s.ai.enabled = true; s.ai.blockedWords = ['SecretServer']; });
  mockGroq(groqReply('You should join secretserver instead'));
  const res = await run('ai', { sub: 'ask', options: { question: 'best server' }, as: ID.admin });
  globalThis.fetch = harnessFetch;
  const content = res.responses.find((r) => r.method === 'PATCH').body.content;
  assert.equal(content, 'I can\'t talk about that.');
  assert.doesNotMatch(res.text, /secretserver/i);
  await updateSettings(ID.guild, (s) => { s.ai.blockedWords = []; });
});

test('/ai prompt edits the rules, shows them, and needs Manage Server', async () => {
  await new Promise((r) => { setTimeout(r, 4100); });
  assert.match((await run('ai', { sub: 'prompt', options: { say: 'x' }, as: ID.member })).text, /Manage Server/);
  assert.equal(getSettings(ID.guild).ai.say, '');
  await run('ai', { sub: 'prompt', options: { main: 'You are a pirate', say: 'Say arr', never_say: 'No swearing' }, as: ID.owner });
  assert.equal(getSettings(ID.guild).ai.systemPrompt, 'You are a pirate');
  assert.equal(getSettings(ID.guild).ai.say, 'Say arr');
  assert.equal(getSettings(ID.guild).ai.neverSay, 'No swearing');
  await new Promise((r) => { setTimeout(r, 4100); });
  assert.match((await run('ai', { sub: 'prompt', as: ID.owner })).text, /You are a pirate/);
  await new Promise((r) => { setTimeout(r, 4100); });
  await run('ai', { sub: 'prompt', options: { say: 'none' }, as: ID.owner });
  assert.equal(getSettings(ID.guild).ai.say, '');
  await updateSettings(ID.guild, (s) => { s.ai.enabled = false; s.ai.neverSay = ''; });
});

async function clearBroadcasts() {
  await db.run('DELETE FROM broadcasts');
  await db.run('DELETE FROM broadcast_recipients');
  await db.run('DELETE FROM broadcast_subscribers');
}
const dmsSent = () => posted(DM_CHANNEL);

test('only the owner can message everyone', async () => {
  await clearBroadcasts();
  const res = await run('broadcast', { sub: 'send', options: { message: 'hi' }, as: ID.admin });
  assert.match(res.text, /Only the server owner/);
});

test('broadcast asks first, then pings @everyone and DMs only people who opted in', async () => {
  await clearBroadcasts();
  await world.button(`broadcast:toggle:${ID.guild}`, { as: ID.other });
  const preview = await run('broadcast', { sub: 'send', options: { message: 'Big news', channel: ID.general } });
  assert.match(preview.text, /Send to everyone\?/);
  assert.equal(posted(ID.general).length, 0, 'nothing posted before confirming');
  const draftId = preview.text.match(/broadcast:confirm:([\w-]+)/)[1];
  await world.button(`broadcast:confirm:${draftId}`, { as: ID.owner });

  const post = posted(ID.general).at(-1);
  assert.equal(post.body.content, '@everyone');
  assert.deepEqual(post.body.allowed_mentions.parse, ['everyone']);
  assert.match(JSON.stringify(post.body.embeds), /Big news/);

  await broadcastStep(world.client);
  await broadcastStep(world.client);
  assert.equal(dmsSent().length, 1, 'exactly one DM, to the one person who opted in');
  const row = await db.one('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1');
  assert.equal(row.status, 'done');
  assert.equal(row.sent, 1);
});

test('nobody is DMed without opting in', async () => {
  await clearBroadcasts();
  const preview = await run('broadcast', { sub: 'send', options: { message: 'Quiet', channel: ID.general } });
  await world.button(`broadcast:confirm:${preview.text.match(/broadcast:confirm:([\w-]+)/)[1]}`, { as: ID.owner });
  await broadcastStep(world.client);
  assert.equal(dmsSent().length, 0);
});

test('only the same person can confirm a broadcast draft', async () => {
  await clearBroadcasts();
  const preview = await run('broadcast', { sub: 'send', options: { message: 'Mine', channel: ID.general } });
  const id = preview.text.match(/broadcast:confirm:([\w-]+)/)[1];
  assert.match((await world.button(`broadcast:confirm:${id}`, { as: ID.admin })).text, /expired/);
  assert.equal(posted(ID.general).length, 0);
});

test('only one broadcast per hour', async () => {
  await clearBroadcasts();
  const send = async () => {
    const p = await run('broadcast', { sub: 'send', options: { message: 'Again', channel: ID.general } });
    return world.button(`broadcast:confirm:${p.text.match(/broadcast:confirm:([\w-]+)/)[1]}`, { as: ID.owner });
  };
  await send();
  const second = await send();
  assert.match(second.text, /again in/);
  assert.equal(posted(ID.general).length, 1);
});

test('the opt-out button stops future DMs', async () => {
  await clearBroadcasts();
  await world.button(`broadcast:toggle:${ID.guild}`, { as: ID.other });
  assert.ok(await db.one('SELECT 1 AS y FROM broadcast_subscribers WHERE user_id = $1', [ID.other]));
  await world.button(`broadcast:toggle:${ID.guild}`, { as: ID.other });
  assert.equal(await db.one('SELECT 1 AS y FROM broadcast_subscribers WHERE user_id = $1', [ID.other]), null);
});

test('DMs stop immediately if Discord objects', async () => {
  await clearBroadcasts();
  for (const id of [ID.other, ID.member]) await db.run('INSERT INTO broadcast_subscribers VALUES ($1, $2)', [ID.guild, id]);
  const preview = await run('broadcast', { sub: 'send', options: { message: 'Slow down', channel: ID.general } });
  await world.button(`broadcast:confirm:${preview.text.match(/broadcast:confirm:([\w-]+)/)[1]}`, { as: ID.owner });
  const realRequest = world.client.rest.request;
  world.client.rest.request = async (options) => {
    if (options.fullRoute.endsWith(`/channels/${DM_CHANNEL}/messages`)) throw Object.assign(new Error('You are opening direct messages too fast'), { code: 40003 });
    return realRequest(options);
  };
  await broadcastStep(world.client);
  world.client.rest.request = realRequest;
  const row = await db.one('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1');
  assert.equal(row.status, 'stopped');
  assert.equal((await db.all('SELECT 1 FROM broadcast_recipients WHERE broadcast_id = $1', [row.id])).length, 0);
});

test('invite logs show who joined, who invited them, and who left', async () => {
  const { Collection } = await import('discord.js');
  let timesUsed = 0;
  world.guild.invites.fetch = async () => new Collection([['abc', { code: 'abc', uses: timesUsed, inviterId: ID.mod }]]);
  await db.run('DELETE FROM invite_log');
  await updateSettings(ID.guild, (s) => { s.invites.logChannel = ID.logs; });
  await world.emit('guildMemberAdd', world.guild.members.cache.get(ID.other));
  assert.match(JSON.stringify(posted(ID.logs).at(-1).body.embeds), /unknown/, 'no invite matched, so the log says unknown');

  timesUsed = 1;
  await world.emit('guildMemberAdd', world.guild.members.cache.get(ID.member));
  const joined = JSON.stringify(posted(ID.logs).at(-1).body.embeds);
  assert.match(joined, /Member joined/);
  assert.ok(joined.includes(`<@${ID.mod}>`), 'names the inviter');
  assert.match(joined, /`abc`/);
  assert.match(joined, /Their invites now:\*\* 1/);

  await world.emit('guildMemberRemove', world.guild.members.cache.get(ID.member));
  const left = JSON.stringify(posted(ID.logs).at(-1).body.embeds);
  assert.match(left, /Member left/);
  assert.ok(left.includes(`<@${ID.mod}>`));
  assert.match(left, /Their invites now:\*\* 0/);

  delete world.guild.invites.fetch;
  await updateSettings(ID.guild, (s) => { s.invites.logChannel = null; });
});

test('/invites log needs Manage Server', async () => {
  assert.match((await run('invites', { sub: 'log', options: { channel: ID.logs }, as: ID.member })).text, /Manage Server/);
  assert.equal(getSettings(ID.guild).invites.logChannel, null);
  await run('invites', { sub: 'log', options: { channel: ID.logs }, as: ID.admin });
  assert.equal(getSettings(ID.guild).invites.logChannel, ID.logs);
  await updateSettings(ID.guild, (s) => { s.invites.logChannel = null; });
});

test('/dm reaches one member, is logged with the sender, and needs a moderator', async () => {
  await updateSettings(ID.guild, (s) => { s.moderation.logChannel = ID.logs; });
  assert.match((await run('dm', { options: { user: ID.other, message: 'hi' }, as: ID.member })).text, /do not have permission/);
  assert.equal(dmsSent().length, 0);
  await run('dm', { options: { user: ID.other, message: 'Please read the rules' }, as: ID.mod });
  assert.equal(dmsSent().length, 1);
  assert.match(JSON.stringify(dmsSent()[0].body.embeds), /Please read the rules/);
  const log = JSON.stringify(posted(ID.logs).at(-1).body.embeds);
  assert.match(log, /DM sent by staff/);
  assert.ok(log.includes(`<@${ID.mod}>`), 'records who sent it');
  await updateSettings(ID.guild, (s) => { s.moderation.logChannel = null; });
});

test('/dm explains when someone has DMs closed', async () => {
  const realRequest = world.client.rest.request;
  world.client.rest.request = async (options) => {
    if (options.fullRoute.endsWith(`/channels/${DM_CHANNEL}/messages`)) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    return realRequest(options);
  };
  const res = await run('dm', { options: { user: ID.other, message: 'hello' }, as: ID.admin });
  world.client.rest.request = realRequest;
  assert.match(res.text, /does not accept DMs/);
});

const dmAllSend = async (message) => {
  const preview = await run('dm-all', { sub: 'send', options: { message } });
  return world.button(`broadcast:confirm:${preview.text.match(/broadcast:confirm:([\w-]+)/)[1]}`, { as: ID.owner });
};

test('/dm-all is owner-only and refuses when nobody signed up', async () => {
  await clearBroadcasts();
  assert.match((await run('dm-all', { sub: 'send', options: { message: 'x' }, as: ID.admin })).text, /Only the server owner/);
  assert.match((await run('dm-all', { sub: 'send', options: { message: 'x' } })).text, /Nobody has signed up/);
});

test('/dm-all messages only members who signed up, and posts nothing in channels', async () => {
  await clearBroadcasts();
  await db.run('INSERT INTO broadcast_subscribers VALUES ($1, $2)', [ID.guild, ID.other]);
  await dmAllSend('Members only news');
  assert.equal(posted(ID.general).length, 0, 'no channel post');
  assert.equal(world.discord.calls.filter((c) => /@everyone/.test(c.body?.content ?? '')).length, 0, 'no @everyone');
  await broadcastStep(world.client);
  await broadcastStep(world.client);
  assert.equal(dmsSent().length, 1, 'one signed-up member, one DM');
  const row = await db.one('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1');
  assert.equal(row.channel_id, 'dm');
  assert.equal(row.status, 'done');
  assert.equal(row.sent, 1);
});

test('/dm-all shares the one-per-hour limit', async () => {
  await clearBroadcasts();
  await db.run('INSERT INTO broadcast_subscribers VALUES ($1, $2)', [ID.guild, ID.other]);
  await dmAllSend('First');
  assert.match((await dmAllSend('Second')).text, /again in/);
});

test('/dm-all panel posts a sign-up button that works', async () => {
  await clearBroadcasts();
  await run('dm-all', { sub: 'panel', options: { channel: ID.extra } });
  const panel = posted(ID.extra).at(-1);
  assert.equal(panel.body.components[0].components[0].custom_id, `broadcast:toggle:${ID.guild}`);
  await world.button(`broadcast:toggle:${ID.guild}`, { as: ID.member });
  assert.ok(await db.one('SELECT 1 AS y FROM broadcast_subscribers WHERE user_id = $1', [ID.member]));
});

async function http(method, path, as, body) {
  const token = await createSession({ userId: as, username: 'x', guilds: [] });
  const res = await harnessRealFetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}
const harnessRealFetch = (...args) => realFetchRef(...args);
const { fetch: realFetchRef } = await import('undici').catch(() => ({ fetch: globalThis.fetch }));
const G = `/api/guilds/${ID.guild}`;

test('pictures can be uploaded, read and removed through the website API', async () => {
  const data = PNG.toString('base64');
  assert.equal((await http('POST', `${G}/images/goodbye`, ID.admin, { data })).status, 200);
  assert.ok((await http('GET', `${G}/images`, ID.admin)).json.slots.find((s) => s.id === 'goodbye').hasImage);
  assert.match((await http('GET', `${G}/images/goodbye`, ID.admin)).json.dataUrl, /^data:image\/png;base64,/);
  const bad = await http('POST', `${G}/images/goodbye`, ID.admin, { data: Buffer.from('nope, not a picture').toString('base64') });
  assert.equal(bad.status, 400);
  assert.equal((await http('POST', `${G}/images/nonsense`, ID.admin, { data })).status, 404);
  assert.equal((await http('POST', `${G}/images/goodbye`, ID.member, { data })).status, 403);
  assert.equal((await http('DELETE', `${G}/images/goodbye`, ID.admin)).status, 200);
  assert.equal((await http('GET', `${G}/images/goodbye`, ID.admin)).status, 404);
});

test('message-everyone on the website is owner-only', async () => {
  await clearBroadcasts();
  assert.equal((await http('GET', `${G}/collections/broadcasts`, ID.admin)).status, 403);
  assert.equal((await http('POST', `${G}/collections/broadcasts`, ID.admin, { row: { message: 'x', channel_id: ID.general } })).status, 403);
  const sent = await http('POST', `${G}/collections/broadcasts`, ID.owner, { row: { message: 'From the site', channel_id: ID.general } });
  assert.equal(sent.status, 200);
  assert.match(sent.json.rows[0].dms, /0 of 0/);
  assert.equal(posted(ID.general).at(-1).body.content, '@everyone');
});

test('the DM page on the website is owner-only and reaches only signed-up members', async () => {
  await clearBroadcasts();
  assert.equal((await http('GET', `${G}/collections/dmall`, ID.admin)).status, 403);
  const none = await http('POST', `${G}/collections/dmall`, ID.owner, { row: { message: 'x' } });
  assert.equal(none.status, 400);
  assert.match(none.json.error, /Nobody has signed up/);
  await db.run('INSERT INTO broadcast_subscribers VALUES ($1, $2)', [ID.guild, ID.other]);
  const sent = await http('POST', `${G}/collections/dmall`, ID.owner, { row: { message: 'Hello' } });
  assert.equal(sent.status, 200);
  assert.match(sent.json.rows[0].dms, /of 1/);
  assert.equal(posted(ID.general).length, 0);
  assert.equal((await http('GET', `${G}/collections/broadcasts`, ID.owner)).json.rows.length, 0, 'kept off the @everyone history');
});

test('the invite log channel can be set on the website', async () => {
  assert.equal((await http('PATCH', `${G}/settings/invites`, ID.admin, { values: { logChannel: ID.logs } })).status, 200);
  assert.equal(getSettings(ID.guild).invites.logChannel, ID.logs);
  await updateSettings(ID.guild, (s) => { s.invites.logChannel = null; });
});

test('saving voice settings on the website joins the channel', async () => {
  const res = await http('PATCH', `${G}/settings/stayvoice`, ID.owner, { values: { enabled: true, channel: ID.voice } });
  assert.equal(res.status, 200);
  assert.ok(world.gatewayPayloads.find((p) => p.op === 4 && p.d.channel_id === ID.voice));
  await updateSettings(ID.guild, (s) => { s.stayvoice.enabled = false; });
});

test('choosing an unverified role on the website hides channels straight away', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.verification, { enabled: true, channel: ID.general, role: ID.roleVip, removeRole: null }); });
  await http('PATCH', `${G}/settings/verification`, ID.owner, { values: { removeRole: ID.roleMember } });
  await new Promise((r) => { setTimeout(r, 200); });
  assert.ok(world.discord.calls.find((c) => c.method === 'PUT' && c.route.endsWith(`/channels/${ID.logs}/permissions/${ID.roleMember}`)));
  await updateSettings(ID.guild, (s) => { s.verification.enabled = false; s.verification.removeRole = null; });
});
