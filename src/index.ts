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

  const shutdown = async (signal: string) => {
    logger.info("shutdown requested", { signal });
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
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
