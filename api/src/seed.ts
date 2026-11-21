// Demo data so reviewers can try every flow straight away. Runs on every `docker compose up`
// but only seeds an empty database (idempotent).
import { randomUUID } from "node:crypto";
import { prisma } from "./lib/prisma";
import type { BatchStatus } from "@prisma/client";

const FIRST = ["Aarav", "Diya", "Ishaan", "Kavya", "Rohan", "Sneha", "Arjun", "Pooja", "Vikram", "Ananya", "Rahul", "Priya", "Karan", "Neelam", "Suresh", "Lakshmi", "Manoj", "Fatima", "Imran", "Gurpreet"];
const LAST = ["Sharma", "Patil", "Kulkarni", "Deshmukh", "Joshi", "Shaikh", "Pawar", "Jadhav", "Iyer", "Singh", "Khan", "More"];

function candidates(prefix: string, count: number, phoneBase: number) {
  return Array.from({ length: count }, (_, i) => ({
    rowNumber: i + 2,
    enrolmentNo: `${prefix}-${String(i + 1).padStart(3, "0")}`,
    name: `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`,
    phone: `+91${phoneBase + i}`,
    dateOfBirth: new Date(Date.UTC(1998 + (i % 8), i % 12, 1 + (i % 27))),
    score: 55 + ((i * 13) % 45),
  }));
}

async function main() {
  if (await prisma.user.findUnique({ where: { id: "anika" } })) {
    console.log("seed: data already present, skipping");
    return;
  }

  await prisma.district.createMany({ data: [{ id: "pune", name: "Pune" }, { id: "nagpur", name: "Nagpur" }] });
  await prisma.centre.createMany({
    data: [
      { id: "centre-pune-1", name: "Pragati Skill Centre, Hadapsar", districtId: "pune" },
      { id: "centre-nagpur-1", name: "Vidarbha Technical Institute", districtId: "nagpur" },
    ],
  });
  await prisma.user.createMany({
    data: [
      { id: "anika", name: "Anika", role: "CENTRE", centreId: "centre-pune-1" },
      { id: "dev", name: "Dev", role: "DISTRICT_OFFICER", districtId: "pune" },
      { id: "meera", name: "Meera", role: "DISTRICT_OFFICER", districtId: "pune" },
      { id: "kabir", name: "Kabir", role: "DISTRICT_OFFICER", districtId: "pune" },
      { id: "neha", name: "Neha", role: "QUALITY" },
      { id: "farah", name: "Farah", role: "STATE_OFFICE" },
      // Extra people used to show (and test) that access is scoped by centre and district.
      { id: "sunil", name: "Sunil", role: "CENTRE", centreId: "centre-nagpur-1" },
      { id: "ravi", name: "Ravi", role: "DISTRICT_OFFICER", districtId: "nagpur" },
    ],
  });

  const make = async (title: string, courseCode: string, courseName: string, status: BatchStatus, round: number, prefix: string, count: number, phoneBase: number, centreId = "centre-pune-1") => {
    const id = randomUUID();
    await prisma.batch.create({
      data: { id, title, courseCode, courseName, status, round, centreId, stageEnteredAt: new Date(), candidates: { create: candidates(prefix, count, phoneBase) } },
    });
    await prisma.auditEvent.create({ data: { entityType: "batch", entityId: id, action: "seeded", actorId: null, data: { status }, correlationId: "seed" } });
    return id;
  };

  await make("Electrician batch - Oct 2026", "ELEC-L3", "Assistant Electrician (Level 3)", "DRAFT", 0, "PSC-EL26", 6, 9876500100);

  const retail = await make("Retail associate batch 14", "RET-L4", "Retail Sales Associate (Level 4)", "DISTRICT_REVIEW", 1, "PSC-RT14", 12, 9876500200);
  await prisma.decision.create({ data: { batchId: retail, round: 1, stage: "DISTRICT", actorId: "kabir", action: "APPROVE" } });
  await prisma.auditEvent.create({ data: { entityType: "batch", entityId: retail, action: "decision:APPROVE", actorId: "kabir", data: { stage: "DISTRICT", round: 1 }, correlationId: "seed" } });

  await make("Data entry operators batch 7", "DEO-L4", "Data Entry Operator (Level 4)", "STATE_REVIEW", 1, "PSC-DE07", 8, 9876500300);

  // Already approved: the worker issues these certificates on first start, so verification can be tried immediately.
  const plumbing = await make("Plumbing batch 3", "PLB-L3", "Plumber General (Level 3)", "APPROVED", 1, "PSC-PL03", 5, 9876500400);
  await prisma.outboxEvent.create({ data: { type: "batch.approved", aggregateId: plumbing, payload: { batchId: plumbing, centreId: "centre-pune-1", districtId: "pune", round: 1 }, correlationId: "seed" } });

  await make("Welding batch 2", "WLD-L3", "Welder (Level 3)", "DISTRICT_REVIEW", 1, "VTI-WL02", 4, 9876500500, "centre-nagpur-1");

  console.log("seed: demo data created");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
