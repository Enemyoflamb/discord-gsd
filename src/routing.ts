import type { RelayTarget } from "./models.js";

function sanitizeThreadFragment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function buildThreadName(input: string): string {
  const prefix = sanitizeThreadFragment(input) || "session";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  return `gsd-${prefix}-${stamp}`.slice(0, 100);
}

export function resolveRelayTarget(
  channelId: string,
  referencedMessageId: string | undefined,
  threadToSession: ReadonlyMap<string, string>,
  messageToSession: ReadonlyMap<string, string>,
): RelayTarget | null {
  const direct = threadToSession.get(channelId);
  if (direct) {
    return { sessionId: direct, via: "thread" };
  }

  if (referencedMessageId) {
    const referenced = messageToSession.get(referencedMessageId);
    if (referenced) {
      return { sessionId: referenced, via: "message_reference" };
    }
  }

  return null;
}
