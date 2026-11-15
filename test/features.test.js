import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { AuditLogEvent as A } from 'discord.js';
import { createWorld, ID } from './harness.js';
import { closeDatabase, db } from '../src/core/db.js';
import { jobs } from '../src/core/jobs.js';
import { commandJson } from '../src/core/registry.js';
import { getSettings, updateSettings } from '../src/core/settings.js';
import { formatDuration, parseDuration, parseEmoji, render } from '../src/core/util.js';
import { extractHosts, inspectContent, inspectRate } from '../src/modules/automod.js';
import { recordAction } from '../src/modules/antinuke.js';
import { spendCredits, addCredits, transferCredits, slotsPayout } from '../src/modules/economy.js';
import { drawOne } from '../src/modules/giveaways.js';
import { levelFromXp, xpForLevel } from '../src/modules/leveling.js';
import { matchResponder } from '../src/modules/custom.js';

let world;
const schema = (name) => commandJson().find((c) => c.name === name);
const run = (name, opts = {}) => world.command(name, { schema: schema(name), ...opts });
// discord.js adds one role with PUT, and several at once by PATCHing the member's whole role list.
const gaveRole = (userId, roleId) => world.discord.calls.some((c) => (c.method === 'PUT' && c.route.endsWith(`/members/${userId}/roles/${roleId}`))
  || (c.method === 'PATCH' && c.route.endsWith(`/members/${userId}`) && c.body?.roles?.includes(roleId)));
before(async () => { world = await createWorld(); });
beforeEach(() => { world.reset(); world.discord.calls.length = 0; });
after(async () => { await closeDatabase(); });

test('durations parse strictly', () => {
  assert.equal(parseDuration('1d2h'), 864e5 + 72e5);
  assert.equal(parseDuration('90m'), 54e5);
  for (const bad of ['', 'abc', '10', '5x', '-1h', '1h;drop']) assert.equal(parseDuration(bad), null, bad);
  assert.equal(formatDuration(36e5), '1h');
});

test('templates substitute once and cannot be injected through a value', () => {
  assert.equal(render('hi {user}\\nbye {nope}', { user: 'X' }), 'hi X\nbye {nope}');
  assert.equal(render('{name}', { name: '{secret}', secret: 'leak' }), '{secret}');
});

test('emoji parsing normalises variation selectors and rejects text', () => {
  assert.equal(parseEmoji('❤️').key, '❤');
  assert.equal(parseEmoji('<:cool:123456789012345678>').key, '123456789012345678');
  assert.equal(parseEmoji('hello'), null);
});

test('level math is consistent at every boundary', () => {
  for (let level = 0; level < 200; level += 1) {
    assert.equal(levelFromXp(xpForLevel(level)), level);
    if (level > 0) assert.equal(levelFromXp(xpForLevel(level) - 1), level - 1);
  }
});

const automodConfig = (overrides) => {
  const base = structuredClone(getSettings('fresh-guild').automod);
  for (const [name, patch] of Object.entries(overrides)) Object.assign(base.filters[name], { enabled: true }, patch);
  return base;
};

test('automod content filters catch what they should and leave normal chat alone', () => {
  const cfg = automodConfig({
    scam: {}, invites: {}, links: { allow: ['youtube.com'] }, badwords: { words: ['badword', 'كلمة'] }, caps: {}, emoji: { max: 3 }, mentions: { max: 2 }, newlines: { max: 2 }, zalgo: {},
  });
  const expectHit = (text, filter, extra) => assert.equal(inspectContent(cfg, text, extra)?.filter, filter, text);
  expectHit('free nitro here https://dlscord-gift.ru/x', 'scam');
  expectHit('join discord.gg/abc', 'invites');
  expectHit('look at evil.com/x', 'links');
  expectHit('you b4dw0rd', 'badwords');
  expectHit('هذه كلمة سيئة', 'badwords');
  expectHit('THIS IS ALL CAPS MESSAGE', 'caps');
  expectHit('😀😀😀😀', 'emoji');
  expectHit('hello', 'mentions', { mentions: 3 });
  expectHit('a\nb\nc\nd', 'newlines');
  expectHit('z̴̢͝a̵̛͜l̶͠͝g̷͘͝o̸͘͠', 'zalgo');
  for (const safe of ['hello everyone', 'watch https://www.youtube.com/watch?v=1', 'node.js is nice', 'Nobody said badwords here', 'A normal Sentence.']) {
    assert.equal(inspectContent(cfg, safe), null, safe);
  }
  assert.deepEqual(extractHosts('see HTTPS://Foo.com/x and bar.net'), ['foo.com', 'bar.net']);
});

test('real discord and steam links are not treated as scams', () => {
  const cfg = automodConfig({ scam: {} });
  assert.equal(inspectContent(cfg, 'free nitro? https://discord.com/nitro'), null);
  assert.equal(inspectContent(cfg, 'steam gift https://steamcommunity.com/gift/1'), null);
});

test('automod rate limits trigger once and return messages to clean up', () => {
  const cfg = automodConfig({ spam: { count: 3, seconds: 5 } });
  const msg = (id) => ({ id, channelId: 'c', content: `m${id}` });
  assert.equal(inspectRate(cfg, 'k', msg('1'), 1000), null);
  assert.equal(inspectRate(cfg, 'k', msg('2'), 2000), null);
  assert.deepEqual(inspectRate(cfg, 'k', msg('3'), 3000).purge, ['1', '2', '3']);
  assert.equal(inspectRate(cfg, 'k', msg('4'), 3100), null);
});

test('automod deletes the message, blocks XP and logs a case end to end', async () => {
  await updateSettings(ID.guild, (s) => { s.automod.enabled = true; s.automod.filters.badwords.enabled = true; s.automod.filters.badwords.action = 'warn'; s.automod.filters.badwords.words = ['forbidden']; });
  const m = world.message('this is forbidden');
  await db.run('DELETE FROM members WHERE user_id = $1', [ID.member]);
  await world.emit('messageCreate', m);
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && c.route.endsWith(`/messages/${m.id}`)), 'message deleted');
  assert.equal(await db.one('SELECT xp FROM members WHERE user_id = $1', [ID.member]), null, 'blocked message earned no XP');
  assert.ok(await db.one("SELECT 1 AS y FROM cases WHERE user_id = $1 AND reason LIKE 'AutoMod%' AND type = 'warn'", [ID.member]));
  await updateSettings(ID.guild, (s) => { s.automod.enabled = false; });
});

test('staff are exempt from automod', async () => {
  await updateSettings(ID.guild, (s) => { s.automod.enabled = true; s.automod.filters.badwords.enabled = true; s.automod.filters.badwords.words = ['forbidden']; });
  const m = world.message('forbidden', { as: ID.mod });
  await world.emit('messageCreate', m);
  assert.ok(!world.discord.calls.find((c) => c.method === 'DELETE' && c.route.endsWith(`/messages/${m.id}`)));
  await updateSettings(ID.guild, (s) => { s.automod.enabled = false; });
});

test('anti-nuke window counts only recent actions', () => {
  const rule = { count: 3, seconds: 10 };
  assert.equal(recordAction('x', { targetId: 1 }, rule, 0), null);
  assert.equal(recordAction('x', { targetId: 2 }, rule, 20_000), null);
  assert.equal(recordAction('x', { targetId: 3 }, rule, 21_000), null);
  assert.equal(recordAction('x', { targetId: 4 }, rule, 22_000).length, 3);
});

test('anti-nuke bans a rogue admin and restores deleted channels', async () => {
  await updateSettings(ID.guild, (s) => { s.antinuke.enabled = true; s.antinuke.limits.channelDelete = { count: 2, seconds: 30 }; s.antinuke.logChannel = ID.logs; });
  for (const id of [ID.extra, ID.voice]) {
    const channel = world.guild.channels.cache.get(id);
    await world.emit('channelDelete', channel);
    world.guild.channels.cache.delete(id);
    await world.emit('guildAuditLogEntryCreate', world.auditEntry(A.ChannelDelete, ID.admin, id), world.guild);
  }
  assert.ok(world.discord.bans.has(ID.admin), 'attacker banned');
  const recreated = world.discord.calls.filter((c) => c.method === 'POST' && /^\/guilds\/\d+\/channels$/.test(c.route));
  assert.deepEqual(recreated.map((c) => c.body.name).sort(), ['extra', 'voice']);
  await updateSettings(ID.guild, (s) => { s.antinuke.enabled = false; });
});

test('anti-nuke ignores the owner and whitelisted users, and only they can configure it', async () => {
  await updateSettings(ID.guild, (s) => { s.antinuke.enabled = true; s.antinuke.limits.channelDelete = { count: 1, seconds: 30 }; s.antinuke.whitelist = [ID.mod]; });
  await world.emit('guildAuditLogEntryCreate', world.auditEntry(A.ChannelDelete, ID.owner, ID.extra), world.guild);
  await world.emit('guildAuditLogEntryCreate', world.auditEntry(A.ChannelDelete, ID.mod, ID.extra), world.guild);
  assert.equal(world.discord.bans.size, 0);
  const denied = await run('antinuke', { sub: 'power', options: { enabled: false }, as: ID.admin });
  assert.match(denied.text, /Only the server owner/);
  assert.equal(getSettings(ID.guild).antinuke.enabled, true);
  await updateSettings(ID.guild, (s) => { s.antinuke.enabled = false; s.antinuke.whitelist = []; });
});

test('lockdown remembers and restores each channel\'s previous state', async () => {
  const before = world.discord.calls.length;
  await run('lockdown', { sub: 'on' });
  const locked = world.discord.calls.slice(before).filter((c) => c.method === 'PUT' && c.route.includes('/permissions/'));
  assert.ok(locked.length >= 2);
  assert.ok(Object.keys(getSettings(ID.guild).antiraid.lockState).length >= 2);
  await run('lockdown', { sub: 'off' });
  assert.deepEqual(getSettings(ID.guild).antiraid.lockState, {});
});

test('credits cannot be overspent, even by concurrent requests', async () => {
  await db.run('DELETE FROM members WHERE user_id = $1', [ID.other]);
  await addCredits(ID.guild, ID.other, 100);
  const results = await Promise.all(Array.from({ length: 5 }, () => spendCredits(ID.guild, ID.other, 60)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await db.one('SELECT credits FROM members WHERE user_id = $1', [ID.other])).credits, 40);
  assert.equal(await transferCredits(ID.guild, ID.other, ID.member, 41), false);
  assert.equal(await transferCredits(ID.guild, ID.other, ID.member, 40), true);
  assert.equal((await db.one('SELECT credits FROM members WHERE user_id = $1', [ID.other])).credits, 0);
});

test('slot payouts follow the table', () => {
  assert.equal(slotsPayout(['💎', '💎', '💎'], 10), 100);
  assert.equal(slotsPayout(['⭐', '⭐', '⭐'], 10), 50);
  assert.equal(slotsPayout(['⭐', '⭐', '🍒'], 10), 20);
  assert.equal(slotsPayout(['⭐', '🍋', '🍒'], 10), 0);
});

test('weighted draw removes the winner and respects weights', () => {
  const pool = [{ user_id: 'a', weight: 1 }, { user_id: 'b', weight: 1 }];
  const first = drawOne(pool);
  assert.equal(pool.length, 1);
  assert.notEqual(pool[0].user_id, first.user_id);
  let heavy = 0;
  for (let n = 0; n < 2000; n += 1) if (drawOne([{ user_id: 'x', weight: 3 }, { user_id: 'y', weight: 1 }]).user_id === 'x') heavy += 1;
  assert.ok(heavy > 1350 && heavy < 1650, String(heavy));
});

test('a giveaway takes entries, enforces requirements and draws once', async () => {
  await run('giveaway', { sub: 'start', options: { duration: '1h', prize: 'Prize', required_role: ID.roleMember, winners: 1 } });
  const g = await db.one("SELECT * FROM giveaways WHERE prize = 'Prize' ORDER BY id DESC LIMIT 1");
  assert.ok(g.message_id);
  assert.match((await world.button(`gw:enter:${g.id}`, { as: ID.mod })).text, /You need/);
  assert.match((await world.button(`gw:enter:${g.id}`, { as: ID.member })).text, /You are in/);
  assert.match((await world.button(`gw:enter:${g.id}`, { as: ID.member })).text, /already entered/);

  const [job] = await jobs.list('giveaway:end', ID.guild, String(g.id));
  assert.ok(job, 'end job scheduled');
  await jobs.tick(world.client, job.run_at + 1);
  const ended = await db.one('SELECT * FROM giveaways WHERE id = $1', [g.id]);
  assert.equal(ended.ended, true);
  assert.deepEqual(ended.winner_ids, [ID.member]);
  assert.equal((await jobs.list('giveaway:end', ID.guild, String(g.id))).length, 0);
  assert.match((await run('giveaway', { sub: 'reroll', options: { id: g.id } })).text, /no other entries/);
});

test('a drop can only be claimed by the first click', async () => {
  await run('giveaway', { sub: 'drop', options: { prize: 'Drop' } });
  const g = await db.one("SELECT * FROM giveaways WHERE prize = 'Drop' ORDER BY id DESC LIMIT 1");
  assert.match((await world.button(`gw:claim:${g.id}`, { as: ID.member })).text, /claimed/);
  assert.match((await world.button(`gw:claim:${g.id}`, { as: ID.other })).text, /Too late/);
});

test('temporary bans schedule an unban that survives as a job', async () => {
  await run('ban', { options: { user: ID.other, duration: '1h', reason: 'temp' } });
  assert.ok(world.discord.bans.has(ID.other));
  const [job] = await jobs.list('mod:unban', ID.guild, ID.other);
  assert.ok(job);
  world.client.guilds.cache.get(ID.guild).bans.cache.clear();
  await jobs.tick(world.client, job.run_at + 1);
  assert.ok(!world.discord.bans.has(ID.other));
});

test('messages earn XP once per cooldown, then level up and grant the reward', async () => {
  await db.run('DELETE FROM members WHERE user_id = $1', [ID.other]);
  await updateSettings(ID.guild, (s) => { s.leveling.xpMin = 150; s.leveling.xpMax = 150; s.leveling.rewards = [{ level: 1, roleId: ID.roleVip }]; });
  await world.emit('messageCreate', world.message('hi', { as: ID.other }));
  await world.emit('messageCreate', world.message('hi again', { as: ID.other }));
  assert.equal((await db.one('SELECT xp FROM members WHERE user_id = $1', [ID.other])).xp, 150);
  assert.ok(gaveRole(ID.other, ID.roleVip), 'reward role added');
  assert.ok(world.discord.calls.find((c) => c.method === 'POST' && c.route.endsWith(`/channels/${ID.general}/messages`) && /level \*\*1\*\*/.test(c.body.content)), 'level-up announced');
  await updateSettings(ID.guild, (s) => { s.leveling.xpMin = 15; s.leveling.xpMax = 25; s.leveling.rewards = []; });
});

test('role commands refuse admin-level roles for self-assignment', async () => {
  const res = await run('autorole', { sub: 'add', options: { role: ID.roleAdmin } });
  assert.match(res.text, /admin-level/);
  assert.deepEqual(getSettings(ID.guild).welcome.autorolesHumans.filter((r) => r === ID.roleAdmin), []);
});

test('tags and custom commands respond with the prefix, without pinging roles', async () => {
  await run('customcommand', { sub: 'add', options: { name: 'hello', response: 'Hi {username}, you said {args}' } });
  await run('tag', { sub: 'create', options: { name: 'rules', content: 'Be nice @everyone' } });
  await world.emit('messageCreate', world.message('!hello big world'));
  const cc = world.discord.calls.find((c) => c.method === 'POST' && c.body?.content === 'Hi member, you said big world');
  assert.ok(cc, 'custom command replied');
  await world.emit('messageCreate', world.message('!rules'));
  const tag = world.discord.calls.find((c) => c.method === 'POST' && c.body?.content === 'Be nice @everyone');
  assert.deepEqual(tag.body.allowed_mentions.parse, []);
});

test('auto-responders match by mode', () => {
  const list = [{ id: 1, trigger_text: 'hi', match_type: 'exact' }, { id: 2, trigger_text: 'help', match_type: 'startswith' }, { id: 3, trigger_text: 'pizza', match_type: 'contains' }];
  assert.equal(matchResponder(list, 'HI ').id, 1);
  assert.equal(matchResponder(list, 'hi there'), null);
  assert.equal(matchResponder(list, 'help me').id, 2);
  assert.equal(matchResponder(list, 'i love Pizza!').id, 3);
});

test('reaction roles add and remove the linked role', async () => {
  const target = world.discord.makeMessage(ID.general, { content: 'pick' });
  world.guild.channels.cache.get(ID.general).messages._add(target);
  await run('reactionrole', { sub: 'add', options: { message: `https://discord.com/channels/${ID.guild}/${ID.general}/${target.id}`, emoji: '⭐', role: ID.roleVip } });
  const message = world.guild.channels.cache.get(ID.general).messages.cache.get(target.id);
  const reaction = { message, emoji: { id: null, name: '⭐' } };
  const user = world.client.users._add(world.discord.users.get(ID.other));
  await world.emit('messageReactionAdd', reaction, user);
  assert.ok(world.discord.calls.find((c) => c.method === 'PUT' && c.route.endsWith(`/members/${ID.other}/roles/${ID.roleVip}`)));
  await world.emit('messageReactionRemove', reaction, user);
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && c.route.endsWith(`/members/${ID.other}/roles/${ID.roleVip}`)));
});

test('a role panel only grants roles that are on it', async () => {
  const created = await run('rolepanel', { sub: 'create', options: { title: 'Pick' } });
  assert.match(created.text, /posted/);
  const panel = await db.one("SELECT * FROM role_panels WHERE title = 'Pick' ORDER BY id DESC LIMIT 1");
  await run('rolepanel', { sub: 'add', options: { panel: panel.id, role: ID.roleVip } });
  assert.match((await world.button(`panel:btn:${panel.id}:${ID.roleAdmin}`, { as: ID.other })).text, /no longer exists/);
  assert.match((await world.button(`panel:btn:${panel.id}:${ID.roleVip}`, { as: ID.other })).text, /Added/);
});

test('verification grants the role only for the right answer', async () => {
  await run('verification', { sub: 'setup', options: { channel: ID.general, role: ID.roleVip, mode: 'math' } });
  const start = await world.button('verify:start', { as: ID.other });
  const title = JSON.stringify(start.calls.find((c) => /callback/.test(c.route)).body);
  const [, a, b] = title.match(/What is (\d+) \+ (\d+)/);
  assert.match((await world.modal('verify:submit', { answer: '999' }, { as: ID.other })).text, /not right|expired/);
  await world.button('verify:start', { as: ID.other });
  const second = world.discord.calls.at(-1);
  const [, c, d] = JSON.stringify(second.body).match(/What is (\d+) \+ (\d+)/);
  assert.ok(a && b);
  const pass = await world.modal('verify:submit', { answer: String(Number(c) + Number(d)) }, { as: ID.other });
  assert.match(pass.text, /verified/i);
  assert.ok(world.discord.calls.find((x) => x.method === 'PUT' && x.route.endsWith(`/members/${ID.other}/roles/${ID.roleVip}`)));
});

test('a ticket opens privately, and only staff or the opener can close it', async () => {
  await run('ticket', { sub: 'setup', options: { channel: ID.general, support_role: ID.roleMod, log_channel: ID.logs } });
  await world.modal('ticket:submit', { subject: 'Help me' }, { as: ID.other });
  const ticket = await db.one("SELECT * FROM tickets WHERE user_id = $1 AND status = 'open' ORDER BY id DESC LIMIT 1", [ID.other]);
  assert.ok(ticket);
  const created = world.discord.calls.find((c) => c.method === 'POST' && c.route.endsWith('/channels'));
  const everyone = created.body.permission_overwrites.find((o) => o.id === ID.guild);
  assert.equal(BigInt(everyone.deny) & 1024n, 1024n, '@everyone cannot view the ticket');
  world.guild.channels.cache.has(ticket.channel_id) || world.client.channels._add(world.discord.channels.get(ticket.channel_id), world.guild);
  assert.match((await world.modal('ticket:submit', { subject: 'Again' }, { as: ID.other })).text, /already have an open ticket/);
  assert.match((await world.button('ticket:close', { as: ID.member, channel: ticket.channel_id })).text, /Only staff/);
  await world.button('ticket:confirm', { as: ID.other, channel: ticket.channel_id });
  assert.equal((await db.one('SELECT status FROM tickets WHERE id = $1', [ticket.id])).status, 'closed');
  assert.ok(world.discord.calls.find((c) => c.method === 'POST' && c.route.endsWith(`/channels/${ID.logs}/messages`) && c.files?.length), 'transcript sent');
});

test('suggestions count one vote per person and a repeat click removes it', async () => {
  await updateSettings(ID.guild, (s) => { s.suggestions.channel = ID.general; });
  await run('suggest', { options: { idea: 'More cats' }, as: ID.mod });
  const s = await db.one("SELECT * FROM suggestions WHERE content = 'More cats' ORDER BY id DESC LIMIT 1");
  await world.button(`suggest:vote:${s.id}:1`, { as: ID.other });
  await world.button(`suggest:vote:${s.id}:-1`, { as: ID.other });
  assert.equal((await db.all('SELECT vote FROM suggestion_votes WHERE suggestion_id = $1', [s.id]))[0].vote, -1);
  await world.button(`suggest:vote:${s.id}:-1`, { as: ID.other });
  assert.equal((await db.all('SELECT vote FROM suggestion_votes WHERE suggestion_id = $1', [s.id])).length, 0);
});

test('joining sends the welcome card, applies auto roles and counts the join', async () => {
  await updateSettings(ID.guild, (s) => { s.welcome.enabled = true; s.welcome.channel = ID.general; s.welcome.card = true; s.welcome.autorolesHumans = [ID.roleVip]; });
  await world.emit('guildMemberAdd', world.guild.members.cache.get(ID.other));
  const post = world.discord.calls.find((c) => c.method === 'POST' && c.route.endsWith(`/channels/${ID.general}/messages`));
  assert.match(post.body.content, new RegExp(ID.other));
  assert.equal(post.files.length, 1);
  assert.ok(gaveRole(ID.other, ID.roleVip));
  await updateSettings(ID.guild, (s) => { s.welcome.enabled = false; s.welcome.autorolesHumans = []; });
});

test('a raid is detected and new accounts are filtered', async () => {
  await updateSettings(ID.guild, (s) => { s.antiraid.enabled = true; s.antiraid.minAccountDays = 100000; s.antiraid.ageAction = 'kick'; });
  const member = world.guild.members.cache.get(ID.other);
  await world.emit('guildMemberAdd', member);
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && c.route.endsWith(`/members/${ID.other}`)), 'too-new account kicked');
  await updateSettings(ID.guild, (s) => { s.antiraid.enabled = false; s.antiraid.minAccountDays = 0; });
});

test('afk is set, shown to people who mention you, and cleared when you talk', async () => {
  await run('afk', { options: { reason: 'lunch' }, as: ID.other });
  const raw = world.message(`<@${ID.other}> hi`, { mentions: [world.discord.users.get(ID.other)] });
  await world.emit('messageCreate', raw);
  assert.ok(world.discord.calls.find((c) => /lunch/.test(c.body?.content ?? '')));
  await world.emit('messageCreate', world.message('back', { as: ID.other }));
  assert.equal(await db.one('SELECT 1 AS y FROM afk WHERE user_id = $1', [ID.other]), null);
});

test('repeating timers reschedule themselves', async () => {
  await run('timer', { sub: 'add', options: { channel: ID.general, every: '1h', message: 'ping' } });
  const [job] = await jobs.list('timer', ID.guild);
  await jobs.tick(world.client, job.run_at + 1);
  const [after] = await jobs.list('timer', ID.guild);
  assert.equal(after.id, job.id);
  assert.ok(after.run_at > job.run_at);
  await db.run("DELETE FROM jobs WHERE type = 'timer'");
});

test('a failing job retries with backoff instead of being lost', async () => {
  jobs.register('test:flaky', () => { throw new Error('discord down'); });
  world.logger.errorCount = 0;
  await jobs.schedule('test:flaky', ID.guild, 1, {}, 'f');
  await jobs.tick(world.client, 10);
  const [job] = await jobs.list('test:flaky', ID.guild);
  assert.equal(job.attempts, 1);
  assert.ok(job.run_at > 10);
  await db.run("DELETE FROM jobs WHERE type = 'test:flaky'");
  world.logger.errorCount = 0;
});
