// Deliver one certificate: make the PDF (if missing), send it on WhatsApp, record the result.
// Idempotent end to end: already SENT -> no-op; PDF exists -> reused; send -> idempotency key.
import { UnrecoverableError } from "bullmq";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import { emitEvent, recordAudit } from "../lib/events";
import { ProviderError, sendCertificateMessage } from "../lib/whatsapp";
import { ensureCertificatePdf } from "../domain/pdf";
import { downloadUrl, verifyUrl } from "../domain/certificates";

async function loadCert(certificateId: string) {
  return prisma.certificate.findUnique({ where: { id: certificateId }, include: { candidate: true, batch: { include: { centre: true } } } });
}
type CertWithRefs = NonNullable<Awaited<ReturnType<typeof loadCert>>>;
const scope = (c: CertWithRefs) => ({ batchId: c.batchId, centreId: c.batch.centreId, districtId: c.batch.centre.districtId, certificateId: c.id });

export async function deliverCertificate(certificateId: string, correlationId: string, attempt: number) {
  const cert = await loadCert(certificateId);
  if (!cert) throw new UnrecoverableError(`certificate ${certificateId} not found`);
  if (cert.deliveryStatus === "SENT") return { skipped: "already sent" };
  if (cert.status === "REVOKED") {
    await prisma.$transaction((tx) => recordAudit(tx, { entityType: "certificate", entityId: cert.id, action: "delivery_skipped_revoked", actorId: null, correlationId }));
    return { skipped: "revoked" };
  }

  const pdfPath = await ensureCertificatePdf({
    number: cert.number,
    holderName: cert.holderName,
    enrolmentNo: cert.enrolmentNo,
    courseName: cert.batch.courseName,
    centreName: cert.batch.centre.name,
    issuedAt: cert.issuedAt,
  });
  await prisma.certificate.update({ where: { id: cert.id }, data: { pdfPath, deliveryAttempts: { increment: 1 } } });

  try {
    const result = await sendCertificateMessage({
      idempotencyKey: cert.id,
      to: cert.candidate.phone,
      documentUrl: downloadUrl(cert.id),
      text: `Congratulations ${cert.holderName}! Your Pragati Skills Mission certificate for ${cert.batch.courseName} (no. ${cert.number}) is ready. Download: ${downloadUrl(cert.id)} . Anyone can check it at ${verifyUrl(cert.number)}`,
    });
    await prisma.$transaction(async (tx) => {
      await tx.certificate.update({ where: { id: cert.id }, data: { deliveryStatus: "SENT", deliveredAt: new Date(), providerMessageId: result.messageId, lastDeliveryError: null } });
      await recordAudit(tx, { entityType: "certificate", entityId: cert.id, action: "delivered", actorId: null, data: { attempt, messageId: result.messageId, deduplicated: result.deduplicated }, correlationId });
      await emitEvent(tx, "certificate.delivered", scope(cert), correlationId);
    });
    return { sent: true, messageId: result.messageId };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError((e as Error).message, true);
    await prisma.$transaction(async (tx) => {
      await tx.certificate.update({ where: { id: cert.id }, data: { lastDeliveryError: err.message } });
      await recordAudit(tx, { entityType: "certificate", entityId: cert.id, action: "delivery_attempt_failed", actorId: null, data: { attempt, error: err.message, willRetry: err.retryable }, correlationId });
    });
    logger.warn({ certificateId, attempt, err: err.message, correlationId }, "delivery attempt failed");
    if (!err.retryable) throw new UnrecoverableError(err.message);
    throw err; // BullMQ retries with exponential backoff
  }
}

/** Called once BullMQ has given up on a certificate: surface it to the state office. */
export async function markDeliveryFailed(certificateId: string, correlationId: string, reason: string) {
  const cert = await loadCert(certificateId);
  if (!cert || cert.deliveryStatus === "SENT") return;
  await prisma.$transaction(async (tx) => {
    await tx.certificate.update({ where: { id: cert.id }, data: { deliveryStatus: "FAILED", lastDeliveryError: reason } });
    await recordAudit(tx, { entityType: "certificate", entityId: cert.id, action: "delivery_failed", actorId: null, data: { reason }, correlationId });
    await emitEvent(tx, "certificate.delivery_failed", scope(cert), correlationId);
  });
}
