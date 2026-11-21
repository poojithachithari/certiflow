// Certificate numbers, verification codes, download links, public verification and revocation.
//
// - Verification code = HMAC(secret, number). Printed on the certificate / in its QR code.
//   The public check needs number AND code, so nobody can walk sequential numbers to harvest data.
// - Download token = HMAC(secret, "download:" + id). Sent only to the candidate's WhatsApp.
//   Deterministic, so a retried delivery sends the SAME link; only its SHA-256 is stored.
// - Verification never uses a cache: a revoked certificate shows as revoked on the next check.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { User } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../lib/prisma";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { emitEvent, recordAudit } from "../lib/events";

const hmac = (input: string) => createHmac("sha256", config.CERT_SIGNING_SECRET).update(input).digest();

export function verificationCode(number: string): string {
  const hex = hmac(`verify:${number}`).toString("hex").slice(0, 10).toUpperCase();
  return `${hex.slice(0, 5)}-${hex.slice(5)}`;
}

export function downloadToken(certificateId: string): string {
  return hmac(`download:${certificateId}`).toString("base64url");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const verifyUrl = (number: string) => `${config.PUBLIC_BASE_URL}/verify?n=${encodeURIComponent(number)}&c=${verificationCode(number)}`;
export const downloadUrl = (certificateId: string) => `${config.PUBLIC_BASE_URL}/api/public/download/${downloadToken(certificateId)}`;

export const formatNumber = (seq: bigint | number, year = new Date().getUTCFullYear()) => `PSM-${year}-${seq}`;

/** "Ravi Kumar" -> "R*** K****": enough for an employer to match, not enough to identify. */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] + "*".repeat(Math.max(w.length - 1, 2)))
    .join(" ");
}

function codesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given.trim().toUpperCase());
  return a.length === b.length && timingSafeEqual(a, b); // constant time: no timing side channel
}

export type VerifyResult =
  | { result: "NOT_FOUND" }
  | {
      result: "VALID" | "REVOKED";
      number: string;
      holder: string;
      course: string;
      centre: string;
      issuedAt: Date;
      revokedAt: Date | null;
      revokeReason: string | null;
    };

export async function verifyCertificate(number: string, code: string): Promise<VerifyResult> {
  const n = number.trim().toUpperCase();
  // Same answer for "no such number" and "wrong code", so the endpoint can't be used to discover numbers.
  if (!/^PSM-\d{4}-\d{1,12}$/.test(n) || !codesMatch(verificationCode(n), code)) return { result: "NOT_FOUND" };
  const cert = await prisma.certificate.findUnique({
    where: { number: n },
    include: { batch: { include: { centre: true } } },
  });
  if (!cert) return { result: "NOT_FOUND" };
  return {
    result: cert.status === "VALID" ? "VALID" : "REVOKED",
    number: cert.number,
    holder: maskName(cert.holderName),
    course: cert.batch.courseName,
    centre: cert.batch.centre.name,
    issuedAt: cert.issuedAt,
    revokedAt: cert.revokedAt,
    revokeReason: cert.status === "REVOKED" ? cert.revokeReason : null,
  };
}

export async function revokeCertificate(actor: User, certificateId: string, reason: string, correlationId: string) {
  if (actor.role !== "STATE_OFFICE") throw forbidden("Only the state office can cancel certificates");
  if (!reason.trim()) throw badRequest("A reason is required to cancel a certificate");
  return prisma.$transaction(async (tx) => {
    // Conditional update: only flips VALID -> REVOKED once, even if two requests race.
    const { count } = await tx.certificate.updateMany({
      where: { id: certificateId, status: "VALID" },
      data: { status: "REVOKED", revokedAt: new Date(), revokedById: actor.id, revokeReason: reason.trim() },
    });
    const cert = await tx.certificate.findUnique({ where: { id: certificateId }, include: { batch: { include: { centre: true } } } });
    if (!cert) throw notFound("Certificate not found");
    if (count === 0) throw conflict("Certificate is already cancelled");
    await recordAudit(tx, { entityType: "certificate", entityId: cert.id, action: "revoked", actorId: actor.id, data: { reason, number: cert.number }, correlationId });
    await emitEvent(tx, "certificate.revoked", { batchId: cert.batchId, centreId: cert.batch.centreId, districtId: cert.batch.centre.districtId, certificateId: cert.id }, correlationId);
    return { id: cert.id, number: cert.number, status: "REVOKED" as const };
  });
}

export async function requestRedelivery(actor: User, certificateId: string, correlationId: string) {
  if (actor.role !== "STATE_OFFICE") throw forbidden("Only the state office can retry deliveries");
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.certificate.updateMany({
      where: { id: certificateId, deliveryStatus: "FAILED", status: "VALID" },
      data: { deliveryStatus: "PENDING", lastDeliveryError: null },
    });
    const cert = await tx.certificate.findUnique({ where: { id: certificateId }, include: { batch: { include: { centre: true } } } });
    if (!cert) throw notFound("Certificate not found");
    if (count === 0) throw conflict("Only failed deliveries of valid certificates can be retried");
    await recordAudit(tx, { entityType: "certificate", entityId: cert.id, action: "redelivery_requested", actorId: actor.id, correlationId });
    await emitEvent(tx, "certificate.redelivery_requested", { batchId: cert.batchId, centreId: cert.batch.centreId, districtId: cert.batch.centre.districtId, certificateId: cert.id }, correlationId);
    return { id: cert.id, deliveryStatus: "PENDING" as const };
  });
}
