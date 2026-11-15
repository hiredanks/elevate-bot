import 'dotenv/config';

export const config = {
  token: process.env.DISCORD_TOKEN?.trim() || null,
  databaseUrl: process.env.DATABASE_URL?.trim() || null,
  dataDir: process.env.DATA_DIR || 'data',
  // Optional: register commands to one server only (updates instantly, handy while testing).
  devGuildId: process.env.DEV_GUILD_ID?.trim() || null,
  // Render injects PORT and health-checks it.
  port: Number(process.env.PORT) || 3001,
  // Website login stays off until both of these are set.
  clientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() || null,
  dashboardUrl: process.env.DASHBOARD_URL?.trim().replace(/\/$/, '') || null,
  // This service's own address. Render provides it automatically.
  publicUrl: (process.env.PUBLIC_URL?.trim() || process.env.RENDER_EXTERNAL_URL || `http://localhost:${Number(process.env.PORT) || 3001}`).replace(/\/$/, ''),
  // From console.groq.com. The AI stays off until this is set.
  groqKey: process.env.GROQ_API_KEY?.trim() || null,
  // Stream alerts. Each platform turns on once its keys are set.
  twitchClientId: process.env.TWITCH_CLIENT_ID?.trim() || null,
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET?.trim() || null,
  kickClientId: process.env.KICK_CLIENT_ID?.trim() || null,
  kickClientSecret: process.env.KICK_CLIENT_SECRET?.trim() || null,
  youtubeApiKey: process.env.YOUTUBE_API_KEY?.trim() || null,
  // "Log in with Epic Games" for scrims. Without these, members type their Epic name instead.
  epicClientId: process.env.EPIC_CLIENT_ID?.trim() || null,
  epicClientSecret: process.env.EPIC_CLIENT_SECRET?.trim() || null,
  // Tests only: lets music play from this computer. Never set it on Render.
  musicAllowPrivate: process.env.MUSIC_ALLOW_PRIVATE_URLS === '1',
  onRender: Boolean(process.env.RENDER),
};
