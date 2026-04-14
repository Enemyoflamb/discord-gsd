import { basename } from "node:path";

import {
  AnyThreadChannel,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  Message,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  ThreadAutoArchiveDuration,
} from "discord.js";
import type { SdkAgentEvent } from "@gsd-build/rpc-client";

import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type {
  SessionBlockedEvent,
  SessionCompletedEvent,
  SessionErrorEvent,
  SessionEventEnvelope,
  SessionStartedEvent,
  SessionThreadState,
} from "./models.js";
import { formatBlockerMessage } from "./blockers.js";
import { FinalOutputStore, splitIntoDiscordChunks } from "./output-buffer.js";
import { buildThreadName, resolveRelayTarget } from "./routing.js";
import { SessionController } from "./session-controller.js";

const DG_COMMAND = new SlashCommandBuilder()
  .setName("dg")
  .setDescription("Relay a prompt or /gsd command into the configured GSD session")
  .addStringOption((option) =>
    option
      .setName("input")
      .setDescription("Prompt or /gsd command to send")
      .setRequired(true),
  )
  .toJSON();

function describeDiscordStartupError(error: unknown, config: AppConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";

  if (message.includes("Used disallowed intents")) {
    return "Used disallowed intents — enable Message Content Intent for the Discord bot in the Discord Developer Portal.";
  }

  if (code === "10004" || message.includes("Unknown Guild")) {
    return [
      `Unknown Guild for DISCORD_GUILD_ID (${config.discordGuildId}).`,
      "Make sure the bot is installed in that server and the guild ID matches the actual server you invited it to.",
    ].join(" ");
  }

  if (code === "50001" || message.includes("Missing Access")) {
    return [
      "Missing Access while registering Discord slash commands or fetching the configured guild/channel.",
      `Check DISCORD_GUILD_ID (${config.discordGuildId}) and DISCORD_PARENT_CHANNEL_ID (${config.discordParentChannelId}).`,
      "Make sure the bot was invited with both the `bot` and `applications.commands` scopes and can view the parent channel.",
    ].join(" ");
  }

  return message;
}

export class DiscordGsdService {
  private readonly client: Client;
  private readonly outputStore = new FinalOutputStore();
  private readonly sessionThreads = new Map<string, SessionThreadState>();
  private readonly threadToSession = new Map<string, string>();
  private readonly messageToSession = new Map<string, string>();
  private readonly pendingThreadByProject = new Map<string, SessionThreadState>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly controller: SessionController,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.bindDiscordEvents();
    this.bindSessionEvents();
  }

  async start(): Promise<void> {
    const readyPromise = new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.client.off("clientReady", onReady);
        this.client.off("error", onError);
      };

      const onReady = () => {
        cleanup();
        void this.onReady().then(resolve, reject);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      this.client.once("clientReady", onReady);
      this.client.once("error", onError);
    });

    await this.client.login(this.config.discordBotToken);

    try {
      await readyPromise;
    } catch (error) {
      throw new Error(describeDiscordStartupError(error, this.config));
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    await this.controller.shutdown();
  }

  private bindDiscordEvents(): void {
    this.client.on("interactionCreate", (interaction) => {
      void this.onInteraction(interaction);
    });

    this.client.on("messageCreate", (message) => {
      void this.onMessage(message);
    });
  }

  private bindSessionEvents(): void {
    this.controller.on("session-started", (payload: SessionStartedEvent) => {
      void this.onSessionStarted(payload);
    });
    this.controller.on("session-event", (payload: SessionEventEnvelope) => {
      void this.onSessionEvent(payload);
    });
    this.controller.on("session-blocked", (payload: SessionBlockedEvent) => {
      void this.onSessionBlocked(payload);
    });
    this.controller.on("session-completed", (payload: SessionCompletedEvent) => {
      void this.onSessionCompleted(payload);
    });
    this.controller.on("session-error", (payload: SessionErrorEvent) => {
      void this.onSessionError(payload);
    });
  }

  private isAuthorized(userId: string): boolean {
    return userId === this.config.discordOwnerId;
  }

  private async onReady(): Promise<void> {
    const user = this.client.user;
    if (!user) {
      throw new Error("Discord client is ready without a user object.");
    }

    await this.client.guilds.fetch(this.config.discordGuildId);
    await this.registerCommands(user.id);
    await this.getParentChannel();

    this.logger.info("discord ready", {
      userTag: user.tag,
      parentChannelId: this.config.discordParentChannelId,
      projectDir: this.config.gsdProjectDir,
    });
  }

  private async registerCommands(applicationId: string): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(this.config.discordBotToken);
    await rest.put(
      Routes.applicationGuildCommands(applicationId, this.config.discordGuildId),
      { body: [DG_COMMAND] },
    );
    this.logger.info("discord slash commands registered", {
      guildId: this.config.discordGuildId,
      commandCount: 1,
    });
  }

  private async getParentChannel(): Promise<TextChannel> {
    const channel = await this.client.channels.fetch(this.config.discordParentChannelId);
    if (!channel) {
      throw new Error(`Parent channel not found: ${this.config.discordParentChannelId}`);
    }
    if (!(channel instanceof TextChannel) || channel.type !== ChannelType.GuildText) {
      throw new Error("DISCORD_PARENT_CHANNEL_ID must reference a standard guild text channel.");
    }
    return channel;
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "dg") {
      return;
    }

    if (!this.isAuthorized(interaction.user.id)) {
      await interaction.reply({ content: "You are not allowed to use this bot.", ephemeral: true });
      return;
    }

    await this.handleDgCommand(interaction);
  }

  private async handleDgCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString("input", true).trim();
    if (!input) {
      await interaction.reply({ content: "Input cannot be empty.", ephemeral: true });
      return;
    }

    const activeChannelId = interaction.channelId;
    const activeThreadSession = this.threadToSession.get(activeChannelId);
    const threadState = activeThreadSession
      ? this.sessionThreads.get(activeThreadSession) ?? null
      : await this.getOrCreatePendingThread(input);

    await interaction.deferReply({ ephemeral: true });

    try {
      const dispatch = await this.controller.dispatch(input);
      const mapped = await this.ensureSessionThreadState(
        dispatch.session.sessionId,
        dispatch.session.projectDir,
        dispatch.session.projectName,
        input,
      );

      if (dispatch.startedFresh) {
        await this.sendToSession(mapped.sessionId, `Started session for \`${dispatch.session.projectName}\`. Reply here or use \`/dg\` again.`);
      }

      await interaction.editReply({
        content: mapped.threadId === activeChannelId
          ? "Relayed to this thread."
          : `Relayed to <#${mapped.threadId}>.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("slash command relay failed", { error: message });
      await interaction.editReply({ content: `Failed to relay message: ${message}` });
      if (threadState) {
        await this.sendToSession(threadState.sessionId, `❌ Failed to start or relay to GSD: ${message}`);
      }
    }
  }

  private async getOrCreatePendingThread(input: string): Promise<SessionThreadState> {
    const currentSession = this.controller.getCurrentProjectSession();
    if (currentSession) {
      const existing = this.sessionThreads.get(currentSession.sessionId);
      if (existing) {
        return existing;
      }
    }

    const pending = this.pendingThreadByProject.get(this.config.gsdProjectDir);
    if (pending) {
      return pending;
    }

    const parent = await this.getParentChannel();
    const projectName = basename(this.config.gsdProjectDir);
    const starter = await parent.send({
      content: `🧵 Starting GSD session for \`${projectName}\`...`,
      allowedMentions: { parse: [] },
    });

    const thread = await starter.startThread({
      name: buildThreadName(input),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `discord-gsd session for ${projectName}`,
    });

    const state: SessionThreadState = {
      sessionId: "pending",
      threadId: thread.id,
      starterMessageId: starter.id,
      lastBotMessageIds: new Set([starter.id]),
    };

    this.pendingThreadByProject.set(this.config.gsdProjectDir, state);
    return state;
  }

  private async ensureSessionThreadState(
    sessionId: string,
    projectDir: string,
    projectName: string,
    input?: string,
  ): Promise<SessionThreadState> {
    const existing = this.sessionThreads.get(sessionId);
    if (existing) {
      return existing;
    }

    const pending = this.pendingThreadByProject.get(projectDir);
    if (pending) {
      pending.sessionId = sessionId;
      this.pendingThreadByProject.delete(projectDir);
      this.sessionThreads.set(sessionId, pending);
      this.threadToSession.set(pending.threadId, sessionId);
      this.messageToSession.set(pending.starterMessageId, sessionId);
      return pending;
    }

    const fallback = await this.getOrCreatePendingThread(input ?? projectName);
    fallback.sessionId = sessionId;
    this.pendingThreadByProject.delete(projectDir);
    this.sessionThreads.set(sessionId, fallback);
    this.threadToSession.set(fallback.threadId, sessionId);
    this.messageToSession.set(fallback.starterMessageId, sessionId);
    return fallback;
  }

  private async fetchThread(threadId: string): Promise<AnyThreadChannel> {
    const channel = await this.client.channels.fetch(threadId);
    if (!channel?.isThread()) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    if (channel.archived) {
      await channel.setArchived(false, "discord-gsd session activity");
    }
    return channel;
  }

  private rememberBotMessage(sessionId: string, messageId: string): void {
    this.messageToSession.set(messageId, sessionId);
    const state = this.sessionThreads.get(sessionId);
    state?.lastBotMessageIds.add(messageId);
  }

  private async sendToSession(sessionId: string, content: string): Promise<void> {
    const state = this.sessionThreads.get(sessionId);
    if (!state) {
      this.logger.warn("dropping outbound Discord message for unknown session", { sessionId });
      return;
    }

    const thread = await this.fetchThread(state.threadId);
    const message = await thread.send({ content, allowedMentions: { parse: [] } });
    this.rememberBotMessage(sessionId, message.id);
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot) {
      return;
    }
    if (!this.isAuthorized(message.author.id)) {
      return;
    }
    if (!message.content.trim()) {
      return;
    }

    const relayTarget = resolveRelayTarget(
      message.channelId,
      message.reference?.messageId,
      this.threadToSession,
      this.messageToSession,
    );
    if (!relayTarget) {
      return;
    }

    try {
      await this.controller.relayToSession(relayTarget.sessionId, message.content);
      await message.react("📨").catch(() => {});
      this.logger.info("discord reply relayed", {
        sessionId: relayTarget.sessionId,
        via: relayTarget.via,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error("discord reply relay failed", {
        sessionId: relayTarget.sessionId,
        error: detail,
      });
      await message.reply({
        content: `❌ ${detail}`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
  }

  private async onSessionStarted(event: SessionStartedEvent): Promise<void> {
    await this.ensureSessionThreadState(event.sessionId, event.projectDir, event.projectName);
    this.logger.info("session thread attached", {
      sessionId: event.sessionId,
      projectName: event.projectName,
    });
  }

  private async onSessionEvent(payload: SessionEventEnvelope): Promise<void> {
    await this.ensureSessionThreadState(payload.sessionId, payload.projectDir, basename(payload.projectDir));
    this.outputStore.updateFromEvent(payload.sessionId, payload.event);

    const eventType = (payload.event as Record<string, unknown>).type;
    if (eventType === "execution_complete") {
      await this.flushFinalOutput(payload.sessionId, payload.event);
    }
  }

  private async flushFinalOutput(sessionId: string, event: SdkAgentEvent): Promise<void> {
    const output = this.outputStore.consume(sessionId);
    const status = typeof (event as Record<string, unknown>).status === "string"
      ? String((event as Record<string, unknown>).status)
      : "completed";

    if (!output) {
      await this.sendToSession(sessionId, status === "completed"
        ? "✅ GSD finished with no assistant text to forward."
        : `⚠️ GSD finished with status: ${status}`);
      return;
    }

    if (status !== "completed") {
      await this.sendToSession(sessionId, `⚠️ GSD finished with status: ${status}`);
    }

    const chunks = splitIntoDiscordChunks(output, this.config.discordMessageChunkSize);
    for (const chunk of chunks) {
      await this.sendToSession(sessionId, chunk);
    }

    this.logger.info("final output flushed", {
      sessionId,
      chunkCount: chunks.length,
      charCount: output.length,
      status,
    });
  }

  private async onSessionBlocked(event: SessionBlockedEvent): Promise<void> {
    await this.ensureSessionThreadState(event.sessionId, event.projectDir, event.projectName);
    await this.sendToSession(event.sessionId, formatBlockerMessage(event.blocker));
    this.outputStore.clear(event.sessionId);
    this.logger.warn("session blocked", {
      sessionId: event.sessionId,
      method: event.blocker.method,
    });
  }

  private async onSessionCompleted(event: SessionCompletedEvent): Promise<void> {
    await this.ensureSessionThreadState(event.sessionId, event.projectDir, event.projectName);
    this.logger.info("session completed", {
      sessionId: event.sessionId,
      projectName: event.projectName,
    });
  }

  private async onSessionError(event: SessionErrorEvent): Promise<void> {
    const pending = this.pendingThreadByProject.get(event.projectDir);
    if (pending) {
      pending.sessionId = event.sessionId || "pending";
      this.sessionThreads.set(pending.sessionId, pending);
      this.threadToSession.set(pending.threadId, pending.sessionId);
      this.messageToSession.set(pending.starterMessageId, pending.sessionId);
      this.pendingThreadByProject.delete(event.projectDir);
    }

    const state = pending ?? this.sessionThreads.get(event.sessionId);
    if (state) {
      await this.sendToSession(state.sessionId, `❌ GSD session failed: ${event.error}`);
    }

    this.logger.error("session error surfaced", {
      sessionId: event.sessionId,
      error: event.error,
    });
  }
}
