// Outbox relay: moves committed events from Postgres to the queues and to live updates.
//
// Why: writing to the DB and then to Redis is two separate writes; a crash in between would
// lose the event ("batch approved but no certificates ever issued"). Instead the API writes
// the event row in the SAME transaction as the change, and this relay publishes it afterwards.
//
// Safe with many workers: FOR UPDATE SKIP LOCKED gives each relay different rows.
// Safe on crash: if we die after queue.add but before marking published, the row is re-sent,
// and the fixed jobId makes BullMQ ignore the duplicate (and every job is idempotent anyway).
import type { Redis } from "ioredis";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { CHANNEL } from "../lib/realtime";
import type { Queues } from "./queues";

interface OutboxRow {
  id: bigint;
  type: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId: string;
}

export async function relayOnce(queues: Queues, redis: Redis, batchSize = 200): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT id, type, "aggregateId", payload, "correlationId" FROM "OutboxEvent"
      WHERE "publishedAt" IS NULL ORDER BY id LIMIT ${batchSize} FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;

    for (const row of rows) {
      const data = { ...row.payload, eventId: row.id.toString(), correlationId: row.correlationId };
      switch (row.type) {
        case "batch.approved":
          await queues.issuance.add("issue", data, { jobId: `issue-${row.aggregateId}` });
          break;
        case "certificate.issued":
          await queues.delivery.add("deliver", data, { jobId: `deliver-${row.aggregateId}` });
          break;
        case "certificate.redelivery_requested":
          // New job id per request (the first job already finished), still deduped per request.
          await queues.delivery.add("deliver", data, { jobId: `deliver-${row.aggregateId}-retry-${row.id}` });
          break;
      }
      // Live updates are best-effort: a missed one is fixed by the next refetch.
      await redis.publish(CHANNEL, JSON.stringify({ type: row.type, ...row.payload })).catch(() => undefined);
    }
    await tx.$executeRaw`UPDATE "OutboxEvent" SET "publishedAt" = now() WHERE id = ANY(${rows.map((r) => r.id)}::bigint[])`;
    return rows.length;
  });
}

export function startOutboxRelay(queues: Queues, redis: Redis, intervalMs = 500) {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        const n = await relayOnce(queues, redis);
        if (n > 0) logger.debug({ n }, "outbox relayed");
        if (n === 0) await new Promise((r) => setTimeout(r, intervalMs));
      } catch (err) {
        // DB or Redis unavailable: back off and retry; unpublished rows stay in the outbox.
        logger.warn({ err }, "outbox relay failed, retrying");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
