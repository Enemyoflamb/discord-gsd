# Discord bot setup

Quick setup for a **private** Discord bot used by `discord-gsd`.

This guide covers:

- creating or configuring the bot
- inviting it to your server
- enabling the required intents
- collecting the IDs needed for `.env`

## 1. Open the Discord Developer Portal

Go to:

- https://discord.com/developers/applications

Select your application.

## 2. Configure the bot

Open **Bot** in the left sidebar.

### Public vs private bot

If you want a private bot:

- turn **Public Bot** **off**

That is fine. A private bot can still be added to your own server by you.

### Required intent

Enable:

- **Message Content Intent**

`discord-gsd` needs this because it reads message replies inside Discord threads.

Without it, startup will fail with:

- `Used disallowed intents`

## 3. Invite the bot to your server

Open **OAuth2** → **URL Generator**.

### Required scopes

Select:

- `bot`
- `applications.commands`

### Recommended permissions

Select at least:

- View Channels
- Send Messages
- Read Message History
- Create Public Threads
- Send Messages in Threads
- Add Reactions

Then copy the generated invite URL.

Open that URL while logged into the Discord account that manages your server.

Choose the target server and authorize the bot.

## 4. If your server does not appear in the invite dropdown

Usually one of these is true:

- you are logged into the wrong Discord account
- that account does not have **Manage Server** on the target server
- the bot/application belongs to a different account than the one you are currently using

## 5. Confirm the bot is actually in the server

After the invite:

- open the target server
- confirm the bot appears in the member list
- confirm the bot shows as online once `discord-gsd` starts

If the app says `Unknown Guild`, the bot is usually not in the server referenced by `DISCORD_GUILD_ID`, or the ID is wrong.

## 6. Enable Developer Mode and collect IDs

In Discord:

- open **User Settings**
- go to **Advanced**
- enable **Developer Mode**

Then collect these values.

### `DISCORD_GUILD_ID`

- right-click the target server
- click **Copy Server ID**

### `DISCORD_OWNER_ID`

- right-click your Discord user
- click **Copy User ID**

### `DISCORD_PARENT_CHANNEL_ID`

This should be a normal text channel where the bot will create per-session threads.

- right-click the target text channel
- click **Copy Channel ID**

## 7. Put the values into `.env`

Example:

```env
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=123456789012345678
DISCORD_OWNER_ID=234567890123456789
DISCORD_PARENT_CHANNEL_ID=345678901234567890
GSD_PROJECT_DIR=/workspace/dgtest1
```

If `gsd` is not in `PATH`, also set:

```env
GSD_CLI_PATH=/absolute/path/to/gsd
```

## 8. Start the app

```bash
npm start
```

A healthy startup should log:

- `starting discord-gsd`
- `discord slash commands registered`
- `discord ready`

## 9. First Discord test

In your server, run:

```text
/dg input:"/gsd init"
```

Expected behavior:

- the bot responds to the slash command
- a thread is created under the configured parent text channel
- the GSD session starts there
- replies in that thread go back into the active GSD session

## Common errors

### `Used disallowed intents`

Enable **Message Content Intent** in the Developer Portal.

### `Unknown Guild`

Usually one of these:

- `DISCORD_GUILD_ID` is wrong
- the bot is not installed in that server
- the token belongs to a different application than the bot you invited

### `Missing Access`

Usually one of these:

- the bot was invited to the wrong server
- the invite omitted the `applications.commands` scope
- the bot cannot view the configured parent channel
- `DISCORD_PARENT_CHANNEL_ID` points to the wrong channel

### `/dg` does not appear

Check:

- the bot is in the correct server
- the invite used `applications.commands`
- `DISCORD_GUILD_ID` matches that server
- give Discord a short moment to finish guild-scoped slash-command registration after startup

### `/dg-reattach` cannot find a session

That command only works for the current in-memory session while the same bot process is still running. It is not a post-restart recovery command.

## Related docs

- `env_setup.md`
- `README.md`
Check:

- the bot is in the correct server
- the invite used `applications.commands`
- `DISCORD_GUILD_ID` matches that server
- give Discord a short moment to finish guild-scoped slash-command registration after startup

## Related docs

- `env_setup.md`
- `README.md`
