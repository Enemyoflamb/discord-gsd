import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface GsdCommandDefinition {
  cmd: string;
  desc: string;
}

export interface GsdAutocompleteContext {
  projectDir?: string;
  gsdHome?: string;
  cwd?: string;
}

const MAX_DISCORD_AUTOCOMPLETE_CHOICES = 25;
const MAX_DISCORD_CHOICE_NAME_LENGTH = 100;

export const GSD_TOP_LEVEL_COMMANDS: readonly GsdCommandDefinition[] = [
  { cmd: "help", desc: "Categorized command reference with descriptions" },
  { cmd: "start", desc: "Start a workflow template" },
  { cmd: "templates", desc: "List available workflow templates" },
  { cmd: "next", desc: "Explicit step mode" },
  { cmd: "auto", desc: "Autonomous mode" },
  { cmd: "stop", desc: "Stop auto mode gracefully" },
  { cmd: "pause", desc: "Pause auto-mode" },
  { cmd: "status", desc: "Progress dashboard" },
  { cmd: "widget", desc: "Cycle widget visibility" },
  { cmd: "visualize", desc: "Open workflow visualizer" },
  { cmd: "queue", desc: "Queue and reorder future milestones" },
  { cmd: "quick", desc: "Execute a quick task" },
  { cmd: "discuss", desc: "Discuss architecture and decisions" },
  { cmd: "capture", desc: "Fire-and-forget thought capture" },
  { cmd: "triage", desc: "Triage pending captures" },
  { cmd: "dispatch", desc: "Dispatch a specific phase directly" },
  { cmd: "history", desc: "View execution history" },
  { cmd: "undo", desc: "Revert last completed unit" },
  { cmd: "undo-task", desc: "Reset a specific task's completion state" },
  { cmd: "reset-slice", desc: "Reset a slice and all its tasks" },
  { cmd: "rate", desc: "Rate the last unit's model tier" },
  { cmd: "skip", desc: "Prevent a unit from auto-mode dispatch" },
  { cmd: "export", desc: "Export milestone/slice results" },
  { cmd: "cleanup", desc: "Remove merged branches or snapshots" },
  { cmd: "mode", desc: "Switch workflow mode" },
  { cmd: "prefs", desc: "Manage preferences" },
  { cmd: "config", desc: "Set API keys for external tools" },
  { cmd: "keys", desc: "API key manager" },
  { cmd: "hooks", desc: "Show configured hooks" },
  { cmd: "run-hook", desc: "Run a specific hook" },
  { cmd: "skill-health", desc: "Skill lifecycle dashboard" },
  { cmd: "doctor", desc: "Runtime health checks with auto-fix" },
  { cmd: "logs", desc: "Browse activity and debug logs" },
  { cmd: "forensics", desc: "Examine execution logs" },
  { cmd: "changelog", desc: "Show categorized release notes" },
  { cmd: "migrate", desc: "Migrate v1 .planning to .gsd" },
  { cmd: "remote", desc: "Control remote auto-mode" },
  { cmd: "steer", desc: "Hard-steer plan documents" },
  { cmd: "knowledge", desc: "Add persistent project knowledge" },
  { cmd: "new-milestone", desc: "Create a milestone from a spec" },
  { cmd: "parallel", desc: "Parallel milestone orchestration" },
  { cmd: "cmux", desc: "Manage cmux integration" },
  { cmd: "park", desc: "Park a milestone" },
  { cmd: "unpark", desc: "Reactivate a parked milestone" },
  { cmd: "init", desc: "Project init wizard" },
  { cmd: "setup", desc: "Global setup status" },
  { cmd: "inspect", desc: "Show SQLite DB diagnostics" },
  { cmd: "extensions", desc: "Manage extensions" },
  { cmd: "update", desc: "Update GSD" },
  { cmd: "fast", desc: "Toggle OpenAI service tier" },
  { cmd: "mcp", desc: "MCP server status and connectivity" },
  { cmd: "rethink", desc: "Conversational project reorganization" },
  { cmd: "workflow", desc: "Custom workflow lifecycle" },
  { cmd: "codebase", desc: "Generate and manage CODEBASE.md" },
  { cmd: "notifications", desc: "View persistent notification history" },
];

const GSD_ARG_COMMANDS: Readonly<Record<string, readonly GsdCommandDefinition[]>> = {
  auto: [
    { cmd: "--verbose", desc: "Show detailed execution output" },
    { cmd: "--debug", desc: "Enable debug logging" },
  ],
  next: [
    { cmd: "--verbose", desc: "Show detailed step output" },
    { cmd: "--dry-run", desc: "Preview next step without executing" },
    { cmd: "--debug", desc: "Enable debug logging" },
  ],
  widget: [
    { cmd: "full", desc: "Full widget display" },
    { cmd: "small", desc: "Compact widget display" },
    { cmd: "min", desc: "Minimal widget display" },
    { cmd: "off", desc: "Hide widget" },
  ],
  mode: [
    { cmd: "global", desc: "Edit global workflow mode" },
    { cmd: "project", desc: "Edit project-specific workflow mode" },
  ],
  parallel: [
    { cmd: "start", desc: "Start parallel milestone orchestration" },
    { cmd: "status", desc: "Show parallel worker statuses" },
    { cmd: "stop", desc: "Stop all parallel workers" },
    { cmd: "pause", desc: "Pause a specific worker" },
    { cmd: "resume", desc: "Resume a paused worker" },
    { cmd: "merge", desc: "Merge completed milestone branches" },
    { cmd: "watch", desc: "Live TUI dashboard monitoring all workers" },
  ],
  setup: [
    { cmd: "llm", desc: "Configure LLM provider settings" },
    { cmd: "search", desc: "Configure web search provider" },
    { cmd: "remote", desc: "Configure remote integrations" },
    { cmd: "keys", desc: "Manage API keys" },
    { cmd: "prefs", desc: "Configure global preferences" },
  ],
  notifications: [
    { cmd: "clear", desc: "Clear all notifications" },
    { cmd: "tail", desc: "Show last N notifications" },
    { cmd: "filter", desc: "Filter by severity" },
  ],
  logs: [
    { cmd: "debug", desc: "List or view debug log files" },
    { cmd: "tail", desc: "Show recent activity log summaries" },
    { cmd: "clear", desc: "Remove old activity and debug logs" },
  ],
  keys: [
    { cmd: "list", desc: "Show key status dashboard" },
    { cmd: "add", desc: "Add a key for a provider" },
    { cmd: "remove", desc: "Remove a key" },
    { cmd: "test", desc: "Validate key(s) with an API call" },
    { cmd: "rotate", desc: "Replace an existing key" },
    { cmd: "doctor", desc: "Health check all keys" },
  ],
  prefs: [
    { cmd: "global", desc: "Edit global preferences file" },
    { cmd: "project", desc: "Edit project preferences file" },
    { cmd: "status", desc: "Show effective preferences" },
    { cmd: "wizard", desc: "Interactive preferences wizard" },
    { cmd: "setup", desc: "First-time preferences setup" },
    { cmd: "import-claude", desc: "Import settings from Claude Code" },
  ],
  remote: [
    { cmd: "slack", desc: "Configure Slack integration" },
    { cmd: "discord", desc: "Configure Discord integration" },
    { cmd: "status", desc: "Show remote connection status" },
    { cmd: "disconnect", desc: "Disconnect remote integrations" },
  ],
  history: [
    { cmd: "--cost", desc: "Show cost breakdown per entry" },
    { cmd: "--phase", desc: "Filter by phase type" },
    { cmd: "--model", desc: "Filter by model used" },
    { cmd: "10", desc: "Show last 10 entries" },
    { cmd: "20", desc: "Show last 20 entries" },
    { cmd: "50", desc: "Show last 50 entries" },
  ],
  export: [
    { cmd: "--json", desc: "Export as JSON" },
    { cmd: "--markdown", desc: "Export as Markdown" },
    { cmd: "--html", desc: "Export as HTML" },
    { cmd: "--html --all", desc: "Export all milestones as HTML" },
  ],
  cleanup: [
    { cmd: "branches", desc: "Remove merged milestone and legacy branches" },
    { cmd: "snapshots", desc: "Remove old execution snapshots" },
    { cmd: "worktrees", desc: "Remove merged and safe-to-delete worktrees" },
    { cmd: "projects", desc: "Audit orphaned ~/.gsd/projects state directories" },
    { cmd: "projects --fix", desc: "Delete orphaned project state directories" },
  ],
  knowledge: [
    { cmd: "rule", desc: "Add a project rule" },
    { cmd: "pattern", desc: "Add a code pattern to follow" },
    { cmd: "lesson", desc: "Record a lesson learned" },
  ],
  start: [
    { cmd: "bugfix", desc: "Triage, fix, test, and ship a bug fix" },
    { cmd: "small-feature", desc: "Lightweight feature with optional discussion" },
    { cmd: "spike", desc: "Research, prototype, and document findings" },
    { cmd: "hotfix", desc: "Minimal: fix it, test it, ship it" },
    { cmd: "refactor", desc: "Inventory, plan waves, migrate, verify" },
    { cmd: "security-audit", desc: "Scan, triage, remediate, re-scan" },
    { cmd: "dep-upgrade", desc: "Assess, upgrade, fix breaks, verify" },
    { cmd: "full-project", desc: "Complete GSD workflow with full ceremony" },
    { cmd: "resume", desc: "Resume an in-progress workflow" },
    { cmd: "--list", desc: "List all available templates" },
    { cmd: "--dry-run", desc: "Preview workflow without executing" },
  ],
  templates: [
    { cmd: "info", desc: "Show detailed template info" },
  ],
  extensions: [
    { cmd: "list", desc: "List all extensions and their status" },
    { cmd: "enable", desc: "Enable a disabled extension" },
    { cmd: "disable", desc: "Disable an extension" },
    { cmd: "info", desc: "Show extension details" },
  ],
  fast: [
    { cmd: "on", desc: "Enable priority tier" },
    { cmd: "off", desc: "Disable service tier" },
    { cmd: "flex", desc: "Enable flex tier" },
    { cmd: "status", desc: "Show current service tier setting" },
  ],
  mcp: [
    { cmd: "status", desc: "Show all MCP server statuses" },
    { cmd: "check", desc: "Detailed status for a specific server" },
  ],
  doctor: [
    { cmd: "fix", desc: "Auto-fix detected issues" },
    { cmd: "heal", desc: "AI-driven deep healing" },
    { cmd: "audit", desc: "Run health audit without fixing" },
    { cmd: "--dry-run", desc: "Show what fix would change without applying" },
    { cmd: "--json", desc: "Output report as JSON" },
    { cmd: "--build", desc: "Include slow build health check" },
    { cmd: "--test", desc: "Include slow test health check" },
  ],
  dispatch: [
    { cmd: "research", desc: "Run research phase" },
    { cmd: "plan", desc: "Run planning phase" },
    { cmd: "execute", desc: "Run execution phase" },
    { cmd: "complete", desc: "Run completion phase" },
    { cmd: "reassess", desc: "Reassess current progress" },
    { cmd: "uat", desc: "Run user acceptance testing" },
    { cmd: "replan", desc: "Replan the current slice" },
  ],
  rate: [
    { cmd: "over", desc: "Model was overqualified for this task" },
    { cmd: "ok", desc: "Model was appropriate for this task" },
    { cmd: "under", desc: "Model was underqualified for this task" },
  ],
  workflow: [
    { cmd: "new", desc: "Create a new workflow definition" },
    { cmd: "run", desc: "Create a run and start auto-mode" },
    { cmd: "list", desc: "List workflow runs" },
    { cmd: "validate", desc: "Validate a workflow definition YAML" },
    { cmd: "pause", desc: "Pause custom workflow auto-mode" },
    { cmd: "resume", desc: "Resume paused custom workflow auto-mode" },
  ],
  codebase: [
    { cmd: "generate", desc: "Generate or regenerate CODEBASE.md" },
    { cmd: "generate --max-files", desc: "Generate with a custom file limit" },
    { cmd: "generate --collapse-threshold", desc: "Generate with a custom collapse threshold" },
    { cmd: "update", desc: "Incremental update that preserves descriptions" },
    { cmd: "update --max-files", desc: "Update with a custom file limit" },
    { cmd: "update --collapse-threshold", desc: "Update with a custom collapse threshold" },
    { cmd: "stats", desc: "Show file count and generation stats" },
    { cmd: "help", desc: "Show codebase command usage" },
  ],
  cmux: [
    { cmd: "status", desc: "Show cmux detection and capabilities" },
    { cmd: "on", desc: "Enable cmux integration" },
    { cmd: "off", desc: "Disable cmux integration" },
    { cmd: "notifications on", desc: "Enable cmux desktop notifications" },
    { cmd: "notifications off", desc: "Disable cmux desktop notifications" },
    { cmd: "sidebar on", desc: "Enable cmux sidebar metadata" },
    { cmd: "sidebar off", desc: "Disable cmux sidebar metadata" },
    { cmd: "splits on", desc: "Enable cmux visual subagent splits" },
    { cmd: "splits off", desc: "Disable cmux visual subagent splits" },
    { cmd: "browser on", desc: "Enable future browser integration flag" },
    { cmd: "browser off", desc: "Disable future browser integration flag" },
  ],
  undo: [
    { cmd: "--force", desc: "Skip confirmation prompt" },
  ],
};

function truncateChoiceLabel(label: string, maxLength = MAX_DISCORD_CHOICE_NAME_LENGTH): string {
  return label.length <= maxLength ? label : `${label.slice(0, maxLength - 1)}…`;
}

function toDiscordChoices(definitions: readonly GsdCommandDefinition[]): Array<{ name: string; value: string }> {
  return definitions.slice(0, MAX_DISCORD_AUTOCOMPLETE_CHOICES).map((entry) => ({
    name: truncateChoiceLabel(`${entry.cmd} — ${entry.desc}`),
    value: entry.cmd,
  }));
}

function uniqueDefinitions(definitions: readonly GsdCommandDefinition[]): GsdCommandDefinition[] {
  const seen = new Set<string>();
  const result: GsdCommandDefinition[] = [];

  for (const definition of definitions) {
    if (seen.has(definition.cmd)) {
      continue;
    }
    seen.add(definition.cmd);
    result.push(definition);
  }

  return result;
}

function normalizePrefix(prefix?: string | null): string {
  return (prefix ?? "").trimStart();
}

function defaultContext(context?: GsdAutocompleteContext): Required<GsdAutocompleteContext> {
  return {
    projectDir: resolve(context?.projectDir ?? process.env.GSD_PROJECT_DIR ?? process.cwd()),
    gsdHome: resolve(context?.gsdHome ?? process.env.GSD_HOME ?? join(homedir(), ".gsd")),
    cwd: resolve(context?.cwd ?? process.cwd()),
  };
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function readTemplateIds(context?: GsdAutocompleteContext): string[] {
  const { cwd } = defaultContext(context);
  const candidates = [
    join(cwd, "node_modules", "gsd-pi", "src", "resources", "extensions", "gsd", "workflow-templates", "registry.json"),
    join(cwd, "src", "resources", "extensions", "gsd", "workflow-templates", "registry.json"),
  ];

  for (const candidate of candidates) {
    const registry = readJsonFile(candidate);
    const templates = registry?.templates;
    if (templates && typeof templates === "object") {
      return Object.keys(templates);
    }
  }

  return [];
}

function readWorkflowDefinitionNames(context?: GsdAutocompleteContext): string[] {
  const { projectDir } = defaultContext(context);
  const defsDir = join(projectDir, ".gsd", "workflow-defs");

  try {
    if (!existsSync(defsDir)) {
      return [];
    }

    return readdirSync(defsDir)
      .filter((entry) => entry.endsWith(".yaml"))
      .map((entry) => entry.replace(/\.yaml$/, ""));
  } catch {
    return [];
  }
}

function readExtensionIds(context?: GsdAutocompleteContext): string[] {
  const { gsdHome } = defaultContext(context);
  const extDir = join(gsdHome, "agent", "extensions");
  const ids: string[] = [];

  try {
    if (!existsSync(extDir)) {
      return [];
    }

    for (const entry of readdirSync(extDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const manifest = readJsonFile(join(extDir, entry.name, "extension-manifest.json"));
      const id = typeof manifest?.id === "string" ? manifest.id : null;
      if (id) {
        ids.push(id);
      }
    }
  } catch {
    return [];
  }

  return ids;
}

function readMcpServerNames(context?: GsdAutocompleteContext): string[] {
  const { projectDir } = defaultContext(context);
  const seen = new Set<string>();
  const names: string[] = [];
  const configPaths = [
    join(projectDir, ".mcp.json"),
    join(projectDir, ".gsd", "mcp.json"),
  ];

  for (const configPath of configPaths) {
    const parsed = readJsonFile(configPath);
    const servers = (parsed?.mcpServers ?? parsed?.servers) as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== "object") {
      continue;
    }

    for (const name of Object.keys(servers)) {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

function buildPrefixedChoices(
  commandPrefix: string,
  descriptionPrefix: string,
  values: readonly string[],
  partial: string,
): GsdCommandDefinition[] {
  const normalizedPartial = partial.toLowerCase();
  return values
    .filter((value) => !normalizedPartial || value.toLowerCase().startsWith(normalizedPartial))
    .map((value) => ({
      cmd: `${commandPrefix}${value}`,
      desc: `${descriptionPrefix}${value}`,
    }));
}

function getDynamicArgChoices(
  command: string,
  rawPrefix: string,
  context?: GsdAutocompleteContext,
): GsdCommandDefinition[] {
  const lower = rawPrefix.toLowerCase();

  if (command === "templates" && lower.startsWith("info ")) {
    return buildPrefixedChoices("info ", "Show template info for ", readTemplateIds(context), rawPrefix.slice(5).trim());
  }

  if (command === "workflow") {
    if (lower.startsWith("run ")) {
      return buildPrefixedChoices("run ", "Run workflow definition ", readWorkflowDefinitionNames(context), rawPrefix.slice(4).trim());
    }
    if (lower.startsWith("validate ")) {
      return buildPrefixedChoices("validate ", "Validate workflow definition ", readWorkflowDefinitionNames(context), rawPrefix.slice(9).trim());
    }
  }

  if (command === "extensions") {
    if (lower.startsWith("enable ")) {
      return buildPrefixedChoices("enable ", "Enable extension ", readExtensionIds(context), rawPrefix.slice(7).trim());
    }
    if (lower.startsWith("disable ")) {
      return buildPrefixedChoices("disable ", "Disable extension ", readExtensionIds(context), rawPrefix.slice(8).trim());
    }
    if (lower.startsWith("info ")) {
      return buildPrefixedChoices("info ", "Show extension info for ", readExtensionIds(context), rawPrefix.slice(5).trim());
    }
  }

  if (command === "mcp" && lower.startsWith("check ")) {
    return buildPrefixedChoices("check ", "Check MCP server ", readMcpServerNames(context), rawPrefix.slice(6).trim());
  }

  return [];
}

export function getGsdAutocompleteChoices(prefix: string): Array<{ name: string; value: string }> {
  const normalized = prefix.trim().toLowerCase();
  return toDiscordChoices(
    GSD_TOP_LEVEL_COMMANDS.filter((entry) => !normalized || entry.cmd.startsWith(normalized)),
  );
}

export function getGsdArgsAutocompleteChoices(
  command?: string | null,
  prefix?: string | null,
  context?: GsdAutocompleteContext,
): Array<{ name: string; value: string }> {
  const normalizedCommand = command?.trim().toLowerCase() ?? "";
  if (!normalizedCommand) {
    return [];
  }

  const rawPrefix = normalizePrefix(prefix);
  const normalizedPrefix = rawPrefix.toLowerCase();
  const staticDefinitions = GSD_ARG_COMMANDS[normalizedCommand] ?? [];
  const staticMatches = staticDefinitions.filter((entry) => !normalizedPrefix || entry.cmd.startsWith(normalizedPrefix));
  const dynamicMatches = getDynamicArgChoices(normalizedCommand, rawPrefix, context);

  return toDiscordChoices(uniqueDefinitions([...dynamicMatches, ...staticMatches]));
}

export function buildGsdCommandInput(command?: string | null, args?: string | null): string {
  const normalizedCommand = command?.trim() ?? "";
  const normalizedArgs = args?.trim() ?? "";

  if (!normalizedCommand && !normalizedArgs) {
    return "/gsd";
  }

  if (!normalizedCommand && normalizedArgs) {
    throw new Error("A GSD command is required when passing args.");
  }

  return normalizedArgs
    ? `/gsd ${normalizedCommand} ${normalizedArgs}`
    : `/gsd ${normalizedCommand}`;
}
