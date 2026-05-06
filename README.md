# discord-gsd

Run multiple GSD projects behind one Discord bot.

This service assumes it is already running inside the same runtime/container as `gsd` and Claude Code. It does not start or manage containers itself.

This service is aimed at one workspace per process:

- a Discord bot logs into one guild
- `GSD_PROJECT_DIR` points at a workspace root that contains project directories plus `projectlist.json`
- `/dg create project:<name>` creates and registers a new project directory under that workspace root
- `/dg project project:<id> [prompt]` opens or continues work on a registered project
- `/dg context [project:<id>]` shows the session/model details the RPC surface exposes for a project
- `/dg new-context [project:<id>]` starts a fresh in-memory session for a project thread
- `/dg list` lists the registered projects available to work on
- `/gsd command:<name> [args]` runs native GSD slash commands inside the active project thread
- a per-project session thread is created under one configured parent text channel
- replies in that thread go back to the same GSD session
- final assistant output is posted back to Discord in fresh messages up to 1500 characters each
- thinking transcript blocks and shell-command activity can also be posted as fresh progress messages when GSD emits them
- blockers are surfaced immediately and answered by replying in-thread

## Why this shape

Discord message edits during streaming hit rate limits quickly. This bridge buffers assistant output locally, forwards machine/thinking activity only when a real block is available, and avoids live-editing progress messages.

## Required environment variables

- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_OWNER_ID`
- `DISCORD_PARENT_CHANNEL_ID`
- `GSD_PROJECT_DIR` — workspace root where `projectlist.json` and per-project directories live

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

`npm install` now pulls in a pinned local `gsd-pi` version for this repo. `discord-gsd` resolves multiple CLI candidates at startup, prefers the global `gsd` install when available, and falls back to repo-local loaders only if needed. Use `GSD_CLI_PATH` only if you want to force a specific binary.

```bash
npm install
npm test
npm start
```

For watch mode:

```bash
npm run dev
```

### Project workflow

Use `/dg` to manage the workspace project registry:

```text
/dg create project:"Acme API"
/dg list
/dg project project:acme-api
/dg context project:acme-api
/dg new-context project:acme-api
/dg rename project:acme-api name:"Acme API v2"
/dg end project:acme-api
/dg remove project:acme-api
/dg project project:acme-api prompt:"continue with the current milestone"
```

Behavior:
- `create` makes a new directory under `GSD_PROJECT_DIR`, registers it in `projectlist.json`, and does not start GSD yet
- `list` shows the currently registered project ids, names, and paths, sorted by recent use
- `project` opens or reuses the Discord thread for that project and starts work there
- `context` shows the active model, model context window, cumulative session tokens, queued-message count, and streaming status; exact current context usage is not exposed by the current GSD RPC interface
- `new-context` starts a fresh in-memory session for that project thread without deleting the project or thread
- `rename` updates the registry display name only — it does not move or rename the project directory
- `end` stops the active in-memory GSD session for that project (similar to Ctrl-C out of the live GSD session) and leaves the Discord thread in place
- `remove` deletes the project from `projectlist.json` only — it does not delete the project directory, and it is blocked while an in-memory session for that project is active
- if the project already has `.gsd/`, `project` defaults to `continue with the current milestone`
- if the project is new and has no `.gsd/`, `project` defaults to `/gsd init`

### Native GSD commands

Use `/gsd` inside a project thread for native GSD commands:

```text
/gsd command:init
/gsd command:help
/gsd command:auto args:"--verbose"
/gsd command:workflow args:"run demo"
```

The `/gsd` command option autocompletes the top-level commands from GSD help, and the `args` field autocompletes common nested subcommands plus dynamic values where local state exists:

- workflow definition names from `.gsd/workflow-defs/`
- template names for `templates info`
- extension IDs from `GSD_HOME/agent/extensions/`
- MCP server names from `.mcp.json` or `.gsd/mcp.json`

If no thread exists yet, the bot creates one under the configured parent channel.

### Reply to the bot

Inside the session thread, just reply normally. The bot will:

- resolve a pending blocker when one exists
- otherwise relay the text back into the live GSD session

For select blockers, reply with the option number.
For confirm blockers, reply with `yes` or `no`.

### Reattach the current session

If the thread mapping drifts, use:

```text
/dg-reattach
```

Behavior:
- if you run it inside a thread, the current in-memory session is rebound to that thread
- if you run it outside a thread, the bot creates a fresh thread and rebinds the current in-memory session there

## Thinking / progress visibility

While GSD is still running a turn, the bot can post discrete progress messages without editing prior Discord messages.

Native GSD slash commands that answer via notifications — for example `/gsd help` — are forwarded to Discord as full messages.

If the active model/provider exposes reasoning text in the event stream, the bot posts thinking transcript chunks in 500-character blocks:

```text
[Thinking 1 · provider/model]
...
```

If GSD starts shell activity through `bash`, `async_bash`, or command-running `bg_shell` actions, the bot also posts the command as a machine-activity block:

````text
[Machine · bash]
```bash
npm test
```
````

Not all models/providers expose thinking text. If no thinking transcript appears, that may be a provider limitation rather than a bot problem.

## Session lifecycle

A GSD **session** is not the same thing as a single reply.

Current model:

- one active in-memory GSD session per registered project directory
- `/dg project` starts or resumes a project-specific session thread
- `/gsd` runs inside the currently bound project thread
- later `/dg project`, `/gsd`, and thread replies reuse that same project session
- each user message creates a new turn inside that session

The session ends when:

- `discord-gsd` shuts down
- the GSD/RPC child process errors out
- the controller tears it down and recreates it after failure

Sessions are currently **in-memory and process-bound**. `/dg-reattach` works only while the same bot process is still alive; it is not full post-restart session recovery.

When the service shuts down cleanly or the session errors out, the bot posts a close/failure notice into the thread so the user knows the session is no longer attachable.

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
