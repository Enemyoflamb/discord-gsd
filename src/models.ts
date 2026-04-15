import type { RpcClient, RpcExtensionUIRequest, SdkAgentEvent } from "@gsd-build/rpc-client";

export type SessionStatus = "starting" | "running" | "blocked" | "completed" | "error" | "cancelled";

export interface PendingBlocker {
  id: string;
  method: string;
  message: string;
  event: RpcExtensionUIRequest;
}

export interface CostAccumulator {
  totalCost: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface ManagedSession {
  sessionId: string;
  projectDir: string;
  projectName: string;
  status: SessionStatus;
  isStreaming: boolean;
  client: RpcClient;
  events: SdkAgentEvent[];
  pendingBlocker: PendingBlocker | null;
  cost: CostAccumulator;
  startTime: number;
  unsubscribe?: (() => void) | undefined;
  error?: string | undefined;
}

export interface SessionThreadState {
  sessionId: string;
  threadId: string;
  starterMessageId: string;
  lastBotMessageIds: Set<string>;
}

export interface SessionStartedEvent {
  sessionId: string;
  projectDir: string;
  projectName: string;
}

export interface SessionEventEnvelope {
  sessionId: string;
  projectDir: string;
  event: SdkAgentEvent;
}

export interface SessionBlockedEvent {
  sessionId: string;
  projectDir: string;
  projectName: string;
  blocker: PendingBlocker;
}

export interface SessionCompletedEvent {
  sessionId: string;
  projectDir: string;
  projectName: string;
}

export interface SessionErrorEvent {
  sessionId: string;
  projectDir: string;
  projectName: string;
  error: string;
}

export interface RelayTarget {
  sessionId: string;
  via: "thread" | "message_reference";
}

export interface DispatchResult {
  session: ManagedSession;
  startedFresh: boolean;
}
