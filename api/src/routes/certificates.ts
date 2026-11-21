import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import { requireRole, requireUser } from "../auth";
import { config } from "../config";
import { prisma } from "../lib/prisma";
import { HttpError, notFound } from "../lib/errors";
import { rateLimit } from "../lib/rateLimit";
import { requestRedelivery, revokeCertificate, sha256, verifyCertificate } from "../domain/certificates";

export function certificatesRouter() {
  const r = Router();
  r.use(requireUser);

  r.get("/certificates", async (req, res) => {
    const user = req.user!;
    const where: Prisma.CertificateWhereInput =
      user.role === "CENTRE" ? { batch: { centreId: user.centreId! } } : user.role === "DISTRICT_OFFICER" ? { batch: { centre: { districtId: user.districtId! } } } : {};
    const batchId = typeof req.query.batchId === "string" ? req.query.batchId : undefined;
    const certs = await prisma.certificate.findMany({
      where: { AND: [where, batchId ? { batchId } : {}] },
      include: { batch: { select: { title: true, courseName: true } } },
      orderBy: { number: "desc" },
      take: 500,
    });
    res.json(
      certs.map((c) => ({
        id: c.id,
        number: c.number,
        holderName: c.holderName,
        enrolmentNo: c.enrolmentNo,
        course: c.batch.courseName,
        batch: c.batch.title,
        batchId: c.batchId,
        status: c.status,
        issuedAt: c.issuedAt,
        revokedAt: c.revokedAt,
        revokeReason: c.revokeReason,
        deliveryStatus: c.deliveryStatus,
        deliveryAttempts: c.deliveryAttempts,
        lastDeliveryError: c.lastDeliveryError,
      })),
    );
  });

  r.post("/certificates/:id/revoke", requireRole("STATE_OFFICE"), async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    res.json(await revokeCertificate(req.user!, req.params.id as string, reason, req.correlationId));
  });

  r.post("/certificates/:id/retry-delivery", requireRole("STATE_OFFICE"), async (req, res) => {
    res.json(await requestRedelivery(req.user!, req.params.id as string, req.correlationId));
  });

  return r;
}

/** No-login endpoints for employers/public and candidates. */
export function publicRouter(redis: Redis) {
  const r = Router();

  r.get("/public/verify", rateLimit(redis, { name: "verify", limit: 30, windowSeconds: 60 }), async (req, res) => {
    const q = z.object({ number: z.string().max(40), code: z.string().max(20) }).safeParse(req.query);
    if (!q.success) return res.json({ result: "NOT_FOUND" });
    res.setHeader("Cache-Control", "no-store"); // never let a proxy cache a "VALID" answer
    res.json(await verifyCertificate(q.data.number, q.data.code));
  });

  // The secret link from the candidate's WhatsApp message.
  r.get("/public/download/:token", rateLimit(redis, { name: "download", limit: 30, windowSeconds: 60 }), async (req, res) => {
    const token = String(req.params.token);
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound("Certificate not found");
    const cert = await prisma.certificate.findUnique({ where: { downloadTokenHash: sha256(token) } });
    if (!cert) throw notFound("Certificate not found");
    if (cert.status === "REVOKED") throw new HttpError(410, "REVOKED", "This certificate has been cancelled by the state office.");
    if (!cert.pdfPath) throw new HttpError(404, "NOT_READY", "The certificate is still being prepared. Try again in a minute.");
    // Path comes from our own DB, but still confirm it is inside the storage dir.
    const root = path.resolve(config.CERT_STORAGE_DIR);
    const file = path.resolve(root, cert.pdfPath);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) throw notFound("Certificate file not found");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${cert.number}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    fs.createReadStream(file).pipe(res);
  });

  return r;
}
