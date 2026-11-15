import { AttachmentBuilder, EmbedBuilder, PermissionFlagsBits as P } from 'discord.js';
import { profileCard } from '../core/cards.js';
import { db } from '../core/db.js';
import { getSettings } from '../core/settings.js';
import { cmd, COLOR, fail, ok, respond, roleError } from '../core/ui.js';
import { fmt, formatDuration, pick, rand, ts } from '../core/util.js';
import { levelFromXp, rankOf } from './leveling.js';

const DAY = 864e5;
const STREAK_GRACE = 2 * DAY;
const MAX_STREAK_BONUS = 30;
const SLOTS = ['🍒', '🍋', '🔔', '⭐', '💎'];
const WORK_LINES = ['You fixed a server', 'You delivered pizza', 'You walked a dog', 'You debugged some code', 'You sold lemonade', 'You mowed a lawn'];

const cur = (guildId) => getSettings(guildId).economy.currency;
const ensure = (run, guildId, userId, username = null) => run(
  'INSERT INTO members(guild_id, user_id, username) VALUES ($1, $2, $3) ON CONFLICT (guild_id, user_id) DO NOTHING',
  [guildId, userId, username],
);

export async function getMember(guildId, userId) {
  await ensure(db.run, guildId, userId);
  return db.one('SELECT * FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
}

export async function addCredits(guildId, userId, amount, username = null) {
  await ensure(db.run, guildId, userId, username);
  await db.run('UPDATE members SET credits = GREATEST(0, credits + $1), username = COALESCE($4, username) WHERE guild_id = $2 AND user_id = $3', [amount, guildId, userId, username]);
}

/** Takes credits only if the balance covers it. The check and the debit are one statement. */
export async function spendCredits(guildId, userId, amount) {
  return (await db.run('UPDATE members SET credits = credits - $1 WHERE guild_id = $2 AND user_id = $3 AND credits >= $1', [amount, guildId, userId])) === 1;
}

export function transferCredits(guildId, fromId, toId, amount) {
  return db.tx(async (t) => {
    const paid = await t.run('UPDATE members SET credits = credits - $1 WHERE guild_id = $2 AND user_id = $3 AND credits >= $1', [amount, guildId, fromId]);
    if (paid !== 1) return false;
    await ensure(t.run, guildId, toId);
    await t.run('UPDATE members SET credits = credits + $1 WHERE guild_id = $2 AND user_id = $3', [amount, guildId, toId]);
    return true;
  });
}

const betOption = (o) => o.setName('amount').setDescription('How much to bet').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000);

export function slotsPayout(reels, bet) {
  if (reels[0] === reels[1] && reels[1] === reels[2]) return bet * (reels[0] === '💎' ? 10 : 5);
  if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) return bet * 2;
  return 0;
}

export default {
  name: 'economy',
  label: '💰 Economy',
  defaults: { currency: 'credits', dailyAmount: 200, streakBonus: 20, workMin: 50, workMax: 200, workCooldownMinutes: 60 },
  form: {
    title: 'Economy',
    description: 'Credits earned with /daily and /work, spent in /shop.',
    fields: [
      { key: 'currency', type: 'text', label: 'Currency name', max: 20 },
      { key: 'dailyAmount', type: 'int', label: 'Daily reward', min: 1, max: 1000000 },
      { key: 'streakBonus', type: 'int', label: 'Extra per day of streak', min: 0, max: 100000 },
      { key: 'workMin', type: 'int', label: 'Work: minimum pay', min: 1, max: 1000000 },
      { key: 'workMax', type: 'int', label: 'Work: maximum pay', min: 1, max: 1000000 },
      { key: 'workCooldownMinutes', type: 'int', label: 'Work cooldown (minutes)', min: 1, max: 10080 },
    ],
  },

  commands: [
    {
      data: cmd('balance', 'Check a balance').addUserOption((o) => o.setName('user').setDescription('Defaults to you')),
      async run(i) {
        const user = i.options.getUser('user') ?? i.user;
        const row = await getMember(i.guildId, user.id);
        return ok(i, `**${user.username}** has **${fmt(row.credits)}** ${cur(i.guildId)}.`);
      },
    },
    {
      data: cmd('daily', 'Collect your daily reward'),
      async run(i) {
        const cfg = getSettings(i.guildId).economy;
        const row = await getMember(i.guildId, i.user.id);
        const now = Date.now();
        if (now - row.last_daily < DAY) return fail(i, `You can collect again ${ts(row.last_daily + DAY)}.`);
        const streak = now - row.last_daily < STREAK_GRACE ? row.streak + 1 : 1;
        const amount = cfg.dailyAmount + cfg.streakBonus * Math.min(streak - 1, MAX_STREAK_BONUS);
        // The last_daily guard stops a double click from paying twice.
        const paid = await db.run(
          'UPDATE members SET credits = credits + $1, last_daily = $2, streak = $3, username = $4 WHERE guild_id = $5 AND user_id = $6 AND last_daily = $7',
          [amount, now, streak, i.user.username, i.guildId, i.user.id, row.last_daily],
        );
        if (!paid) return fail(i, 'Already collected.');
        return ok(i, `You collected **${fmt(amount)}** ${cfg.currency}. Streak: **${streak}** day(s).`);
      },
    },
    {
      data: cmd('work', 'Earn some credits'),
      async run(i) {
        const cfg = getSettings(i.guildId).economy;
        const row = await getMember(i.guildId, i.user.id);
        const now = Date.now();
        const wait = cfg.workCooldownMinutes * 60_000;
        if (now - row.last_work < wait) return fail(i, `You are tired. Rest for ${formatDuration(row.last_work + wait - now)}.`);
        const amount = rand(Math.min(cfg.workMin, cfg.workMax), Math.max(cfg.workMin, cfg.workMax));
        const paid = await db.run(
          'UPDATE members SET credits = credits + $1, last_work = $2, username = $3 WHERE guild_id = $4 AND user_id = $5 AND last_work = $6',
          [amount, now, i.user.username, i.guildId, i.user.id, row.last_work],
        );
        if (!paid) return fail(i, 'Slow down.');
        return ok(i, `${pick(WORK_LINES)} and earned **${fmt(amount)}** ${cfg.currency}.`);
      },
    },
    {
      data: cmd('pay', 'Send credits to someone')
        .addUserOption((o) => o.setName('user').setDescription('Who to pay').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)),
      async run(i) {
        const user = i.options.getUser('user', true);
        const amount = i.options.getInteger('amount', true);
        if (user.id === i.user.id || user.bot) return fail(i, 'Pick another person to pay.');
        const sent = await transferCredits(i.guildId, i.user.id, user.id, amount);
        if (!sent) return fail(i, 'You do not have enough.');
        return ok(i, `Sent **${fmt(amount)}** ${cur(i.guildId)} to ${user}.`);
      },
    },
    {
      data: cmd('gamble', 'Flip a coin to double your bet').addIntegerOption(betOption),
      cooldown: 3,
      async run(i) {
        const bet = i.options.getInteger('amount', true);
        if (!(await spendCredits(i.guildId, i.user.id, bet))) return fail(i, 'You do not have enough.');
        if (rand(0, 1) === 1) {
          await addCredits(i.guildId, i.user.id, bet * 2);
          return ok(i, `🪙 You won **${fmt(bet)}** ${cur(i.guildId)}!`);
        }
        return respond(i, { embeds: [new EmbedBuilder().setColor(COLOR.err).setDescription(`🪙 You lost **${fmt(bet)}** ${cur(i.guildId)}.`)] });
      },
    },
    {
      data: cmd('slots', 'Spin the slot machine').addIntegerOption(betOption),
      cooldown: 3,
      async run(i) {
        const bet = i.options.getInteger('amount', true);
        if (!(await spendCredits(i.guildId, i.user.id, bet))) return fail(i, 'You do not have enough.');
        const reels = [pick(SLOTS), pick(SLOTS), pick(SLOTS)];
        const payout = slotsPayout(reels, bet);
        if (payout) await addCredits(i.guildId, i.user.id, payout);
        const text = payout ? `You won **${fmt(payout)}** ${cur(i.guildId)}!` : `You lost **${fmt(bet)}** ${cur(i.guildId)}.`;
        return respond(i, { embeds: [new EmbedBuilder().setColor(payout ? COLOR.ok : COLOR.err).setDescription(`# ${reels.join(' ')}\n${text}`)] });
      },
    },
    {
      data: cmd('rep', 'Give someone a reputation point, once a day')
        .addUserOption((o) => o.setName('user').setDescription('Who deserves it').setRequired(true)),
      async run(i) {
        const user = i.options.getUser('user', true);
        if (user.id === i.user.id || user.bot) return fail(i, 'Pick another person.');
        const row = await getMember(i.guildId, i.user.id);
        const now = Date.now();
        if (now - row.last_rep < DAY) return fail(i, `You can give rep again ${ts(row.last_rep + DAY)}.`);
        await db.run('UPDATE members SET last_rep = $1 WHERE guild_id = $2 AND user_id = $3', [now, i.guildId, i.user.id]);
        await ensure(db.run, i.guildId, user.id, user.username);
        await db.run('UPDATE members SET rep = rep + 1 WHERE guild_id = $1 AND user_id = $2', [i.guildId, user.id]);
        return ok(i, `You gave ${user} a reputation point.`);
      },
    },
    {
      data: cmd('bio', 'Set the bio on your profile')
        .addStringOption((o) => o.setName('text').setDescription('Your bio').setRequired(true).setMaxLength(120)),
      async run(i) {
        await ensure(db.run, i.guildId, i.user.id, i.user.username);
        await db.run('UPDATE members SET bio = $1 WHERE guild_id = $2 AND user_id = $3', [i.options.getString('text', true), i.guildId, i.user.id]);
        return ok(i, 'Bio updated. See it with `/profile`.', { flags: 64 });
      },
    },
    {
      data: cmd('profile', 'Show a profile card').addUserOption((o) => o.setName('user').setDescription('Defaults to you')),
      cooldown: 3,
      async run(i) {
        const user = i.options.getUser('user') ?? i.user;
        await i.deferReply();
        const row = await getMember(i.guildId, user.id);
        const position = (await rankOf(i.guildId, user.id))?.position ?? 1;
        const png = await profileCard({
          avatarUrl: user.displayAvatarURL({ extension: 'png', size: 256 }), name: user.displayName ?? user.username,
          bio: row.bio, level: levelFromXp(row.xp), rank: position, credits: row.credits, currency: cur(i.guildId), rep: row.rep,
        });
        return i.editReply({ files: [new AttachmentBuilder(png, { name: 'profile.png' })] });
      },
    },
    {
      data: cmd('shop', 'Buy roles with credits')
        .addSubcommand((s) => s.setName('list').setDescription('See what is for sale'))
        .addSubcommand((s) => s.setName('buy').setDescription('Buy a role')
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand((s) => s.setName('add').setDescription('Put a role on sale (Manage Server)')
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
          .addIntegerOption((o) => o.setName('price').setDescription('Price').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)))
        .addSubcommand((s) => s.setName('remove').setDescription('Take a role off sale (Manage Server)')
          .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))),
      async run(i) {
        const sub = i.options.getSubcommand();
        const currency = cur(i.guildId);
        if (sub === 'list') {
          const items = await db.all('SELECT * FROM shop_items WHERE guild_id = $1 ORDER BY price', [i.guildId]);
          const body = items.map((it) => `<@&${it.role_id}> · **${fmt(it.price)}** ${currency}`).join('\n') || 'The shop is empty.';
          return respond(i, { embeds: [new EmbedBuilder().setColor(COLOR.gold).setTitle('Role shop').setDescription(body)], allowedMentions: { parse: [] } });
        }
        const role = i.options.getRole('role', true);
        if (sub === 'add' || sub === 'remove') {
          if (!i.memberPermissions.has(P.ManageGuild)) return fail(i, 'You need Manage Server to do that.');
          if (sub === 'remove') {
            await db.run('DELETE FROM shop_items WHERE guild_id = $1 AND role_id = $2', [i.guildId, role.id]);
            return ok(i, `${role} removed from the shop.`, { allowedMentions: { parse: [] } });
          }
          const problem = roleError(i, role);
          if (problem) return fail(i, problem);
          const price = i.options.getInteger('price', true);
          await db.run(
            'INSERT INTO shop_items(guild_id, role_id, price) VALUES ($1, $2, $3) ON CONFLICT (guild_id, role_id) DO UPDATE SET price = excluded.price',
            [i.guildId, role.id, price],
          );
          return ok(i, `${role} is on sale for **${fmt(price)}** ${currency}.`, { allowedMentions: { parse: [] } });
        }
        const item = await db.one('SELECT * FROM shop_items WHERE guild_id = $1 AND role_id = $2', [i.guildId, role.id]);
        if (!item) return fail(i, 'That role is not for sale.');
        if (i.member.roles.cache.has(role.id)) return fail(i, 'You already own that.');
        if (!(await spendCredits(i.guildId, i.user.id, item.price))) return fail(i, 'You do not have enough.');
        try {
          await i.member.roles.add(role, 'Bought in the shop');
        } catch (err) {
          await addCredits(i.guildId, i.user.id, item.price);
          throw err;
        }
        return ok(i, `You bought ${role} for **${fmt(item.price)}** ${currency}.`, { allowedMentions: { parse: [] } });
      },
    },
    {
      data: cmd('economy', 'Adjust a member\'s balance', P.ManageGuild)
        .addSubcommand((s) => s.setName('give').setDescription('Give credits')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000)))
        .addSubcommand((s) => s.setName('take').setDescription('Take credits')
          .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
          .addIntegerOption((o) => o.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1).setMaxValue(1_000_000_000))),
      async run(i) {
        const user = i.options.getUser('user', true);
        const amount = i.options.getInteger('amount', true);
        const give = i.options.getSubcommand() === 'give';
        await addCredits(i.guildId, user.id, give ? amount : -amount, user.username);
        return ok(i, `${give ? 'Gave' : 'Took'} **${fmt(amount)}** ${cur(i.guildId)} ${give ? 'to' : 'from'} **${user.username}**.`);
      },
    },
  ],
};
