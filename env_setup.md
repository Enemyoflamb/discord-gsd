# env setup

Quick setup for `discord-gsd`.

This app assumes:

- `discord-gsd`, `gsd`, and Claude Code are running in the same runtime/container
- `gsd` is already installed and callable from that runtime
- one bot instance controls one configured GSD project path

## 1. Install dependencies

```bash
npm install
```

## 2. Create `.env`

Copy `.env.example` to `.env` and fill these values:

```env
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_OWNER_ID=
DISCORD_PARENT_CHANNEL_ID=
GSD_PROJECT_DIR=
```

Optional:

```env
GSD_CLI_PATH=
GSD_MODEL=
GSD_BARE=false
DISCORD_MESSAGE_CHUNK_SIZE=1500
LOG_LEVEL=info
```

## 3. Find the Discord IDs

Enable **Developer Mode** in Discord first.

### `DISCORD_GUILD_ID`
- Right-click the target server
- Click **Copy Server ID**

### `DISCORD_OWNER_ID`
- Right-click your Discord user
- Click **Copy User ID**

### `DISCORD_PARENT_CHANNEL_ID`
- Right-click the text channel where session threads should be created
- Click **Copy Channel ID**

## 4. Set up the bot in Discord Developer Portal

Open your application in the **Discord Developer Portal**.

### Bot settings
Enable:
- **Message Content Intent**

### OAuth2 URL / invite scopes
Invite the bot with these scopes:
- `bot`
- `applications.commands`

### Recommended bot permissions
At minimum, the bot should have:
- View Channels
- Send Messages
- Create Public Threads
- Send Messages in Threads
- Add Reactions
- Read Message History

## 5. Set `GSD_PROJECT_DIR` correctly

This must be the path to the target repo **inside the same runtime where `discord-gsd` is running**.

Examples:

Linux/container:
```env
GSD_PROJECT_DIR=/workspace/dgtest1
```

Windows host:
```env
GSD_PROJECT_DIR=C:\Users\Brendan\Desktop\opencode\sandbox\my-project
```

Use the path that exists from the app's point of view.

## 6. Confirm `gsd` is available

```bash
gsd --help
```

If that fails, set:

```env
GSD_CLI_PATH=/absolute/path/to/gsd
```

## 7. Start the app

```bash
npm start
```

A healthy startup should log:

- `starting discord-gsd`
- `discord slash commands registered`
- `discord ready`

## 8. First Discord test

In the configured server:

```text
/dg input:"/gsd init"
```

The bot should create a thread under the configured parent channel.

Then reply inside the thread to continue the session.

## Common errors

### `Missing required environment variable: GSD_PROJECT_DIR`
Your `.env` is missing `GSD_PROJECT_DIR`, or `.env` was not created.

### `GSD_PROJECT_DIR does not exist`
The path is wrong for the runtime where the app is running.

### `Used disallowed intents`
Enable **Message Content Intent** in the Discord Developer Portal.

### `Missing Access`
Usually one of these:
- `DISCORD_GUILD_ID` points to the wrong server
- the bot is not installed in that server
- the invite omitted the `applications.commands` scope
- the bot cannot view the configured parent channel

### Bot starts but `/dg` does not appear
Guild-scoped slash command registration can take a short moment after startup. If it never appears, re-check:
- bot token belongs to the same application you invited
- correct `DISCORD_GUILD_ID`
- `applications.commands` scope was included in the invite

### `/dg-reattach` says there is no active session
That command only works while the same bot process still has an in-memory session. It does not resurrect an old session after a full restart.
igured parent channel

### Bot starts but `/dg` does not appear
Guild-scoped slash command registration can take a short moment after startup. If it never appears, re-check:
- bot token belongs to the same application you invited
- correct `DISCORD_GUILD_ID`
- `applications.commands` scope was included in the invite
