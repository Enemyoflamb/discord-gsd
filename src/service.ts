import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import {
  AnyThreadChannel,
  AutocompleteInteraction,
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
import {
  FinalOutputStore,
  extractAssistantModelLabel,
  extractShellCommandActivity,
  formatShellCommandMessages,
  splitIntoDiscordChunks,
} from "./output-buffer.js";
import {
  buildGsdCommandInput,
  getGsdArgsAutocompleteChoices,
  getGsdAutocompleteChoices,
} from "./gsd-command-catalog.js";
import {
  createProject,
  findProject,
  formatProjectList,
  listProjects,
  markProjectUsed,
  removeProject,
  renameProject,
  type ProjectRecord,
} from "./project-registry.js";
import { normalizeRelayInput } from "./relay-input.js";
import { buildThreadName, resolveRelayTarget } from "./routing.js";
import { SessionController } from "./session-controller.js";

const DG_COMMAND = new SlashCommandBuilder()
  .setName("dg")
  .setDescription("Create, select, and list Discord-managed GSD projects")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("create")
      .setDescription("Create and register a new project directory")
      .addStringOption((option) =>
        option
          .setName("project")
          .setDescription("Project name to create")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("project")
      .setDescription("Open or continue work on a registered project")
      .addStringOption((option) =>
        option
          .setName("project")
          .setDescription("Registered project id")
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("prompt")
          .setDescription("Optional prompt to send after opening the project")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("rename")
      .setDescription("Rename a registered project without moving its directory")
      .addStringOption((option) =>
        option
          .setName("project")
          .setDescription("Registered project id")
          .setAutocomplete(true)
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("New display name for the project")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a project from projectlist.json without deleting its directory")
      .addStringOption((option) =>
        option
          .setName("project")
          .setDescription("Registered project id")
          .setAutocomplete(true)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("context")
      .setDescription("Show available session/context details for a project")
      .addStringOption((option) =>
        option
          .setName("project")
          .setDescription("Registered project id; defaults to the current thread project")
          .setAutocomplete(true)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("new-context")
      .setDescription("Start a fresh in-memory session for a project thread")
      .addStringOption((option) =>
        option
          .setName("project")
          .setDescription("Registered project id; defaults to the current thread project")
          .setAutocomplete(true)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("end")
      .setDescription("Stop an active in-memory GSD session for a project")
      .addStringOption((option) =>
        option
          .setName("project")
          .setDescription("Registered project id; defaults to the current thread project")
          .setAutocomplete(true)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("List registered projects"),
  )
  .toJSON();

const GSD_COMMAND = new SlashCommandBuilder()
  .setName("gsd")
  .setDescription("Run a GSD slash command inside the configured GSD session")
  .addStringOption((option) =>
    option
      .setName("command")
      .setDescription("Top-level GSD command, like help, auto, or status")
      .setAutocomplete(true)
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("args")
      .setDescription("Optional raw arguments appended after the command")
      .setRequired(false),
  )
  .toJSON();

const DG_REATTACH_COMMAND = new SlashCommandBuilder()
  .setName("dg-reattach")
  .setDescription("Reattach an active in-memory GSD session to this thread or a new thread")
  .addStringOption((option) =>
    option
      .setName("project")
      .setDescription("Registered project id to reattach when multiple sessions are active")
      .setAutocomplete(true)
      .setRequired(false),
  )
  .toJSON();

const THINKING_REACTION_FRAMES = ["➡️", "↘️", "⬇️", "↙️", "⬅️", "↖️", "⬆️", "↗️"] as const;
const THINKING_STATUS_REACTION = "💭";
const THINKING_REACTION_INTERVAL_MS = 2000;
const RELAY_COMPLETE_REACTION = "📨";
const RELAY_ERROR_REACTION = "❌";

interface ThinkingTranscriptState {
  fullText: string;
  sentChars: number;
  part: number;
  modelLabel?: string;
}

interface MessageReactionIndicatorState {
  message: Message;
  frameIndex: number;
  currentEmoji?: string;
  statusEmoji?: string;
  timer: ReturnType<typeof setInterval>;
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

/** Discord error code 10062 = interaction token expired or already consumed. */
function isExpiredInteraction(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === 10062 || code === "10062";
}

export class DiscordGsdService {
  private readonly client: Client;
  private readonly outputStore = new FinalOutputStore();
  private readonly sessionThreads = new Map<string, SessionThreadState>();
  private readonly threadToSession = new Map<string, string>();
  private readonly messageToSession = new Map<string, string>();
  private readonly pendingThreadByProject = new Map<string, SessionThreadState>();
  private readonly thinkingStreams = new Map<string, ThinkingTranscriptState>();
  private readonly streamedShellCommands = new Map<string, Set<string>>();
  private readonly reactionIndicators = new Map<string, MessageReactionIndicatorState>();
  private readonly lastOutboundText = new Map<string, string>();

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
      await this.stopReactionIndicator(sessionId);
      await this.flushRemainingThinking(sessionId);
      this.streamedShellCommands.delete(sessionId);
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
      { body: [DG_COMMAND, GSD_COMMAND, DG_REATTACH_COMMAND] },
    );
    this.logger.info("discord slash commands registered", {
      guildId: this.config.discordGuildId,
      commandCount: 3,
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
    if (interaction.isAutocomplete()) {
      await this.handleAutocomplete(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!this.isAuthorized(interaction.user.id)) {
      await interaction.reply({ content: "You are not allowed to use this bot.", flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    try {
      if (interaction.commandName === "dg") {
        await this.handleDgCommand(interaction);
        return;
      }

      if (interaction.commandName === "gsd") {
        await this.handleGsdCommand(interaction);
        return;
      }

      if (interaction.commandName === "dg-reattach") {
        await this.handleReattachCommand(interaction);
      }
    } catch (error) {
      // Discord returns 10062 (Unknown interaction) when the 3-second or
      // 15-minute interaction token expires. This is not actionable — log
      // and move on instead of crashing the process.
      if (isExpiredInteraction(error)) {
        this.logger.warn("interaction expired before response", {
          command: interaction.commandName,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      throw error;
    }
  }

  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    if (!this.isAuthorized(interaction.user.id)) {
      await interaction.respond([]).catch(() => {});
      return;
    }

    const focused = interaction.options.getFocused(true);
    const value = typeof focused.value === "string" ? focused.value : String(focused.value ?? "");

    if (interaction.commandName === "dg") {
      const subcommand = interaction.options.getSubcommand(false);
      if (subcommand && ["project", "rename", "remove", "end", "context", "new-context"].includes(subcommand) && focused.name === "project") {
        const normalized = value.trim().toLowerCase();
        const choices = listProjects(this.config.gsdProjectDir)
          .filter((project) => !normalized || project.id.startsWith(normalized) || project.name.toLowerCase().startsWith(normalized))
          .slice(0, 25)
          .map((project) => ({
            name: `${project.id} — ${project.name}`.slice(0, 100),
            value: project.id,
          }));
        await interaction.respond(choices).catch(() => {});
        return;
      }

      await interaction.respond([]).catch(() => {});
      return;
    }

    if (interaction.commandName === "dg-reattach") {
      if (focused.name === "project") {
        const normalized = value.trim().toLowerCase();
        const choices = listProjects(this.config.gsdProjectDir)
          .filter((project) => !normalized || project.id.startsWith(normalized) || project.name.toLowerCase().startsWith(normalized))
          .slice(0, 25)
          .map((project) => ({
            name: `${project.id} — ${project.name}`.slice(0, 100),
            value: project.id,
          }));
        await interaction.respond(choices).catch(() => {});
        return;
      }

      await interaction.respond([]).catch(() => {});
      return;
    }

    if (interaction.commandName !== "gsd") {
      await interaction.respond([]).catch(() => {});
      return;
    }

    if (focused.name === "command") {
      await interaction.respond(getGsdAutocompleteChoices(value)).catch(() => {});
      return;
    }

    if (focused.name === "args") {
      const command = interaction.options.getString("command");
      const autocompleteContext = {
        projectDir: this.getActiveProjectDirForChannel(interaction.channelId) ?? this.config.gsdProjectDir,
        ...(this.config.gsdHome ? { gsdHome: this.config.gsdHome } : {}),
      };
      await interaction.respond(getGsdArgsAutocompleteChoices(command, value, autocompleteContext)).catch(() => {});
      return;
    }

    await interaction.respond([]).catch(() => {});
  }

  private async handleDgCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);

    if (subcommand === "list") {
      await this.handleProjectListCommand(interaction);
      return;
    }

    if (subcommand === "create") {
      await this.handleProjectCreateCommand(interaction);
      return;
    }

    if (subcommand === "project") {
      await this.handleProjectOpenCommand(interaction);
      return;
    }

    if (subcommand === "rename") {
      await this.handleProjectRenameCommand(interaction);
      return;
    }

    if (subcommand === "remove") {
      await this.handleProjectRemoveCommand(interaction);
      return;
    }

    if (subcommand === "end") {
      await this.handleProjectEndCommand(interaction);
      return;
    }

    if (subcommand === "context") {
      await this.handleProjectContextCommand(interaction);
      return;
    }

    if (subcommand === "new-context") {
      await this.handleProjectNewContextCommand(interaction);
      return;
    }
  }

  private async handleProjectListCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const projects = listProjects(this.config.gsdProjectDir);
    await interaction.reply({
      content: formatProjectList(projects),
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  private async handleProjectCreateCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const requestedName = interaction.options.getString("project", true);

    try {
      const project = createProject(this.config.gsdProjectDir, requestedName);
      await interaction.reply({
        content: [
          `Created project \`${project.id}\` (${project.name}).`,
          `Path: \`${project.path}\``,
          `Run \`/dg project project:${project.id}\` to start working on it.`,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await interaction.reply({
        content: `Failed to create project: ${message}`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }

  private async handleProjectOpenCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const requestedProject = interaction.options.getString("project", true);
    const project = findProject(this.config.gsdProjectDir, requestedProject);
    if (!project) {
      await interaction.reply({
        content: `Unknown project: ${requestedProject}. Use \`/dg list\` to see registered projects.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const prompt = interaction.options.getString("prompt")?.trim() || this.defaultProjectPrompt(project);
    await this.handleRelayCommand(interaction, project, prompt, {
      startedSessionMessage: "Started session for",
      successReply: `Working on \`${project.id}\` in this thread.`,
    });
  }

  private async handleProjectRenameCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const requestedProject = interaction.options.getString("project", true);
    const nextName = interaction.options.getString("name", true);

    try {
      const renamed = renameProject(this.config.gsdProjectDir, requestedProject, nextName);

      for (const state of this.sessionThreads.values()) {
        if (state.projectDir === renamed.path) {
          state.projectName = renamed.name;
        }
      }
      for (const state of this.pendingThreadByProject.values()) {
        if (state.projectDir === renamed.path) {
          state.projectName = renamed.name;
        }
      }

      await interaction.reply({
        content: [
          `Renamed project \`${renamed.id}\` to ${renamed.name}.`,
          `Directory remains \`${renamed.path}\`.`,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await interaction.reply({
        content: `Failed to rename project: ${message}`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }

  private async handleProjectRemoveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const requestedProject = interaction.options.getString("project", true);
    const project = findProject(this.config.gsdProjectDir, requestedProject);
    if (!project) {
      await interaction.reply({
        content: `Unknown project: ${requestedProject}. Use \`/dg list\` to see registered projects.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const activeSession = this.controller.getProjectSession(project.path);
    if (activeSession) {
      await interaction.reply({
        content: `Cannot remove \`${project.id}\` while it still has an active in-memory session.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    if (this.pendingThreadByProject.has(project.path)) {
      await interaction.reply({
        content: `Cannot remove \`${project.id}\` while its Discord thread is still being attached.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    try {
      const removed = removeProject(this.config.gsdProjectDir, requestedProject);
      await interaction.reply({
        content: [
          `Removed project \`${removed.id}\` from projectlist.json.`,
          `Directory left in place at \`${removed.path}\`.`,
        ].join("\n"),
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await interaction.reply({
        content: `Failed to remove project: ${message}`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }

  private async handleProjectEndCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const requestedProject = interaction.options.getString("project")?.trim();
    const project = this.resolveProjectForSessionCommand(interaction);
    if (!project) {
      await interaction.reply({
        content: requestedProject
          ? `Unknown project: ${requestedProject}. Use \`/dg list\` to see registered projects.`
          : "No project is bound to this channel, and there is no single active session to end.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const session = this.controller.getProjectSession(project.path);
    if (!session) {
      await interaction.reply({
        content: `No active in-memory GSD session is running for \`${project.id}\`.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const hadThreadBinding = this.sessionThreads.has(session.sessionId);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (hadThreadBinding) {
        await this.sendToSession(session.sessionId, "🛑 Ended this GSD session.");
      }

      const ended = await this.controller.endProjectSession(project.path);
      if (!ended) {
        await interaction.editReply({ content: `No active in-memory GSD session is running for \`${project.id}\`.` });
        return;
      }

      await this.cleanupEndedSession(ended.sessionId, ended.projectDir);
      await interaction.editReply({ content: `Ended the GSD session for \`${project.id}\`.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("project end failed", { projectDir: project.path, error: message });
      await interaction.editReply({ content: `Failed to end the GSD session: ${message}` });
    }
  }

  private async handleProjectContextCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const requestedProject = interaction.options.getString("project")?.trim();
    const project = this.resolveProjectForSessionCommand(interaction);
    if (!project) {
      await interaction.reply({
        content: requestedProject
          ? `Unknown project: ${requestedProject}. Use \`/dg list\` to see registered projects.`
          : "No project is bound to this channel, and there is no single active session to inspect.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const details = await this.controller.inspectProjectSession(project.path);
    if (!details) {
      await interaction.reply({
        content: `No active in-memory GSD session is running for \`${project.id}\`.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const modelLabel = details.state.model
      ? `${details.state.model.provider}/${details.state.model.id}`
      : "unknown";
    const contextWindow = details.state.model?.contextWindow;
    const contextWindowText = typeof contextWindow === "number" && contextWindow > 0
      ? contextWindow.toLocaleString()
      : "unknown";

    await interaction.reply({
      content: [
        `Context — \`${project.id}\``,
        "",
        `Model: ${modelLabel}`,
        `Context window: ${contextWindowText}`,
        "Current context usage: not exposed by the current GSD RPC interface.",
        `Cumulative session tokens: ${details.stats.tokens.total.toLocaleString()}`,
        `Pending queued messages: ${details.state.pendingMessageCount}`,
        `Streaming now: ${details.state.isStreaming ? "yes" : "no"}`,
      ].join("\n"),
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  private async handleProjectNewContextCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const requestedProject = interaction.options.getString("project")?.trim();
    const project = this.resolveProjectForSessionCommand(interaction);
    if (!project) {
      await interaction.reply({
        content: requestedProject
          ? `Unknown project: ${requestedProject}. Use \`/dg list\` to see registered projects.`
          : "No project is bound to this channel, and there is no single active session to reset.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    const existing = this.controller.getProjectSession(project.path);
    if (!existing) {
      await interaction.reply({
        content: `No active in-memory GSD session is running for \`${project.id}\`. Use \`/dg project project:${project.id}\` first.`,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await this.controller.startNewContext(project.path);
      if (!result) {
        await interaction.editReply({ content: `No active in-memory GSD session is running for \`${project.id}\`.` });
        return;
      }
      if (result.cancelled) {
        await interaction.editReply({ content: `Starting a new context for \`${project.id}\` was cancelled.` });
        return;
      }

      await this.rebindSessionContext(result.previousSessionId, result.session);
      markProjectUsed(this.config.gsdProjectDir, result.session.projectDir);
      await this.sendToSession(result.session.sessionId, "🪟 Started a fresh GSD context window for this project.");
      await interaction.editReply({ content: `Started a fresh context window for \`${project.id}\`.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("project new-context failed", { projectDir: project.path, error: message });
      await interaction.editReply({ content: `Failed to start a new context window: ${message}` });
    }
  }

  private async handleGsdCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const project = this.resolveProjectForInteraction(interaction);
    if (!project) {
      await interaction.reply({
        content: "No project is bound to this channel. Use `/dg project` first, then run `/gsd` inside that project thread.",
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
      return;
    }

    let input: string;
    try {
      input = buildGsdCommandInput(
        interaction.options.getString("command"),
        interaction.options.getString("args"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      return;
    }

    await this.handleRelayCommand(interaction, project, input, {
      startedSessionMessage: "Started GSD session for",
      successReply: "Ran GSD command in this thread.",
    });
  }

  private async handleRelayCommand(
    interaction: ChatInputCommandInteraction,
    project: ProjectRecord,
    input: string,
    messages: { startedSessionMessage: string; successReply: string },
  ): Promise<void> {
    // Defer immediately — Discord requires a response within 3 seconds.
    // Everything else (thread creation, session dispatch) happens after.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const activeChannelId = interaction.channelId;
    const activeThreadState = this.getThreadStateForChannel(activeChannelId);

    try {
      const threadState = activeThreadState?.projectDir === project.path
        ? activeThreadState
        : await this.getOrCreatePendingThread(project.path, project.name, input);

      const dispatch = await this.controller.dispatch(project.path, input);
      markProjectUsed(this.config.gsdProjectDir, dispatch.session.projectDir);
      const mapped = await this.ensureSessionThreadState(
        dispatch.session.sessionId,
        dispatch.session.projectDir,
        dispatch.session.projectName,
        input,
      );

      if (dispatch.startedFresh) {
        await this.sendToSession(mapped.sessionId, `${messages.startedSessionMessage} \`${dispatch.session.projectName}\`. Reply here or use \`/dg\` or \`/gsd\` again.`);
      }

      await interaction.editReply({
        content: mapped.threadId === activeChannelId
          ? messages.successReply
          : `Relayed to <#${mapped.threadId}>.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("slash command relay failed", { error: message, input, projectDir: project.path });
      await interaction.editReply({ content: `Failed to relay message: ${message}` });
    }
  }

  private defaultProjectPrompt(project: ProjectRecord): string {
    return existsSync(join(project.path, ".gsd"))
      ? "continue with the current milestone"
      : "/gsd init";
  }

  private getThreadStateForChannel(channelId: string): SessionThreadState | null {
    const sessionId = this.threadToSession.get(channelId);
    return sessionId ? this.sessionThreads.get(sessionId) ?? null : null;
  }

  private getActiveProjectDirForChannel(channelId: string): string | null {
    return this.getThreadStateForChannel(channelId)?.projectDir ?? null;
  }

  private resolveProjectForInteraction(interaction: ChatInputCommandInteraction): ProjectRecord | null {
    const state = this.getThreadStateForChannel(interaction.channelId);
    if (!state) {
      return null;
    }

    return {
      id: basename(state.projectDir),
      name: state.projectName,
      directory: basename(state.projectDir),
      path: state.projectDir,
      createdAt: "",
    };
  }

  private resolveProjectForSessionCommand(interaction: ChatInputCommandInteraction): ProjectRecord | null {
    const requestedProject = interaction.options.getString("project")?.trim();
    if (requestedProject) {
      return findProject(this.config.gsdProjectDir, requestedProject);
    }

    const threadProject = this.resolveProjectForInteraction(interaction);
    if (threadProject) {
      return threadProject;
    }

    const currentSession = this.controller.getCurrentProjectSession();
    if (!currentSession) {
      return null;
    }

    return {
      id: basename(currentSession.projectDir),
      name: currentSession.projectName,
      directory: basename(currentSession.projectDir),
      path: currentSession.projectDir,
      createdAt: "",
    };
  }

  private async cleanupEndedSession(sessionId: string, projectDir: string): Promise<void> {
    await this.stopReactionIndicator(sessionId);
    this.outputStore.clear(sessionId);
    this.streamedShellCommands.delete(sessionId);
    this.thinkingStreams.delete(sessionId);
    this.lastOutboundText.delete(sessionId);
    this.unbindSession(sessionId);
    this.sessionThreads.delete(sessionId);
    this.pendingThreadByProject.delete(projectDir);
  }

  private async rebindSessionContext(previousSessionId: string, session: { sessionId: string; projectDir: string; projectName: string }): Promise<void> {
    await this.stopReactionIndicator(previousSessionId);
    this.outputStore.clear(previousSessionId);
    this.streamedShellCommands.delete(previousSessionId);
    this.thinkingStreams.delete(previousSessionId);
    this.lastOutboundText.delete(previousSessionId);

    const existing = this.sessionThreads.get(previousSessionId);
    if (!existing) {
      return;
    }

    this.unbindSession(previousSessionId);
    this.sessionThreads.delete(previousSessionId);
    existing.sessionId = session.sessionId;
    existing.projectDir = session.projectDir;
    existing.projectName = session.projectName;
    this.bindSessionState(session.sessionId, existing);
  }

  private async handleReattachCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const requestedProject = interaction.options.getString("project")?.trim();
    const project = requestedProject
      ? findProject(this.config.gsdProjectDir, requestedProject)
      : null;

    if (requestedProject && !project) {
      await interaction.editReply({
        content: `Unknown project: ${requestedProject}. Use \`/dg list\` to see registered projects.`,
      });
      return;
    }

    const session = project
      ? this.controller.getProjectSession(project.path)
      : this.controller.getCurrentProjectSession();

    if (!session) {
      await interaction.editReply({
        content: project
          ? `No active in-memory GSD session is available for \`${project.id}\`.`
          : "No single active in-memory GSD session is available to reattach. Pass a project id when multiple sessions are active.",
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
        projectDir: session.projectDir,
        projectName: session.projectName,
        threadId: currentChannel.id,
        starterMessageId: marker.id,
        lastBotMessageIds: new Set([marker.id]),
      };
      this.unbindSession(session.sessionId);
      this.bindSessionState(session.sessionId, state);
      await interaction.editReply({ content: "Reattached the selected session to this thread." });
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
      projectDir: session.projectDir,
      projectName: session.projectName,
      threadId: thread.id,
      starterMessageId: starter.id,
      lastBotMessageIds: new Set([starter.id]),
    };
    this.unbindSession(session.sessionId);
    this.bindSessionState(session.sessionId, state);
    await interaction.editReply({ content: `Reattached the selected session to <#${thread.id}>.` });
  }

  private async getOrCreatePendingThread(
    projectDir: string,
    projectName: string,
    input: string,
  ): Promise<SessionThreadState> {
    const currentSession = this.controller.getProjectSession(projectDir);
    if (currentSession) {
      const existing = this.sessionThreads.get(currentSession.sessionId);
      if (existing) {
        return existing;
      }
    }

    const pending = this.pendingThreadByProject.get(projectDir);
    if (pending) {
      return pending;
    }

    const parent = await this.getParentChannel();
    const starter = await parent.send({
      content: `🧵 Starting GSD session for \`${projectName}\`...`,
      allowedMentions: { parse: [] },
    });

    const thread = await starter.startThread({
      name: buildThreadName(`${projectName} ${input}`),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: `discord-gsd session for ${projectName}`,
    });

    const state: SessionThreadState = {
      sessionId: "pending",
      projectDir,
      projectName,
      threadId: thread.id,
      starterMessageId: starter.id,
      lastBotMessageIds: new Set([starter.id]),
    };

    this.pendingThreadByProject.set(projectDir, state);
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

    const fallback = await this.getOrCreatePendingThread(projectDir, projectName, input ?? projectName);
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

  private async sendToSession(
    sessionId: string,
    content: string,
    options?: { trackAsReplyContext?: boolean },
  ): Promise<void> {
    const state = this.sessionThreads.get(sessionId);
    if (!state) {
      this.logger.warn("dropping outbound Discord message for unknown session", { sessionId });
      return;
    }

    const thread = await this.fetchThread(state.threadId);
    const message = await thread.send({ content, allowedMentions: { parse: [] } });
    if (options?.trackAsReplyContext !== false) {
      this.lastOutboundText.set(sessionId, content);
    }
    this.rememberBotMessage(sessionId, message.id);
  }

  private async removeOwnReaction(message: Message, emoji: string): Promise<void> {
    const botUserId = this.client.user?.id;
    if (!botUserId) {
      return;
    }

    try {
      const reaction = message.reactions.resolve(emoji);
      if (!reaction) {
        return;
      }
      await reaction.users.remove(botUserId).catch(() => {});
    } catch {
      // ignored
    }
  }

  private async tickReactionIndicator(sessionId: string): Promise<void> {
    const indicator = this.reactionIndicators.get(sessionId);
    if (!indicator) {
      return;
    }

    const nextEmoji = THINKING_REACTION_FRAMES[indicator.frameIndex % THINKING_REACTION_FRAMES.length] ?? THINKING_REACTION_FRAMES[0];
    indicator.frameIndex += 1;

    if (!nextEmoji) {
      return;
    }

    try {
      if (indicator.currentEmoji && indicator.currentEmoji !== nextEmoji) {
        await this.removeOwnReaction(indicator.message, indicator.currentEmoji);
      }
      await indicator.message.react(nextEmoji).catch(() => {});
      indicator.currentEmoji = nextEmoji;
    } catch {
      // ignored
    }
  }

  private async stopReactionIndicator(sessionId: string, finalEmoji?: string): Promise<void> {
    const indicator = this.reactionIndicators.get(sessionId);
    if (!indicator) {
      return;
    }

    this.reactionIndicators.delete(sessionId);
    clearInterval(indicator.timer);

    if (indicator.currentEmoji) {
      await this.removeOwnReaction(indicator.message, indicator.currentEmoji);
    }
    if (indicator.statusEmoji) {
      await this.removeOwnReaction(indicator.message, indicator.statusEmoji);
    }

    if (finalEmoji) {
      await indicator.message.react(finalEmoji).catch(() => {});
    }
  }

  private async startReactionIndicator(sessionId: string, message: Message): Promise<void> {
    await this.stopReactionIndicator(sessionId);

    const timer = setInterval(() => {
      void this.tickReactionIndicator(sessionId);
    }, THINKING_REACTION_INTERVAL_MS);
    const indicator: MessageReactionIndicatorState = {
      message,
      frameIndex: 0,
      statusEmoji: THINKING_STATUS_REACTION,
      timer,
    };
    this.reactionIndicators.set(sessionId, indicator);
    await message.react(THINKING_STATUS_REACTION).catch(() => {});
    await this.tickReactionIndicator(sessionId);
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
      const session = this.controller.getSession(relayTarget.sessionId);
      const normalization = session?.pendingBlocker
        ? { text: message.content, kind: null }
        : normalizeRelayInput(message.content, this.lastOutboundText.get(relayTarget.sessionId));

      if (normalization.kind) {
        this.logger.info("normalized relay input", {
          sessionId: relayTarget.sessionId,
          normalizationKind: normalization.kind,
        });
      }

      const updatedSession = await this.controller.relayToSession(relayTarget.sessionId, normalization.text);
      if (session) {
        markProjectUsed(this.config.gsdProjectDir, session.projectDir);
      }
      if (updatedSession.isStreaming) {
        await this.startReactionIndicator(updatedSession.sessionId, message);
      } else {
        await this.stopReactionIndicator(updatedSession.sessionId);
        await message.react(RELAY_COMPLETE_REACTION).catch(() => {});
      }
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
    await this.maybeForwardNotify(payload.sessionId, payload.event);
    await this.maybeStreamShellCommand(payload.sessionId, payload.event);
    await this.maybeStreamThinking(payload.sessionId, payload.event);

    const eventType = (payload.event as Record<string, unknown>).type;
    if (eventType === "execution_complete") {
      await this.flushRemainingThinking(payload.sessionId);
      await this.flushFinalOutput(payload.sessionId, payload.event);
      this.streamedShellCommands.delete(payload.sessionId);
    }
  }

  private async flushFinalOutput(sessionId: string, event: SdkAgentEvent): Promise<void> {
    await this.stopReactionIndicator(sessionId, RELAY_COMPLETE_REACTION);
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
    await this.stopReactionIndicator(event.sessionId, RELAY_COMPLETE_REACTION);
    await this.flushRemainingThinking(event.sessionId);
    this.streamedShellCommands.delete(event.sessionId);
    await this.ensureSessionThreadState(event.sessionId, event.projectDir, event.projectName);
    await this.sendToSession(event.sessionId, formatBlockerMessage(event.blocker));
    this.outputStore.clear(event.sessionId);
    this.logger.warn("session blocked", {
      sessionId: event.sessionId,
      method: event.blocker.method,
    });
  }

  private async onSessionCompleted(event: SessionCompletedEvent): Promise<void> {
    await this.stopReactionIndicator(event.sessionId, RELAY_COMPLETE_REACTION);
    await this.flushRemainingThinking(event.sessionId);
    this.streamedShellCommands.delete(event.sessionId);
    await this.ensureSessionThreadState(event.sessionId, event.projectDir, event.projectName);
    this.logger.info("session completed", {
      sessionId: event.sessionId,
      projectName: event.projectName,
    });
  }

  private async onSessionError(event: SessionErrorEvent): Promise<void> {
    await this.stopReactionIndicator(event.sessionId, RELAY_ERROR_REACTION);
    await this.flushRemainingThinking(event.sessionId);
    this.streamedShellCommands.delete(event.sessionId);

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

  private async maybeForwardNotify(sessionId: string, event: SdkAgentEvent): Promise<void> {
    const record = event as Record<string, unknown>;
    if (record.type !== "extension_ui_request" || record.method !== "notify") {
      return;
    }

    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (!message) {
      return;
    }

    if (message.toLowerCase().includes("blocked:")) {
      return;
    }

    const notifyType = typeof record.notifyType === "string" ? record.notifyType : "info";
    const prefix = notifyType === "error"
      ? "❌ "
      : notifyType === "warning"
        ? "⚠️ "
        : "";

    const chunks = splitIntoDiscordChunks(message, Math.max(1, this.config.discordMessageChunkSize - prefix.length));
    for (const chunk of chunks) {
      await this.sendToSession(sessionId, `${prefix}${chunk}`);
    }
  }

  private async maybeStreamShellCommand(sessionId: string, event: SdkAgentEvent): Promise<void> {
    const activity = extractShellCommandActivity(event);
    if (!activity) {
      return;
    }

    const seenToolCalls = this.streamedShellCommands.get(sessionId) ?? new Set<string>();
    if (seenToolCalls.has(activity.toolCallId)) {
      return;
    }

    const messages = formatShellCommandMessages(activity, this.config.discordMessageChunkSize);
    for (const message of messages) {
      await this.sendToSession(sessionId, message, { trackAsReplyContext: false });
    }

    seenToolCalls.add(activity.toolCallId);
    this.streamedShellCommands.set(sessionId, seenToolCalls);
    this.logger.info("shell command forwarded", {
      sessionId,
      toolName: activity.toolName,
      label: activity.label,
    });
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
      await this.sendToSession(sessionId, `${header}\n${chunk}`, { trackAsReplyContext: false });
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
    await this.sendToSession(sessionId, `${header}\n${remaining}`, { trackAsReplyContext: false });
  }
}
