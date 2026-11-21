// SLA escalation: find batches sitting at one review stage longer than SLA_MINUTES.
// One atomic UPDATE ... WHERE "escalatedAt" IS NULL ... RETURNING marks them, so even with many
// workers running this at once, each stuck batch is escalated exactly once per stage.
// (escalatedAt is cleared whenever the batch changes stage - see workflow.transition.)
import { prisma } from "../lib/prisma";
import { config } from "../config";
import { emitEvent, recordAudit } from "../lib/events";
import { REVIEW_STATUSES } from "../domain/workflow";
import { randomUUID } from "node:crypto";

export async function escalateStuckBatches(now = new Date(), slaMinutes = config.SLA_MINUTES) {
  const cutoff = new Date(now.getTime() - slaMinutes * 60_000);
  const correlationId = randomUUID();
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; status: string; stageEnteredAt: Date; centreId: string; districtId: string }[]>`
      UPDATE "Batch" b SET "escalatedAt" = ${now}
      FROM "Centre" c
      WHERE b."centreId" = c.id
        AND b."escalatedAt" IS NULL
        AND b.status::text = ANY(${REVIEW_STATUSES}::text[])
        AND b."stageEnteredAt" < ${cutoff}
      RETURNING b.id, b.status::text AS status, b."stageEnteredAt", b."centreId", c."districtId"`;
    for (const b of rows) {
      const waitingMinutes = Math.round((now.getTime() - b.stageEnteredAt.getTime()) / 60_000);
      await recordAudit(tx, { entityType: "batch", entityId: b.id, action: "escalated", actorId: null, data: { status: b.status, waitingMinutes, slaMinutes }, correlationId });
      await emitEvent(tx, "batch.escalated", { batchId: b.id, centreId: b.centreId, districtId: b.districtId }, correlationId, { status: b.status, waitingMinutes });
    }
    return rows.map((r) => r.id);
  });
}
