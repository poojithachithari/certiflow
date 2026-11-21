// Worker process entrypoint: outbox relay + queue processors + SLA scheduler.
// Run as many replicas as needed; every piece is safe to run concurrently and to crash mid-job
// (BullMQ re-queues "stalled" jobs whose worker died; every job is idempotent).
import { Worker } from "bullmq";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { createRedis } from "./lib/redis";
import { DELIVERY_ATTEMPTS, QUEUE, createQueues } from "./jobs/queues";
import { startOutboxRelay } from "./jobs/outboxRelay";
import { issueCertificatesForBatch } from "./jobs/issuance";
import { deliverCertificate, markDeliveryFailed } from "./jobs/delivery";
import { escalateStuckBatches } from "./jobs/sla";

const connection = createRedis();
const queues = createQueues(connection);
const stopRelay = startOutboxRelay(queues, connection);

const issuanceWorker = new Worker(
  QUEUE.issuance,
  async (job) => {
    const r = await issueCertificatesForBatch(job.data.batchId, job.data.correlationId);
    logger.info({ batchId: job.data.batchId, correlationId: job.data.correlationId, ...r }, "issuance done");
    return r;
  },
  { connection: createRedis(), concurrency: 2 },
);

const deliveryWorker = new Worker(
  QUEUE.delivery,
  async (job) => deliverCertificate(job.data.certificateId, job.data.correlationId, job.attemptsMade + 1),
  // concurrency: parallel sends per worker. limiter: stay under the provider's rate limit across ALL workers.
  { connection: createRedis(), concurrency: 10, limiter: { max: 50, duration: 1000 } },
);
deliveryWorker.on("failed", (job, err) => {
  if (!job) return;
  const exhausted = job.attemptsMade >= (job.opts.attempts ?? DELIVERY_ATTEMPTS) || err.name === "UnrecoverableError";
  if (exhausted) void markDeliveryFailed(job.data.certificateId, job.data.correlationId, err.message).catch((e) => logger.error({ err: e }, "markDeliveryFailed failed"));
});

const maintenanceWorker = new Worker(
  QUEUE.maintenance,
  async () => {
    const escalated = await escalateStuckBatches();
    if (escalated.length) logger.info({ escalated }, "batches escalated");
    return { escalated: escalated.length };
  },
  { connection: createRedis(), concurrency: 1 },
);
// upsert = one schedule shared by all replicas (not one per worker).
void queues.maintenance.upsertJobScheduler("sla-check", { every: 30_000 }, { name: "sla-check" });

for (const w of [issuanceWorker, deliveryWorker, maintenanceWorker]) w.on("error", (err) => logger.error({ err, queue: w.name }, "worker error"));
logger.info("worker started");

async function shutdown(signal: string) {
  logger.info({ signal }, "worker shutting down");
  stopRelay();
  // close() waits for in-flight jobs to finish; anything cut off is re-queued as stalled.
  await Promise.allSettled([issuanceWorker.close(), deliveryWorker.close(), maintenanceWorker.close()]);
  await Promise.allSettled([prisma.$disconnect(), connection.quit()]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
