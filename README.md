# ELEVATE: Discord bot

The ELEVATE community bot, on its own. It runs on Render, keeps its data in Postgres, and handles the login for the website. The website is a separate project in its own repository.

## What it does

| Area | Features |
| --- | --- |
| Moderation | Ban, temporary ban, softban, kick, timeout, warn, automatic punishment at warning counts, case history, purge, lock, slowmode |
| AutoMod | Scam links, invites, links, blocked words, mass mentions, caps, emoji, walls of text, zalgo, spam, repeats |
| Security | Anti-nuke with automatic undo, anti-raid, server lockdown, minimum account age, captcha verification, unverified role that only sees the verify channel |
| Trap channel | Anyone who types in the chosen channel is banned (or softbanned, kicked or timed out). Catches spam bots and hacked accounts. Staff are never punished |
| Music | `/music play` with a direct audio link or an uploaded file, `/music radio` for stations saved on the website, plus skip, pause, queue and stop |
| Fortnite scrims | Post a scrim from the website or `/scrim create` with the mode, build or Zero Build, region, start time and custom key. Members link their Epic account and press **Register**. When it starts, registered players press **Get key** and see the key in a private reply, so it never leaks in the channel. `/scrim next` runs the next game with a new key |
| Stream alerts | Twitch, Kick, YouTube and TikTok live alerts: your message and ping, the streamer's name and profile picture, the stream title and a **Watch Stream** button. YouTube works with no keys; TikTok, and Twitch or Kick without keys, are posted by the streamer with `/live` |
| Self roles | Role menus with buttons or dropdowns, made on the website or with `/rolepanel`, plus reaction roles |
| Webhook messages | `/webhook` or the website posts under any name and picture. The real sender is always written to the moderation log |
| Messaging | `/broadcast` pings @everyone, `/dm` messages one member, `/dm-all` messages everyone who signed up |
| Welcome | Image cards in ELEVATE purple, DMs, goodbyes, auto roles, role restore on rejoin |
| Levels and economy | Text and voice XP, rank cards, role rewards, credits, daily rewards, role shop |
| Community | AI chat (Groq), 24/7 voice, giveaways, tickets, suggestions, starboard, invite logs, polls, reminders, birthdays |
| Stats | Live counter channels, member goal, activity charts |

Type `/help` in Discord for the full list.

Music plays direct links to audio (a radio stream or a link ending in .mp3, .ogg and similar) and audio files uploaded to Discord. YouTube, Spotify and SoundCloud are refused, because their terms forbid playing them through bots and they have shut down music bots that did. Links to private network addresses are refused too, so nobody can use the bot to read things inside Render.

The bot does not log into Fortnite, send friend requests or join lobbies. That needs a Fortnite account run by unofficial software, which [Epic warns against](https://www.epicgames.com/help/c-202300000001636/c-202300000001721/bots-discord-and-other-bots-a202300000082715) and which has led to account bans. Players enter the key themselves, which is how custom matchmaking is meant to work.

`/dm-all` only messages members who signed up, through the button from `/dm-all panel` or the one shown after they pass verification. [Discord treats mass DMs from bots as API abuse](https://discord.com/safety/360044104071-tips-against-spam-and-hacking) and can restrict the bot.

## Host it on Render

This is a separate bot from any other you run, so it needs its own Discord application, its own Render service (about $7 a month) and its own database.

### 1. Create the Discord application

1. In [the Discord Developer Portal](https://discord.com/developers/applications), create an application named ELEVATE.
2. Under **General Information**, upload `elevate-avatar.png` as the app icon. Under **Bot**, upload it as the bot's avatar too.
3. Under **Bot**, press **Reset Token** and save the token. Turn on all three **Privileged Gateway Intents**.
4. Under **OAuth2**, save the **Client Secret**.

### 2. Create the database

Create a new free project on [Supabase](https://supabase.com), press **Connect**, and copy the **Session pooler** connection string with your password filled in. Use a new project rather than your other bot's database.

### 3. Put this folder on GitHub

In GitHub Desktop, choose **File > Add local repository**, pick this `bot` folder, create the repository, and publish it privately as `elevate-bot`.

### 4. Deploy on Render

Choose **New > Blueprint**, pick `elevate-bot`, and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, `DATABASE_URL`, `DASHBOARD_URL` (your ELEVATE website address) and, for AI chat, `GROQ_API_KEY`. Check that **Instance Type** is **Starter**.

### 5. Finish in Discord

1. In the Developer Portal under **OAuth2 > Redirects**, add `https://YOUR-RENDER-ADDRESS/auth/callback`.
2. In Render's **Logs**, open the `Invite link:` line to add the bot to the ELEVATE server.
3. In **Server Settings > Roles**, drag the bot's role to the very top.

### 6. Stream alerts

Add alerts on the website's **Stream alerts** page, or with `/stream add`. `/stream test` posts a sample, without the ping, so you can see how it looks.

| Platform | Without keys | With keys |
| --- | --- | --- |
| YouTube | Works. Uses YouTube's public feed and posts when a new video or stream appears, with the video picture. Add the channel by its ID (starts with `UC`) | Posts only when a stream goes live, with the profile picture, and accepts @handles |
| Twitch, Kick | The streamer posts the alert with `/live` | Posted automatically within 2 minutes of going live |
| TikTok | The streamer posts the alert with `/live`. TikTok has no public way for bots to check who is live | Same |

For `/live` alerts, fill in **Profile picture link** so the alert shows their picture. On the **Stream alert settings** page, pick a **Streamer role**: members with it can use `/live`, and staff always can.

The keys are free and only the server owner sets them up, once. Add them in Render under **Environment**, then save, and the service restarts. Only add the platforms you want.

| Platform | Where to get the keys | Render variables |
| --- | --- | --- |
| Twitch | [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps): **Register Your Application**, any name, OAuth Redirect URL `http://localhost`, category **Chat Bot**, client type **Confidential**. Copy the **Client ID**, then press **New Secret** | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` |
| Kick | [kick.com](https://kick.com) **Settings > Developer > Create App**, any name, redirect URL `http://localhost`. Copy the **Client ID** and **Client Secret** | `KICK_CLIENT_ID`, `KICK_CLIENT_SECRET` |
| YouTube | [console.cloud.google.com](https://console.cloud.google.com): create a project, enable **YouTube Data API v3**, then **Credentials > Create credentials > API key** | `YOUTUBE_API_KEY` |

### 7. Turn on "Log in with Epic Games" (optional)

Without this, members link by typing their Epic name, which anyone could fake. With it, they log in with Epic, so the link is proven and one Epic account can only be linked to one Discord account.

1. Sign in at [dev.epicgames.com/portal](https://dev.epicgames.com/portal) and create an organization and a product (any name, such as ELEVATE).
2. In the product's settings, create a client and copy its **Client ID** and **Client Secret**.
3. Under **Epic Account Services**, fill in the brand settings, keep the **Basic Profile** permission, link the client, and add the redirect URL `https://YOUR-RENDER-ADDRESS/epic/callback`.
4. Submit the brand review. Until Epic approves it, which takes a few days, only members of your Epic organization can log in, so wait for approval before the next step.
5. On Render, add `EPIC_CLIENT_ID` and `EPIC_CLIENT_SECRET`.

## Run on your own PC

```bash
npm install
```

Copy `.env.example` to `.env`, add your `DISCORD_TOKEN`, then:

```bash
npm start
```

## Tests

```bash
npm test
```
