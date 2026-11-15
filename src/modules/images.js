import { PermissionFlagsBits as P } from 'discord.js';
import { filledSlots, IMAGE_SLOTS, removeImage, saveFromAttachment } from '../core/images.js';
import { cmd, EPHEMERAL, fail, ok, okPrivate } from '../core/ui.js';

const slotChoices = Object.entries(IMAGE_SLOTS).map(([value, name]) => ({ name, value }));
const slotOption = (o) => o.setName('place').setDescription('Where the picture appears').setRequired(true).addChoices(...slotChoices);

export default {
  name: 'images',
  label: '🖼️ Pictures',

  commands: [{
    data: cmd('images', 'Add pictures to welcome messages, verification, tickets and more', P.ManageGuild)
      .addSubcommand((s) => s.setName('set').setDescription('Upload a picture')
        .addStringOption(slotOption)
        .addAttachmentOption((o) => o.setName('image').setDescription('PNG, JPG, GIF or WebP, up to 5 MB').setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a picture').addStringOption(slotOption))
      .addSubcommand((s) => s.setName('list').setDescription('See which pictures are set')),
    async run(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        const filled = await filledSlots(i.guildId);
        return okPrivate(i, Object.entries(IMAGE_SLOTS).map(([id, label]) => `${filled.has(id) ? '🟢' : '⚫'} ${label}`).join('\n'));
      }
      const slot = i.options.getString('place', true);
      if (sub === 'remove') {
        await removeImage(i.guildId, slot);
        return okPrivate(i, `Picture removed from **${IMAGE_SLOTS[slot]}**.`);
      }
      await i.deferReply({ flags: EPHEMERAL });
      const problem = await saveFromAttachment(i.guildId, slot, i.options.getAttachment('image', true));
      return problem ? fail(i, problem) : ok(i, `Picture saved for **${IMAGE_SLOTS[slot]}**.`);
    },
  }],
};
