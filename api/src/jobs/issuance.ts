// Issue certificates for an approved batch - idempotent.
//
// Runs in one transaction with the batch row locked:
//  - if the batch is no longer APPROVED, it was already issued -> do nothing (safe to run twice)
//  - numbers come from a Postgres sequence (atomic across all workers)
//  - createMany(skipDuplicates) + unique constraints mean a candidate can never get two certificates
//  - one "certificate.issued" outbox event per certificate triggers delivery
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { emitEvent, recordAudit } from "../lib/events";
import { lockBatch, scopeOf } from "../domain/workflow";
import { downloadToken, formatNumber, sha256 } from "../domain/certificates";

export async function issueCertificatesForBatch(batchId: string, correlationId: string) {
  return prisma.$transaction(
    async (tx) => {
      const batch = await lockBatch(tx, batchId);
      if (batch.status !== "APPROVED") {
        logger.info({ batchId, status: batch.status, correlationId }, "issuance skipped: batch not in APPROVED (already issued?)");
        return { issued: 0, skipped: true };
      }

      const candidates = await tx.candidate.findMany({ where: { batchId, certificate: null }, orderBy: { rowNumber: "asc" } });
      let created: { id: string; candidateId: string; number: string }[] = [];
      if (candidates.length) {
        const seqs = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('certificate_number_seq') AS n FROM generate_series(1, ${candidates.length})`;
        const rows = candidates.map((c, i) => {
          const id = crypto.randomUUID();
          return {
            id,
            number: formatNumber(seqs[i].n),
            candidateId: c.id,
            batchId,
            enrolmentNo: c.enrolmentNo,
            courseCode: batch.courseCode,
            holderName: c.name,
            downloadTokenHash: sha256(downloadToken(id)),
          };
        });
        await tx.certificate.createMany({ data: rows, skipDuplicates: true });
        // Re-read what actually got inserted (skipDuplicates may have skipped a person already certified elsewhere).
        created = await tx.certificate.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, candidateId: true, number: true } });
        const skipped = rows.filter((r) => !created.some((c) => c.id === r.id));
        for (const s of skipped) {
          await recordAudit(tx, { entityType: "batch", entityId: batchId, action: "certificate_skipped_duplicate", actorId: null, data: { enrolmentNo: s.enrolmentNo }, correlationId });
        }
      }

      for (const c of created) {
        await recordAudit(tx, { entityType: "certificate", entityId: c.id, action: "issued", actorId: null, data: { number: c.number, batchId }, correlationId });
        await emitEvent(tx, "certificate.issued", { ...scopeOf(batch), certificateId: c.id }, correlationId);
      }
      await tx.batch.update({ where: { id: batchId }, data: { status: "ISSUED", stageEnteredAt: new Date() } });
      await recordAudit(tx, { entityType: "batch", entityId: batchId, action: "status:APPROVED->ISSUED", actorId: null, data: { issued: created.length }, correlationId });
      await emitEvent(tx, "batch.issued", scopeOf(batch), correlationId, { issued: created.length });
      return { issued: created.length, skipped: false };
    },
    { timeout: 30_000 },
  );
}
