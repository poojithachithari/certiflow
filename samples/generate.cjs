// Generates the sample spreadsheets in this folder.  Run:  node samples/generate.cjs
// (uses exceljs from api/node_modules for the .xlsx files)
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require(path.join(__dirname, "..", "api", "node_modules", "exceljs"));

const OUT = __dirname;
const HEADER = ["enrolment_no", "name", "phone", "date_of_birth", "score"];

const FIRST = ["Aarav", "Diya", "Ishaan", "Kavya", "Rohan", "Sneha", "Arjun", "Pooja", "Vikram", "Ananya", "Rahul", "Priya", "Karan", "Neelam", "Suresh", "Lakshmi", "Manoj", "Fatima", "Imran", "Gurpreet", "Meenakshi", "Tenzin", "Joseph", "Shalini"];
const LAST = ["Sharma", "Patil", "Kulkarni", "Deshmukh", "Joshi", "Shaikh", "Pawar", "Jadhav", "Iyer", "Singh", "Khan", "More", "D'Souza", "Nair"];
const name = (i) => `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`;
const dob = (i) => `${2000 + (i % 8)}-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`;
const score = (i) => 45 + ((i * 7) % 55); // always >= pass mark (40)

const rows = (prefix, n, phoneBase) => Array.from({ length: n }, (_, i) => [`${prefix}-${String(i + 1).padStart(3, "0")}`, name(i), String(phoneBase + i), dob(i), score(i)]);

function writeCsv(file, header, body) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  fs.writeFileSync(path.join(OUT, file), [header, ...body].map((r) => r.map(esc).join(",")).join("\n") + "\n");
}

async function writeXlsx(file, header, body) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Passed candidates");
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  body.forEach((r) => ws.addRow(r));
  ws.columns.forEach((c) => (c.width = 22));
  await wb.xlsx.writeFile(path.join(OUT, file));
}

(async () => {
  // ---------- GOOD: accepted ----------
  writeCsv("good-60-candidates.csv", HEADER, rows("GD60", 60, 9822100000)); // > 50, so it also goes to quality review
  writeCsv("good-12-candidates.csv", HEADER, rows("GD12", 12, 9822200000)); // small batch: district -> state directly
  await writeXlsx("good-15-candidates.xlsx", HEADER, rows("GDXL", 15, 9822300000));
  // Real-world messiness that is still valid: header spelled differently, Indian phone formats, dd/mm/yyyy dates.
  writeCsv("good-indian-formats.csv", ["Enrolment No", "Name", "Phone", "Date of Birth", "Score"], [
    ["gdin-001", "Farhan Ali", "+91 98221 40001", "15/09/2003", 90],
    ["GDIN-002", "Meenakshi Iyer", "098221 40002", "02-11-2004", 67],
    ["GDIN-003", "Joseph D'Souza", "919822140003", "2002-07-21", 74],
    ["GDIN-004", "Tenzin Norbu", "(982) 214-0004", "30/01/2001", 40],
    ["GDIN-005", "Lakshmi Nair", "9822140005", "2005-12-31", 100],
  ]);

  // ---------- BAD: rejected, nothing saved ----------
  const bad = (prefix, phoneBase) => rows(prefix, 6, phoneBase);

  // one of every kind of row error
  writeCsv("bad-mixed-errors.csv", HEADER, [
    ["BDMX-001", "Ritu Desai", "9822011001", "2003-04-12", 78],
    ["BDMX-002", "Sameer Kale", "12345", "2002-08-30", 66],
    ["BDMX-003", "=SUM(A1:A9)", "9822011003", "2001-01-15", 70],
    ["BDMX-004", "Nisha Rao", "9822011004", "2004-02-31", 81],
    ["BDMX-005", "Om Gupta", "9822011005", "2002-06-11", 32],
    ["BDMX-001", "Ritu Desai", "9822011001", "2003-04-12", 78],
    ["BDMX-007", "Farhan Ali", "+91 98220 11007", "15/09/2003", 90],
  ]);

  const missing = bad("BDMC", 9822500000).map((r) => r.slice(0, 3));
  writeCsv("bad-missing-columns.csv", HEADER.slice(0, 3), missing);

  const dup = bad("BDDP", 9822510000);
  dup[3][0] = dup[0][0];
  dup[5][0] = dup[1][0];
  writeCsv("bad-duplicate-enrolment.csv", HEADER, dup);

  const failed = bad("BDFS", 9822520000);
  failed[1][4] = 39;
  failed[4][4] = 12;
  writeCsv("bad-failed-candidates.csv", HEADER, failed);

  const phones = bad("BDPH", 9822530000);
  phones[0][2] = "12345";
  phones[2][2] = "5822530002"; // Indian mobiles start 6-9
  phones[4][2] = "98225300041"; // 11 digits
  writeCsv("bad-phone-numbers.csv", HEADER, phones);

  const dates = bad("BDDT", 9822540000);
  dates[0][3] = "2004-02-30"; // no such day
  dates[2][3] = "31/13/2003"; // month 13
  dates[3][3] = "yesterday";
  dates[5][3] = "2019-01-01"; // age 7
  writeCsv("bad-dates-and-ages.csv", HEADER, dates);

  const names = bad("BDNM", 9822550000);
  names[0][1] = "=HYPERLINK(\"http://evil.example\",\"click\")"; // spreadsheet formula injection
  names[2][1] = "";
  names[3][1] = "Agent 007";
  writeCsv("bad-names.csv", HEADER, names);

  writeCsv("bad-empty.csv", HEADER, []);
  writeCsv("bad-too-many-rows.csv", HEADER, rows("BDTM", 1001, 9823000000));

  const xl = rows("BDXL", 5, 9822560000);
  xl[1][2] = "not a phone";
  xl[3][4] = 20;
  await writeXlsx("bad-errors.xlsx", HEADER, xl);

  fs.writeFileSync(path.join(OUT, "bad-wrong-file-type.txt"), "This is not a spreadsheet.\n");

  console.log("samples written to", OUT);
})();
