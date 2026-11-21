// Moment 3: a batch of 60 is approved. Every candidate ends up with exactly one certificate on
// their phone, even though WhatsApp is unreliable.
// Plus: never two certificates for one candidate, never two certificates sharing a number.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Queue } from "bullmq";
import { prisma } from "../src/lib/prisma";
import { createMockWhatsApp } from "../src/mock-whatsapp/server";
import { issueCertificatesForBatch } from "../src/jobs/issuance";
import { deliverCertificate } from "../src/jobs/delivery";
import { relayOnce } from "../src/jobs/outboxRelay";
import { createQueues } from "../src/jobs/queues";
import { decide, makeBatch, redis, resetDb } from "./helpers";

// Flaky provider: 30% hard failures, 20% "delivered but the response arrived too late".
const mock = createMockWhatsApp({ failureRate: 0.3, timeoutRate: 0.2, timeoutDelayMs: 300 });
let server: Server;
beforeAll(async () => {
  server = mock.app.listen(4999);
});
afterAll(() => server.close());
beforeEach(async () => {
  await resetDb();
  mock.messages.length = 0;
});

/** What BullMQ does for us in production: retry a failing job until it succeeds. */
async function deliverWithRetries(certificateId: string) {
  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      return await deliverCertificate(certificateId, "test", attempt);
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`gave up on ${certificateId}`);
}

describe("Moment 3: 60 candidates approved, unreliable WhatsApp", () => {
  it("every candidate gets exactly one certificate and exactly one message", async () => {
    const batch = await makeBatch("STATE_REVIEW", 60);
    expect((await decide("farah", batch.id, "APPROVE")).body.status).toBe("APPROVED");

    // Issuance runs twice concurrently (e.g. a duplicate job after a worker crash): still 60.
    const runs = await Promise.all([issueCertificatesForBatch(batch.id, "t"), issueCertificatesForBatch(batch.id, "t")]);
    expect(runs.map((r) => r.issued).sort()).toEqual([0, 60]);

    const certs = await prisma.certificate.findMany({ where: { batchId: batch.id } });
    expect(certs).toHaveLength(60);
    expect(new Set(certs.map((c) => c.number)).size).toBe(60);
    expect(new Set(certs.map((c) => c.candidateId)).size).toBe(60);

    // Every delivery job runs TWICE in parallel (two workers picked up the same job) with retries.
    await Promise.all(certs.flatMap((c) => [deliverWithRetries(c.id), deliverWithRetries(c.id)]));

    const after = await prisma.certificate.findMany({ where: { batchId: batch.id } });
    expect(after.every((c) => c.deliveryStatus === "SENT")).toBe(true);

    const phones = (await prisma.candidate.findMany({ where: { batchId: batch.id } })).map((c) => c.phone);
    for (const phone of phones) expect(mock.messages.filter((m) => m.to === phone)).toHaveLength(1);
    expect(mock.messages).toHaveLength(60);
    // The provider really was unreliable during this test:
    expect(mock.stats.failures + mock.stats.timeouts).toBeGreaterThan(0);
  });

  it("a cancelled certificate is never sent", async () => {
    const batch = await makeBatch("APPROVED", 1);
    await issueCertificatesForBatch(batch.id, "t");
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId: batch.id } });
    await prisma.certificate.update({ where: { id: cert.id }, data: { status: "REVOKED" } });
    expect(await deliverCertificate(cert.id, "t", 1)).toEqual({ skipped: "revoked" });
    expect(mock.messages).toHaveLength(0);
  });
});

describe("Never: two certificates for one candidate, or two sharing a number", () => {
  it("the database refuses a second certificate for the same candidate", async () => {
    const batch = await makeBatch("APPROVED", 1);
    await issueCertificatesForBatch(batch.id, "t");
    const cert = await prisma.certificate.findFirstOrThrow({ where: { batchId: batch.id } });
    await expect(prisma.certificate.create({ data: { ...cert, id: undefined, number: "PSM-2026-999", downloadTokenHash: "other" } })).rejects.toThrow(/Unique constraint/);
  });

  it("the database refuses two certificates with the same number", async () => {
    const batch = await makeBatch("APPROVED", 2);
    await issueCertificatesForBatch(batch.id, "t");
    const [a, b] = await prisma.certificate.findMany({ where: { batchId: batch.id } });
    await expect(prisma.certificate.update({ where: { id: b.id }, data: { number: a.number } })).rejects.toThrow(/Unique constraint/);
  });

  it("the same person cannot be certified twice for a course through two batches", async () => {
    const first = await makeBatch("APPROVED", 3);
    const second = await makeBatch("APPROVED", 3, { phoneStart: 9600000000 }); // same enrolment numbers T-0001..3
    await issueCertificatesForBatch(first.id, "t");
    const r = await issueCertificatesForBatch(second.id, "t");
    expect(r.issued).toBe(0);
    expect(await prisma.certificate.count()).toBe(3);
  });

  it("certificate numbers stay unique when several batches are issued at the same time", async () => {
    const batches = await Promise.all([0, 1, 2, 3].map((i) => makeBatch("APPROVED", 25, { courseCode: `C-${i}`, phoneStart: 9500000000 + i * 100 })));
    await Promise.all(batches.map((b) => issueCertificatesForBatch(b.id, "t")));
    const numbers = (await prisma.certificate.findMany({ select: { number: true } })).map((c) => c.number);
    expect(numbers).toHaveLength(100);
    expect(new Set(numbers).size).toBe(100);
  });
});

describe("Outbox relay (event delivery survives restarts)", () => {
  it("publishes each event once, and re-running the relay does not create duplicate jobs", async () => {
    const queues = createQueues(redis);
    await queues.issuance.obliterate({ force: true });
    const batch = await makeBatch("STATE_REVIEW", 2);
    await decide("farah", batch.id, "APPROVE");

    expect(await relayOnce(queues, redis)).toBeGreaterThan(0);
    expect(await relayOnce(queues, redis)).toBe(0); // nothing left unpublished

    // Simulate a crash between "added to queue" and "marked published": mark unpublished and relay again.
    await prisma.outboxEvent.updateMany({ data: { publishedAt: null } });
    await relayOnce(queues, redis);

    const jobs = await queues.issuance.getJobs(["waiting", "delayed", "active", "completed"]);
    expect(jobs.filter((j) => j.data.batchId === batch.id)).toHaveLength(1);
    await Promise.all(Object.values(queues).map((q: Queue) => q.close()));
  });
});
