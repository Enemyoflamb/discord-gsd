import type { PendingBlocker } from "./models.js";

export interface BlockerUiResponse {
  value?: string;
  values?: string[];
  confirmed?: boolean;
  cancelled?: boolean;
}

function eventRecord(blocker: PendingBlocker): Record<string, unknown> {
  return blocker.event as Record<string, unknown>;
}

function selectOptions(blocker: PendingBlocker): string[] {
  return Array.isArray(eventRecord(blocker).options)
    ? (eventRecord(blocker).options as unknown[]).filter((value): value is string => typeof value === "string")
    : [];
}

export function formatBlockerMessage(blocker: PendingBlocker): string {
  const header = `⚠️ GSD is waiting for input\n\n${blocker.message || "A response is required."}`;

  switch (blocker.method) {
    case "select": {
      const options = selectOptions(blocker);
      const lines = options.map((option, index) => `${index + 1}. ${option}`);
      const allowMultiple = eventRecord(blocker).allowMultiple === true;
      const instructions = allowMultiple
        ? "Reply with one or more option numbers separated by commas."
        : "Reply with the option number.";
      return `${header}\n\n${instructions}\n${lines.join("\n")}`.trim();
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

export function buildBlockerUiResponse(blocker: PendingBlocker, reply: string): BlockerUiResponse {
  const trimmed = reply.trim();
  if (!trimmed) {
    throw new Error("Reply was empty.");
  }

  switch (blocker.method) {
    case "select": {
      const options = selectOptions(blocker);
      const allowMultiple = eventRecord(blocker).allowMultiple === true;
      const matches = [...trimmed.matchAll(/\d+/g)].map((match) => Number.parseInt(match[0], 10));
      if (matches.length === 0) {
        throw new Error("Select blockers require a numeric reply like `1`.");
      }

      const labels = matches.map((oneBasedIndex) => {
        if (!Number.isFinite(oneBasedIndex) || oneBasedIndex < 1 || oneBasedIndex > options.length) {
          throw new Error(`Reply must be between 1 and ${options.length}.`);
        }
        return options[oneBasedIndex - 1] as string;
      });

      if (allowMultiple) {
        return { values: [...new Set(labels)] };
      }

      const label = labels[0];
      if (!label) {
        throw new Error("No option could be resolved from the reply.");
      }
      return { value: label };
    }

    case "confirm": {
      const normalized = trimmed.toLowerCase();
      if (["yes", "y", "true", "1"].includes(normalized)) {
        return { confirmed: true };
      }
      if (["no", "n", "false", "0"].includes(normalized)) {
        return { confirmed: false };
      }
      throw new Error("Confirm blockers require yes or no.");
    }

    default:
      return { value: trimmed };
  }
}
