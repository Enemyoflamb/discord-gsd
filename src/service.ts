import { basename } from "node:path";

import {
  AnyThreadChannel,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Interaction,
  Message,
  MessageFlags,
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
import { FinalOutputStore, extractAssistantModelLabel, splitIntoDiscordChunks } from "./output-buffer.js";
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

const DG_REATTACH_COMMAND = new SlashCommandBuilder()
  .setName("dg-reattach")
  .setDescription("Reattach the current in-memory GSD session to this thread or a new thread")
  .toJSON();

const THINKING_FRAMES = [
  "↻ GSD is thinking…",
  "↺ GSD is thinking…",
  "⟳ GSD is thinking…",
  "⟲ GSD is thinking…",
] as const;

interface LoadingIndicatorState {
  activationTimer?: ReturnType<typeof setTimeout>;
  tickTimer?: ReturnType<typeof setInterval>;
  messageId?: string;
  frameIndex: number;
}

interface ThinkingTranscriptState {
  fullText: string;
  sentChars: number;
  part: number;
  modelLabel?: string;
}

function thinkingFrame(index: number): string {
  return THINKING_FRAMES[index % THINKING_FRAMES.length] ?? THINKING_FRAMES[0];
}

function extractThinkingText(source: unknown): string {
  if (!source || typeof source !== "object") {
    return "";
  }

  const record = source as Record<string, unknown>;
  if (!Array.isArray(record.content)) {
    return "";
  }

  return record.content
    .filter((item): item is { type?: string; thinking?: string; redacted?: boolean } => typeof item === "object" && item !== null)
    .filter((item) => item.type === "thinking" && typeof item.thinking === "string" && item.redacted !== true)
    .map((item) => item.thinking ?? "")
    .join("\n")
    .trim();
}

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
  private readonly loadingIndicators = new Map<string, LoadingIndicatorState>();
  private readonly thinkingStreams = new Map<string, ThinkingTranscriptState>();

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
    const sessionIds = [...this.sessionThreads.keys()];

    for (const sessionId of sessionIds) {
      await this.stopLoadingIndicator(sessionId);
      await this.flushRemainingThinking(sessionId);
    }

    await Promise.allSettled(sessionIds.map((sessionId) =>
      this.sendToSession(
        sessionId,
        "⚠️ discord-gsd is shutting down. This in-memory GSD session will close with the process. After restart, start a new run with `/dg ...`. `/dg-reattach` only works while the same process is still alive.",
      ),
    ));

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
      { body: [DG_COMMAND, DG_REATTACH_COMMAND] },
    );
    this.logger.info("discord slash commands registered", {
      guildId: this.config.discordGuildId,
      commandCount: 2,
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
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!this.isAuthorized(interaction.user.id)) {
      await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "dg") {
      await this.handleDgCommand(interaction);
      return;
    }

    if (interaction.commandName === "dg-reattach") {
      await this.handleReattachCommand(interaction);
    }
  }

  private async handleDgCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const input = interaction.options.getString("input", true).trim();
    if (!input) {
      await interaction.reply({ content: "Input cannot be empty.", flags: MessageFlags.Ephemeral });
      return;
    }

    const activeChannelId = interaction.channelId;
    const activeThreadSession = this.threadToSession.get(activeChannelId);
    const threadState = activeThreadSession
      ? this.sessionThreads.get(activeThreadSession) ?? null
      : await this.getOrCreatePendingThread(input);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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

      void this.startLoadingIndicator(mapped.sessionId);

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

  private async handleReattachCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const session = this.controller.getCurrentProjectSession();
    if (!session) {
      await interaction.editReply({
        content: "No active in-memory GSD session is available to reattach.",
      });
      return;
    }

    const currentChannel = interaction.channel;
    if (currentChannel?.isThread()) {
      const marker = await currentChannel.send({
        content: `🔗 Reattached session \`${session.projectName}\` here.`,
        allowedMentions: { parse: [] },
      });
      const state: SessionThreadState = {
        sessionId: session.sessionId,
        threadId: currentChannel.id,
        starterMessageId: marker.id,
        lastBotMessageIds: new Set([marker.id]),
      };
      this.unbindSession(session.sessionId);
      this.bindSessionState(session.sessionId, state);
      await interaction.editReply({ content: "Reattached the current session to this thread." });
      return;
    }

    const parent = await this.getParentChannel();
    const starter = await parent.send({
      content: `🔗 Reattaching GSD session for \`${session.projectName}\`...`,
      allowedMentions: { parse: [] },
    });
    const thread = await starter.startThread({
      name: buildThreadName(`reattach ${session.projectName}`),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `discord-gsd reattach for ${session.projectName}`,
    });
    const state: SessionThreadState = {
      sessionId: session.sessionId,
      threadId: thread.id,
      starterMessageId: starter.id,
      lastBotMessageIds: new Set([starter.id]),
    };
    this.unbindSession(session.sessionId);
    this.bindSessionState(session.sessionId, state);
    await interaction.editReply({ content: `Reattached the current session to <#${thread.id}>.` });
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
      this.unbindSession(sessionId);
      this.bindSessionState(sessionId, pending);
      return pending;
    }

    const fallback = await this.getOrCreatePendingThread(input ?? projectName);
    fallback.sessionId = sessionId;
    this.pendingThreadByProject.delete(projectDir);
    this.unbindSession(sessionId);
    this.bindSessionState(sessionId, fallback);
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

  private forgetBotMessage(sessionId: string, messageId: string): void {
    this.messageToSession.delete(messageId);
    const state = this.sessionThreads.get(sessionId);
    state?.lastBotMessageIds.delete(messageId);
  }

  private unbindSession(sessionId: string): void {
    const existing = this.sessionThreads.get(sessionId);
    if (!existing) {
      return;
    }

    this.threadToSession.delete(existing.threadId);
    for (const messageId of existing.lastBotMessageIds) {
      this.messageToSession.delete(messageId);
    }
  }

  private bindSessionState(sessionId: string, state: SessionThreadState): void {
    this.sessionThreads.set(sessionId, state);
    this.threadToSession.set(state.threadId, sessionId);
    this.messageToSession.set(state.starterMessageId, sessionId);
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
      void this.startLoadingIndicator(relayTarget.sessionId);
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
    await this.maybeStreamThinking(payload.sessionId, payload.event);

    const eventType = (payload.event as Record<string, unknown>).type;
    if (eventType === "execution_complete") {
      await this.flushRemainingThinking(payload.sessionId);
      await this.flushFinalOutput(payload.sessionId, payload.event);
    }
  }

  private async flushFinalOutput(sessionId: string, event: SdkAgentEvent): Promise<void> {
    await this.stopLoadingIndicator(sessionId);
    const buffered = this.outputStore.consume(sessionId);
    const status = typeof (event as Record<string, unknown>).status === "string"
      ? String((event as Record<string, unknown>).status)
      : "completed";

    if (!buffered) {
      await this.sendToSession(sessionId, status === "completed"
        ? "✅ GSD finished with no assistant text to forward."
        : `⚠️ GSD finished with status: ${status}`);
      return;
    }

    if (status !== "completed") {
      await this.sendToSession(sessionId, `⚠️ GSD finished with status: ${status}`);
    }

    const modelLabel = buffered.modelLabel ?? this.config.gsdModel ?? "GSD runtime default";
    const prefix = `[LLM: ${modelLabel}] `;
    const chunks = splitIntoDiscordChunks(
      buffered.text,
      Math.max(1, this.config.discordMessageChunkSize - prefix.length),
    );

    for (const chunk of chunks) {
      await this.sendToSession(sessionId, `${prefix}${chunk}`);
    }

    this.logger.info("final output flushed", {
      sessionId,
      chunkCount: chunks.length,
      charCount: buffered.text.length,
      modelLabel,
      status,
    });
  }

  private async onSessionBlocked(event: SessionBlockedEvent): Promise<void> {
    await this.stopLoadingIndicator(event.sessionId);
    await this.flushRemainingThinking(event.sessionId);
    await this.ensureSessionThreadState(event.sessionId, event.projectDir, event.projectName);
    await this.sendToSession(event.sessionId, formatBlockerMessage(event.blocker));
    this.outputStore.clear(event.sessionId);
    this.logger.warn("session blocked", {
      sessionId: event.sessionId,
      method: event.blocker.method,
    });
  }

  private async onSessionCompleted(event: SessionCompletedEvent): Promise<void> {
    await this.stopLoadingIndicator(event.sessionId);
    await this.flushRemainingThinking(event.sessionId);
    await this.ensureSessionThreadState(event.sessionId, event.projectDir, event.projectName);
    this.logger.info("session completed", {
      sessionId: event.sessionId,
      projectName: event.projectName,
    });
  }

  private async onSessionError(event: SessionErrorEvent): Promise<void> {
    await this.stopLoadingIndicator(event.sessionId);
    await this.flushRemainingThinking(event.sessionId);

    const pending = this.pendingThreadByProject.get(event.projectDir);
    if (pending) {
      pending.sessionId = event.sessionId || "pending";
      this.bindSessionState(pending.sessionId, pending);
      this.pendingThreadByProject.delete(event.projectDir);
    }

    const state = pending ?? this.sessionThreads.get(event.sessionId);
    if (state) {
      await this.sendToSession(state.sessionId, `❌ GSD session failed and closed: ${event.error}`);
    }

    this.logger.error("session error surfaced", {
      sessionId: event.sessionId,
      error: event.error,
    });
  }

  private async startLoadingIndicator(sessionId: string): Promise<void> {
    if (this.loadingIndicators.has(sessionId)) {
      return;
    }

    const indicator: LoadingIndicatorState = { frameIndex: 0 };
    this.loadingIndicators.set(sessionId, indicator);

    indicator.activationTimer = setTimeout(() => {
      void this.activateLoadingIndicator(sessionId);
    }, 2000);
  }

  private async maybeStreamThinking(sessionId: string, event: SdkAgentEvent): Promise<void> {
    const record = event as Record<string, unknown>;
    const eventType = typeof record.type === "string" ? record.type : "";
    if (!["message_update", "message_end"].includes(eventType)) {
      return;
    }

    const message = record.message && typeof record.message === "object"
      ? record.message
      : record;
    const thinkingText = extractThinkingText(message);
    if (!thinkingText) {
      return;
    }

    const state = this.thinkingStreams.get(sessionId) ?? { fullText: "", sentChars: 0, part: 0 };
    state.fullText = thinkingText;
    state.sentChars = Math.min(state.sentChars, state.fullText.length);

    const modelLabel = extractAssistantModelLabel(event);
    if (modelLabel) {
      state.modelLabel = modelLabel;
    }

    await this.flushThinkingChunks(sessionId, state, 500);
    this.thinkingStreams.set(sessionId, state);
  }

  private async flushThinkingChunks(
    sessionId: string,
    state: ThinkingTranscriptState,
    threshold: number,
  ): Promise<void> {
    while (state.fullText.length - state.sentChars >= threshold) {
      const rawChunk = state.fullText.slice(state.sentChars, state.sentChars + threshold);
      state.sentChars += rawChunk.length;
      const chunk = rawChunk.trim();
      if (!chunk) {
        continue;
      }

      state.part += 1;
      const header = state.modelLabel
        ? `[Thinking ${state.part} · ${state.modelLabel}]`
        : `[Thinking ${state.part}]`;
      await this.sendToSession(sessionId, `${header}\n${chunk}`);
    }
  }

  private async flushRemainingThinking(sessionId: string): Promise<void> {
    const state = this.thinkingStreams.get(sessionId);
    if (!state) {
      return;
    }

    this.thinkingStreams.delete(sessionId);
    const remaining = state.fullText.slice(state.sentChars).trim();
    if (!remaining) {
      return;
    }

    state.part += 1;
    const header = state.modelLabel
      ? `[Thinking ${state.part} · ${state.modelLabel}]`
      : `[Thinking ${state.part}]`;
    await this.sendToSession(sessionId, `${header}\n${remaining}`);
  }

  private async activateLoadingIndicator(sessionId: string): Promise<void> {
    const indicator = this.loadingIndicators.get(sessionId);
    const state = this.sessionThreads.get(sessionId);
    if (!indicator || !state) {
      return;
    }

    try {
      const thread = await this.fetchThread(state.threadId);
      const message = await thread.send({
        content: thinkingFrame(indicator.frameIndex),
        allowedMentions: { parse: [] },
      });
      indicator.messageId = message.id;
      this.rememberBotMessage(sessionId, message.id);
      indicator.tickTimer = setInterval(() => {
        void this.tickLoadingIndicator(sessionId);
      }, 5000);
    } catch (error) {
      this.logger.warn("loading indicator activation failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      this.loadingIndicators.delete(sessionId);
    }
  }

  private async tickLoadingIndicator(sessionId: string): Promise<void> {
    const indicator = this.loadingIndicators.get(sessionId);
    const state = this.sessionThreads.get(sessionId);
    if (!indicator || !indicator.messageId || !state) {
      return;
    }

    try {
      const thread = await this.fetchThread(state.threadId);
      indicator.frameIndex = (indicator.frameIndex + 1) % THINKING_FRAMES.length;
      const message = await thread.messages.fetch(indicator.messageId);
      await message.edit({ content: thinkingFrame(indicator.frameIndex) });
    } catch (error) {
      this.logger.warn("loading indicator tick failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopLoadingIndicator(sessionId: string): Promise<void> {
    const indicator = this.loadingIndicators.get(sessionId);
    if (!indicator) {
      return;
    }

    this.loadingIndicators.delete(sessionId);
    if (indicator.activationTimer) {
      clearTimeout(indicator.activationTimer);
    }
    if (indicator.tickTimer) {
      clearInterval(indicator.tickTimer);
    }

    if (!indicator.messageId) {
      return;
    }

    const state = this.sessionThreads.get(sessionId);
    if (!state) {
      return;
    }

    try {
      const thread = await this.fetchThread(state.threadId);
      const message = await thread.messages.fetch(indicator.messageId);
      await message.delete().catch(() => {});
    } catch {
      // non-fatal
    } finally {
      this.forgetBotMessage(sessionId, indicator.messageId);
    }
  }
}
