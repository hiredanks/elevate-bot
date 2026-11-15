import { ChannelType } from 'discord.js';
import { roleError } from '../core/ui.js';
import { parseEmoji } from '../core/util.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (field, why) => new HttpError(400, `${field.label}: ${why}`);
const KINDS = {
  text: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
  voice: [ChannelType.GuildVoice],
  category: [ChannelType.GuildCategory],
};

function channel(field, value, ctx) {
  const found = ctx.guild.channels.cache.get(value);
  const kinds = KINDS[field.channelKind ?? 'text'];
  if (!found || !kinds.includes(found.type)) throw bad(field, 'that channel does not exist or is the wrong type.');
  return value;
}

function role(field, value, ctx) {
  const found = ctx.guild.roles.cache.get(value);
  if (!found) throw bad(field, 'that role does not exist.');
  if (field.assignable) {
    const problem = roleError({ guild: ctx.guild, user: { id: ctx.member.id }, member: ctx.member }, found);
    if (problem) throw bad(field, problem.replace(/<@&\d+>/g, found.name));
  }
  return value;
}

function text(field, value) {
  if (typeof value !== 'string') throw bad(field, 'must be text.');
  const trimmed = value.trim();
  if ((field.required || field.optional === false) && !trimmed) throw bad(field, 'cannot be empty.');
  if (field.max && trimmed.length > field.max) throw bad(field, `can be at most ${field.max} characters.`);
  if (trimmed && field.pattern && !new RegExp(field.pattern, field.patternFlags).test(trimmed)) throw bad(field, 'is not in a valid format.');
  if (trimmed && field.format === 'emoji' && !parseEmoji(trimmed)) throw bad(field, 'must be a single emoji.');
  return trimmed;
}

function asArray(field, value, max = 200) {
  if (!Array.isArray(value)) throw bad(field, 'must be a list.');
  if (value.length > (field.max ?? max)) throw bad(field, `can have at most ${field.max ?? max} entries.`);
  return value;
}

/** Checks one dashboard value against its field definition and returns the cleaned value. */
export function validateField(field, value, ctx) {
  switch (field.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw bad(field, 'must be on or off.');
      return value;
    case 'int': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (!Number.isInteger(n)) throw bad(field, 'must be a whole number.');
      if (n < field.min || n > field.max) throw bad(field, `must be between ${field.min} and ${field.max}.`);
      return n;
    }
    case 'text':
    case 'textarea':
      return text(field, value);
    case 'select':
      if (!field.options.includes(value)) throw bad(field, 'is not one of the choices.');
      return value;
    case 'channel':
      return value ? channel(field, value, ctx) : null;
    case 'role':
      return value ? role(field, value, ctx) : null;
    case 'channels':
      return [...new Set(asArray(field, value))].map((v) => {
        const found = ctx.guild.channels.cache.get(v);
        if (!found) throw bad(field, 'a channel in the list no longer exists.');
        return v;
      });
    case 'roles':
      return [...new Set(asArray(field, value))].map((v) => role(field, v, ctx));
    case 'list':
      return [...new Set(asArray(field, value).map((v) => text({ ...field, max: 200, required: true }, v)))];
    case 'rows':
      return asArray(field, value, 50).map((row) => {
        if (row === null || typeof row !== 'object') throw bad(field, 'has an invalid row.');
        const clean = {};
        for (const column of field.columns) {
          const cell = row[column.key];
          if (column.optional && (cell === null || cell === undefined || cell === '')) clean[column.key] = null;
          else if (!column.optional && (cell === null || cell === undefined || cell === '')) throw bad(field, `${column.label} is required in every row.`);
          else clean[column.key] = validateField({ ...column, label: `${field.label} ${column.label}` }, cell, ctx);
        }
        return clean;
      });
    default:
      throw new HttpError(500, `Unknown field type ${field.type}`);
  }
}

export const getPath = (object, path) => path.split('.').reduce((node, key) => node?.[key], object);

export function setPath(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((node, key) => node[key], object);
  parent[last] = value;
}
