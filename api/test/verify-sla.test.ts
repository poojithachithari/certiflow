// Moment 4 (cancelled certificate reported invalid a minute later), moment 5 (stuck batch
// reaches someone senior) and "never: a stranger gets someone else's certificate or details".
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma";
import { issueCertificatesForBatch } from "../src/jobs/issuance";
import { escalateStuckBatches } from "../src/jobs/sla";
import { downloadToken, verificationCode } from "../src/domain/certificates";
import { auth, decide, http, makeBatch, resetDb } from "./helpers";

beforeEach(resetDb);

async function issuedCertificate() {
  const batch = await makeBatch("APPROVED", 2);
  await issueCertificatesForBatch(batch.id, "t");
  return prisma.certificate.findFirstOrThrow({ where: { batchId: batch.id }, orderBy: { number: "asc" } });
}
const verify = (number: string, code: string) => http().get(`/api/public/verify`).query({ number, code });

describe("Moment 4: the state office cancels a fake certificate", () => {
  it("an employer checking right after is told it is no longer valid", async () => {
    const cert = await issuedCertificate();
    const code = verificationCode(cert.number);
    expect((await verify(cert.number, code)).body.result).toBe("VALID");

    const revoke = await http().post(`/api/certificates/${cert.id}/revoke`).set(auth("farah")).send({ reason: "Marks were forged" });
    expect(revoke.status).toBe(200);

    const after = await verify(cert.number, code);
    expect(after.body).toMatchObject({ result: "REVOKED", revokeReason: "Marks were forged" });
    expect(after.headers["cache-control"]).toBe("no-store");
  });

  it("only the state office can cancel; cancelling twice is refused", async () => {
    const cert = await issuedCertificate();
    for (const u of ["anika", "dev", "neha"]) expect((await http().post(`/api/certificates/${cert.id}/revoke`).set(auth(u)).send({ reason: "nope" })).status).toBe(403);
    expect((await http().post(`/api/certificates/${cert.id}/revoke`).set(auth("farah")).send({ reason: "fake" })).status).toBe(200);
    expect((await http().post(`/api/certificates/${cert.id}/revoke`).set(auth("farah")).send({ reason: "fake" })).status).toBe(409);
  });

  it("the candidate's download link stops working once cancelled", async () => {
    const cert = await issuedCertificate();
    await http().post(`/api/certificates/${cert.id}/revoke`).set(auth("farah")).send({ reason: "fake" });
    expect((await http().get(`/api/public/download/${downloadToken(cert.id)}`)).status).toBe(410);
  });
});

describe("Never: a stranger gets someone else's certificate or personal details", () => {
  it("public verification needs the right code, and gives the same answer for a wrong code as for no certificate", async () => {
    const cert = await issuedCertificate();
    expect((await verify(cert.number, "AAAAA-BBBBB")).body).toEqual({ result: "NOT_FOUND" });
    expect((await verify("PSM-2026-424242", "AAAAA-BBBBB")).body).toEqual({ result: "NOT_FOUND" });
  });

  it("public verification shows a masked name and no phone or date of birth", async () => {
    const cert = await issuedCertificate();
    const res = await verify(cert.number, verificationCode(cert.number));
    const text = JSON.stringify(res.body);
    expect(res.body.holder).toMatch(/^C\*+ \d\*+$/); // "Candidate 1" -> "C******** 1**"
    expect(text).not.toContain("Candidate");
    expect(text).not.toMatch(/\+91\d{10}/);
    expect(text).not.toContain("dateOfBirth");
  });

  it("a guessed download token gets nothing", async () => {
    await issuedCertificate();
    expect((await http().get(`/api/public/download/${"A".repeat(43)}`)).status).toBe(404);
  });

  it("public verification is rate limited", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 35; i++) statuses.push((await verify("PSM-2026-1", "AAAAA-BBBBB").set("X-Forwarded-For", "203.0.113.9")).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it("reviewers see masked phone numbers; other centres see nothing", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 1);
    const asOfficer = await http().get(`/api/batches/${batch.id}`).set(auth("dev"));
    expect(asOfficer.body.candidates[0].phone).toMatch(/^\+91\*{6}\d{4}$/);
    expect(asOfficer.body.candidates[0].dateOfBirth).toBeNull();
    expect((await http().get(`/api/batches/${batch.id}`).set(auth("sunil"))).status).toBe(404);
    expect((await http().get(`/api/certificates`).set(auth("sunil"))).body).toEqual([]);
  });
});

describe("Moment 5: a batch sits untouched with an officer for too long", () => {
  it("it is escalated to the state office once, without anyone chasing it", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 2);
    await prisma.batch.update({ where: { id: batch.id }, data: { stageEnteredAt: new Date(Date.now() - 3 * 24 * 3600_000) } });
    const fresh = await makeBatch("DISTRICT_REVIEW", 2); // within the limit

    // Two workers run the check at the same moment: each stuck batch is still escalated once.
    const [a, b] = await Promise.all([escalateStuckBatches(new Date(), 2880), escalateStuckBatches(new Date(), 2880)]);
    expect([...a, ...b]).toEqual([batch.id]);
    expect(await escalateStuckBatches(new Date(), 2880)).toEqual([]);

    expect(await prisma.auditEvent.count({ where: { entityId: batch.id, action: "escalated" } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: batch.id, type: "batch.escalated" } })).toBe(1);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: fresh.id } })).escalatedAt).toBeNull();

    const stuck = await http().get("/api/stuck").set(auth("farah"));
    expect(stuck.body.find((s: { id: string }) => s.id === batch.id).escalatedAt).not.toBeNull();
    expect((await http().get("/api/stuck").set(auth("dev"))).status).toBe(403);
  });

  it("moving to the next stage clears the flag so the new stage gets its own clock", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 2);
    await prisma.batch.update({ where: { id: batch.id }, data: { stageEnteredAt: new Date(Date.now() - 3 * 24 * 3600_000) } });
    await escalateStuckBatches(new Date(), 2880);
    await decide("dev", batch.id, "APPROVE");
    await decide("meera", batch.id, "APPROVE");
    const after = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("STATE_REVIEW");
    expect(after.escalatedAt).toBeNull();
  });
});
