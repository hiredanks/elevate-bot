import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { createWorld, ID } from './harness.js';
import { createSession } from '../src/api/auth.js';
import { createApi } from '../src/api/server.js';
import { config } from '../src/config.js';
import { closeDatabase, db } from '../src/core/db.js';
import { commandJson } from '../src/core/registry.js';
import { getSettings, updateSettings } from '../src/core/settings.js';
import { modules } from '../src/modules/index.js';
import { checkAudioUrl, musicStatus, stopMusic } from '../src/modules/music.js';
import { pollStreams } from '../src/modules/streams.js';

const { fetch: httpFetch } = await import('undici').catch(() => ({ fetch: globalThis.fetch }));
let world;
let api;
let base;
let audio;
let audioBase;
let harnessFetch;
const schema = (name) => commandJson().find((c) => c.name === name);
const run = (name, opts = {}) => world.command(name, { schema: schema(name), ...opts });
const posted = (channelId) => world.discord.calls.filter((c) => c.method === 'POST' && c.route.endsWith(`/channels/${channelId}/messages`));
const G = `/api/guilds/${ID.guild}`;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A sine tone as a WAV file, so ffmpeg has something real to convert. */
function tone(seconds) {
  const rate = 8000;
  const samples = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples * 2, 40);
  for (let n = 0; n < samples; n += 1) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * n) / rate) * 8000), 44 + n * 2);
  return buf;
}

before(async () => {
  world = await createWorld();
  harnessFetch = globalThis.fetch;
  api = createApi(world.client, modules).listen(0);
  await new Promise((resolve) => { api.once('listening', resolve); });
  base = `http://127.0.0.1:${api.address().port}`;
  const files = { '/long.wav': tone(30), '/short.wav': tone(0.4), '/second.wav': tone(30) };
  audio = http.createServer((req, res) => {
    const file = files[req.url];
    if (!file) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': file.length }).end(file);
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => { audio.once('listening', resolve); });
  audioBase = `http://127.0.0.1:${audio.address().port}`;
});
beforeEach(() => {
  world.reset();
  world.discord.calls.length = 0;
  world.gatewayPayloads.length = 0;
  globalThis.fetch = harnessFetch;
});
after(async () => {
  stopMusic(world.guild);
  api.close();
  audio.close();
  await closeDatabase();
});

async function web(method, path, as, body) {
  const token = await createSession({ userId: as, username: 'x', guilds: [] });
  const res = await httpFetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
}

/* ---------- Trap channel ---------- */

async function trapPost(as, channel = ID.extra) {
  const message = world.message('free nitro here', { as, channel });
  await world.emit('messageCreate', message);
  return message;
}
const banCall = (userId) => world.discord.calls.find((c) => c.method === 'PUT' && c.route.endsWith(`/bans/${userId}`));

test('/trap set turns the trap on and posts a warning in the channel', async () => {
  const res = await run('trap', { sub: 'set', options: { channel: ID.extra } });
  assert.match(res.text, /now gets: \*\*Ban\*\*/);
  assert.deepEqual({ ...getSettings(ID.guild).trap }, { enabled: true, channel: ID.extra, action: 'ban' });
  assert.match(JSON.stringify(posted(ID.extra).at(-1).body.embeds), /Do not send messages in this channel/);
  assert.match((await run('trap', { sub: 'set', options: { channel: ID.extra }, as: ID.mod })).text, /do not have permission/);
});

test('a member who types in the trap channel is banned, their message deleted and a case recorded', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.trap, { enabled: true, channel: ID.extra, action: 'ban' }); });
  const message = await trapPost(ID.member);
  assert.equal(message.blocked, true, 'later modules skip it');
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && c.route.endsWith(`/channels/${ID.extra}/messages/${message.id}`)), 'message deleted');
  const ban = banCall(ID.member);
  assert.ok(ban, 'banned');
  assert.equal(ban.body.delete_message_seconds, 3600, 'their last hour of spam is removed too');
  const row = await db.one("SELECT * FROM cases WHERE guild_id = $1 AND user_id = $2 AND type = 'ban'", [ID.guild, ID.member]);
  assert.equal(row.reason, 'Sent a message in the trap channel');
});

test('staff, the owner and other channels are never punished by the trap', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.trap, { enabled: true, channel: ID.extra, action: 'ban' }); });
  await trapPost(ID.mod);
  await trapPost(ID.owner);
  await trapPost(ID.other, ID.general);
  assert.equal(world.discord.calls.filter((c) => c.method === 'PUT' && c.route.includes('/bans/')).length, 0);
  assert.equal(world.discord.calls.filter((c) => c.method === 'DELETE').length, 0);
});

test('the trap can kick, softban or time out instead, and does nothing when off', async () => {
  await updateSettings(ID.guild, (s) => { Object.assign(s.trap, { enabled: true, channel: ID.extra, action: 'timeout' }); });
  await trapPost(ID.other);
  const timeout = world.discord.calls.find((c) => c.method === 'PATCH' && c.route.endsWith(`/members/${ID.other}`));
  assert.ok(Date.parse(timeout.body.communication_disabled_until) > Date.now() + 23 * 3600e3, 'timed out for a day');

  world.reset();
  await updateSettings(ID.guild, (s) => { s.trap.action = 'softban'; });
  await trapPost(ID.other);
  assert.equal(banCall(ID.other).body.delete_message_seconds, 86400);
  assert.ok(world.discord.calls.find((c) => c.method === 'DELETE' && c.route.endsWith(`/bans/${ID.other}`)), 'unbanned again');

  world.reset();
  world.discord.calls.length = 0;
  await run('trap', { sub: 'off' });
  await trapPost(ID.other);
  assert.equal(world.discord.calls.filter((c) => c.route.includes('/bans/') || c.route.endsWith(`/members/${ID.other}`)).length, 0);
});

/* ---------- Music ---------- */

test('music refuses YouTube, Spotify, non-web links and private addresses', async () => {
  const refuses = async (url, why) => assert.rejects(checkAudioUrl(url), why);
  await refuses('https://www.youtube.com/watch?v=dQw4w9WgXcQ', /YouTube, Spotify/);
  await refuses('https://youtu.be/dQw4w9WgXcQ', /YouTube, Spotify/);
  await refuses('https://open.spotify.com/track/1', /YouTube, Spotify/);
  await refuses('file:///etc/passwd', /http/);
  await refuses('not a link', /valid link/);
  await refuses('http://127.0.0.1:8080/stream.mp3', /private network/);
  await refuses('http://169.254.169.254/latest/meta-data', /private network/);
  await refuses('http://[::1]/a.mp3', /private network/);
  await refuses('http://10.1.2.3/a.mp3', /private network/);
  assert.equal(await checkAudioUrl('http://93.184.215.14/radio.mp3'), 'http://93.184.215.14/radio.mp3');
});

function joinVoice(userId, channelId = ID.voice) {
  const before = world.guild.voiceStates.cache.get(userId)?._clone() ?? null;
  const after = world.guild.voiceStates._add({
    user_id: userId, channel_id: channelId, guild_id: ID.guild, session_id: `s-${userId}`, deaf: false, mute: false,
    self_deaf: false, self_mute: false, self_video: false, suppress: false, request_to_speak_timestamp: null,
  });
  return { before, after };
}

test('/music play needs a voice channel and a playable link', async () => {
  assert.match((await run('music', { sub: 'play', options: { link: `${audioBase}/long.wav` }, as: ID.other })).text, /Join a voice channel first/);
  joinVoice(ID.other);
  assert.match((await run('music', { sub: 'play', options: { link: 'https://youtube.com/watch?v=abc' }, as: ID.other })).text, /cannot be played/);
  assert.match((await run('music', { sub: 'play', as: ID.other })).text, /Give a link/);
  assert.match((await run('music', { sub: 'skip', as: ID.other })).text, /Nothing is playing/);
  assert.equal(musicStatus(ID.guild), null);
  joinVoice(ID.other, null);
});

test('music joins your channel, plays, queues, skips and stops', async () => {
  config.musicAllowPrivate = true;
  try {
    joinVoice(ID.member);
    const first = await run('music', { sub: 'play', options: { link: `${audioBase}/long.wav` }, as: ID.member });
    assert.match(first.text, /Playing \*\*long\.wav\*\*/);
    const join = world.gatewayPayloads.find((p) => p.op === 4 && p.d.channel_id === ID.voice);
    assert.ok(join, 'joined the voice channel');
    assert.equal(join.d.self_deaf, true);
    await until(() => musicStatus(ID.guild)?.state === 'playing', 'ffmpeg to start playing');
    assert.match(JSON.stringify(posted(ID.general).at(-1).body), /Now playing \*\*long\.wav\*\*/);

    const second = await run('music', { sub: 'play', options: { link: `${audioBase}/second.wav` }, as: ID.member });
    assert.match(second.text, /position 1/);
    assert.deepEqual(musicStatus(ID.guild).queue, ['second.wav']);
    assert.match((await run('music', { sub: 'queue', as: ID.other })).text, /Now playing: long\.wav.*second\.wav/s);

    // Someone outside the voice channel cannot control it.
    assert.match((await run('music', { sub: 'skip', as: ID.other })).text, /Join <#300000000000000003>/);
    await run('music', { sub: 'skip', as: ID.member });
    await until(() => musicStatus(ID.guild)?.current === 'second.wav' && musicStatus(ID.guild).state === 'playing', 'the next song');

    await run('music', { sub: 'pause', as: ID.member });
    assert.equal(musicStatus(ID.guild).state, 'paused');
    await run('music', { sub: 'resume', as: ID.member });

    world.gatewayPayloads.length = 0;
    assert.match((await run('music', { sub: 'stop', as: ID.member })).text, /Stopped and left/);
    assert.equal(musicStatus(ID.guild), null);
    assert.ok(world.gatewayPayloads.find((p) => p.op === 4 && p.d.channel_id === null), 'left the voice channel');
  } finally {
    stopMusic(world.guild);
    config.musicAllowPrivate = false;
  }
});

test('music leaves when the queue runs out or everyone else leaves', async () => {
  config.musicAllowPrivate = true;
  world.client.musicLeaveDelay = 50;
  try {
    joinVoice(ID.member);
    await run('music', { sub: 'play', options: { link: `${audioBase}/short.wav` }, as: ID.member });
    await until(() => musicStatus(ID.guild) === null, 'leaving after the last song');

    await run('music', { sub: 'play', options: { link: `${audioBase}/long.wav` }, as: ID.member });
    await until(() => musicStatus(ID.guild)?.state === 'playing', 'playing');
    const { before: was, after: now } = joinVoice(ID.member, null);
    await world.emit('voiceStateUpdate', was, now);
    await until(() => musicStatus(ID.guild) === null, 'leaving an empty channel');
  } finally {
    stopMusic(world.guild);
    delete world.client.musicLeaveDelay;
    config.musicAllowPrivate = false;
  }
});

test('music hands the voice connection back to 24/7 voice when it stops', async () => {
  config.musicAllowPrivate = true;
  try {
    await updateSettings(ID.guild, (s) => { Object.assign(s.stayvoice, { enabled: true, channel: ID.voice }); });
    joinVoice(ID.member);
    await run('music', { sub: 'play', options: { link: `${audioBase}/long.wav` }, as: ID.member });
    world.gatewayPayloads.length = 0;
    stopMusic(world.guild);
    assert.equal(world.gatewayPayloads.some((p) => p.op === 4 && p.d.channel_id === null), false, 'did not leave');
    assert.ok(world.gatewayPayloads.find((p) => p.op === 4 && p.d.channel_id === ID.voice && p.d.self_mute === true), 'back to 24/7 mode');
  } finally {
    stopMusic(world.guild);
    await updateSettings(ID.guild, (s) => { s.stayvoice.enabled = false; });
    config.musicAllowPrivate = false;
  }
});

test('radio stations are saved on the website and played with /music radio', async () => {
  const bad = await web('POST', `${G}/collections/stations`, ID.owner, { row: { name: 'Tube', url: 'https://www.youtube.com/watch?v=x' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /cannot be played/);
  const local = await web('POST', `${G}/collections/stations`, ID.owner, { row: { name: 'Sneaky', url: 'http://127.0.0.1:9/' } });
  assert.match(local.json.error, /private network/);

  config.musicAllowPrivate = true;
  try {
    const saved = await web('POST', `${G}/collections/stations`, ID.owner, { row: { name: 'Lofi Radio', url: `${audioBase}/long.wav` } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.rows[0].name, 'Lofi Radio');
    const picks = await world.autocomplete('music', () => [{ name: 'radio', type: 1, options: [{ name: 'station', type: 3, value: 'lofi', focused: true }] }], { schema: schema('music') });
    assert.match(picks.text, /Lofi Radio/);
    joinVoice(ID.member);
    assert.match((await run('music', { sub: 'radio', options: { station: 'lofi radio' }, as: ID.member })).text, /Playing \*\*Lofi Radio\*\*/);
    assert.match((await run('music', { sub: 'radio', options: { station: 'nope' }, as: ID.member })).text, /No saved station/);
  } finally {
    stopMusic(world.guild);
    config.musicAllowPrivate = false;
  }
});

/* ---------- Stream alerts ---------- */

const TWITCH_PFP = 'https://static-cdn.jtvnw.net/jtv_user_pictures/streamer-profile_image-300x300.png';
const KICK_PFP = 'https://files.kick.com/images/user/77/profile_image/kicker.webp';
const YT_ID = 'UCabcdefghijklmnopqrstuv';

function mockPlatforms(state) {
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    seen.push({ url, headers: init.headers ?? {} });
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.host === 'id.twitch.tv') return json({ access_token: 'tw-app-token', expires_in: 3600 });
    if (url.host === 'id.kick.com') return json({ access_token: 'kick-app-token', expires_in: 3600 });
    if (url.pathname === '/helix/users') {
      return json({ data: url.searchParams.get('login') === 'streamer' ? [{ login: 'streamer', display_name: 'Streamer', profile_image_url: TWITCH_PFP }] : [] });
    }
    if (url.pathname === '/helix/streams') {
      return json({ data: state.twitch ? [{ id: state.twitch, user_login: 'streamer', title: 'Ranked grind', game_name: 'Valorant', thumbnail_url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_streamer-{width}x{height}.jpg' }] : [] });
    }
    if (url.pathname === '/public/v1/channels') {
      return json({ data: [{ slug: 'kicker', broadcaster_user_id: 77, stream_title: 'Late night chat', category: { name: 'Just Chatting' }, stream: { is_live: Boolean(state.kick), start_time: state.kick, thumbnail: 'https://images.kick.com/video_thumbnails/kicker/thumb.webp' } }] });
    }
    if (url.pathname === '/public/v1/users') return json({ data: [{ name: 'Kicker', profile_picture: KICK_PFP }] });
    if (url.pathname === '/youtube/v3/channels') return json({ items: [{ id: YT_ID, snippet: { title: 'YT Guy', thumbnails: { high: { url: 'https://yt3.ggpht.com/ytguy=s800' } } } }] });
    if (url.pathname === '/feeds/videos.xml') return new Response(`<feed><entry><yt:videoId>liveVideo01</yt:videoId></entry><entry><yt:videoId>oldVideo001</yt:videoId></entry></feed>`, { status: 200 });
    if (url.pathname === '/youtube/v3/videos') {
      return json({ items: [{ id: 'liveVideo01', snippet: { title: 'Building live', liveBroadcastContent: state.youtube ? 'live' : 'none', thumbnails: { high: { url: 'https://i.ytimg.com/vi/liveVideo01/hq.jpg' } } } }, { id: 'oldVideo001', snippet: { title: 'Old', liveBroadcastContent: 'none' } }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return seen;
}

function withKeys() {
  Object.assign(config, { twitchClientId: 'tw-id', twitchClientSecret: 'tw-secret', kickClientId: 'k-id', kickClientSecret: 'k-secret', youtubeApiKey: 'yt-key' });
}

test('without keys a Twitch alert is manual and nothing is fetched; with keys the account must exist', async () => {
  Object.assign(config, { twitchClientId: null, twitchClientSecret: null });
  const seen = mockPlatforms({});
  const manual = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'Twitch', account: 'twitch.tv/SomeOne', channel_id: ID.general } });
  assert.equal(manual.status, 200, JSON.stringify(manual.json));
  assert.deepEqual(manual.json.rows.map((r) => [r.platform, r.account, r.status]), [['Twitch', 'someone', 'Manual: /live']]);
  await pollStreams(world.client, { force: true });
  assert.equal(seen.length, 0, 'manual alerts never contact Twitch');
  await db.run('DELETE FROM stream_alerts WHERE guild_id = $1', [ID.guild]);
  withKeys();
  const missing = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'Twitch', account: 'nobody_here', channel_id: ID.general } });
  assert.match(missing.json.error, /no Twitch account named nobody_here/);
  const badPlatform = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'Facebook', account: 'x', channel_id: ID.general } });
  assert.equal(badPlatform.status, 400);
});

test('a Twitch alert posts once per stream with the profile picture, title and Watch Stream button', async () => {
  withKeys();
  const state = { twitch: null };
  const seen = mockPlatforms(state);
  const added = await web('POST', `${G}/collections/streams`, ID.owner, {
    row: { platform: 'Twitch', account: 'https://www.twitch.tv/Streamer', channel_id: ID.general, ping: '@everyone', image: 'Profile picture' },
  });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.deepEqual(added.json.rows.map((r) => [r.platform, r.account, r.status]), [['Twitch', 'Streamer', 'Offline']]);
  const dupe = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'Twitch', account: 'streamer', channel_id: ID.general } });
  assert.match(dupe.json.error, /already has an alert/);

  await pollStreams(world.client, { force: true });
  assert.equal(posted(ID.general).length, 0, 'nothing while offline');

  state.twitch = 'stream-1';
  await pollStreams(world.client, { force: true });
  const [alert] = posted(ID.general);
  assert.ok(alert, 'alert posted when they went live');
  assert.equal(alert.body.content, 'Streamer is live! @everyone');
  assert.deepEqual(alert.body.allowed_mentions.parse, ['everyone']);
  const e = alert.body.embeds[0];
  assert.equal(e.author.name, 'Streamer');
  assert.equal(e.author.icon_url, TWITCH_PFP);
  assert.equal(e.image.url, TWITCH_PFP, 'big picture is the profile picture');
  assert.equal(e.title, 'Ranked grind');
  assert.equal(e.url, 'https://twitch.tv/streamer');
  assert.match(e.description, /Valorant/);
  const button = alert.body.components[0].components[0];
  assert.deepEqual([button.style, button.label, button.url], [5, 'Watch Stream', 'https://twitch.tv/streamer']);
  const api = seen.find((s) => s.url.pathname === '/helix/streams');
  assert.equal(api.headers.authorization, 'Bearer tw-app-token');
  assert.equal(api.headers['client-id'], 'tw-id');

  await pollStreams(world.client, { force: true });
  assert.equal(posted(ID.general).length, 1, 'no repeat while the same stream is live');
  assert.equal((await web('GET', `${G}/collections/streams`, ID.owner)).json.rows[0].status, 'Live now');

  state.twitch = null;
  await pollStreams(world.client, { force: true });
  state.twitch = 'stream-2';
  await pollStreams(world.client, { force: true });
  assert.equal(posted(ID.general).length, 2, 'a new stream posts again');

  await db.run('DELETE FROM stream_alerts WHERE guild_id = $1', [ID.guild]);
});

test('/stream add for Kick can use the stream preview and no ping, and /stream test shows a sample', async () => {
  withKeys();
  const state = { kick: null };
  mockPlatforms(state);
  const res = await run('stream', { sub: 'add', options: { platform: 'kick', account: 'kick.com/kicker', channel: ID.extra, ping: 'none', picture: 'preview' } });
  const id = Number(res.text.match(/Alert \*\*(\d+)\*\*/)?.[1]);
  assert.ok(id, res.text);
  assert.match(res.text, /Kicker/);

  await run('stream', { sub: 'test', options: { id } });
  const sample = posted(ID.extra).at(-1).body;
  assert.equal(sample.content, 'Kicker is live!');
  assert.equal(sample.embeds[0].image.url, KICK_PFP, 'the sample has no stream yet, so it shows the profile picture');
  assert.equal(sample.components[0].components[0].url, 'https://kick.com/kicker');

  state.kick = '2026-11-15T20:00:00Z';
  await pollStreams(world.client, { force: true });
  const alert = posted(ID.extra).at(-1).body;
  assert.equal(alert.content, 'Kicker is live!');
  assert.deepEqual(alert.allowed_mentions.parse, []);
  assert.equal(alert.embeds[0].author.icon_url, KICK_PFP);
  assert.match(alert.embeds[0].image.url, /^https:\/\/images\.kick\.com\/video_thumbnails\/kicker\/thumb\.webp\?t=\d+$/);
  assert.match(alert.embeds[0].description, /Just Chatting/);

  assert.match((await run('stream', { sub: 'list' })).text, /Kick: Kicker in <#300000000000000005> \(live now\)/);
  await run('stream', { sub: 'remove', options: { id } });
  assert.equal(await db.one('SELECT 1 AS y FROM stream_alerts WHERE id = $1', [id]), null);
  assert.match((await run('stream', { sub: 'add', options: { platform: 'kick', account: 'x', channel: ID.extra }, as: ID.mod })).text, /do not have permission/);
});

test('a YouTube alert finds the live video and links to it, with a custom message', async () => {
  withKeys();
  const state = { youtube: false };
  mockPlatforms(state);
  const added = await web('POST', `${G}/collections/streams`, ID.owner, {
    row: { platform: 'YouTube', account: '@ytguy', channel_id: ID.general, message: '🔴 {name} started: {title}', ping: 'No ping' },
  });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  await pollStreams(world.client, { force: true });
  assert.equal(posted(ID.general).length, 0);
  state.youtube = true;
  await pollStreams(world.client, { force: true });
  const alert = posted(ID.general).at(-1).body;
  assert.equal(alert.content, '🔴 YT Guy started: Building live');
  assert.equal(alert.embeds[0].image.url, 'https://yt3.ggpht.com/ytguy=s800');
  assert.equal(alert.components[0].components[0].url, 'https://www.youtube.com/watch?v=liveVideo01');
  await web('DELETE', `${G}/collections/streams/${added.json.rows[0].id}`, ID.owner);
  assert.equal((await web('GET', `${G}/collections/streams`, ID.owner)).json.rows.length, 0);
});

test('YouTube works without a key, using the public feed of new videos and streams', async () => {
  Object.assign(config, { youtubeApiKey: null });
  const feed = [{ id: 'oldVideo001', title: 'Old upload', published: Date.now() - 3 * 864e5 }];
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.pathname !== '/feeds/videos.xml' || url.searchParams.get('channel_id') !== YT_ID) return new Response('', { status: 404 });
    const entries = feed.map((e) => `<entry><id>yt:video:${e.id}</id><yt:videoId>${e.id}</yt:videoId><title>${e.title}</title><published>${new Date(e.published).toISOString()}</published>`
      + `<media:group><media:title>${e.title}</media:title><media:thumbnail url="https://i1.ytimg.com/vi/${e.id}/hqdefault.jpg" width="480" height="360"/></media:group></entry>`).join('');
    return new Response(`<?xml version="1.0"?><feed><yt:channelId>${YT_ID}</yt:channelId><title>YT Guy &amp; Friends</title>${entries}</feed>`, { status: 200 });
  };
  const handle = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'YouTube', account: '@ytguy', channel_id: ID.general } });
  assert.match(handle.json.error, /channel ID \(it starts with UC\)/);
  const unknown = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'YouTube', account: 'UCzzzzzzzzzzzzzzzzzzzzzz', channel_id: ID.general } });
  assert.match(unknown.json.error, /could not find that YouTube channel/);
  const added = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'YouTube', account: `https://www.youtube.com/channel/${YT_ID}`, channel_id: ID.general, ping: 'No ping' } });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.deepEqual([added.json.rows[0].account, added.json.rows[0].status], ['YT Guy & Friends', 'Watching for new videos']);

  await pollStreams(world.client, { force: true });
  assert.equal(posted(ID.general).length, 0, 'the video from before the alert existed is not posted');
  feed.unshift({ id: 'newStream01', title: 'Live: building &amp; chatting', published: Date.now() - 60_000 });
  await pollStreams(world.client, { force: true });
  const alert = posted(ID.general).at(-1)?.body;
  assert.ok(alert, 'new stream posted');
  assert.equal(alert.content, 'YT Guy & Friends is live!');
  assert.equal(alert.embeds[0].title, 'Live: building & chatting');
  assert.match(alert.embeds[0].image.url, /^https:\/\/i1\.ytimg\.com\/vi\/newStream01\/hqdefault\.jpg\?t=\d+$/, 'no key means no profile picture, so the stream picture is used');
  assert.equal(alert.components[0].components[0].url, 'https://www.youtube.com/watch?v=newStream01');
  await pollStreams(world.client, { force: true });
  assert.equal(posted(ID.general).length, 1, 'posted once');
  assert.ok(seen.every((u) => u.hostname === 'www.youtube.com'), 'only the public feed is used');
  await db.run('DELETE FROM stream_alerts WHERE guild_id = $1', [ID.guild]);
});

test('TikTok alerts are posted by streamers with /live, using the profile picture link', async () => {
  const seen = mockPlatforms({});
  const PFP = 'https://p16-sign.tiktokcdn.com/dancer-avatar.jpeg';
  const insecure = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'TikTok', account: '@dancer', channel_id: ID.general, picture_url: 'http://x.example/a.png' } });
  assert.equal(insecure.status, 400);
  const added = await web('POST', `${G}/collections/streams`, ID.owner, {
    row: { platform: 'TikTok', account: 'https://www.tiktok.com/@Dancer.Pro', channel_id: ID.general, ping: '@here', picture_url: PFP },
  });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  const row = added.json.rows[0];
  assert.deepEqual([row.platform, row.account, row.status], ['TikTok', 'dancer.pro', 'Manual: /live']);
  await pollStreams(world.client, { force: true });
  assert.equal(seen.length, 0, 'TikTok is never contacted');

  const choices = await world.autocomplete('live', () => [{ name: 'alert', type: 4, value: 'tik', focused: true }], { schema: schema('live'), as: ID.member });
  assert.match(choices.text, /TikTok: dancer\.pro/);
  assert.match((await run('live', { options: { alert: row.id }, as: ID.member })).text, /Only staff can post live alerts/);
  await updateSettings(ID.guild, (s) => { s.streamalerts.streamerRole = ID.roleMember; });
  assert.match((await run('live', { options: { alert: row.id, title: 'Dance battle tonight' }, as: ID.member })).text, /Live alert posted/);
  const alert = posted(ID.general).at(-1).body;
  assert.equal(alert.content, 'dancer.pro is live! @here');
  assert.deepEqual(alert.allowed_mentions.parse, ['everyone']);
  const e = alert.embeds[0];
  assert.deepEqual([e.author.icon_url, e.image.url, e.title, e.footer.text], [PFP, PFP, 'Dance battle tonight', 'TikTok']);
  assert.equal(alert.components[0].components[0].url, 'https://www.tiktok.com/@dancer.pro/live');
  assert.match((await run('live', { options: { alert: row.id }, as: ID.member })).text, /can be posted again <t:\d+:R>/);
  assert.equal(posted(ID.general).length, 1, 'cooldown stops a double post');

  withKeys();
  const twitchRow = await web('POST', `${G}/collections/streams`, ID.owner, { row: { platform: 'Twitch', account: 'streamer', channel_id: ID.general } });
  const twitchId = twitchRow.json.rows.find((r) => r.platform === 'Twitch').id;
  assert.match((await run('live', { options: { alert: twitchId }, as: ID.member })).text, /posted automatically/);
  await updateSettings(ID.guild, (s) => { s.streamalerts.streamerRole = null; });
  await db.run('DELETE FROM stream_alerts WHERE guild_id = $1', [ID.guild]);
});
