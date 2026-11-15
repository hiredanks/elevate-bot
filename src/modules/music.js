import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import { AudioPlayerStatus, createAudioPlayer, createAudioResource, joinVoiceChannel, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import { EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import ffmpegStatic from 'ffmpeg-static';
import { config } from '../config.js';
import { db } from '../core/db.js';
import { logger } from '../core/logger.js';
import { cmd, COLOR, EPHEMERAL, fail, ok, okPrivate, respond, sendTo } from '../core/ui.js';
import { truncate } from '../core/util.js';
import { musicGuilds } from '../core/voice-state.js';
import { syncVoice } from './stayvoice.js';

const MAX_QUEUE = 50;
const MAX_STATIONS = 25;
const LEAVE_AFTER_MS = 2 * 60_000;
// These services forbid playing their audio through bots, so their links are refused up front.
const BLOCKED_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com|music\.apple\.com|soundcloud\.com|deezer\.com|tidal\.com)$/i;
const AUDIO_FILE = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm)$/i;
const sessions = new Map();

class MusicError extends Error {}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/**
 * The bot's server fetches whatever link is played, so links are limited to public web addresses.
 * Otherwise someone could make it read files or services that are only reachable from inside Render.
 */
export async function checkAudioUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new MusicError('That is not a valid link.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new MusicError('Links must start with http:// or https://');
  if (BLOCKED_HOSTS.test(url.hostname)) throw new MusicError('YouTube, Spotify, SoundCloud and similar services cannot be played. Use a radio stream or a direct link to an audio file.');
  if (!config.musicAllowPrivate) {
    const addresses = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    if (!addresses.length) throw new MusicError('I could not find that website.');
    if (addresses.some((a) => isPrivateAddress(a.address))) throw new MusicError('That link points to a private network address.');
  }
  return url.href;
}

const ffmpegBinary = () => (ffmpegStatic && fs.existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg');

function titleFor(url) {
  const { hostname, pathname } = new URL(url);
  const file = decodeURIComponent(pathname.split('/').pop() || '');
  return AUDIO_FILE.test(file) ? file : hostname;
}

/** Converts any audio link into Opus, the format Discord voice uses, without loading it all into memory. */
function ffmpeg(url) {
  return spawn(ffmpegBinary(), [
    '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'http,https,tcp,tls,crypto,hls',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-i', url,
    '-vn', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'ogg', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

function say(session, text) {
  return sendTo(session.guild, session.textChannelId, { content: text, allowedMentions: { parse: [] } });
}

function scheduleLeave(session, key) {
  clearTimeout(session[key]);
  session[key] = setTimeout(() => stopMusic(session.guild), session.guild.client.musicLeaveDelay ?? LEAVE_AFTER_MS);
  session[key].unref?.();
}

function playNext(session) {
  session.proc?.kill('SIGKILL');
  session.proc = null;
  const track = session.queue.shift() ?? null;
  session.current = track;
  clearTimeout(session.idleTimer);
  if (!track) return scheduleLeave(session, 'idleTimer');
  const proc = ffmpeg(track.url);
  session.proc = proc;
  proc.on('error', (err) => {
    logger.warn(`ffmpeg could not start: ${err.message}`);
    say(session, '❌ Music needs ffmpeg, which is missing on this server.');
  });
  proc.on('close', (code) => {
    if (code && session.current === track) say(session, `❌ **${track.title}** could not be played. Check that the link goes straight to audio.`);
  });
  session.player.play(createAudioResource(proc.stdout, { inputType: StreamType.OggOpus, metadata: track }));
  say(session, `🎶 Now playing **${track.title}**, requested by <@${track.requestedBy}>`);
  return undefined;
}

function startSession(guild, voiceChannel, textChannel) {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
  const session = { guild, player, queue: [], current: null, proc: null, channelId: voiceChannel.id, textChannelId: textChannel?.id ?? null };
  player.on(AudioPlayerStatus.Idle, () => playNext(session));
  player.on('error', (err) => logger.warn(`Music playback error: ${err.message}`));
  musicGuilds.add(guild.id);
  const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  session.subscription = connection.subscribe(player);
  sessions.set(guild.id, session);
  return session;
}

/** Stops playback and leaves, or goes back to the 24/7 voice channel if one is set. */
export function stopMusic(guild) {
  const session = sessions.get(guild.id);
  if (!session) return false;
  sessions.delete(guild.id);
  musicGuilds.delete(guild.id);
  clearTimeout(session.idleTimer);
  clearTimeout(session.emptyTimer);
  session.queue.length = 0;
  session.player.removeAllListeners(AudioPlayerStatus.Idle);
  session.player.stop(true);
  session.proc?.kill('SIGKILL');
  session.subscription?.unsubscribe();
  syncVoice(guild);
  return true;
}

export function musicStatus(guildId) {
  const session = sessions.get(guildId);
  if (!session) return null;
  return { state: session.player.state.status, current: session.current?.title ?? null, queue: session.queue.map((t) => t.title), channelId: session.channelId };
}

function enqueue(i, voiceChannel, track) {
  const session = sessions.get(i.guildId) ?? startSession(i.guild, voiceChannel, i.channel);
  if (session.queue.length >= MAX_QUEUE) throw new MusicError(`The queue is full (${MAX_QUEUE} songs).`);
  session.queue.push(track);
  if (!session.current) {
    playNext(session);
    return 0;
  }
  return session.queue.length;
}

function controlProblem(i, session) {
  if (!session) return 'Nothing is playing.';
  if (i.memberPermissions.has(P.ManageChannels) || i.member.voice.channelId === session.channelId) return null;
  return `Join <#${session.channelId}> to control the music.`;
}

const stations = (guildId) => db.all('SELECT * FROM radio_stations WHERE guild_id = $1 ORDER BY name', [guildId]);

export default {
  name: 'music',
  label: '🎵 Music',

  collections: {
    stations: {
      title: 'Radio stations',
      description: 'Saved stations members can play with /music radio. Use a direct stream link, which often ends in .mp3, .aac or .m3u8. YouTube and Spotify links cannot be played.',
      submitLabel: 'Save station',
      columns: [
        { key: 'name', label: 'Name', type: 'text', max: 60, required: true, placeholder: 'Lofi radio' },
        { key: 'url', label: 'Stream link', type: 'text', max: 500, required: true, pattern: '^https?://\\S+$', placeholder: 'https://...' },
      ],
      list: (guildId) => db.all('SELECT id, name, url FROM radio_stations WHERE guild_id = $1 ORDER BY name', [guildId]),
      async create(guild, row) {
        if ((await stations(guild.id)).length >= MAX_STATIONS) throw new Error(`You can save up to ${MAX_STATIONS} stations.`);
        const url = await checkAudioUrl(row.url);
        await db.run('INSERT INTO radio_stations(guild_id, name, url) VALUES ($1, $2, $3)', [guild.id, row.name, url]);
      },
      remove: (guild, id) => db.run('DELETE FROM radio_stations WHERE guild_id = $1 AND id = $2', [guild.id, id]),
    },
  },

  commands: [{
    data: cmd('music', 'Play music in your voice channel')
      .addSubcommand((s) => s.setName('play').setDescription('Play a link to an audio file or stream, or an uploaded audio file')
        .addStringOption((o) => o.setName('link').setDescription('Direct link to audio (not YouTube or Spotify)').setMaxLength(500))
        .addAttachmentOption((o) => o.setName('file').setDescription('An audio file such as MP3')))
      .addSubcommand((s) => s.setName('radio').setDescription('Play a saved radio station')
        .addStringOption((o) => o.setName('station').setDescription('Station name').setRequired(true).setAutocomplete(true)))
      .addSubcommand((s) => s.setName('skip').setDescription('Skip the current song'))
      .addSubcommand((s) => s.setName('pause').setDescription('Pause'))
      .addSubcommand((s) => s.setName('resume').setDescription('Resume'))
      .addSubcommand((s) => s.setName('queue').setDescription('See what is playing and what is next'))
      .addSubcommand((s) => s.setName('stop').setDescription('Stop and clear the queue')),
    botPerms: [P.Connect, P.Speak],
    async run(i) {
      const sub = i.options.getSubcommand();
      const session = sessions.get(i.guildId);
      if (sub === 'queue') {
        if (!session?.current) return okPrivate(i, 'Nothing is playing.');
        const next = session.queue.slice(0, 10).map((t, n) => `${n + 1}. ${t.title}`).join('\n') || 'Nothing else queued.';
        return respond(i, { embeds: [new EmbedBuilder().setColor(COLOR.brand).setTitle(`Now playing: ${truncate(session.current.title, 200)}`).setDescription(next)], flags: EPHEMERAL });
      }
      if (sub !== 'play' && sub !== 'radio') {
        const problem = controlProblem(i, session);
        if (problem) return fail(i, problem);
        if (sub === 'skip') session.player.stop(true);
        if (sub === 'pause') session.player.pause();
        if (sub === 'resume') session.player.unpause();
        if (sub === 'stop') stopMusic(i.guild);
        return ok(i, { skip: 'Skipped.', pause: 'Paused.', resume: 'Resumed.', stop: 'Stopped and left.' }[sub]);
      }

      const voiceChannel = i.member.voice.channel;
      if (!voiceChannel) return fail(i, 'Join a voice channel first.');
      if (session && session.channelId !== voiceChannel.id && !i.memberPermissions.has(P.ManageChannels)) {
        return fail(i, `I am already playing in <#${session.channelId}>. Join that channel.`);
      }
      if (!voiceChannel.joinable) return fail(i, `I cannot join ${voiceChannel}. Check that I have the Connect permission there.`);

      let track;
      try {
        if (sub === 'radio') {
          const name = i.options.getString('station', true);
          const station = (await stations(i.guildId)).find((s) => s.name.toLowerCase() === name.toLowerCase());
          if (!station) return fail(i, 'No saved station with that name. Add stations on the website.');
          track = { url: await checkAudioUrl(station.url), title: station.name };
        } else {
          const file = i.options.getAttachment('file');
          const link = i.options.getString('link');
          if (file) {
            if (!file.contentType?.startsWith('audio/') && !AUDIO_FILE.test(file.name)) return fail(i, 'That file is not audio.');
            track = { url: file.url, title: file.name };
          } else if (link) {
            const url = await checkAudioUrl(link);
            track = { url, title: titleFor(url) };
          } else {
            return fail(i, 'Give a link or attach an audio file.');
          }
        }
        track.requestedBy = i.user.id;
        const position = enqueue(i, voiceChannel, track);
        return ok(i, position ? `Added **${track.title}** to the queue (position ${position}).` : `Playing **${track.title}** in ${voiceChannel}.`, { allowedMentions: { parse: [] } });
      } catch (err) {
        if (!(err instanceof MusicError)) throw err;
        return fail(i, err.message);
      }
    },
    async autocomplete(i) {
      const typed = i.options.getFocused().toLowerCase();
      const list = (await stations(i.guildId)).filter((s) => s.name.toLowerCase().includes(typed)).slice(0, 25);
      return i.respond(list.map((s) => ({ name: s.name, value: s.name })));
    },
  }],

  shutdown(client) {
    for (const guild of client.guilds.cache.values()) stopMusic(guild);
  },

  events: {
    voiceStateUpdate(before, after) {
      const session = sessions.get(after.guild.id);
      if (!session) return;
      // Disconnected by someone: stop cleanly instead of playing to nobody.
      if (after.id === after.client.user.id && !after.channelId) {
        stopMusic(after.guild);
        return;
      }
      const channel = after.guild.channels.cache.get(session.channelId);
      const listeners = channel?.members.filter((m) => !m.user.bot).size ?? 0;
      if (listeners === 0) scheduleLeave(session, 'emptyTimer');
      else clearTimeout(session.emptyTimer);
    },
  },
};
