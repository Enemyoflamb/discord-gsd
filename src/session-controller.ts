import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { basename, resolve } from "node:path";

import {
  RpcClient,
  type RpcCostUpdateEvent,
  type RpcExtensionUIRequest,
  type RpcInitResult,
  type SdkAgentEvent,
} from "@gsd-build/rpc-client";

import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { normalizeBlockerReply } from "./blockers.js";
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

function resolveCliPath(config: AppConfig): string {
  if (config.gsdCliPath) {
    return resolve(config.gsdCliPath);
  }

  try {
    const detected = execSync("which gsd", { encoding: "utf-8" }).trim();
    if (detected) {
      return resolve(detected);
    }
  } catch {
    // ignored
  }

  throw new Error("Cannot find the gsd CLI. Set GSD_CLI_PATH or install gsd in PATH.");
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
  private readonly cliPath: string;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    super();
    this.cliPath = resolveCliPath(config);
  }

  private sessionArgs(): string[] {
    const args = ["--mode", "rpc"];
    if (this.config.gsdModel) {
      args.push("--model", this.config.gsdModel);
    }
    if (this.config.gsdBare) {
      args.push("--bare");
    }
    return args;
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

  private projectKey(): string {
    return resolve(this.config.gsdProjectDir);
  }

  private getProjectSessionInternal(): ManagedSession | undefined {
    return this.sessions.get(this.projectKey());
  }

  private async createSession(command: string): Promise<ManagedSession> {
    const projectDir = this.projectKey();
    const projectName = basename(projectDir);
    const client = new RpcClient({
      cliPath: this.cliPath,
      cwd: projectDir,
      args: this.sessionArgs(),
    });

    const session: ManagedSession = {
      sessionId: "",
      projectDir,
      projectName,
      status: "starting",
      isStreaming: false,
      client,
      events: [],
      pendingBlocker: null,
      cost: emptyCost(),
      startTime: Date.now(),
    };

    this.sessions.set(projectDir, session);

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

      await client.prompt(command);
      session.isStreaming = true;
      this.logger.info("session started", {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
      });
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.isStreaming = false;
      session.status = "error";
      session.error = message;
      this.sessions.delete(projectDir);
      try {
        await client.stop();
      } catch {
        // ignored
      }
      const payload: SessionErrorEvent = {
        sessionId: session.sessionId,
        projectDir: session.projectDir,
        projectName: session.projectName,
        error: message,
      };
      this.emit("session-error", payload);
      throw new Error(`Failed to start session for ${projectDir}: ${message}`);
    }
  }

  async dispatch(command: string): Promise<DispatchResult> {
    const existing = this.getProjectSessionInternal();
    if (!existing) {
      const session = await this.createSession(command);
      return { session, startedFresh: true };
    }

    if (existing.status === "cancelled") {
      this.sessions.delete(existing.projectDir);
      const session = await this.createSession(command);
      return { session, startedFresh: true };
    }

    if (existing.status === "error") {
      try {
        await existing.client.stop();
      } catch {
        // ignored
      }
      this.sessions.delete(existing.projectDir);
      const session = await this.createSession(command);
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
      const normalized = normalizeBlockerReply(session.pendingBlocker, input);
      session.client.sendUIResponse(session.pendingBlocker.id, { value: normalized });
      session.pendingBlocker = null;
      session.isStreaming = true;
      session.status = "running";
      this.logger.info("blocker resolved", {
        sessionId,
        projectDir: session.projectDir,
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
      await session.client.steer(input);
      return;
    }

    session.status = "running";
    session.error = undefined;
    this.logger.info("session input dispatched", {
      sessionId: session.sessionId,
      mode: "prompt",
      status: session.status,
    });
    await session.client.prompt(input);
    session.isStreaming = true;
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return [...this.sessions.values()].find((session) => session.sessionId === sessionId);
  }

  getCurrentProjectSession(): ManagedSession | undefined {
    return this.getProjectSessionInternal();
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
