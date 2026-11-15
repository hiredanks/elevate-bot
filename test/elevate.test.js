import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createWorld, ID } from './harness.js';
import { createSession } from '../src/api/auth.js';
import { createApi } from '../src/api/server.js';
import { closeDatabase, db } from '../src/core/db.js';
import { commandJson } from '../src/core/registry.js';
import { updateSettings } from '../src/core/settings.js';
import { modules } from '../src/modules/index.js';

const { fetch: httpFetch } = await import('undici').catch(() => ({ fetch: globalThis.fetch }));
let world;
let base;
let server;
const schema = (name) => commandJson().find((c) => c.name === name);
const run = (name, opts = {}) => world.command(name, { schema: schema(name), ...opts });
const hookSends = () => world.discord.calls.filter((c) => c.method === 'POST' && /^\/webhooks\/\d+\/hooktoken$/.test(c.route));
const posted = (channelId) => world.discord.calls.filter((c) => c.method === 'POST' && c.route.endsWith(`/channels/${channelId}/messages`));
const G = `/api/guilds/${ID.guild}`;

before(async () => {
  world = await createWorld();
  server = createApi(world.client, modules).listen(0);
  await new Promise((resolve) => { server.once('listening', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { world.reset(); world.discord.calls.length = 0; });
after(async () => { server.close(); await closeDatabase(); });

async function http(method, path, as, body) {
  const token = await createSession({ userId: as, username: 'x', guilds: [] });
  const res = await httpFetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}

test('/webhook posts under the chosen name and picture, without pings, and logs the real sender', async () => {
  await updateSettings(ID.guild, (s) => { s.moderation.logChannel = ID.logs; });
  await run('webhook', { options: { channel: ID.general, message: 'Event tonight', name: 'ELEVATE Team', avatar_url: 'https://cdn.example.com/a.png', title: 'News' }, as: ID.admin });
  const [send] = hookSends();
  assert.ok(send, 'sent through a webhook');
  assert.equal(send.body.username, 'ELEVATE Team');
  assert.equal(send.body.avatar_url, 'https://cdn.example.com/a.png');
  assert.equal(send.body.content, 'Event tonight');
  assert.equal(send.body.embeds[0].title, 'News');
  assert.deepEqual(send.body.allowed_mentions.parse, []);
  const log = JSON.stringify(posted(ID.logs).at(-1).body.embeds);
  assert.ok(log.includes(`<@${ID.admin}>`) && log.includes('ELEVATE Team'), 'log names who really sent it');
  await updateSettings(ID.guild, (s) => { s.moderation.logChannel = null; });
});

test('the webhook is created once per channel and then reused', async () => {
  await run('webhook', { options: { channel: ID.extra, message: 'one' }, as: ID.admin });
  await run('webhook', { options: { channel: ID.extra, message: 'two' }, as: ID.owner });
  const created = world.discord.calls.filter((c) => c.method === 'POST' && c.route === `/channels/${ID.extra}/webhooks`);
  assert.equal(created.length, 1);
  assert.equal(hookSends().length, 2);
});

test('bad names and links are refused before anything is sent', async () => {
  assert.match((await run('webhook', { options: { channel: ID.general, message: 'x', name: 'Discord Staff' }, as: ID.admin })).text, /does not allow/);
  assert.match((await run('webhook', { options: { channel: ID.general, message: 'x', avatar_url: 'http://insecure.example/a.png' }, as: ID.owner })).text, /https/);
  assert.equal(hookSends().length, 0);
});

test('members without Manage Webhooks cannot use it', async () => {
  assert.match((await run('webhook', { options: { channel: ID.general, message: 'x' }, as: ID.mod })).text, /do not have permission/);
  assert.equal(hookSends().length, 0);
});

test('the website sends, lists and deletes webhook messages', async () => {
  const sent = await http('POST', `${G}/collections/webhooks`, ID.owner, { row: { channel_id: ID.general, username: 'Announcer', content: '@everyone big news', pings: 'Ping everyone' } });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.rows[0].username, 'Announcer');
  assert.deepEqual(hookSends()[0].body.allowed_mentions.parse.sort(), ['everyone', 'roles']);
  const bad = await http('POST', `${G}/collections/webhooks`, ID.owner, { row: { channel_id: ID.general, content: 'x', color: 'purple' } });
  assert.equal(bad.status, 400);
  const empty = await http('POST', `${G}/collections/webhooks`, ID.owner, { row: { channel_id: ID.general } });
  assert.match(empty.json.error, /Write a message/);
  const id = sent.json.rows[0].id;
  world.discord.calls.length = 0;
  await http('DELETE', `${G}/collections/webhooks/${id}`, ID.owner);
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && /\/webhooks\/\d+\/hooktoken\/messages\//.test(c.route)), 'message deleted from Discord');
  assert.equal(await db.one('SELECT 1 AS y FROM webhook_messages WHERE id = $1', [id]), null);
});

test('the website posts a self-role menu with the chosen roles', async () => {
  const res = await http('POST', `${G}/collections/panels`, ID.admin, { row: { title: 'Pick a colour', channel_id: ID.general, roles: [ID.roleVip, ID.roleMember], style: 'Buttons', mode: 'Only one' } });
  assert.equal(res.status, 200);
  const post = posted(ID.general).at(-1);
  const ids = post.body.components.flatMap((row) => row.components.map((c) => c.custom_id));
  assert.equal(ids.length, 2);
  assert.ok(ids.every((id) => id.startsWith('panel:btn:')));
  assert.equal(res.json.rows[0].mode, 'Only one');
  assert.deepEqual(res.json.rows[0].roles, [ID.roleVip, ID.roleMember]);
});

test('self-role menus refuse admin roles and need at least one role', async () => {
  const admin = await http('POST', `${G}/collections/panels`, ID.admin, { row: { title: 'x', channel_id: ID.general, roles: [ID.roleAdmin] } });
  assert.equal(admin.status, 400);
  assert.match(admin.json.error, /admin-level|above/);
  const none = await http('POST', `${G}/collections/panels`, ID.admin, { row: { title: 'x', channel_id: ID.general, roles: [] } });
  assert.match(none.json.error, /at least one role/);
});

test('removing a self-role menu on the website deletes its message', async () => {
  const res = await http('POST', `${G}/collections/panels`, ID.owner, { row: { title: 'Temp', channel_id: ID.general, roles: [ID.roleVip] } });
  const panel = await db.one('SELECT * FROM role_panels WHERE id = $1', [res.json.rows[0].id]);
  world.discord.calls.length = 0;
  await http('DELETE', `${G}/collections/panels/${panel.id}`, ID.owner);
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && c.route.endsWith(`/messages/${panel.message_id}`)));
});

test('passing verification offers the DM sign-up button', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.verification, { enabled: true, channel: ID.general, role: ID.roleVip, removeRole: null, mode: 'button' }); });
  const res = await world.button('verify:start', { as: ID.other });
  assert.match(res.text, /verified/i);
  assert.ok(res.text.includes(`broadcast:toggle:${ID.guild}`));
  await world.button(`broadcast:toggle:${ID.guild}`, { as: ID.other });
  assert.ok(await db.one('SELECT 1 AS y FROM broadcast_subscribers WHERE user_id = $1', [ID.other]));
});
