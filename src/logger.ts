import type { LogLevel } from "./config.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export class Logger {
  constructor(private readonly level: LogLevel) {}

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }

    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(data ? { data } : {}),
    };

    const serialized = JSON.stringify(entry);
    if (level === "error" || level === "warn") {
      process.stderr.write(`${serialized}\n`);
      return;
    }

    process.stdout.write(`${serialized}\n`);
  }
}
