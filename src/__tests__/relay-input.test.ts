import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeRelayInput } from "../relay-input.js";

describe("normalizeRelayInput", () => {
  it("expands minimal confirmation replies for the requirements confirmation gate", () => {
    const result = normalizeRelayInput(
      "Confirm",
      "[LLM: claude-opus-4-6] | R001 | Example | active | M001/S01 | user |\n\nConfirm, adjust, or add?",
    );

    assert.deepEqual(result, {
      text: "Confirm. No adjustments or additions.",
      kind: "requirements_confirm",
    });
  });

  it("expands minimal confirmation replies for the write gate", () => {
    const result = normalizeRelayInput(
      "yes",
      "[LLM: claude-opus-4-6] Ready to write, or want to adjust?",
    );

    assert.deepEqual(result, {
      text: "Ready to write. No adjustments.",
      kind: "write_confirm",
    });
  });

  it("leaves non-gate replies untouched", () => {
    const result = normalizeRelayInput(
      "Confirm",
      "[LLM: claude-opus-4-6] Tell me more about the Minecraft event hook you want.",
    );

    assert.deepEqual(result, {
      text: "Confirm",
      kind: null,
    });
  });

  it("leaves detailed replies untouched even when the last bot message is a gate", () => {
    const result = normalizeRelayInput(
      "Adjust R002 to exclude passive mobs.",
      "Confirm, adjust, or add?",
    );

    assert.deepEqual(result, {
      text: "Adjust R002 to exclude passive mobs.",
      kind: null,
    });
  });
});
