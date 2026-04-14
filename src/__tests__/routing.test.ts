import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeBlockerReply } from "../blockers.js";
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

describe("normalizeBlockerReply", () => {
  it("translates select replies to zero-based indexes", () => {
    const normalized = normalizeBlockerReply(
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
        },
      },
      "2",
    );

    assert.equal(normalized, "1");
  });

  it("normalizes yes/no confirm blockers", () => {
    const yes = normalizeBlockerReply(
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

    const no = normalizeBlockerReply(
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

    assert.equal(yes, "true");
    assert.equal(no, "false");
  });
});
