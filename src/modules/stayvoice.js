import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus as V } from '@discordjs/voice';
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { logger } from '../core/logger.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { cmd, fail, ok, okPrivate } from '../core/ui.js';
import { musicGuilds } from '../core/voice-state.js';

const WATCH_MS = 60_000;
const REJOIN_DELAY_MS = 3000;
const hooked = new WeakSet();

function connect(guild, channelId) {
  const connection = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: true });
  if (!hooked.has(connection)) {
    hooked.add(connection);
    connection.on('error', (err) => logger.warn(`Voice connection error: ${err.message}`));
    connection.on(V.Disconnected, async () => {
      // A brief network drop recovers by itself. Anything longer is left for the watcher to rejoin.
      try {
        await Promise.race([entersState(connection, V.Signalling, 5000), entersState(connection, V.Connecting, 5000)]);
      } catch {
        if (connection.state.status !== V.Destroyed) connection.destroy();
      }
    });
  }
  return connection;
}

/** Makes the bot's voice state match the server's setting. Safe to call repeatedly. */
export function syncVoice(guild) {
  // Music owns the voice connection while it plays, then hands back here when it stops.
  if (musicGuilds.has(guild.id)) return true;
  const cfg = getSettings(guild.id).stayvoice;
  const existing = getVoiceConnection(guild.id);
  const channel = cfg.enabled ? guild.channels.cache.get(cfg.channel) : null;
  if (!channel?.isVoiceBased() || !channel.joinable) {
    existing?.destroy();
    return false;
  }
  const connected = existing && existing.state.status !== V.Destroyed && existing.joinConfig.channelId === channel.id && guild.members.me?.voice.channelId === channel.id;
  if (!connected) connect(guild, channel.id);
  return true;
}

export default {
  name: 'stayvoice',
  label: '🎧 24/7 Voice',
  defaults: { enabled: false, channel: null },
  form: {
    title: '24/7 voice',
    description: 'Keeps the bot sitting in a voice channel around the clock, and brings it back if it gets disconnected. It stays muted and plays no audio.',
    fields: [
      { key: 'enabled', type: 'bool', label: 'Stay in voice' },
      { key: 'channel', type: 'channel', channelKind: 'voice', label: 'Voice channel' },
    ],
  },
  onSave: (guild) => { syncVoice(guild); },

  commands: [{
    data: cmd('stay', 'Keep the bot in a voice channel 24/7', P.ManageGuild)
      .addSubcommand((s) => s.setName('join').setDescription('Stay in a voice channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Defaults to the one you are in').addChannelTypes(ChannelType.GuildVoice)))
      .addSubcommand((s) => s.setName('leave').setDescription('Leave and stop staying in voice'))
      .addSubcommand((s) => s.setName('status').setDescription('Show the current voice channel')),
    async run(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        const cfg = getSettings(i.guildId).stayvoice;
        return okPrivate(i, cfg.enabled && cfg.channel ? `Staying in <#${cfg.channel}>.` : 'Not staying in a voice channel.');
      }
      if (sub === 'leave') {
        await updateSettings(i.guildId, (s) => { s.stayvoice.enabled = false; });
        syncVoice(i.guild);
        return ok(i, 'I left the voice channel.');
      }
      const channel = i.options.getChannel('channel') ?? i.member.voice.channel;
      if (!channel) return fail(i, 'Pick a channel, or join one and run this again.');
      if (channel.id === getSettings(i.guildId).tempvoice.hub) return fail(i, 'That is the join-to-create channel. Pick a normal voice channel.');
      if (!channel.joinable) return fail(i, `I cannot join ${channel}. Check that I have the Connect permission there.`);
      await updateSettings(i.guildId, (s) => { s.stayvoice.enabled = true; s.stayvoice.channel = channel.id; });
      syncVoice(i.guild);
      return ok(i, `I will stay in ${channel} around the clock.`);
    },
  }],

  ready(client) {
    const syncAll = () => { for (const guild of client.guilds.cache.values()) syncVoice(guild); };
    syncAll();
    setInterval(syncAll, WATCH_MS).unref?.();
  },

  shutdown(client) {
    for (const guild of client.guilds.cache.values()) getVoiceConnection(guild.id)?.destroy();
  },

  events: {
    voiceStateUpdate(before, after) {
      if (after.id !== after.client.user.id || before.channelId === after.channelId) return;
      const cfg = getSettings(after.guild.id).stayvoice;
      // Kicked or dragged somewhere else: go back after a moment.
      if (cfg.enabled && after.channelId !== cfg.channel) setTimeout(() => syncVoice(after.guild), after.client.voiceRejoinDelay ?? REJOIN_DELAY_MS).unref?.();
    },
  },
};
