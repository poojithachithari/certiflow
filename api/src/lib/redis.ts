import { Redis } from "ioredis";
import { config } from "../config";

// BullMQ requires maxRetriesPerRequest: null so blocking queue commands survive reconnects
// (e.g. during a Redis restart) instead of throwing.
export function createRedis(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}
