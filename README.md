# discord-gsd

Run a single GSD project behind a Discord bot.

This service assumes it is already running inside the same runtime/container as `gsd` and Claude Code. It does not start or manage containers itself.

This service is aimed at one project per process:

- a Discord bot logs into one guild
- `/dg <input>` relays a prompt or native `/gsd ...` command into GSD
- a session thread is created under one configured parent text channel
- replies in that thread go back to the same GSD session
- only **final assistant output** is posted back to Discord, in fresh messages up to 1500 characters each
- blockers are surfaced immediately and answered by replying in-thread

## Why this shape

Discord message edits during streaming hit rate limits quickly. This bridge buffers assistant output locally and only flushes it when GSD emits `execution_complete`.

## Required environment variables

- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_OWNER_ID`
- `DISCORD_PARENT_CHANNEL_ID`
- `GSD_PROJECT_DIR`

Optional:

- `GSD_CLI_PATH`
- `GSD_MODEL`
- `GSD_BARE`
- `DISCORD_MESSAGE_CHUNK_SIZE` (default `1500`)
- `LOG_LEVEL` (`debug|info|warn|error`, default `info`)

See:

- `.env.example`
- `env_setup.md`
- `discord_bot_setup.md`

## Discord bot setup

For the full bot setup and invite flow, read:

- `discord_bot_setup.md`

Important points:

1. **Message Content Intent** must be enabled.
2. The bot invite must include both:
   - `bot`
   - `applications.commands`
3. The bot must be able to view the configured parent text channel.

## Local development

Prerequisite: the `gsd` CLI must be available in `PATH`, or `GSD_CLI_PATH` must point to it.

```bash
npm install
npm test
npm start
```

For watch mode:

```bash
npm run dev
```

## Discord usage

### Start or steer GSD

Use the slash command:

```text
/dg input:"/gsd init"
/dg input:"continue with the current milestone"
```

If no thread exists yet, the bot creates one under the configured parent channel.

### Reply to the bot

Inside the session thread, just reply normally. The bot will:

- resolve a pending blocker when one exists
- otherwise relay the text back into the live GSD session

For select blockers, reply with the option number.
For confirm blockers, reply with `yes` or `no`.

## Runtime model

`discord-gsd` assumes it is running in the same runtime/container as `gsd` and Claude Code.

The service does **not** launch or manage containers itself. It only invokes the local `gsd` CLI already present in that runtime.

The included Dockerfile is just an example of packaging the service and `gsd` into one image.

## Commands

```bash
npm test
npm run build
npm start
```
