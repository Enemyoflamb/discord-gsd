import type { PendingBlocker } from "./models.js";

function eventRecord(blocker: PendingBlocker): Record<string, unknown> {
  return blocker.event as Record<string, unknown>;
}

export function formatBlockerMessage(blocker: PendingBlocker): string {
  const header = `⚠️ GSD is waiting for input\n\n${blocker.message || "A response is required."}`;

  switch (blocker.method) {
    case "select": {
      const options = Array.isArray(eventRecord(blocker).options)
        ? (eventRecord(blocker).options as unknown[]).filter((value): value is string => typeof value === "string")
        : [];

      const lines = options.map((option, index) => `${index + 1}. ${option}`);
      return `${header}\n\nReply with the option number.\n${lines.join("\n")}`.trim();
    }

    case "confirm":
      return `${header}\n\nReply with yes or no.`;

    case "editor":
      return `${header}\n\nReply with the full replacement text.`;

    case "input": {
      const placeholder = typeof eventRecord(blocker).placeholder === "string"
        ? eventRecord(blocker).placeholder
        : undefined;
      return `${header}\n\nReply with the requested text.${placeholder ? `\nHint: ${placeholder}` : ""}`;
    }

    default:
      return `${header}\n\nReply with the value to send back to GSD.`;
  }
}

export function normalizeBlockerReply(blocker: PendingBlocker, reply: string): string {
  const trimmed = reply.trim();
  if (!trimmed) {
    throw new Error("Reply was empty.");
  }

  switch (blocker.method) {
    case "select": {
      const options = Array.isArray(eventRecord(blocker).options)
        ? (eventRecord(blocker).options as unknown[]).filter((value): value is string => typeof value === "string")
        : [];
      const match = trimmed.match(/\d+/);
      if (!match) {
        throw new Error("Select blockers require a numeric reply like `1`.");
      }
      const oneBasedIndex = Number.parseInt(match[0], 10);
      if (!Number.isFinite(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > options.length) {
        throw new Error(`Reply must be between 1 and ${options.length}.`);
      }
      return String(oneBasedIndex - 1);
    }

    case "confirm": {
      const normalized = trimmed.toLowerCase();
      if (["yes", "y", "true", "1"].includes(normalized)) {
        return "true";
      }
      if (["no", "n", "false", "0"].includes(normalized)) {
        return "false";
      }
      throw new Error("Confirm blockers require yes or no.");
    }

    default:
      return trimmed;
  }
}
