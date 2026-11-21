// Moment 1: a centre uploads a spreadsheet with a few bad rows. They find out exactly what is
// wrong, and nothing half-saved ends up in the system.
import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "../src/lib/prisma";
import { auth, csv, http, makeBatch, resetDb } from "./helpers";

beforeEach(resetDb);

const upload = (batchId: string, body: Buffer, name = "batch.csv", user = "anika") =>
  http().put(`/api/batches/${batchId}/candidates`).set(auth(user)).attach("file", body, name);

describe("Moment 1: spreadsheet with bad rows", () => {
  it("reports every bad row with row number and column, and saves nothing", async () => {
    const batch = await makeBatch("DRAFT", 0);
    const file = Buffer.from(
      [
        "enrolment_no,name,phone,date_of_birth,score",
        "ENR-0001,Ritu Desai,9822011001,2003-04-12,78", // row 2 ok
        "ENR-0002,Sameer Kale,12345,2002-08-30,66", // row 3 bad phone
        "ENR-0003,=SUM(A1:A9),9822011003,2001-01-15,70", // row 4 formula injection in name
        "ENR-0004,Nisha Rao,9822011004,2004-02-31,81", // row 5 impossible date
        "ENR-0005,Om Gupta,9822011005,2002-06-11,32", // row 6 below pass mark
        "ENR-0001,Ritu Desai,9822011001,2003-04-12,78", // row 7 duplicate
      ].join("\n"),
    );
    const res = await upload(batch.id, file);
    expect(res.status).toBe(422);
    const errors = res.body.error.details.errors as { row: number; column: string }[];
    expect(errors.map((e) => [e.row, e.column])).toEqual([
      [3, "phone"],
      [4, "name"],
      [5, "date_of_birth"],
      [6, "score"],
      [7, "enrolment_no"],
    ]);
    expect(await prisma.candidate.count({ where: { batchId: batch.id } })).toBe(0);
  });

  it("a bad re-upload leaves the previous valid list untouched", async () => {
    const batch = await makeBatch("DRAFT", 0);
    expect((await upload(batch.id, csv(10))).status).toBe(200);
    const bad = Buffer.from(csv(5).toString() + "BAD ROW,,,,\n");
    expect((await upload(batch.id, bad)).status).toBe(422);
    expect(await prisma.candidate.count({ where: { batchId: batch.id } })).toBe(10);
  });

  it("accepts a valid file, normalising Indian phone and date formats", async () => {
    const batch = await makeBatch("DRAFT", 0);
    const file = Buffer.from("Enrolment No,Name,Phone,Date of Birth,Score\nENR-1,Farhan Ali,+91 98220 11007,15/09/2003,90\n");
    const res = await upload(batch.id, file);
    expect(res.status).toBe(200);
    const c = await prisma.candidate.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(c.phone).toBe("+919822011007");
    expect(c.dateOfBirth.toISOString().slice(0, 10)).toBe("2003-09-15");
  });

  it("reads Excel files too", async () => {
    const batch = await makeBatch("DRAFT", 0);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Passed");
    ws.addRow(["enrolment_no", "name", "phone", "date_of_birth", "score"]);
    ws.addRow(["X-001", "Asha Pawar", "9822000001", "2002-02-02", 88]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await upload(batch.id, buf, "batch.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it("rejects a file with a missing column and names the column", async () => {
    const batch = await makeBatch("DRAFT", 0);
    const res = await upload(batch.id, Buffer.from("enrolment_no,name,phone\nA-1,Asha,9822000001\n"));
    expect(res.status).toBe(422);
    expect(res.body.error.details.errors.map((e: { column: string }) => e.column)).toEqual(["date_of_birth", "score"]);
  });

  it("refuses someone already certified for the same course (no second certificate via another batch)", async () => {
    const old = await makeBatch("ISSUED", 1);
    const cand = await prisma.candidate.findFirstOrThrow({ where: { batchId: old.id } });
    await prisma.certificate.create({ data: { number: "PSM-2026-1", candidateId: cand.id, batchId: old.id, enrolmentNo: "ENR-0001", courseCode: "TST-L1", holderName: "x", downloadTokenHash: "h1" } });
    const batch = await makeBatch("DRAFT", 0);
    const res = await upload(batch.id, csv(3));
    expect(res.status).toBe(422);
    expect(res.body.error.details.errors[0].message).toMatch(/already certified/);
  });

  it("only the batch's own centre can upload, and only while it is editable", async () => {
    const batch = await makeBatch("DRAFT", 0);
    expect((await upload(batch.id, csv(2), "a.csv", "sunil")).status).toBe(404); // other centre can't even see it
    expect((await upload(batch.id, csv(2), "a.csv", "dev")).status).toBe(403);
    const inReview = await makeBatch("DISTRICT_REVIEW", 2);
    expect((await upload(inReview.id, csv(2))).status).toBe(409);
  });
});
