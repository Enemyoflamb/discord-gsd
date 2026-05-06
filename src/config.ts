import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  discordBotToken: string;
  discordGuildId: string;
  discordOwnerId: string;
  discordParentChannelId: string;
  gsdProjectDir: string;
  gsdCliPath?: string;
  gsdModel?: string;
  gsdHome?: string;
  gsdBare: boolean;
  discordMessageChunkSize: number;
  logLevel: LogLevel;
}

const VALID_LOG_LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error"]);

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function booleanEnv(name: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function integerEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const value = env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer for ${name}: ${value}`);
  }

  return parsed;
}

function logLevelEnv(env: NodeJS.ProcessEnv): LogLevel {
  const value = env.LOG_LEVEL?.trim().toLowerCase();
  if (!value) {
    return "info";
  }
  if (!VALID_LOG_LEVELS.has(value as LogLevel)) {
    throw new Error(`Invalid LOG_LEVEL: ${value}`);
  }
  return value as LogLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const gsdProjectDir = resolve(required("GSD_PROJECT_DIR", env));
  if (!existsSync(gsdProjectDir)) {
    throw new Error(`GSD_PROJECT_DIR does not exist: ${gsdProjectDir}`);
  }

  const gsdCliPath = optional("GSD_CLI_PATH", env);
  if (gsdCliPath && !existsSync(gsdCliPath)) {
    throw new Error(`GSD_CLI_PATH does not exist: ${gsdCliPath}`);
  }

  const config: AppConfig = {
    discordBotToken: required("DISCORD_BOT_TOKEN", env),
    discordGuildId: required("DISCORD_GUILD_ID", env),
    discordOwnerId: required("DISCORD_OWNER_ID", env),
    discordParentChannelId: required("DISCORD_PARENT_CHANNEL_ID", env),
    gsdProjectDir,
    gsdBare: booleanEnv("GSD_BARE", false, env),
    discordMessageChunkSize: integerEnv("DISCORD_MESSAGE_CHUNK_SIZE", 1500, env),
    logLevel: logLevelEnv(env),
  };

  if (gsdCliPath) {
    config.gsdCliPath = gsdCliPath;
  }

  const gsdModel = optional("GSD_MODEL", env);
  if (gsdModel) {
    config.gsdModel = gsdModel;
  }

  const gsdHome = optional("GSD_HOME", env);
  if (gsdHome) {
    config.gsdHome = gsdHome;
  }

  return config;
}
