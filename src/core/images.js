import { AttachmentBuilder } from 'discord.js';
import { db } from './db.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const IMAGE_SLOTS = {
  welcome: 'Welcome message',
  welcome_background: 'Welcome card background',
  goodbye: 'Goodbye message',
  verify: 'Verification panel',
  ticket_panel: 'Ticket panel',
  ticket_open: 'New ticket message',
  giveaway: 'Giveaways',
  levelup: 'Level-up message',
  broadcast: 'Message to everyone',
};

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const known = new Map();

/** Identifies a picture by its actual bytes, so a renamed file cannot pass as an image. */
export function imageType(data) {
  if (data.length < 12) return null;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Which slots a server has filled. Cached so sending a message rarely needs the database. */
export async function filledSlots(guildId) {
  if (!known.has(guildId)) {
    const rows = await db.all('SELECT slot FROM guild_images WHERE guild_id = $1', [guildId]);
    known.set(guildId, new Set(rows.map((r) => r.slot)));
  }
  return known.get(guildId);
}

export async function getImage(guildId, slot) {
  if (!(await filledSlots(guildId)).has(slot)) return null;
  const row = await db.one('SELECT image, type FROM guild_images WHERE guild_id = $1 AND slot = $2', [guildId, slot]);
  return row ? { data: Buffer.from(row.image), type: row.type, mime: MIME[row.type] } : null;
}

/** Saves a picture. Returns an error message for the user, or null when it worked. */
export async function saveImage(guildId, slot, data) {
  if (!(slot in IMAGE_SLOTS)) return 'Unknown picture slot.';
  if (data.length > MAX_IMAGE_BYTES) return 'That picture is over 5 MB.';
  const type = imageType(data);
  if (!type) return 'Please use a PNG, JPG, GIF or WebP picture.';
  await db.run(
    'INSERT INTO guild_images(guild_id, slot, image, type) VALUES ($1, $2, $3, $4) ON CONFLICT (guild_id, slot) DO UPDATE SET image = excluded.image, type = excluded.type',
    [guildId, slot, data, type],
  );
  (await filledSlots(guildId)).add(slot);
  return null;
}

export async function saveFromAttachment(guildId, slot, attachment) {
  if (attachment.size > MAX_IMAGE_BYTES) return 'That picture is over 5 MB.';
  const res = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res?.ok) return 'I could not download that picture. Try again.';
  return saveImage(guildId, slot, Buffer.from(await res.arrayBuffer()));
}

export async function removeImage(guildId, slot) {
  await db.run('DELETE FROM guild_images WHERE guild_id = $1 AND slot = $2', [guildId, slot]);
  (await filledSlots(guildId)).delete(slot);
}

/**
 * Adds a server's picture to an outgoing message, if it has one. Pictures are uploaded with each
 * message rather than linked, because Discord's attachment links expire.
 * Use inEmbed: false for messages edited later, since an edit cannot re-reference an upload.
 */
export async function withImage(guildId, slot, payload, { inEmbed = true } = {}) {
  const image = await getImage(guildId, slot);
  if (!image) return payload;
  const name = `${slot}.${image.type}`;
  if (inEmbed) payload.embeds?.[0]?.setImage(`attachment://${name}`);
  return { ...payload, files: [...(payload.files ?? []), new AttachmentBuilder(image.data, { name })] };
}
