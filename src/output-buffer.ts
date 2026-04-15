import type { SdkAgentEvent } from "@gsd-build/rpc-client";

export interface BufferedAssistantOutput {
  text: string;
  modelLabel?: string;
}

interface BufferedOutputState {
  latestAssistantText?: string;
  latestModelLabel?: string;
}

function extractTextBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is { type?: string; text?: string } => typeof item === "object" && item !== null)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "");
}

export function extractMessageText(source: unknown): string {
  if (typeof source === "string") {
    return source;
  }

  if (!source || typeof source !== "object") {
    return "";
  }

  const record = source as Record<string, unknown>;
  const fromContentBlocks = extractTextBlocks(record.content).join("\n").trim();
  if (fromContentBlocks) {
    return fromContentBlocks;
  }

  if (typeof record.text === "string" && record.text.trim()) {
    return record.text.trim();
  }

  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }

  if (record.message && typeof record.message === "object") {
    return extractMessageText(record.message);
  }

  return "";
}

function extractAssistantMessageRecord(event: SdkAgentEvent): Record<string, unknown> | null {
  const record = event as Record<string, unknown>;
  const eventType = typeof record.type === "string" ? record.type : "";
  if (!["message", "message_start", "message_update", "message_end"].includes(eventType)) {
    return null;
  }

  const message = record.message && typeof record.message === "object"
    ? (record.message as Record<string, unknown>)
    : record;

  const role = typeof message.role === "string"
    ? message.role
    : typeof record.role === "string"
      ? record.role
      : undefined;

  if (role && role !== "assistant") {
    return null;
  }

  return message;
}

export function extractAssistantText(event: SdkAgentEvent): string | null {
  const message = extractAssistantMessageRecord(event);
  if (!message) {
    return null;
  }

  const text = extractMessageText(message);
  return text ? text : null;
}

export function extractAssistantModelLabel(event: SdkAgentEvent): string | null {
  const message = extractAssistantMessageRecord(event);
  if (!message) {
    return null;
  }

  const provider = typeof message.provider === "string" ? message.provider.trim() : "";
  const model = typeof message.model === "string" ? message.model.trim() : "";

  if (provider && model) {
    return `${provider}/${model}`;
  }
  if (model) {
    return model;
  }
  if (provider) {
    return provider;
  }

  return null;
}

export function splitIntoDiscordChunks(text: string, maxLength = 1500): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const window = remaining.slice(0, maxLength + 1);
    const splitAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );

    const safeIndex = splitAt > Math.floor(maxLength * 0.6) ? splitAt : maxLength;
    const next = remaining.slice(0, safeIndex).trim();
    if (!next) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength).trimStart();
      continue;
    }

    chunks.push(next);
    remaining = remaining.slice(safeIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

export class FinalOutputStore {
  private readonly state = new Map<string, BufferedOutputState>();

  updateFromEvent(sessionId: string, event: SdkAgentEvent): void {
    const assistantText = extractAssistantText(event);
    const assistantModelLabel = extractAssistantModelLabel(event);
    if (!assistantText && !assistantModelLabel) {
      return;
    }

    const current = this.state.get(sessionId) ?? {};
    if (assistantText) {
      current.latestAssistantText = assistantText;
    }
    if (assistantModelLabel) {
      current.latestModelLabel = assistantModelLabel;
    }
    this.state.set(sessionId, current);
  }

  consume(sessionId: string): BufferedAssistantOutput | null {
    const current = this.state.get(sessionId);
    this.state.delete(sessionId);

    const text = current?.latestAssistantText?.trim();
    if (!text) {
      return null;
    }

    return {
      text,
      ...(current?.latestModelLabel ? { modelLabel: current.latestModelLabel } : {}),
    };
  }

  clear(sessionId: string): void {
    this.state.delete(sessionId);
  }
}
