import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createWorld, ID } from './harness.js';
import { closeDatabase, db } from '../src/core/db.js';
import { commandJson } from '../src/core/registry.js';

let world;
before(async () => { world = await createWorld(); });
after(async () => { await closeDatabase(); });

const NAMED = {
  duration: '1h', in: '1h', every: '1h', user_id: ID.stranger, emoji: '⭐', options: 'a | b', trigger: 'hello there', prefix: '?',
  domain: 'youtube.com', word: 'badword', name: 'sample', message: 'hello world', response: 'hi {user}', content: 'tag body', text: 'bio text',
  idea: 'an idea', reason: 'because', question: 'why?', what: 'stretch', prize: 'Nitro', title: 'A title', description: 'Some text',
};

function fillOptions(list) {
  const out = {};
  for (const opt of list ?? []) {
    if (opt.choices?.length) out[opt.name] = opt.choices[0].value;
    else if (opt.type === 3) out[opt.name] = NAMED[opt.name] ?? 'value';
    else if (opt.type === 4) out[opt.name] = Math.max(opt.min_value ?? 1, 1);
    else if (opt.type === 5) out[opt.name] = true;
    else if (opt.type === 6) out[opt.name] = ID.member;
    else if (opt.type === 7) {
      const kinds = opt.channel_types ?? [0];
      out[opt.name] = kinds.includes(0) ? ID.general : kinds.includes(2) ? ID.voice : ID.category;
    } else if (opt.type === 8) out[opt.name] = ID.roleVip;
    else if (opt.type === 11) out[opt.name] = '700000000000000001';
  }
  return out;
}

function leaves() {
  const out = [];
  for (const schema of commandJson()) {
    const subs = (schema.options ?? []).filter((o) => o.type === 1);
    if (subs.length) for (const sub of subs) out.push({ schema, sub: sub.name, options: fillOptions(sub.options) });
    else out.push({ schema, sub: null, options: fillOptions(schema.options) });
  }
  return out;
}

test('slash command definitions satisfy Discord limits', () => {
  const all = commandJson();
  assert.ok(all.length <= 100, `too many top-level commands: ${all.length}`);
  assert.equal(new Set(all.map((c) => c.name)).size, all.length);

  const walk = (options = [], path) => {
    assert.ok(options.length <= 25, `${path} has more than 25 options`);
    let seenOptional = false;
    for (const opt of options) {
      assert.match(opt.name, /^[-_\p{L}\p{N}]{1,32}$/u, `${path}: bad name ${opt.name}`);
      assert.equal(opt.name, opt.name.toLowerCase(), `${path}: ${opt.name} must be lowercase`);
      assert.ok(opt.description.length >= 1 && opt.description.length <= 100, `${path}.${opt.name} description length`);
      if (opt.type > 2) {
        if (opt.required) assert.ok(!seenOptional, `${path}: required option ${opt.name} after an optional one`);
        else seenOptional = true;
      }
      if (opt.choices) assert.ok(opt.choices.length <= 25, `${path}.${opt.name} has too many choices`);
      if (opt.options) walk(opt.options, `${path}.${opt.name}`);
    }
  };
  for (const c of all) {
    assert.ok(c.description.length <= 100, `${c.name} description too long`);
    walk(c.options, c.name);
    const size = JSON.stringify(c).length;
    assert.ok(size < 8000, `${c.name} is ${size} chars, Discord allows 8000`);
  }
});

test('every command and subcommand runs and answers without an internal error', async () => {
  const failures = [];
  for (const { schema, sub, options } of leaves()) {
    const label = `/${schema.name}${sub ? ` ${sub}` : ''}`;
    const before = world.logger.errorCount;
    const { responses } = await world.command(schema.name, { sub, options, schema, as: ID.owner });
    if (world.logger.errorCount > before) failures.push(`${label}: ${world.logger.errors.at(-1).map((e) => e?.stack ?? e).join(' ')}`);
    else if (!responses.length) failures.push(`${label}: never answered the interaction`);
    world.reset();
  }
  assert.deepEqual(failures, []);
});

test('command permissions are enforced on the server side', async () => {
  const schema = commandJson().find((c) => c.name === 'ban');
  const { text } = await world.command('ban', { schema, options: { user: ID.other }, as: ID.member });
  assert.match(text, /do not have permission/);
  assert.ok(!world.discord.bans.has(ID.other));
});

test('a moderator cannot act on someone above them, or hand out a role above them', async () => {
  const ban = commandJson().find((c) => c.name === 'ban');
  const first = await world.command('ban', { schema: ban, options: { user: ID.admin }, as: ID.mod });
  assert.match(first.text, /equal to or above yours/);
  assert.ok(!world.discord.bans.has(ID.admin));

  const role = commandJson().find((c) => c.name === 'role');
  const second = await world.command('role', { schema: role, sub: 'add', options: { user: ID.mod, role: ID.roleAdmin }, as: ID.mod });
  assert.match(second.text, /at or above your highest role/);
});

test('warn escalation applies the configured punishment and records cases', async () => {
  const modconfig = commandJson().find((c) => c.name === 'modconfig');
  await world.command('modconfig', { schema: modconfig, sub: 'escalate', options: { warnings: 2, action: 'timeout', duration: '1h' } });
  await db.run("DELETE FROM cases WHERE user_id = $1", [ID.other]);
  const warn = commandJson().find((c) => c.name === 'warn');
  await world.command('warn', { schema: warn, options: { user: ID.other, reason: 'one' } });
  world.discord.calls.length = 0;
  await world.command('warn', { schema: warn, options: { user: ID.other, reason: 'two' } });
  const timedOut = world.discord.calls.find((c) => c.method === 'PATCH' && c.route.endsWith(`/members/${ID.other}`) && c.body.communication_disabled_until);
  assert.ok(timedOut, 'expected a timeout call');
  const rows = await db.all('SELECT type FROM cases WHERE user_id = $1 ORDER BY case_id', [ID.other]);
  assert.deepEqual(rows.map((r) => r.type), ['warn', 'warn', 'timeout']);
});
