import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATA_DIR = ':memory:';
delete process.env.DATABASE_URL;
const { config } = await import('../src/config.js');
const { connectDatabase, explainDatabaseError } = await import('../src/core/db.js');
const { logger } = await import('../src/core/logger.js');

logger.quiet = true;
const SECRET = 'hunter2-secret';

test('Supabase direct connection addresses are explained, without showing the password', () => {
  const text = explainDatabaseError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }, `postgresql://postgres:${SECRET}@db.abcdefghijklmnop.supabase.co:5432/postgres`);
  assert.match(text, /Direct connection/);
  assert.match(text, /Session pooler/);
  assert.doesNotMatch(text, new RegExp(SECRET));
});

test("the Supabase project's website address is recognised as the wrong address", () => {
  const text = explainDatabaseError({ message: 'timeout expired' }, `postgresql://postgres:${SECRET}@bikupvuvjycmmalronlp.supabase.co:5432/postgres`);
  assert.match(text, /website address \(bikupvuvjycmmalronlp\.supabase\.co\), which is not a database/);
  assert.match(text, /postgres\.bikupvuvjycmmalronlp/);
  assert.doesNotMatch(text, new RegExp(SECRET));
});

test('wrong passwords, wrong users, unknown hosts and bad addresses each get their own instruction', () => {
  const pooler = `postgresql://postgres.abcdefghijkl:${SECRET}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`;
  assert.match(explainDatabaseError({ code: '28P01', message: 'password authentication failed for user' }, pooler), /password in DATABASE_URL is wrong/);
  assert.match(explainDatabaseError({ code: 'XX000', message: 'Tenant or user not found' }, pooler), /did not recognise the user/);
  assert.match(explainDatabaseError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }, pooler), /does not exist/);
  assert.match(explainDatabaseError({ message: 'timeout expired' }, pooler), /Could not reach the database at aws-0-eu-west-2\.pooler\.supabase\.com/);
  assert.match(explainDatabaseError({ message: 'x' }, 'not a url'), /not a valid address/);
  for (const code of ['28P01', 'ENOTFOUND', 'ETIMEDOUT']) assert.doesNotMatch(explainDatabaseError({ code, message: code }, pooler), new RegExp(SECRET));
});

test('an unreachable database fails quickly with the explanation instead of hanging', async () => {
  config.databaseUrl = `postgresql://postgres:${SECRET}@127.0.0.1:1/postgres`;
  const started = Date.now();
  await assert.rejects(connectDatabase(), (err) => {
    assert.match(err.message, /Could not reach the database at 127\.0\.0\.1/);
    assert.doesNotMatch(err.message, new RegExp(SECRET));
    return true;
  });
  assert.ok(Date.now() - started < 25_000, 'gave up within the connection timeout');
});
