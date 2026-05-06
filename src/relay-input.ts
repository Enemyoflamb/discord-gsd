const LLM_PREFIX_RE = /^\[LLM:[^\]]+\]\s*/i;

const MINIMAL_CONFIRMATIONS = new Set([
  "confirm",
  "confirmed",
  "yes",
  "y",
  "ok",
  "okay",
  "approved",
  "lgtm",
  "looks good",
  "sounds good",
  "go ahead",
]);

export type RelayNormalizationKind = "requirements_confirm" | "write_confirm" | null;

export interface NormalizedRelayInput {
  text: string;
  kind: RelayNormalizationKind;
}

function normalizePromptText(text: string): string {
  return text
    .replace(LLM_PREFIX_RE, "")
    .trim()
    .toLowerCase();
}

function normalizeReplyText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "");
}

export function normalizeRelayInput(userInput: string, lastOutboundText?: string): NormalizedRelayInput {
  if (!lastOutboundText) {
    return { text: userInput, kind: null };
  }

  const normalizedReply = normalizeReplyText(userInput);
  if (!MINIMAL_CONFIRMATIONS.has(normalizedReply)) {
    return { text: userInput, kind: null };
  }

  const normalizedPrompt = normalizePromptText(lastOutboundText);

  if (normalizedPrompt.includes("confirm, adjust, or add?")) {
    return {
      text: "Confirm. No adjustments or additions.",
      kind: "requirements_confirm",
    };
  }

  if (normalizedPrompt.includes("ready to write") && normalizedPrompt.includes("adjust")) {
    return {
      text: "Ready to write. No adjustments.",
      kind: "write_confirm",
    };
  }

  return { text: userInput, kind: null };
}
