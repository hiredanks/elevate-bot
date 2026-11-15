import { EmbedBuilder, MessageFlags, PermissionFlagsBits as P, SlashCommandBuilder, InteractionContextType } from 'discord.js';

export const COLOR = { brand: 0x8f7eff, ok: 0x57f287, warn: 0xfee75c, err: 0xed4245, gold: 0xf1c40f };
export const EPHEMERAL = MessageFlags.Ephemeral;

export function cmd(name, description, permission) {
  const builder = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild);
  if (permission !== undefined) builder.setDefaultMemberPermissions(permission);
  return builder;
}

export const embed = (description, color = COLOR.brand) => new EmbedBuilder().setColor(color).setDescription(description);

export async function respond(i, payload) {
  if (i.deferred && !i.replied) {
    const { flags, ...rest } = payload;
    return i.editReply(rest);
  }
  if (i.replied) return i.followUp(payload);
  return i.reply(payload);
}

export const ok = (i, text, extra = {}) => respond(i, { embeds: [embed(`✅ ${text}`, COLOR.ok)], ...extra });
export const okPrivate = (i, text) => ok(i, text, { flags: EPHEMERAL });
export const fail = (i, text) => respond(i, { embeds: [embed(`❌ ${text}`, COLOR.err)], flags: EPHEMERAL });

const DANGEROUS = [
  P.Administrator, P.BanMembers, P.KickMembers, P.ManageGuild, P.ManageRoles,
  P.ManageChannels, P.ManageWebhooks, P.MentionEveryone, P.ModerateMembers,
];

export const isDangerousRole = (role) => role.permissions.any(DANGEROUS);

/** Why this role must not be handed out via this command, or null when it is fine. */
export function roleError(i, role, { allowDangerous = false } = {}) {
  const me = i.guild.members.me;
  if (role.id === i.guild.id) return 'You cannot use @everyone here.';
  if (role.managed) return `${role} is managed by an integration and cannot be assigned.`;
  if (role.position >= me.roles.highest.position) return `${role} is above my highest role. Move my role higher first.`;
  if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position) {
    return `${role} is at or above your highest role.`;
  }
  if (!allowDangerous && isDangerousRole(role)) {
    return `${role} has admin-level permissions, so I will not hand it out automatically.`;
  }
  return null;
}

/** Sends to a channel by id, swallowing the "channel is gone / no access" cases. */
export async function sendTo(guild, channelId, payload) {
  if (!channelId) return null;
  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased()) return null;
  return channel.send(payload).catch(() => null);
}
