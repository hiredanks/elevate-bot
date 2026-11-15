import { randomInt } from 'node:crypto';

export const noop = () => {};
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const truncate = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
export const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;
export const rand = (min, max) => randomInt(min, max + 1);
export const pick = (list) => list[randomInt(list.length)];
export const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
export const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

const UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, y: 31536e6 };

/** Parses "1d 2h", "90m", "2w" into milliseconds. Returns null for anything else. */
export function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+(s|m|h|d|w|y))+$/.test(text)) return null;
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)(s|m|h|d|w|y)/g)) total += Number(n) * UNITS[unit];
  return total > 0 && Number.isSafeInteger(total) ? total : null;
}

export function formatDuration(ms) {
  if (!ms || ms < 1000) return '0s';
  const parts = [];
  let left = ms;
  for (const [label, size] of [['y', UNITS.y], ['d', UNITS.d], ['h', UNITS.h], ['m', UNITS.m], ['s', UNITS.s]]) {
    const n = Math.floor(left / size);
    if (n) parts.push(`${n}${label}`);
    left -= n * size;
  }
  return parts.slice(0, 3).join(' ');
}

/** Substitutes {placeholders}. One pass only, so a value can never inject another placeholder. */
export function render(template, vars) {
  return String(template ?? '')
    .replace(/\\n/g, '\n')
    .replace(/\{([a-z0-9_]+)\}/gi, (match, key) => {
      const value = vars[key.toLowerCase()];
      return value === undefined || value === null ? match : String(value);
    });
}

export function memberVars(member, extra = {}) {
  const { user, guild } = member;
  return {
    user: `<@${user.id}>`,
    mention: `<@${user.id}>`,
    username: user.username,
    name: member.displayName ?? user.username,
    userid: user.id,
    server: guild.name,
    membercount: guild.memberCount,
    ...extra,
  };
}

const stripVS = (s) => s.replace(/️/g, '');

/** Normalises user input into a reaction key, or null if it is not an emoji. */
export function parseEmoji(input) {
  const text = String(input ?? '').trim();
  const custom = text.match(/^<a?:(\w{2,32}):(\d{15,25})>$/);
  if (custom) return { key: custom[2], react: custom[2], display: text };
  if (/^(\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)/u.test(text) && text.length <= 16) {
    return { key: stripVS(text), react: text, display: text };
  }
  return null;
}

export const emojiKey = (emoji) => emoji.id ?? stripVS(emoji.name ?? '');

export function parseMessageLink(link) {
  const m = String(link ?? '').match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  return m ? { guildId: m[1], channelId: m[2], messageId: m[3] } : null;
}

/** Runs async work for the same key one at a time, so concurrent events cannot double-post. */
export function keyedQueue() {
  const tails = new Map();
  return (key, task) => {
    const next = (tails.get(key) ?? Promise.resolve()).then(task, task);
    tails.set(key, next);
    next.finally(() => { if (tails.get(key) === next) tails.delete(key); }).catch(noop);
    return next;
  };
}
