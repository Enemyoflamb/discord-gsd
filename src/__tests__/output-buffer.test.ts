import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractAssistantModelLabel, extractAssistantText, splitIntoDiscordChunks } from "../output-buffer.js";

describe("splitIntoDiscordChunks", () => {
  it("returns a single chunk when the text already fits", () => {
    assert.deepEqual(splitIntoDiscordChunks("hello", 10), ["hello"]);
  });

  it("splits on whitespace before the hard limit when possible", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta";
    const chunks = splitIntoDiscordChunks(text, 18);
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((chunk) => chunk.length <= 18));
    assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), text);
  });

  it("hard-splits long uninterrupted text", () => {
    const text = "x".repeat(35);
    const chunks = splitIntoDiscordChunks(text, 10);
    assert.deepEqual(chunks.map((chunk) => chunk.length), [10, 10, 10, 5]);
  });
});

describe("extractAssistantText", () => {
  it("extracts assistant text from message_end content blocks", () => {
    const text = extractAssistantText({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      },
    } as never);

    assert.equal(text, "Final answer");
  });

  it("ignores non-assistant messages", () => {
    const text = extractAssistantText({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    } as never);

    assert.equal(text, null);
  });
});

describe("extractAssistantModelLabel", () => {
  it("extracts provider/model from assistant messages", () => {
    const label = extractAssistantModelLabel({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Final answer" }],
      },
    } as never);

    assert.equal(label, "anthropic/claude-sonnet-4-20250514");
  });

  it("returns null when no model metadata is present", () => {
    const label = extractAssistantModelLabel({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Final answer" }],
      },
    } as never);

    assert.equal(label, null);
  });
});
