import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  RpcClient,
  type RpcCostUpdateEvent,
  type RpcExtensionUIRequest,
  type RpcInitResult,
  type RpcSessionState,
  type SessionStats,
  type SdkAgentEvent,
} from "@gsd-build/rpc-client";

import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { buildBlockerUiResponse } from "./blockers.js";
import type {
  CostAccumulator,
  DispatchResult,
  ManagedSession,
  PendingBlocker,
  SessionBlockedEvent,
  SessionCompletedEvent,
  SessionErrorEvent,
  SessionEventEnvelope,
  SessionStartedEvent,
} from "./models.js";

const MAX_EVENTS = 100;
const INIT_TIMEOUT_MS = 30_000;

const FIRE_AND_FORGET_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

const TERMINAL_PREFIXES = ["auto-mode stopped", "step-mode stopped"];

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function isTerminalNotification(event: Record<string, unknown>): boolean {
  if (event.type !== "extension_ui_request" || event.method !== "notify") {
    return false;
  }
  const message = String(event.message ?? "").toLowerCase();
  return TERMINAL_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function isBlockedNotification(event: Record<string, unknown>): boolean {
  if (event.type !== "extension_ui_request" || event.method !== "notify") {
    return false;
  }
  const message = String(event.message ?? "").toLowerCase();
  return message.includes("blocked:");
}

function isBlockingUiRequest(event: Record<string, unknown>): boolean {
  if (event.type !== "extension_ui_request") {
    return false;
  }
  const method = String(event.method ?? "");
  return !FIRE_AND_FORGET_METHODS.has(method);
}

function extractBlocker(event: SdkAgentEvent): PendingBlocker {
  const uiEvent = event as unknown as RpcExtensionUIRequest;
  const record = uiEvent as Record<string, unknown>;
  return {
    id: String(uiEvent.id ?? ""),
    method: String(uiEvent.method ?? ""),
    message: String(record.title ?? record.message ?? ""),
    event: uiEvent,
  };
}

function sessionErrorMessage(event: SdkAgentEvent): string {
  const record = event as Record<string, unknown>;
  const candidates = [record.error, record.message, record.reason];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return "Unknown GSD session error.";
}

function resolveExistingPath(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function discoverPathCliCandidates(): string[] {
  const command = process.platform === "win32" ? "where gsd" : "which -a gsd";
  try {
    return execSync(command, { encoding: "utf-8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function discoverGlobalCliPath(): string | null {
  try {
    const globalRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    if (!globalRoot) {
      return null;
    }
    return resolveExistingPath(resolve(globalRoot, "gsd-pi", "dist", "loader.js"));
  } catch {
    return null;
  }
}

function pushUniqueCandidate(target: string[], candidate: string | null): void {
  if (!candidate || target.includes(candidate)) {
    return;
  }
  target.push(candidate);
}

function resolveCliPaths(config: AppConfig): string[] {
  if (config.gsdCliPath) {
    return [resolve(config.gsdCliPath)];
  }

  const localPackageLoader = resolveExistingPath(resolve(process.cwd(), "node_modules", "gsd-pi", "dist", "loader.js"));
  const localBinPath = resolveExistingPath(resolve(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "gsd.cmd" : "gsd",
  ));
  const globalCliPath = discoverGlobalCliPath();

  const candidates: string[] = [];
  pushUniqueCandidate(candidates, globalCliPath);
  for (const detectedPath of discoverPathCliCandidates()) {
    pushUniqueCandidate(candidates, resolveExistingPath(detectedPath));
  }
  pushUniqueCandidate(candidates, localPackageLoader);
  pushUniqueCandidate(candidates, localBinPath);

  candidates.sort((left, right) => {
    const rank = (value: string): number => {
      if (globalCliPath && value === globalCliPath) {
        return 0;
      }
      if (localPackageLoader && value === localPackageLoader) {
        return 20;
      }
      return 10;
    };
    return rank(left) - rank(right);
  });

  if (candidates.length > 0) {
    return candidates;
  }

  throw new Error("Cannot find the gsd CLI. Install globally (npm install -g gsd-pi) or set GSD_CLI_PATH.");
}

function emptyCost(): CostAccumulator {
  return {
    totalCost: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

export class SessionController extends EventEmitter {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly cliPaths: string[];

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    super();
    this.cliPaths = resolveCliPaths(config);
    this.logger.info("resolved gsd cli candidates", {
      cliPaths: this.cliPaths,
      explicitOverride: config.gsdCliPath ?? null,
    });
  }

  private sessionArgs(): string[] {
    const args: string[] = [];
    if (this.config.gsdModel) {
      args.push("--model", this.config.gsdModel);
    }
    if (this.config.gsdBare) {
      args.push("--bare");
    }
    return args;
  }

  private async syncStreamingState(session: ManagedSession, options?: { settleMs?: number }): Promise<void> {
    const settleMs = options?.settleMs ?? 0;
    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }

    let state: RpcSessionState;
    try {
      state = await session.client.getState();
    } catch (error) {
      this.logger.warn("failed to read session state after dispatch", {
        sessionId: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    session.isStreaming = state.isStreaming;
    session.status = state.isStreaming ? "running" : "completed";
  }

  private async dispatchPrompt(session: ManagedSession, input: string): Promise<void> {
    await session.client.prompt(input);
    await this.syncStreamingState(session, { settleMs: input.startsWith("/") ? 75 : 0 });
  }

  private async dispatchSteer(session: ManagedSession, input: string): Promise<void> {
    await session.client.steer(input);
    await this.syncStreamingState(session, { settleMs: 25 });
  }

  private bindSessionEvents(session: ManagedSession): void {
    session.unsubscribe = session.client.onEvent((event: SdkAgentEvent) => {
      this.handleSessionEvent(session, event);
    });
  }

  private handleSessionEvent(session: ManagedSession, event: SdkAgentEvent): void {
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }

    const envelope: SessionEventEnvelope = {
      sessionId: session.sessionId,
      projectDir: session.projectDir,
      event,
    };
    this.emit("session-event", envelope);

    const record = event as Record<string, unknown>;

    if (record.type === "execution_complete") {
      session.isStreaming = false;
    }

    if (record.type === "cost_update") {
      const costEvent = event as unknown as RpcCostUpdateEvent;
      session.cost.totalCost = Math.max(session.cost.totalCost, costEvent.cumulativeCost ?? 0);
      if (costEvent.tokens) {
        session.cost.tokens.input = Math.max(session.cost.tokens.input, costEvent.tokens.input ?? 0);
        session.cost.tokens.output = Math.max(session.cost.tokens.output, costEvent.tokens.output ?? 0);
        session.cost.tokens.cacheRead = Math.max(session.cost.tokens.cacheRead, costEvent.tokens.cacheRead ?? 0);
        session.cost.tokens.cacheWrite = Math.max(session.cost.tokens.cacheWrite, costEvent.tokens.cacheWrite ?? 0);
      }
    }

    if (record.type === "error" || record.type === "session_error") {
      session.isStreaming = false;
      session.status = "error";
      session.error = sessionErrorMessage(event);
      const payload: SessionErrorEvent = {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        projectName: session.projectName,
        error: session.error,
      };
      this.emit("session-error", payload);
      return;
    }

    if (isTerminalNotification(record)) {
      if (isBlockedNotification(record)) {
        session.isStreaming = false;
        session.status = "blocked";
        session.pendingBlocker = extractBlocker(event);
        const payload: SessionBlockedEvent = {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          projectName: session.projectName,
          blocker: session.pendingBlocker,
        };
        this.emit("session-blocked", payload);
        return;
      }

      session.isStreaming = false;
      session.status = "completed";
      session.pendingBlocker = null;
      const payload: SessionCompletedEvent = {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        projectName: session.projectName,
      };
      this.emit("session-completed", payload);
      return;
    }

    if (isBlockingUiRequest(record)) {
      session.isStreaming = false;
      session.status = "blocked";
      session.pendingBlocker = extractBlocker(event);
      const payload: SessionBlockedEvent = {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        projectName: session.projectName,
        blocker: session.pendingBlocker,
      };
      this.emit("session-blocked", payload);
    }
  }

  private projectKey(projectDir: string): string {
    return resolve(projectDir);
  }

  private getProjectSessionInternal(projectDir: string): ManagedSession | undefined {
    return this.sessions.get(this.projectKey(projectDir));
  }

  getProjectSession(projectDir: string): ManagedSession | undefined {
    return this.getProjectSessionInternal(projectDir);
  }

  private async createSession(projectDir: string, command: string): Promise<ManagedSession> {
    const resolvedProjectDir = this.projectKey(projectDir);
    const projectName = basename(resolvedProjectDir);

    // Build env overrides for the child GSD process.
    // GSD_HOME must point to the agent config directory (auth, models, settings)
    // so the spawned loader.js finds credentials and doesn't trigger first-run setup.
    const childEnv: Record<string, string> = {};
    if (this.config.gsdHome) {
      childEnv.GSD_HOME = this.config.gsdHome;
    }

    const buildClient = (cliPath: string): RpcClient => new RpcClient({
      cliPath,
      cwd: resolvedProjectDir,
      args: this.sessionArgs(),
      env: childEnv,
    });

    const firstCliPath = this.cliPaths[0];
    if (!firstCliPath) {
      throw new Error("No GSD CLI candidates are available.");
    }

    const session: ManagedSession = {
      sessionId: "",
      projectDir: resolvedProjectDir,
      projectName,
      cliPath: firstCliPath,
      status: "starting",
      isStreaming: false,
      client: buildClient(firstCliPath),
      events: [],
      pendingBlocker: null,
      cost: emptyCost(),
      startTime: Date.now(),
    };

    this.sessions.set(resolvedProjectDir, session);

    const failures: Array<{ cliPath: string; error: string }> = [];

    for (const cliPath of this.cliPaths) {
      const client = cliPath === firstCliPath ? session.client : buildClient(cliPath);
      session.client = client;
      session.cliPath = cliPath;

      try {
        await Promise.race([
          client.start(),
          timeout(INIT_TIMEOUT_MS, `RpcClient.start() timed out after ${INIT_TIMEOUT_MS}ms`),
        ]);
        const init = await Promise.race([
          client.init(),
          timeout(INIT_TIMEOUT_MS, `RpcClient.init() timed out after ${INIT_TIMEOUT_MS}ms`),
        ]) as RpcInitResult;

        session.sessionId = init.sessionId;
        session.status = "running";
        this.bindSessionEvents(session);

        const startedEvent: SessionStartedEvent = {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          projectName: session.projectName,
        };
        this.emit("session-started", startedEvent);

        await this.dispatchPrompt(session, command);
        this.logger.info("session started", {
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          cliPath: session.cliPath,
        });
        return session;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ cliPath, error: message });
        this.logger.warn("gsd cli candidate failed", {
          cliPath,
          projectDir: resolvedProjectDir,
          error: message,
        });
        try {
          await client.stop();
        } catch {
          // ignored
        }
      }
    }

    session.isStreaming = false;
    session.status = "error";
    const lastFailure = failures.at(-1);
    session.error = lastFailure
      ? `Failed to initialize GSD CLI after ${failures.length} attempt(s). Last error: ${lastFailure.error}`
      : "Failed to initialize GSD CLI for an unknown reason.";
    this.sessions.delete(resolvedProjectDir);

    this.logger.error("all gsd cli candidates failed", {
      projectDir: resolvedProjectDir,
      attempts: failures.map((failure) => `${failure.cliPath} :: ${failure.error}`),
    });

    const payload: SessionErrorEvent = {
      sessionId: session.sessionId,
      projectDir: session.projectDir,
      projectName: session.projectName,
      error: session.error,
    };
    this.emit("session-error", payload);
    throw new Error(`Failed to start session for ${resolvedProjectDir}: ${session.error}`);
  }

  async dispatch(projectDir: string, command: string): Promise<DispatchResult> {
    const resolvedProjectDir = this.projectKey(projectDir);
    const existing = this.getProjectSessionInternal(resolvedProjectDir);
    if (!existing) {
      const session = await this.createSession(resolvedProjectDir, command);
      return { session, startedFresh: true };
    }

    if (existing.status === "cancelled") {
      this.sessions.delete(existing.projectDir);
      const session = await this.createSession(resolvedProjectDir, command);
      return { session, startedFresh: true };
    }

    if (existing.status === "error") {
      try {
        await existing.client.stop();
      } catch {
        // ignored
      }
      this.sessions.delete(existing.projectDir);
      const session = await this.createSession(resolvedProjectDir, command);
      return { session, startedFresh: true };
    }

    if (existing.pendingBlocker) {
      throw new Error("The session is blocked. Reply in the thread first to resolve the blocker.");
    }

    await this.promptOrSteer(existing, command);
    return { session: existing, startedFresh: false };
  }

  async relayToSession(sessionId: string, input: string): Promise<ManagedSession> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.pendingBlocker) {
      const response = buildBlockerUiResponse(session.pendingBlocker, input);
      session.client.sendUIResponse(session.pendingBlocker.id, response);
      session.pendingBlocker = null;
      session.status = "running";
      await this.syncStreamingState(session, { settleMs: 75 });
      this.logger.info("blocker resolved", {
        sessionId,
        projectDir: session.projectDir,
        responseType: Object.keys(response)[0] ?? "unknown",
      });
      return session;
    }

    await this.promptOrSteer(session, input);
    return session;
  }

  private async promptOrSteer(session: ManagedSession, input: string): Promise<void> {
    if (session.isStreaming) {
      this.logger.info("session input dispatched", {
        sessionId: session.sessionId,
        mode: "steer",
        status: session.status,
      });
      await this.dispatchSteer(session, input);
      return;
    }

    session.status = "running";
    session.error = undefined;
    this.logger.info("session input dispatched", {
      sessionId: session.sessionId,
      mode: "prompt",
      status: session.status,
    });
    await this.dispatchPrompt(session, input);
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return [...this.sessions.values()].find((session) => session.sessionId === sessionId);
  }

  getCurrentProjectSession(): ManagedSession | undefined {
    if (this.sessions.size !== 1) {
      return undefined;
    }
    return [...this.sessions.values()][0];
  }

  async inspectProjectSession(projectDir: string): Promise<{
    session: ManagedSession;
    state: RpcSessionState;
    stats: SessionStats;
  } | undefined> {
    const session = this.getProjectSessionInternal(projectDir);
    if (!session) {
      return undefined;
    }

    const [state, stats] = await Promise.all([
      session.client.getState(),
      session.client.getSessionStats(),
    ]);

    session.isStreaming = state.isStreaming;
    if (session.pendingBlocker) {
      session.status = "blocked";
    } else {
      session.status = state.isStreaming ? "running" : "completed";
    }

    return { session, state, stats };
  }

  async startNewContext(projectDir: string): Promise<{
    previousSessionId: string;
    session: ManagedSession;
    cancelled: boolean;
  } | undefined> {
    const session = this.getProjectSessionInternal(projectDir);
    if (!session) {
      return undefined;
    }

    const previousSessionId = session.sessionId;
    const result = await session.client.newSession();
    if (result.cancelled) {
      return {
        previousSessionId,
        session,
        cancelled: true,
      };
    }

    const state = await session.client.getState();
    session.sessionId = state.sessionId;
    session.isStreaming = state.isStreaming;
    session.status = state.isStreaming ? "running" : "completed";
    session.pendingBlocker = null;
    session.error = undefined;
    session.events = [];
    session.cost = emptyCost();
    session.startTime = Date.now();

    return {
      previousSessionId,
      session,
      cancelled: false,
    };
  }

  async endProjectSession(projectDir: string): Promise<ManagedSession | undefined> {
    const session = this.getProjectSessionInternal(projectDir);
    if (!session) {
      return undefined;
    }

    try {
      session.unsubscribe?.();
    } catch {
      // ignored
    }

    try {
      await session.client.stop();
    } catch {
      // ignored
    }

    session.status = "cancelled";
    session.isStreaming = false;
    this.sessions.delete(session.projectDir);
    return session;
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        session.unsubscribe?.();
      } catch {
        // ignored
      }
      try {
        await session.client.stop();
      } catch {
        // ignored
      }
      session.status = "cancelled";
      session.isStreaming = false;
    }
    this.sessions.clear();
  }
}
