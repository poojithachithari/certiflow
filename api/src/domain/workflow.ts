// The batch workflow as a state machine.
//
// STAGES is the single table of rules: which status is a review stage, which role owns it,
// how many votes each action needs, and where an approval leads. Every decision goes through
// decide(), which runs in ONE transaction holding a row lock on the batch, so two officers
// clicking at the same instant are processed one after the other (never "moves forward twice").
import type { Batch, BatchStatus, DecisionAction, Role, Stage, User } from "@prisma/client";
import { config } from "../config";
import { prisma, type Tx } from "../lib/prisma";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { emitEvent, recordAudit, type EventScope } from "../lib/events";

interface StageRule {
  stage: Stage;
  ownerRole: Role;
  /** votes required for each action to take effect */
  quorum: Record<DecisionAction, number>;
  /** status after the stage approves */
  onApprove: (candidateCount: number) => BatchStatus;
}

export const STAGES: Partial<Record<BatchStatus, StageRule>> = {
  DISTRICT_REVIEW: {
    stage: "DISTRICT",
    ownerRole: "DISTRICT_OFFICER",
    // Approve/reject need DISTRICT_QUORUM different officers. Send-back needs one:
    // asking for a fix is reversible and should not wait for a second officer.
    quorum: { APPROVE: config.DISTRICT_QUORUM, REJECT: config.DISTRICT_QUORUM, SEND_BACK: 1 },
    onApprove: (n) => (n > config.QUALITY_REVIEW_THRESHOLD ? "QUALITY_REVIEW" : "STATE_REVIEW"),
  },
  QUALITY_REVIEW: {
    stage: "QUALITY",
    ownerRole: "QUALITY",
    quorum: { APPROVE: 1, REJECT: 1, SEND_BACK: 1 },
    onApprove: () => "STATE_REVIEW",
  },
  STATE_REVIEW: {
    stage: "STATE",
    ownerRole: "STATE_OFFICE",
    quorum: { APPROVE: 1, REJECT: 1, SEND_BACK: 1 },
    onApprove: () => "APPROVED",
  },
};

export const REVIEW_STATUSES = Object.keys(STAGES) as BatchStatus[];

/** Lock the batch row for the rest of the transaction. Concurrent callers wait here. */
export async function lockBatch(tx: Tx, batchId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Batch" WHERE id = ${batchId} FOR UPDATE`;
  if (rows.length === 0) throw notFound("Batch not found");
  return tx.batch.findUniqueOrThrow({
    where: { id: batchId },
    include: { centre: true, _count: { select: { candidates: true } } },
  });
}

export function scopeOf(batch: Batch & { centre: { districtId: string } }): EventScope {
  return { batchId: batch.id, centreId: batch.centreId, districtId: batch.centre.districtId };
}

/** Status change + its audit entry + its event, always together. */
async function transition(tx: Tx, batch: Batch & { centre: { districtId: string } }, to: BatchStatus, actorId: string | null, correlationId: string, data: Record<string, unknown> = {}) {
  await tx.batch.update({
    where: { id: batch.id },
    data: { status: to, stageEnteredAt: new Date(), escalatedAt: null, ...("reason" in data ? { lastReason: data.reason as string } : {}) },
  });
  await recordAudit(tx, { entityType: "batch", entityId: batch.id, action: `status:${batch.status}->${to}`, actorId, data, correlationId });
  await emitEvent(tx, "batch.status_changed", scopeOf(batch), correlationId, { from: batch.status, to });
  if (to === "APPROVED") await emitEvent(tx, "batch.approved", scopeOf(batch), correlationId, { round: batch.round });
}

export async function submitBatch(actor: User, batchId: string, correlationId: string) {
  return prisma.$transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (actor.role !== "CENTRE" || actor.centreId !== batch.centreId) throw forbidden("Only the batch's own centre can submit it");
    if (batch.status !== "DRAFT" && batch.status !== "SENT_BACK") throw conflict(`Batch is ${batch.status} and cannot be submitted`);
    if (batch._count.candidates === 0) throw badRequest("Upload candidates before submitting");

    // DECISION (moment 6): a resubmission starts a new round. Votes from earlier rounds stay in
    // history but no longer count, because they approved a candidate list that may have changed.
    const round = batch.round + 1;
    await tx.batch.update({ where: { id: batch.id }, data: { round } });
    await recordAudit(tx, { entityType: "batch", entityId: batch.id, action: "submitted", actorId: actor.id, data: { round, candidates: batch._count.candidates }, correlationId });
    await emitEvent(tx, "batch.submitted", scopeOf(batch), correlationId, { round });
    await transition(tx, batch, "DISTRICT_REVIEW", actor.id, correlationId, { round });
    return { status: "DISTRICT_REVIEW" as const, round };
  });
}

export async function decide(actor: User, batchId: string, action: DecisionAction, reason: string | undefined, correlationId: string) {
  if (action !== "APPROVE" && !reason?.trim()) throw badRequest("A reason is required to reject or send back");

  return prisma.$transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    const rule = STAGES[batch.status];
    if (!rule) throw conflict(`Batch is ${batch.status}, not waiting for a review decision`);

    // Is this step theirs? Right role for the stage, and for districts, the right district.
    if (actor.role !== rule.ownerRole) throw forbidden(`This batch is waiting for ${rule.ownerRole}, not ${actor.role}`);
    if (rule.stage === "DISTRICT" && actor.districtId !== batch.centre.districtId) throw forbidden("This batch belongs to another district");

    const already = await tx.decision.findUnique({
      where: { batchId_round_stage_actorId: { batchId, round: batch.round, stage: rule.stage, actorId: actor.id } },
    });
    if (already) throw conflict(`You already recorded ${already.action} for this batch at this stage`);

    await tx.decision.create({ data: { batchId, round: batch.round, stage: rule.stage, actorId: actor.id, action, reason: reason?.trim() } });
    await recordAudit(tx, { entityType: "batch", entityId: batchId, action: `decision:${action}`, actorId: actor.id, data: { stage: rule.stage, round: batch.round, reason }, correlationId });

    const votes = await tx.decision.count({ where: { batchId, round: batch.round, stage: rule.stage, action } });
    const needed = rule.quorum[action];
    await emitEvent(tx, "batch.decision_recorded", scopeOf(batch), correlationId, { action, votes, needed, actorId: actor.id });

    let status: BatchStatus = batch.status;
    if (votes >= needed) {
      status = action === "APPROVE" ? rule.onApprove(batch._count.candidates) : action === "REJECT" ? "REJECTED" : "SENT_BACK";
      await transition(tx, batch, status, actor.id, correlationId, reason ? { reason } : {});
    }
    return { status, votes, needed, moved: status !== batch.status };
  });
}
