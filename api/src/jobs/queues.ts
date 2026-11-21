// Queue definitions. Each queue isolates one kind of work so it can be scaled and tuned separately:
//  - issuance: create certificates for an approved batch (fast, DB-bound)
//  - delivery: PDF + WhatsApp per certificate (slow, unreliable -> many retries)
//  - maintenance: scheduled SLA check
import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";

export const QUEUE = { issuance: "issuance", delivery: "delivery", maintenance: "maintenance" } as const;

export const DELIVERY_ATTEMPTS = 8;

export const jobDefaults: Record<keyof typeof QUEUE, JobsOptions> = {
  issuance: { attempts: 5, backoff: { type: "exponential", delay: 1000 }, removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
  // 2s, 4s, 8s ... ~4 min total before a delivery is marked FAILED for manual retry.
  delivery: { attempts: DELIVERY_ATTEMPTS, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
  maintenance: { removeOnComplete: true, removeOnFail: 100 },
};

export function createQueues(connection: Redis) {
  return {
    issuance: new Queue(QUEUE.issuance, { connection, defaultJobOptions: jobDefaults.issuance }),
    delivery: new Queue(QUEUE.delivery, { connection, defaultJobOptions: jobDefaults.delivery }),
    maintenance: new Queue(QUEUE.maintenance, { connection, defaultJobOptions: jobDefaults.maintenance }),
  };
}
export type Queues = ReturnType<typeof createQueues>;
