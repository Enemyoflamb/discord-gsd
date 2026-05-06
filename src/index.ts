import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { SessionController } from "./session-controller.js";
import { DiscordGsdService } from "./service.js";

function loadDotEnvIfPresent(): void {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  process.loadEnvFile(envPath);
}

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const config = loadConfig();
  const logger = new Logger(config.logLevel);
  logger.info("starting discord-gsd", {
    guildId: config.discordGuildId,
    parentChannelId: config.discordParentChannelId,
    gsdProjectDir: config.gsdProjectDir,
  });
  const controller = new SessionController(config, logger);
  const service = new DiscordGsdService(config, logger, controller);

  // Ensure GSD child processes are cleaned up on ANY exit path —
  // signals, uncaught exceptions, unhandled rejections.
  const shutdown = async (signal: string) => {
    logger.info("shutdown requested", { signal });
    await service.stop().catch(() => {});
    process.exit(0);
  };

  const crashShutdown = async (reason: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${reason}: ${message}`);
    await controller.shutdown().catch(() => {});
    process.exit(1);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("uncaughtException", (error) => {
    void crashShutdown("uncaught exception", error);
  });
  process.on("unhandledRejection", (error) => {
    void crashShutdown("unhandled rejection", error);
  });

  await service.start();
}

main().catch((error) => {
  let message = error instanceof Error ? error.message : String(error);
  if (message.includes("Used disallowed intents")) {
    message = "Used disallowed intents — enable Message Content Intent for the Discord bot in the Discord Developer Portal.";
  }
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", message })}\n`);
  process.exit(1);
});
