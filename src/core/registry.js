import { createHash } from 'node:crypto';
import { Events } from 'discord.js';
import { config } from '../config.js';
import { getMeta, setMeta } from './db.js';
import { jobs } from './jobs.js';
import { logger } from './logger.js';
import { registerDefaults } from './settings.js';
import { fail } from './ui.js';

export const commands = new Map();
const components = new Map();
const cooldowns = new Map();
const MISSING_ACCESS = new Set([50001, 50013]);

export const commandJson = () => [...commands.values()].map((c) => c.data.toJSON());

function checkCooldown(i, command) {
  if (!command.cooldown) return 0;
  const key = `${i.guildId}:${i.user.id}:${command.data.name}`;
  const now = Date.now();
  const until = cooldowns.get(key) ?? 0;
  if (until > now) return until - now;
  cooldowns.set(key, now + command.cooldown * 1000);
  return 0;
}

async function runCommand(i) {
  const command = commands.get(i.commandName);
  if (!command) return;
  // Discord lets admins re-grant commands per role; the bot acts with its own powers, so re-check here.
  const required = command.data.default_member_permissions;
  if (required && !i.memberPermissions?.has(BigInt(required))) {
    return fail(i, 'You do not have permission to use this command.');
  }
  if (command.botPerms) {
    const missing = i.guild.members.me.permissionsIn(i.channelId).missing(command.botPerms);
    if (missing.length) return fail(i, `I am missing these permissions here: **${missing.join(', ')}**`);
  }
  const waitMs = checkCooldown(i, command);
  if (waitMs) return fail(i, `Slow down, try again in ${Math.ceil(waitMs / 1000)}s.`);
  await command.run(i);
}

export async function handleInteraction(i) {
  try {
    if (i.isChatInputCommand()) return await runCommand(i);
    if (i.isAutocomplete()) return await commands.get(i.commandName)?.autocomplete?.(i);
    if (i.isMessageComponent() || i.isModalSubmit()) {
      const [scope, action, ...args] = i.customId.split(':');
      return await components.get(`${scope}:${action}`)?.(i, args);
    }
  } catch (err) {
    if (!i.isRepliable()) return logger.error(`Autocomplete failed: ${i.commandName}`, err);
    if (MISSING_ACCESS.has(err.code)) {
      return fail(i, 'Discord refused that because I lack permission. Check my role is high enough and can access this channel.').catch(() => {});
    }
    logger.error(`Interaction failed: ${i.commandName ?? i.customId}`, err);
    await fail(i, 'Something went wrong running that. It has been logged.').catch(() => {});
  }
}

export function wire(client, modules) {
  const listeners = new Map();
  for (const mod of modules) {
    if (mod.defaults) registerDefaults(mod.name, mod.defaults);
    for (const command of mod.commands ?? []) {
      if (commands.has(command.data.name)) throw new Error(`Duplicate command: ${command.data.name}`);
      commands.set(command.data.name, { ...command, module: mod });
    }
    for (const [id, handler] of Object.entries(mod.components ?? {})) components.set(id, handler);
    for (const [type, handler] of Object.entries(mod.jobs ?? {})) jobs.register(type, handler);
    for (const [event, handler] of Object.entries(mod.events ?? {})) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push({ mod, handler });
    }
  }

  // Handlers run in module order, so automod can stop a message before XP or auto-replies see it.
  for (const [event, handlers] of listeners) {
    client.on(event, async (...args) => {
      for (const { mod, handler } of handlers) {
        try {
          await handler(...args);
        } catch (err) {
          logger.error(`${mod.name}:${event} failed`, err);
        }
      }
    });
  }

  client.on(Events.InteractionCreate, handleInteraction);
  client.on(Events.Error, (err) => logger.error('Client error', err));
  client.once(Events.ClientReady, () => onReady(client, modules));
}

export async function onReady(client, modules) {
  logger.info(`Logged in as ${client.user.tag} on ${client.guilds.cache.size} server(s)`);
  logger.info(`Invite link: https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`);
  await syncCommands(client).catch((err) => logger.error('Command registration failed', err));
  for (const mod of modules) {
    try {
      await mod.ready?.(client);
    } catch (err) {
      logger.error(`${mod.name}: ready failed`, err);
    }
  }
  jobs.start(client);
  logger.info('Bot is ready.');
}

/** Registers slash commands only when they changed, so restarts do not burn rate limits. */
export async function syncCommands(client) {
  const body = commandJson();
  const scope = config.devGuildId ?? 'global';
  const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const metaKey = `commands:${client.user.id}:${scope}`;
  if ((await getMeta(metaKey)) === hash) return false;
  if (config.devGuildId) await client.application.commands.set(body, config.devGuildId);
  else await client.application.commands.set(body);
  await setMeta(metaKey, hash);
  logger.info(`Registered ${body.length} slash commands (${scope}).`);
  return true;
}
