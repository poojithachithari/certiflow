// Every state change records two things INSIDE the same DB transaction:
//  1. an AuditEvent  - the permanent, append-only "who did what, when" record
//  2. an OutboxEvent - the event other parts of the system react to (queue + realtime)
// Because both are in the same transaction as the change itself, either all three
// happen or none do. No "batch approved but certificates never issued" gaps.
import { Prisma } from "@prisma/client";
import type { Tx } from "./prisma";

export type EventType =
  | "batch.created"
  | "batch.candidates_uploaded"
  | "batch.submitted"
  | "batch.decision_recorded"
  | "batch.status_changed"
  | "batch.approved"
  | "batch.escalated"
  | "batch.issued"
  | "certificate.issued"
  | "certificate.delivered"
  | "certificate.delivery_failed"
  | "certificate.redelivery_requested"
  | "certificate.revoked";

/** Routing info carried on every event so realtime can deliver it only to people allowed to see it. */
export interface EventScope {
  batchId: string;
  centreId: string;
  districtId: string;
  certificateId?: string;
}

export async function recordAudit(
  tx: Tx,
  e: { entityType: "batch" | "certificate"; entityId: string; action: string; actorId: string | null; data?: unknown; correlationId: string },
) {
  await tx.auditEvent.create({
    data: {
      entityType: e.entityType,
      entityId: e.entityId,
      action: e.action,
      actorId: e.actorId,
      data: (e.data ?? undefined) as Prisma.InputJsonValue | undefined,
      correlationId: e.correlationId,
    },
  });
}

export async function emitEvent(tx: Tx, type: EventType, scope: EventScope, correlationId: string, extra: Record<string, unknown> = {}) {
  await tx.outboxEvent.create({
    data: {
      type,
      aggregateId: scope.certificateId ?? scope.batchId,
      payload: { ...scope, ...extra } as Prisma.InputJsonValue,
      correlationId,
    },
  });
}
