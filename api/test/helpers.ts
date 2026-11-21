import request from "supertest";
import type { BatchStatus } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { createRedis } from "../src/lib/redis";
import { signSession } from "../src/auth";

export const redis = createRedis();
export const app = createApp(redis);
export const http = () => request(app);
export const auth = (userId: string) => ({ Authorization: `Bearer ${signSession(userId)}` });

/** Wipe all tables (TRUNCATE bypasses the append-only row triggers) and load the demo people. */
export async function resetDb() {
  const keys = await redis.keys("ratelimit:*"); // so back-to-back test runs don't trip the limiter
  if (keys.length) await redis.del(...keys);
  await prisma.$executeRawUnsafe(`TRUNCATE "AuditEvent","OutboxEvent","Certificate","Decision","Candidate","Batch","User","Centre","District" RESTART IDENTITY CASCADE`);
  await prisma.district.createMany({ data: [{ id: "pune", name: "Pune" }, { id: "nagpur", name: "Nagpur" }] });
  await prisma.centre.createMany({
    data: [
      { id: "centre-pune-1", name: "Pragati Skill Centre", districtId: "pune" },
      { id: "centre-nagpur-1", name: "Vidarbha Technical Institute", districtId: "nagpur" },
    ],
  });
  await prisma.user.createMany({
    data: [
      { id: "anika", name: "Anika", role: "CENTRE", centreId: "centre-pune-1" },
      { id: "sunil", name: "Sunil", role: "CENTRE", centreId: "centre-nagpur-1" },
      { id: "dev", name: "Dev", role: "DISTRICT_OFFICER", districtId: "pune" },
      { id: "meera", name: "Meera", role: "DISTRICT_OFFICER", districtId: "pune" },
      { id: "kabir", name: "Kabir", role: "DISTRICT_OFFICER", districtId: "pune" },
      { id: "ravi", name: "Ravi", role: "DISTRICT_OFFICER", districtId: "nagpur" },
      { id: "neha", name: "Neha", role: "QUALITY" },
      { id: "farah", name: "Farah", role: "STATE_OFFICE" },
    ],
  });
}

export function csv(rows: number, opts: { prefix?: string; phoneStart?: number } = {}) {
  const { prefix = "ENR", phoneStart = 9800000000 } = opts;
  const lines = ["enrolment_no,name,phone,date_of_birth,score"];
  for (let i = 0; i < rows; i++) lines.push(`${prefix}-${String(i + 1).padStart(4, "0")},Candidate ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i / 26) | 0))},${phoneStart + i},2001-05-${String(1 + (i % 28)).padStart(2, "0")},${50 + (i % 50)}`);
  return Buffer.from(lines.join("\n") + "\n");
}

/** Create a batch directly in the DB at a given status with n candidates. */
export async function makeBatch(status: BatchStatus, n: number, opts: { centreId?: string; round?: number; courseCode?: string; phoneStart?: number } = {}) {
  return prisma.batch.create({
    data: {
      title: `Test batch ${status}`,
      courseCode: opts.courseCode ?? "TST-L1",
      courseName: "Test Course",
      status,
      round: opts.round ?? (status === "DRAFT" ? 0 : 1),
      centreId: opts.centreId ?? "centre-pune-1",
      candidates: {
        create: Array.from({ length: n }, (_, i) => ({
          rowNumber: i + 2,
          enrolmentNo: `T-${String(i + 1).padStart(4, "0")}`,
          name: `Candidate ${i + 1}`,
          phone: `+91${(opts.phoneStart ?? 9700000000) + i}`,
          dateOfBirth: new Date("2001-01-01"),
          score: 70,
        })),
      },
    },
  });
}

export const decide = (userId: string, batchId: string, action: string, reason?: string) =>
  http().post(`/api/batches/${batchId}/decisions`).set(auth(userId)).send({ action, reason });
