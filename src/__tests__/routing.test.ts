import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildBlockerUiResponse } from "../blockers.js";
import { buildThreadName, resolveRelayTarget } from "../routing.js";

describe("resolveRelayTarget", () => {
  it("prefers a direct thread mapping", () => {
    const target = resolveRelayTarget(
      "thread-1",
      "msg-1",
      new Map([["thread-1", "session-a"]]),
      new Map([["msg-1", "session-b"]]),
    );

    assert.deepEqual(target, { sessionId: "session-a", via: "thread" });
  });

  it("falls back to referenced bot messages", () => {
    const target = resolveRelayTarget(
      "parent",
      "msg-1",
      new Map(),
      new Map([["msg-1", "session-a"]]),
    );

    assert.deepEqual(target, { sessionId: "session-a", via: "message_reference" });
  });
});

describe("buildThreadName", () => {
  it("sanitizes and prefixes thread names", () => {
    const name = buildThreadName("/gsd init: make Discord bridge");
    assert.ok(name.startsWith("gsd-gsd-init-make-discord-bridge-"));
    assert.ok(name.length <= 100);
  });
});

describe("buildBlockerUiResponse", () => {
  it("translates select replies into the selected option label", () => {
    const response = buildBlockerUiResponse(
      {
        id: "req-1",
        method: "select",
        message: "Choose",
        event: {
          type: "extension_ui_request",
          id: "req-1",
          method: "select",
          title: "Choose",
          options: ["Initialize git", "Skip"],
        },
      },
      "1",
    );

    assert.deepEqual(response, { value: "Initialize git" });
  });

  it("translates multi-select replies into selected option labels", () => {
    const response = buildBlockerUiResponse(
      {
        id: "req-1",
        method: "select",
        message: "Choose",
        event: {
          type: "extension_ui_request",
          id: "req-1",
          method: "select",
          title: "Choose",
          options: ["A", "B", "C"],
          allowMultiple: true,
        },
      },
      "1, 3",
    );

    assert.deepEqual(response, { values: ["A", "C"] });
  });

  it("normalizes yes/no confirm blockers to confirmed booleans", () => {
    const yes = buildBlockerUiResponse(
      {
        id: "req-2",
        method: "confirm",
        message: "Continue?",
        event: {
          type: "extension_ui_request",
          id: "req-2",
          method: "confirm",
          title: "Continue?",
          message: "Continue?",
        },
      },
      "yes",
    );

    const no = buildBlockerUiResponse(
      {
        id: "req-2",
        method: "confirm",
        message: "Continue?",
        event: {
          type: "extension_ui_request",
          id: "req-2",
          method: "confirm",
          title: "Continue?",
          message: "Continue?",
        },
      },
      "no",
    );

    assert.deepEqual(yes, { confirmed: true });
    assert.deepEqual(no, { confirmed: false });
  });
});
