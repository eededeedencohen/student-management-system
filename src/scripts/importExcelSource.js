import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { connectDB, disconnectDB } = await import("../config/db.js");
const { default: SourceRow } = await import("../models/SourceRow.js");
const { default: SourceCourseBlock } =
  await import("../models/SourceCourseBlock.js");
const { _internals } = await import("../utils/excelStyled.js");

const { loadWorkbook, cellToJson, lastUsedCol } = _internals;

/**
 * importExcelSource - parses the ORIGINAL workbooks ONCE and stores their styled rows in
 * Mongo (SourceRow / SourceCourseBlock), so the editing pages read plain documents
 * instead of re-parsing .xlsx on every request.
 *
 * Idempotent: re-running replaces the rows of each file it processes.
 *
 *   node src/scripts/importExcelSource.js            # all known files
 *   node src/scripts/importExcelSource.js מורן.xlsx  # just one
 */

// The reps' deal workbooks are ROW-oriented (header in row 1, one deal per row).
const ROW_FILES = [
  "מיכל.xlsx",
  "מורן.xlsx",
  "מיכל - פרטי מרשמים.xlsx",
  "מורן פרטי נרשמים.xlsx",
];
// יקיר's course workbook is COLUMN-oriented (one column per course).
const COLUMN_FILES = ["קורסים.xlsx"];

const MAX_COLS = 32;
const isBlankRow = (cells) => cells.every((c) => !c.v || !String(c.v).trim());

/** Import every non-empty row of a workbook's FIRST sheet (that's the sheet the live
 *  reader uses when a deal carries no explicit sheet name). */
async function importRowFile(file) {
  const wb = await loadWorkbook(file);
  const ws = wb.worksheets[0];
  if (!ws) {
    console.log(`  ⚠ ${file}: no worksheet`);
    return 0;
  }
  const width = Math.max(lastUsedCol(ws.getRow(1), MAX_COLS), 1);

  const docs = [];
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= width; c += 1) cells.push(cellToJson(row.getCell(c)));
    if (r !== 1 && isBlankRow(cells)) continue; // skip empty rows (keep the header always)
    docs.push({ file, sheet: ws.name, row: r, isHeader: r === 1, cells });
  }

  await SourceRow.deleteMany({ file });
  // insertMany in chunks so a huge sheet doesn't build one enormous command
  for (let i = 0; i < docs.length; i += 500) {
    await SourceRow.insertMany(docs.slice(i, i + 500), { ordered: false });
  }
  console.log(
    `  ✓ ${file} · sheet "${ws.name}" · ${docs.length} rows (width ${width})`,
  );
  return docs.length;
}

/** Import each course COLUMN of יקיר's workbook as a labelled block. */
async function importColumnFile(file) {
  const wb = await loadWorkbook(file);
  let total = 0;
  await SourceCourseBlock.deleteMany({ file });

  for (const ws of wb.worksheets) {
    // Find the label column-A rows that start a block ("שם הקורס"), then read across.
    const nameRows = [];
    for (let r = 1; r <= Math.min(ws.rowCount, 400); r += 1) {
      const label = String(ws.getRow(r).getCell(1).text || "").trim();
      if (label === "שם הקורס") nameRows.push(r);
    }
    if (!nameRows.length) continue;

    const blocks = [];
    for (const r of nameRows) {
      const blockStart = "שם הקורס";
      for (let c = 2; c <= Math.min(ws.columnCount, 40); c += 1) {
        const courseName = String(ws.getRow(r).getCell(c).text || "").trim();
        if (!courseName) continue;
        const entries = [];
        let emptyStreak = 0;
        for (let rr = r; rr <= Math.min(ws.rowCount, r + 24); rr += 1) {
          const label = cellToJson(ws.getRow(rr).getCell(1));
          const value = cellToJson(ws.getRow(rr).getCell(c));
          if (rr > r && label.v?.trim() === blockStart) break; // next block starts
          const empty = !label.v?.trim() && !value.v?.trim();
          emptyStreak = empty ? emptyStreak + 1 : 0;
          if (emptyStreak >= 3) break;
          if (!empty) entries.push({ row: rr, label, value });
        }
        if (entries.length) {
          blocks.push({
            file,
            sheet: ws.name,
            column: c,
            startRow: r,
            courseName,
            entries,
          });
        }
      }
    }
    // Blocks repeat down the sheet reusing column numbers, so dedup by COURSE NAME
    // (keeping the richest block) - keying by column would drop most of the courses.
    const byName = new Map();
    for (const b of blocks) {
      const cur = byName.get(b.courseName);
      if (!cur || b.entries.length > cur.entries.length)
        byName.set(b.courseName, b);
    }
    const list = [...byName.values()];
    if (list.length) {
      await SourceCourseBlock.insertMany(list, { ordered: false });
      console.log(
        `  ✓ ${file} · sheet "${ws.name}" · ${list.length} course columns`,
      );
      total += list.length;
    }
  }
  return total;
}

const run = async () => {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  await connectDB();

  const rowFiles = only.length
    ? ROW_FILES.filter((f) => only.includes(f))
    : ROW_FILES;
  const colFiles = only.length
    ? COLUMN_FILES.filter((f) => only.includes(f))
    : COLUMN_FILES;

  console.log("📥 ייבוא נתוני מקור מהאקסלים למונגו");
  let rows = 0;
  for (const f of rowFiles) {
    try {
      rows += await importRowFile(f);
    } catch (err) {
      console.log(`  ⚠ ${f}: ${err.message}`);
    }
  }
  let blocks = 0;
  for (const f of colFiles) {
    try {
      blocks += await importColumnFile(f);
    } catch (err) {
      console.log(`  ⚠ ${f}: ${err.message}`);
    }
  }

  console.log(`\nסה"כ: ${rows} שורות, ${blocks} עמודות קורס`);
  console.log("SourceRow docs:", await SourceRow.countDocuments());
  console.log(
    "SourceCourseBlock docs:",
    await SourceCourseBlock.countDocuments(),
  );
  await disconnectDB();
};

run().catch(async (err) => {
  console.error("❌ הייבוא נכשל:", err.message);
  try {
    await disconnectDB();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
