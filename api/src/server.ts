// API process entrypoint. Stateless: any number of copies can run behind a load balancer.
import { createApp } from "./app";
import { config } from "./config";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { createRedis } from "./lib/redis";
import { startRealtimeFanout } from "./lib/realtime";

const redis = createRedis();
const subscriber = createRedis(); // a subscribed Redis connection can't run other commands
startRealtimeFanout(subscriber);

const server = createApp(redis).listen(config.PORT, () => logger.info({ port: config.PORT }, "api listening"));

// Graceful shutdown: stop taking requests, let in-flight ones finish, close connections.
async function shutdown(signal: string) {
  logger.info({ signal }, "api shutting down");
  server.close();
  server.closeAllConnections?.();
  await Promise.allSettled([prisma.$disconnect(), redis.quit(), subscriber.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
