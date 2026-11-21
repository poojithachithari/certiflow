// Moment 2 (concurrent approvals), moment 6 (send back + resubmit) and the
// "never act at a step that isn't yours / as someone else" rules.
import { beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { prisma } from "../src/lib/prisma";
import { auth, decide, http, makeBatch, resetDb } from "./helpers";

beforeEach(resetDb);

describe("Moment 2: two officers approve the same batch at the same moment", () => {
  it("the batch moves forward exactly once", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 5);
    await prisma.decision.create({ data: { batchId: batch.id, round: 1, stage: "DISTRICT", actorId: "kabir", action: "APPROVE" } });

    const [a, b] = await Promise.all([decide("dev", batch.id, "APPROVE"), decide("meera", batch.id, "APPROVE")]);

    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200); // exactly one succeeds...
    expect(statuses[1]).not.toBe(200); // ...the other is refused because the batch already moved
    const after = await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe("STATE_REVIEW");
    const transitions = await prisma.auditEvent.count({ where: { entityId: batch.id, action: "status:DISTRICT_REVIEW->STATE_REVIEW" } });
    expect(transitions).toBe(1);
    const events = await prisma.outboxEvent.count({ where: { aggregateId: batch.id, type: "batch.status_changed" } });
    expect(events).toBe(1);
  });

  it("three officers racing from zero approvals still produce one transition", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 5);
    const results = await Promise.all(["dev", "meera", "kabir"].map((u) => decide(u, batch.id, "APPROVE")));
    expect(results.filter((r) => r.body.moved === true)).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { entityId: batch.id, action: { startsWith: "status:" } } })).toBe(1);
  });

  it("the same officer double-clicking gets one vote", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 5);
    const results = await Promise.all([decide("dev", batch.id, "APPROVE"), decide("dev", batch.id, "APPROVE")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await prisma.decision.count({ where: { batchId: batch.id } })).toBe(1);
    expect((await prisma.batch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("DISTRICT_REVIEW");
  });
});

describe("Routing", () => {
  it("one officer is not enough; two different officers move a small batch to the state office", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 10);
    expect((await decide("dev", batch.id, "APPROVE")).body).toMatchObject({ moved: false, votes: 1, needed: 2 });
    expect((await decide("meera", batch.id, "APPROVE")).body).toMatchObject({ moved: true, status: "STATE_REVIEW" });
  });

  it("a big batch (more than 50) goes to the quality team first", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 51);
    await decide("dev", batch.id, "APPROVE");
    expect((await decide("meera", batch.id, "APPROVE")).body.status).toBe("QUALITY_REVIEW");
    expect((await decide("neha", batch.id, "APPROVE")).body.status).toBe("STATE_REVIEW");
    expect((await decide("farah", batch.id, "APPROVE")).body.status).toBe("APPROVED");
    expect(await prisma.outboxEvent.count({ where: { aggregateId: batch.id, type: "batch.approved" } })).toBe(1);
  });

  it("reject and send back require a reason", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 3);
    expect((await decide("dev", batch.id, "SEND_BACK")).status).toBe(400);
    expect((await decide("dev", batch.id, "REJECT", "   ")).status).toBe(400);
  });
});

describe("Moment 6: sent back, fixed and resubmitted", () => {
  it("earlier approvals stay on record but no longer count (documented decision)", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 4);
    await decide("kabir", batch.id, "APPROVE");
    const sendBack = await decide("dev", batch.id, "SEND_BACK", "Row 3 phone number is wrong");
    expect(sendBack.body.status).toBe("SENT_BACK");

    const resubmit = await http().post(`/api/batches/${batch.id}/submit`).set(auth("anika"));
    expect(resubmit.body).toEqual({ status: "DISTRICT_REVIEW", round: 2 });

    // Kabir's round-1 approval is still in the record...
    expect(await prisma.decision.count({ where: { batchId: batch.id, actorId: "kabir" } })).toBe(1);
    // ...but in round 2 nobody has approved yet: one new approval is NOT enough.
    expect((await decide("meera", batch.id, "APPROVE")).body).toMatchObject({ votes: 1, needed: 2, moved: false });
    // Kabir may vote again in the new round.
    expect((await decide("kabir", batch.id, "APPROVE")).body).toMatchObject({ moved: true, status: "STATE_REVIEW" });
  });
});

describe("Never: acting at a step that isn't yours, or as someone else", () => {
  it("a centre cannot approve, even its own batch", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 3);
    expect((await decide("anika", batch.id, "APPROVE")).status).toBe(403);
  });

  it("an officer from another district cannot see or act on the batch", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 3);
    expect((await decide("ravi", batch.id, "APPROVE")).status).toBe(404);
    expect((await http().get(`/api/batches/${batch.id}`).set(auth("ravi"))).status).toBe(404);
  });

  it("quality and state office cannot act at the district stage; officers cannot act at the state stage", async () => {
    const district = await makeBatch("DISTRICT_REVIEW", 3);
    expect((await decide("neha", district.id, "APPROVE")).status).toBe(403);
    expect((await decide("farah", district.id, "APPROVE")).status).toBe(403);
    const state = await makeBatch("STATE_REVIEW", 3);
    expect((await decide("dev", state.id, "APPROVE")).status).toBe(403);
    expect(await prisma.decision.count()).toBe(0);
  });

  it("another centre cannot submit or read someone else's batch", async () => {
    const batch = await makeBatch("DRAFT", 3);
    expect((await http().post(`/api/batches/${batch.id}/submit`).set(auth("sunil"))).status).toBe(404);
    expect((await http().get(`/api/batches/${batch.id}`).set(auth("sunil"))).status).toBe(404);
  });

  it("identity comes only from the signed token: an actorId in the body is ignored", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 3);
    await http().post(`/api/batches/${batch.id}/decisions`).set(auth("dev")).send({ action: "APPROVE", actorId: "meera", userId: "meera" });
    const d = await prisma.decision.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(d.actorId).toBe("dev");
  });

  it("tampered, wrongly signed, expired and 'alg: none' tokens are rejected", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 3);
    const good = auth("dev").Authorization.slice(7);
    const [h, p, s] = good.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "farah" })).toString("base64url");
    const tokens = [
      `${h}.${forgedPayload}.${s}`, // payload swapped, old signature
      jwt.sign({ sub: "farah" }, "some-other-secret"), // wrong key
      jwt.sign({ sub: "dev", exp: Math.floor(Date.now() / 1000) - 60 }, "test-jwt-secret-0123456789"), // expired
      `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${forgedPayload}.`, // unsigned
    ];
    for (const t of tokens) {
      const res = await http().post(`/api/batches/${batch.id}/decisions`).set({ Authorization: `Bearer ${t}` }).send({ action: "APPROVE" });
      expect(res.status).toBe(401);
    }
    expect(await prisma.decision.count()).toBe(0);
  });
});

describe("Never: a decision that cannot be traced to who made it and when", () => {
  it("every decision and transition has an audit row with actor and time", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 3);
    await decide("dev", batch.id, "APPROVE");
    await decide("meera", batch.id, "APPROVE");
    const audit = await prisma.auditEvent.findMany({ where: { entityId: batch.id }, orderBy: { id: "asc" } });
    expect(audit.map((a) => [a.action, a.actorId])).toEqual([
      ["decision:APPROVE", "dev"],
      ["decision:APPROVE", "meera"],
      ["status:DISTRICT_REVIEW->STATE_REVIEW", "meera"],
    ]);
    for (const a of audit) expect(a.createdAt).toBeInstanceOf(Date);
  });

  it("history cannot be rewritten: UPDATE/DELETE on decisions and audit rows is blocked by the database", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 3);
    await decide("dev", batch.id, "APPROVE");
    await expect(prisma.decision.updateMany({ data: { actorId: "meera" } })).rejects.toThrow(/append-only/);
    await expect(prisma.decision.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(prisma.auditEvent.deleteMany({})).rejects.toThrow(/append-only/);
  });
});

describe("Split vote: one officer rejects, two approve", () => {
  it("the batch moves on, and the outvoted rejection is recorded and shown to the next reviewer", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 5);
    expect((await decide("dev", batch.id, "REJECT", "Row 7 scores look copied")).body).toMatchObject({ moved: false, votes: 1, needed: 2 });
    expect((await decide("meera", batch.id, "APPROVE")).body).toMatchObject({ moved: false });
    expect((await decide("kabir", batch.id, "APPROVE")).body).toMatchObject({ moved: true, status: "STATE_REVIEW" });

    // Traceable: the transition's audit entry names who was overruled and why.
    const transition = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: batch.id, action: "status:DISTRICT_REVIEW->STATE_REVIEW" } });
    expect(transition.data).toMatchObject({ overruledRejections: [{ actorId: "dev", reason: "Row 7 scores look copied" }] });

    // Visible: the state office sees the dissent on the batch and in its list.
    const detail = await http().get(`/api/batches/${batch.id}`).set(auth("farah"));
    expect(detail.body.dissent).toEqual([{ actor: "Dev", stage: "DISTRICT", reason: "Row 7 scores look copied" }]);
    const list = await http().get(`/api/batches`).set(auth("farah"));
    expect(list.body.find((b: { id: string }) => b.id === batch.id).dissent).toBe(1);
  });

  it("two rejections win: the batch is rejected and nothing is reported as overruled", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 5);
    await decide("dev", batch.id, "REJECT", "Fake attendance");
    await decide("meera", batch.id, "APPROVE");
    expect((await decide("kabir", batch.id, "REJECT", "Agree, attendance is fake")).body).toMatchObject({ moved: true, status: "REJECTED" });
    expect((await http().get(`/api/batches/${batch.id}`).set(auth("farah"))).body.dissent).toEqual([]);
  });

  it("dissent resets with the round: a resubmitted batch starts clean", async () => {
    const batch = await makeBatch("DISTRICT_REVIEW", 5);
    await decide("dev", batch.id, "REJECT", "Wrong course");
    await decide("meera", batch.id, "SEND_BACK", "Please fix the course code");
    await http().post(`/api/batches/${batch.id}/submit`).set(auth("anika"));
    expect((await http().get(`/api/batches/${batch.id}`).set(auth("dev"))).body.dissent).toEqual([]);
  });
});
