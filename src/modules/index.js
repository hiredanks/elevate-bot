import ai from './ai.js';
import antinuke from './antinuke.js';
import antiraid from './antiraid.js';
import automod from './automod.js';
import broadcast from './broadcast.js';
import community, { birthdaysModule } from './community.js';
import custom from './custom.js';
import economy from './economy.js';
import epic from './epic.js';
import giveaways from './giveaways.js';
import images from './images.js';
import invites from './invites.js';
import leveling from './leveling.js';
import logging from './logging.js';
import moderation from './moderation.js';
import music from './music.js';
import roles from './roles.js';
import scrims from './scrims.js';
import site from './site.js';
import starboard from './starboard.js';
import stats from './stats.js';
import stayvoice from './stayvoice.js';
import streams from './streams.js';
import suggestions from './suggestions.js';
import tempvoice from './tempvoice.js';
import tickets from './tickets.js';
import trap from './trap.js';
import utility from './utility.js';
import verification from './verification.js';
import webhooks from './webhooks.js';
import welcome from './welcome.js';

// Order matters: events run top to bottom. Invites feeds Welcome, security can block joins,
// and the trap channel and AutoMod must see a message before XP, tags, auto-replies or the AI do.
export const modules = [
  invites, antinuke, antiraid, verification, trap, automod, stats, moderation, logging, welcome, leveling, economy,
  roles, custom, ai, starboard, giveaways, epic, scrims, tickets, suggestions, broadcast, webhooks, streams, images, community, birthdaysModule,
  tempvoice, stayvoice, music, site, utility,
];
