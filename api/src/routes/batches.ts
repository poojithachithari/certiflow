import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import type { Batch, User } from "@prisma/client";
import { requireRole, requireUser } from "../auth";
import { prisma } from "../lib/prisma";
import { badRequest, notFound } from "../lib/errors";
import { emitEvent, recordAudit } from "../lib/events";
import { visibleBatchesWhere } from "../domain/access";
import { REVIEW_STATUSES, STAGES, decide, submitBatch } from "../domain/workflow";
import { uploadCandidates } from "../domain/upload";

export const batchesRouter = Router();
batchesRouter.use(requireUser);

// In-memory upload, 2 MB cap: spreadsheets of <=1000 rows are tiny; anything bigger is a mistake or an attack.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

const maskPhone = (p: string) => p.slice(0, 3) + "******" + p.slice(-4);

/** Load a batch the user is allowed to see, or 404 (we don't reveal that other batches exist). */
async function findVisibleBatch(user: User, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Batch not found");
  const batch = await prisma.batch.findFirst({ where: { AND: [{ id }, visibleBatchesWhere(user)] }, include: { centre: { include: { district: true } } } });
  if (!batch) throw notFound("Batch not found");
  return batch;
}

/** Rejections in the current round that were outvoted: shown so the next reviewer can't miss them. */
function dissentOf(batch: { status: string; round: number }, decisions: { round: number; action: string; stage: string; reason: string | null; actor: { name: string } }[]) {
  if (batch.status === "REJECTED") return []; // the rejection won; nothing was overruled
  return decisions
    .filter((d) => d.round === batch.round && d.action === "REJECT")
    .map((d) => ({ actor: d.actor.name, stage: d.stage, reason: d.reason }));
}

function awaitingUser(user: User, batch: Batch & { centre: { districtId: string } }, votedThisStage: boolean) {
  const rule = STAGES[batch.status];
  if (!rule || rule.ownerRole !== user.role || votedThisStage) return false;
  return rule.stage !== "DISTRICT" || user.districtId === batch.centre.districtId;
}

batchesRouter.get("/batches", async (req, res) => {
  const user = req.user!;
  const batches = await prisma.batch.findMany({
    where: visibleBatchesWhere(user),
    include: { centre: { include: { district: true } }, _count: { select: { candidates: true, certificates: true } }, decisions: { include: { actor: { select: { name: true } } } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  res.json(
    batches.map((b) => {
      const rule = STAGES[b.status];
      const current = b.decisions.filter((d) => d.round === b.round && rule && d.stage === rule.stage);
      return {
        id: b.id,
        title: b.title,
        courseCode: b.courseCode,
        courseName: b.courseName,
        status: b.status,
        round: b.round,
        centre: b.centre.name,
        district: b.centre.district.name,
        candidates: b._count.candidates,
        certificates: b._count.certificates,
        stageEnteredAt: b.stageEnteredAt,
        escalatedAt: b.escalatedAt,
        lastReason: b.lastReason,
        approvals: current.filter((d) => d.action === "APPROVE").length,
        approvalsNeeded: rule?.quorum.APPROVE ?? null,
        awaitingMe: awaitingUser(user, b, current.some((d) => d.actorId === user.id)),
        dissent: dissentOf(b, b.decisions).length,
        updatedAt: b.updatedAt,
      };
    }),
  );
});

batchesRouter.post("/batches", requireRole("CENTRE"), async (req, res) => {
  const body = z
    .object({
      title: z.string().trim().min(3).max(120),
      courseCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/, "Course code: 2-20 letters, digits or dashes"),
      courseName: z.string().trim().min(3).max(120),
    })
    .parse(req.body);
  const user = req.user!;
  const batch = await prisma.$transaction(async (tx) => {
    const centre = await tx.centre.findUniqueOrThrow({ where: { id: user.centreId! } });
    const b = await tx.batch.create({ data: { ...body, centreId: centre.id } });
    await recordAudit(tx, { entityType: "batch", entityId: b.id, action: "created", actorId: user.id, data: body, correlationId: req.correlationId });
    await emitEvent(tx, "batch.created", { batchId: b.id, centreId: centre.id, districtId: centre.districtId }, req.correlationId);
    return b;
  });
  res.status(201).json(batch);
});

batchesRouter.get("/batches/:id", async (req, res) => {
  const user = req.user!;
  const batch = await findVisibleBatch(user, req.params.id);
  const [candidates, decisions] = await Promise.all([
    prisma.candidate.findMany({ where: { batchId: batch.id }, orderBy: { rowNumber: "asc" }, include: { certificate: { select: { number: true, status: true, deliveryStatus: true } } } }),
    prisma.decision.findMany({ where: { batchId: batch.id }, orderBy: { createdAt: "asc" }, include: { actor: { select: { name: true, role: true } } } }),
  ]);
  const ownCentre = user.role === "CENTRE";
  const rule = STAGES[batch.status];
  const current = decisions.filter((d) => d.round === batch.round && rule && d.stage === rule.stage);
  res.json({
    ...batch,
    centre: { id: batch.centre.id, name: batch.centre.name, district: batch.centre.district.name },
    stage: rule ? { stage: rule.stage, ownerRole: rule.ownerRole, quorum: rule.quorum } : null,
    awaitingMe: awaitingUser(user, batch, current.some((d) => d.actorId === user.id)),
    dissent: dissentOf(batch, decisions),
    candidates: candidates.map((c) => ({
      id: c.id,
      rowNumber: c.rowNumber,
      enrolmentNo: c.enrolmentNo,
      name: c.name,
      // Data minimisation: reviewers don't need full phone numbers or birth dates.
      phone: ownCentre ? c.phone : maskPhone(c.phone),
      dateOfBirth: ownCentre ? c.dateOfBirth : null,
      score: c.score,
      certificate: c.certificate,
    })),
    decisions: decisions.map((d) => ({ id: d.id, round: d.round, stage: d.stage, action: d.action, reason: d.reason, actor: d.actor.name, actorRole: d.actor.role, createdAt: d.createdAt, counts: d.round === batch.round })),
  });
});

batchesRouter.put("/batches/:id/candidates", requireRole("CENTRE"), upload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("Attach the spreadsheet as form field 'file'");
  await findVisibleBatch(req.user!, req.params.id as string);
  const result = await uploadCandidates(req.user!, req.params.id as string, req.file, req.correlationId);
  res.json(result);
});

batchesRouter.post("/batches/:id/submit", requireRole("CENTRE"), async (req, res) => {
  await findVisibleBatch(req.user!, req.params.id as string);
  res.json(await submitBatch(req.user!, req.params.id as string, req.correlationId));
});

batchesRouter.post("/batches/:id/decisions", requireRole("DISTRICT_OFFICER", "QUALITY", "STATE_OFFICE"), async (req, res) => {
  const body = z.object({ action: z.enum(["APPROVE", "REJECT", "SEND_BACK"]), reason: z.string().max(1000).optional() }).parse(req.body);
  await findVisibleBatch(req.user!, req.params.id as string);
  res.json(await decide(req.user!, req.params.id as string, body.action, body.reason, req.correlationId));
});

/** End-to-end trace: every audit entry for the batch and its certificates, oldest first. */
batchesRouter.get("/batches/:id/timeline", async (req, res) => {
  const batch = await findVisibleBatch(req.user!, req.params.id as string);
  const certIds = (await prisma.certificate.findMany({ where: { batchId: batch.id }, select: { id: true } })).map((c) => c.id);
  const events = await prisma.auditEvent.findMany({
    where: { OR: [{ entityType: "batch", entityId: batch.id }, { entityType: "certificate", entityId: { in: certIds } }] },
    orderBy: { id: "asc" },
    take: 1000,
  });
  const actors = new Map((await prisma.user.findMany({ select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  res.json(events.map((e) => ({ id: e.id.toString(), at: e.createdAt, entityType: e.entityType, entityId: e.entityId, action: e.action, actor: e.actorId ? actors.get(e.actorId) ?? e.actorId : "system", data: e.data, correlationId: e.correlationId })));
});

/** State office: what is stuck, oldest first. */
batchesRouter.get("/stuck", requireRole("STATE_OFFICE"), async (_req, res) => {
  const batches = await prisma.batch.findMany({
    where: { status: { in: REVIEW_STATUSES } },
    include: { centre: { include: { district: true } } },
    orderBy: { stageEnteredAt: "asc" },
  });
  res.json(batches.map((b) => ({ id: b.id, title: b.title, status: b.status, centre: b.centre.name, district: b.centre.district.name, stageEnteredAt: b.stageEnteredAt, escalatedAt: b.escalatedAt, waitingMinutes: Math.round((Date.now() - b.stageEnteredAt.getTime()) / 60000) })));
});
