import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildGsdCommandInput,
  getGsdArgsAutocompleteChoices,
  getGsdAutocompleteChoices,
} from "../gsd-command-catalog.js";

describe("buildGsdCommandInput", () => {
  it("builds bare /gsd when no command is provided", () => {
    assert.equal(buildGsdCommandInput(), "/gsd");
  });

  it("builds a command with optional args", () => {
    assert.equal(buildGsdCommandInput("help"), "/gsd help");
    assert.equal(buildGsdCommandInput("workflow", "run demo"), "/gsd workflow run demo");
  });

  it("rejects args without a command", () => {
    assert.throws(() => buildGsdCommandInput("", "run demo"), /command is required/i);
  });
});

describe("getGsdAutocompleteChoices", () => {
  it("returns top-level GSD commands", () => {
    const choices = getGsdAutocompleteChoices("");
    assert.ok(choices.some((choice) => choice.value === "help"));
    assert.ok(choices.some((choice) => choice.value === "auto"));
  });

  it("filters by prefix", () => {
    const choices = getGsdAutocompleteChoices("st");
    assert.deepEqual(choices.map((choice) => choice.value), ["start", "stop", "status", "steer"]);
  });

  it("caps Discord autocomplete results at 25 entries", () => {
    const choices = getGsdAutocompleteChoices("");
    assert.ok(choices.length <= 25);
  });
});

describe("getGsdArgsAutocompleteChoices", () => {
  it("returns empty choices when no command is selected", () => {
    assert.deepEqual(getGsdArgsAutocompleteChoices(undefined, ""), []);
  });

  it("returns nested static subcommands for the selected command", () => {
    const choices = getGsdArgsAutocompleteChoices("workflow", "");
    assert.deepEqual(choices.map((choice) => choice.value), ["new", "run", "list", "validate", "pause", "resume"]);
  });

  it("filters nested static arg choices by prefix", () => {
    const choices = getGsdArgsAutocompleteChoices("export", "--h");
    assert.deepEqual(choices.map((choice) => choice.value), ["--html", "--html --all"]);
  });

  it("supports multi-word static nested choices", () => {
    const choices = getGsdArgsAutocompleteChoices("cmux", "sidebar ");
    assert.deepEqual(choices.map((choice) => choice.value), ["sidebar on", "sidebar off"]);
  });

  it("returns bundled template ids for templates info", () => {
    const choices = getGsdArgsAutocompleteChoices("templates", "info b");
    assert.ok(choices.some((choice) => choice.value === "info bugfix"));
  });

  it("returns workflow definition names from the target project", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "discord-gsd-workflow-"));
    try {
      const defsDir = join(projectDir, ".gsd", "workflow-defs");
      mkdirSync(defsDir, { recursive: true });
      writeFileSync(join(defsDir, "demo.yaml"), "name: demo\n", "utf-8");
      writeFileSync(join(defsDir, "deploy.yaml"), "name: deploy\n", "utf-8");

      const choices = getGsdArgsAutocompleteChoices("workflow", "run d", { projectDir });
      assert.deepEqual(choices.map((choice) => choice.value), ["run demo", "run deploy"]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("returns extension ids from the configured GSD home", () => {
    const gsdHome = mkdtempSync(join(tmpdir(), "discord-gsd-home-"));
    try {
      const extDir = join(gsdHome, "agent", "extensions", "demo-ext");
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, "extension-manifest.json"), JSON.stringify({
        id: "demo-ext",
        name: "Demo Extension",
      }), "utf-8");

      const choices = getGsdArgsAutocompleteChoices("extensions", "enable d", { gsdHome });
      assert.deepEqual(choices.map((choice) => choice.value), ["enable demo-ext"]);
    } finally {
      rmSync(gsdHome, { recursive: true, force: true });
    }
  });

  it("returns MCP server names from project config", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "discord-gsd-mcp-"));
    try {
      writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({
        mcpServers: {
          linear: { command: "npx", args: ["linear-mcp"] },
          railway: { url: "http://localhost:3001" },
        },
      }), "utf-8");

      const choices = getGsdArgsAutocompleteChoices("mcp", "check r", { projectDir });
      assert.deepEqual(choices.map((choice) => choice.value), ["check railway"]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
