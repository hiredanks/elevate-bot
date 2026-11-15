import { createApi } from './api/server.js';
import { createBot } from './bot.js';
import { config } from './config.js';
import { closeDatabase, connectDatabase } from './core/db.js';
import { jobs } from './core/jobs.js';
import { acquireLease, releaseLease } from './core/lease.js';
import { logger } from './core/logger.js';
import { loadAllSettings } from './core/settings.js';
import { modules } from './modules/index.js';

function explainLoginError(err) {
  if (err.code === 'TokenInvalid') return 'DISCORD_TOKEN is wrong. Reset it in the Discord Developer Portal under Bot, and paste the new one.';
  if (/disallowed intents/i.test(err.message)) {
    return 'Open the Discord Developer Portal, go to your app, then Bot, and turn on all three Privileged Gateway Intents: Presence, Server Members, Message Content.';
  }
  return err.message;
}

async function main() {
  if (!config.token) throw new Error('DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  await connectDatabase();
  const client = createBot();
  const loaded = await loadAllSettings();
  logger.info(`Database ready. Loaded settings for ${loaded} server(s).`);

  // Started before login so Render's health check passes while the old instance is shutting down.
  const server = createApi(client, modules).listen(config.port, () => logger.info(`HTTP listening on port ${config.port}`));
  if (!config.clientSecret || !config.dashboardUrl) logger.warn('DISCORD_CLIENT_SECRET or DASHBOARD_URL is not set, so website login is off.');
  else logger.info(`Website login is on for ${config.dashboardUrl}. Discord's OAuth2 > Redirects must list ${config.publicUrl}/auth/callback`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down.`);
    jobs.stop();
    for (const mod of modules) await mod.shutdown?.(client)?.catch?.((err) => logger.error(`${mod.name} shutdown failed`, err));
    await client.destroy();
    await releaseLease().catch(() => {});
    server.close();
    await closeDatabase().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await acquireLease();
  await client.login(config.token).catch((err) => { throw new Error(explainLoginError(err)); });
}

process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', err));

main().catch((err) => {
  console.error(`\nCould not start: ${err.message}\n`);
  process.exit(1);
});
