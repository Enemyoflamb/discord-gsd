import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractAssistantModelLabel, extractAssistantText, extractShellCommandActivity, formatShellCommandMessages, splitIntoDiscordChunks } from "../output-buffer.js";

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

describe("extractShellCommandActivity", () => {
  it("extracts bash tool execution starts", () => {
    const activity = extractShellCommandActivity({
      type: "tool_execution_start",
      toolCallId: "toolu_1",
      toolName: "bash",
      args: { command: "npm test" },
    } as never);

    assert.deepEqual(activity, {
      toolCallId: "toolu_1",
      toolName: "bash",
      label: "bash",
      command: "npm test",
    });
  });

  it("supports legacy input payloads", () => {
    const activity = extractShellCommandActivity({
      type: "tool_execution_start",
      toolCallId: "toolu_2",
      toolName: "async_bash",
      input: { command: "npm run build" },
    } as never);

    assert.deepEqual(activity, {
      toolCallId: "toolu_2",
      toolName: "async_bash",
      label: "async_bash",
      command: "npm run build",
    });
  });

  it("extracts bg_shell run actions with a command", () => {
    const activity = extractShellCommandActivity({
      type: "tool_execution_start",
      toolCallId: "toolu_3",
      toolName: "bg_shell",
      args: { action: "run", command: "pnpm dev" },
    } as never);

    assert.deepEqual(activity, {
      toolCallId: "toolu_3",
      toolName: "bg_shell",
      label: "bg_shell:run",
      command: "pnpm dev",
    });
  });

  it("ignores non-command tool activity", () => {
    const activity = extractShellCommandActivity({
      type: "tool_execution_start",
      toolCallId: "toolu_4",
      toolName: "read",
      args: { path: "README.md" },
    } as never);

    assert.equal(activity, null);
  });
});

describe("formatShellCommandMessages", () => {
  it("formats machine activity as a plain Discord message with a code block", () => {
    const messages = formatShellCommandMessages({
      toolCallId: "toolu_5",
      toolName: "bash",
      label: "bash",
      command: "npm test",
    }, 200);

    assert.deepEqual(messages, ["[Machine · bash]\n```bash\nnpm test\n```"]);
  });

  it("splits long commands into multiple Discord-safe parts", () => {
    const messages = formatShellCommandMessages({
      toolCallId: "toolu_6",
      toolName: "bash",
      label: "bash",
      command: "echo " + "x".repeat(120),
    }, 90);

    assert.ok(messages.length > 1);
    assert.ok(messages.every((message) => message.length <= 90));
    assert.ok(messages[0]);
    assert.match(messages[0], /\[Machine · bash\] · 1\//);
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
