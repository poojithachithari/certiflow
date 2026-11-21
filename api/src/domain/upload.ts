// Spreadsheet upload: parse -> validate EVERY row -> save all-or-nothing.
//
// If any row is wrong we return every problem (row number, column, message) and save nothing.
// Only a fully valid file is written, in one transaction that replaces the batch's candidates.
import { createHash } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { z } from "zod";
import type { User } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { badRequest, conflict, forbidden, unprocessable } from "../lib/errors";
import { emitEvent, recordAudit } from "../lib/events";
import { lockBatch, scopeOf } from "./workflow";

export const MAX_ROWS = 1000;
export const PASS_MARK = 40;
export const REQUIRED_COLUMNS = ["enrolment_no", "name", "phone", "date_of_birth", "score"] as const;

export interface RowError {
  row: number; // spreadsheet row number as the centre sees it (header = row 1)
  column: string;
  message: string;
}

const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Indian mobile: 10 digits starting 6-9, optional +91 / 91 / 0 prefix. Stored as E.164. */
function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, "");
  const m = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(digits);
  return m ? `+91${m[1]}` : null;
}

function parseDate(raw: string): Date | null {
  const s = raw.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); // 2004-03-15
  if (m) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(s))) [d, mo, y] = [+m[1], +m[2], +m[3]]; // 15/03/2004 (Indian format)
  else return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  // Reject impossible dates like 31/02 that JS would silently roll over.
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

const rowSchema = z.object({
  enrolment_no: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{4,20}$/, "must be 4-20 letters, digits or dashes"),
  name: z
    .string()
    .trim()
    .min(2, "is required (at least 2 characters)")
    .max(100, "is too long (max 100)")
    // Letters (any script), spaces, dot, apostrophe, hyphen. Also blocks spreadsheet formula injection (=, +, @).
    .regex(/^\p{L}[\p{L}\p{M} .'-]*$/u, "may contain only letters, spaces, . ' -"),
  phone: z.string().transform((v, ctx) => {
    const p = normalisePhone(v);
    if (!p) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a 10-digit Indian mobile number" });
    return p ?? "";
  }),
  date_of_birth: z.string().transform((v, ctx) => {
    const d = parseDate(v);
    if (!d) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a date like 2004-03-15 or 15/03/2004" });
      return new Date(NaN);
    }
    const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 14 || age > 70) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "gives an age outside 14-70" });
    return d;
  }),
  score: z.string().transform((v, ctx) => {
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a whole number 0-100" });
      return 0;
    }
    if (n < PASS_MARK) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `is below the pass mark (${PASS_MARK}); only passed candidates can be certified` });
    return n;
  }),
});

export type ValidRow = z.output<typeof rowSchema> & { rowNumber: number };

/** Turn CSV or XLSX bytes into header-keyed string rows. */
export async function readSpreadsheet(buffer: Buffer, filename: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) {
    let records: string[][];
    try {
      records = parseCsv(buffer, { bom: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true, trim: true });
    } catch (e) {
      throw badRequest(`Could not read CSV: ${(e as Error).message}`);
    }
    const [header = [], ...body] = records;
    const headers = header.map(normaliseHeader);
    return { headers, rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
  }
  if (lower.endsWith(".xlsx")) {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw badRequest("Could not read the Excel file. Save it as .xlsx or .csv and try again");
    }
    const ws = wb.worksheets[0];
    if (!ws) throw badRequest("The Excel file has no sheets");
    const cellText = (v: ExcelJS.CellValue): string => {
      if (v == null) return "";
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === "object" && "text" in v) return String(v.text);
      if (typeof v === "object" && "result" in v) return String(v.result ?? "");
      return String(v);
    };
    const all: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as ExcelJS.CellValue[]; // 1-based
      all.push(values.slice(1).map(cellText));
    });
    const [header = [], ...body] = all;
    const headers = header.map(normaliseHeader);
    return { headers, rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()]))) };
  }
  throw badRequest("Upload a .csv or .xlsx file");
}

/** Pure validation: returns every error, or the clean rows. No database writes. */
export function validateRows(headers: string[], rows: Record<string, string>[]): { errors: RowError[]; valid: ValidRow[] } {
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) return { errors: missing.map((c) => ({ row: 1, column: c, message: "column is missing from the header row" })), valid: [] };
  if (rows.length === 0) return { errors: [{ row: 2, column: "-", message: "the file has no candidate rows" }], valid: [] };
  if (rows.length > MAX_ROWS) return { errors: [{ row: MAX_ROWS + 2, column: "-", message: `too many rows (max ${MAX_ROWS} per batch)` }], valid: [] };

  const errors: RowError[] = [];
  const valid: ValidRow[] = [];
  const seen = new Map<string, number>();

  rows.forEach((raw, i) => {
    const rowNumber = i + 2;
    const input = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, raw[c] ?? ""]));
    const result = rowSchema.safeParse(input);
    if (!result.success) {
      for (const issue of result.error.issues) errors.push({ row: rowNumber, column: String(issue.path[0] ?? "-"), message: issue.message });
      return;
    }
    const firstRow = seen.get(result.data.enrolment_no);
    if (firstRow) {
      errors.push({ row: rowNumber, column: "enrolment_no", message: `duplicate of row ${firstRow}` });
      return;
    }
    seen.set(result.data.enrolment_no, rowNumber);
    valid.push({ ...result.data, rowNumber });
  });
  return { errors, valid };
}

export async function uploadCandidates(actor: User, batchId: string, file: { buffer: Buffer; originalname: string }, correlationId: string) {
  const { headers, rows } = await readSpreadsheet(file.buffer, file.originalname);
  const { errors, valid } = validateRows(headers, rows);

  return prisma.$transaction(async (tx) => {
    const batch = await lockBatch(tx, batchId);
    if (actor.role !== "CENTRE" || actor.centreId !== batch.centreId) throw forbidden("Only the batch's own centre can upload candidates");
    if (batch.status !== "DRAFT" && batch.status !== "SENT_BACK") throw conflict(`Candidates can only be changed while the batch is a draft or sent back (it is ${batch.status})`);

    // Cross-batch rule: a person is certified at most once per course.
    const already = await tx.certificate.findMany({
      where: { courseCode: batch.courseCode, enrolmentNo: { in: valid.map((r) => r.enrolment_no) } },
      select: { enrolmentNo: true, number: true },
    });
    for (const c of already) {
      const r = valid.find((v) => v.enrolment_no === c.enrolmentNo)!;
      errors.push({ row: r.rowNumber, column: "enrolment_no", message: `already certified for ${batch.courseCode} (certificate ${c.number})` });
    }

    if (errors.length) {
      errors.sort((a, b) => a.row - b.row);
      // Throwing inside the transaction rolls it back: nothing is saved.
      throw unprocessable(`${errors.length} problem(s) found. Nothing was saved. Fix the file and upload it again.`, { errors });
    }

    await tx.candidate.deleteMany({ where: { batchId } });
    await tx.candidate.createMany({
      data: valid.map((r) => ({
        batchId,
        rowNumber: r.rowNumber,
        enrolmentNo: r.enrolment_no,
        name: r.name,
        phone: r.phone,
        dateOfBirth: r.date_of_birth,
        score: r.score,
      })),
    });
    const fileHash = createHash("sha256").update(file.buffer).digest("hex");
    await recordAudit(tx, { entityType: "batch", entityId: batchId, action: "candidates_uploaded", actorId: actor.id, data: { count: valid.length, file: file.originalname, sha256: fileHash }, correlationId });
    await emitEvent(tx, "batch.candidates_uploaded", scopeOf(batch), correlationId, { count: valid.length });
    return { count: valid.length };
  });
}
