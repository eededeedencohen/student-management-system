/**
 * exportStudentFiles.js — one Excel file per student, holding that student's ORIGINAL rows
 * from מיכל.xlsx / מורן.xlsx, faithful to the source: same values, **same cell background /
 * font colors**, right-to-left sheet, and columns auto-sized to fit the text.
 *
 * Uses exceljs (the community `xlsx` package can't read/write cell styles).
 *
 *   node src/scripts/exportStudentFiles.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import ExcelJS from 'exceljs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const ROOT = path.resolve(__dirname, '../../../'); // project root — where the source Excel files live
const OUT_DIR = path.join(ROOT, 'קבצי-סטודנטים');
const SOURCES = ['מורן.xlsx', 'מיכל.xlsx'];

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');
const { default: Student } = await import('../models/Student.js');

await connectDB();

// 1) load source workbooks WITH styles
const srcWbs = {};
for (const f of SOURCES) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(ROOT, f));
  srcWbs[f] = wb;
}
const getSheet = (file, sheetName) => {
  const wb = srcWbs[file];
  return (sheetName && wb.getWorksheet(sheetName)) || wb.worksheets[0];
};

const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : o);
const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString('he-IL');
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v.hyperlink != null) return String(v.text ?? v.hyperlink);
    return '';
  }
  return String(v);
};
// copy value + full style (fill, font, alignment, border, numFmt); force wrap for readability
const copyCell = (src, dst) => {
  let v = src.value;
  // formula / shared-formula cells reference other cells that won't exist in the per-student
  // file → flatten to the computed result so the displayed value stays faithful.
  if (v && typeof v === 'object' && (v.formula != null || v.sharedFormula != null || v.shareType != null)) {
    v = v.result != null ? v.result : null;
  }
  dst.value = v;
  const st = clone(src.style) || {};
  st.alignment = { ...(st.alignment || {}), wrapText: true, vertical: (st.alignment && st.alignment.vertical) || 'top' };
  dst.style = st;
};

// 2) all source-derived records, grouped by student
const regs = await Registration.find({ sourceFile: { $in: SOURCES }, sourceRow: { $ne: null } })
  .select('student studentName sourceFile sourceSheet sourceRow')
  .lean();
const students = await Student.find({}).select('fullName').lean();
const nameById = new Map(students.map((s) => [String(s._id), s.fullName]));

const groups = new Map();
for (const r of regs) {
  const key = r.student ? String(r.student) : `name:${r.studentName}`;
  const name = (r.student && nameById.get(String(r.student))) || r.studentName || 'ללא שם';
  if (!groups.has(key)) groups.set(key, { name, regs: [] });
  groups.get(key).regs.push(r);
}

// 2b) "תקינים" = students who paid EVERY course they bought in a single full payment
//     (fully paid, no installments, no schedule, exactly one payment record).
const dealRows = await Registration.find({ recordType: 'registration', student: { $ne: null } })
  .select('student installments installmentPlan payments totalAmount outstanding')
  .lean();
const isSinglePayment = (d) =>
  d.totalAmount > 0 &&
  d.outstanding <= 0.5 &&
  !(d.installments > 1) &&
  (d.installmentPlan || []).length === 0 &&
  (d.payments || []).length <= 1;
const dealsByStudent = new Map();
for (const d of dealRows) {
  const k = String(d.student);
  if (!dealsByStudent.has(k)) dealsByStudent.set(k, []);
  dealsByStudent.get(k).push(d);
}
const singleStudents = new Set();
for (const [k, ds] of dealsByStudent) if (ds.length && ds.every(isSinglePayment)) singleStudents.add(k);

// 3) fresh output folders (main + תקינים subfolder)
const OK_DIR = path.join(OUT_DIR, 'תקינים');
const cleanDir = (dir) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.xlsx') || f.startsWith('~$')) continue; // skip Excel lock/temp files
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      /* open in Excel — will be overwritten or skipped */
    }
  }
};
cleanDir(OUT_DIR);
cleanDir(OK_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(OK_DIR, { recursive: true });

const sanitizeFile = (s) =>
  String(s || 'ללא-שם').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'ללא-שם';
const sanitizeSheet = (s) => String(s).replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'מקור';

const used = new Set();
const skipped = [];
let written = 0;
let okWritten = 0;
let rowsTotal = 0;
for (const [key, g] of groups) {
  const byFile = new Map();
  for (const r of g.regs) {
    if (!byFile.has(r.sourceFile)) byFile.set(r.sourceFile, []);
    byFile.get(r.sourceFile).push(r);
  }

  const outWb = new ExcelJS.Workbook();
  for (const [file, rows] of byFile) {
    rows.sort((a, b) => (a.sourceRow || 0) - (b.sourceRow || 0));
    const headSheet = getSheet(file, rows[0].sourceSheet);

    // effective column count = widest of header + this student's rows
    let colCount = headSheet.getRow(1).cellCount;
    for (const r of rows) colCount = Math.max(colCount, getSheet(file, r.sourceSheet).getRow(r.sourceRow).cellCount);
    colCount = Math.max(colCount, 1);
    const refCol = colCount + 1; // trailing "שורה במקור" column (keeps source layout intact)

    const ws = outWb.addWorksheet(sanitizeSheet(file.replace('.xlsx', '')), {
      views: [{ rightToLeft: true }],
    });
    const widths = new Array(refCol).fill(6);

    // header row (row 1) — copy from source with its styling
    const srcHeader = headSheet.getRow(1);
    const outHeader = ws.getRow(1);
    for (let c = 1; c <= colCount; c++) {
      copyCell(srcHeader.getCell(c), outHeader.getCell(c));
      widths[c - 1] = Math.max(widths[c - 1], cellText(srcHeader.getCell(c).value).length);
    }
    const refHead = outHeader.getCell(refCol);
    refHead.value = 'שורה במקור';
    refHead.font = { bold: true };
    refHead.alignment = { wrapText: true, vertical: 'top' };
    widths[refCol - 1] = Math.max(widths[refCol - 1], 'שורה במקור'.length);
    outHeader.commit();

    // data rows — copy each source row with its styling
    let outR = 2;
    for (const r of rows) {
      const srcRow = getSheet(file, r.sourceSheet).getRow(r.sourceRow);
      const dstRow = ws.getRow(outR++);
      for (let c = 1; c <= colCount; c++) {
        copyCell(srcRow.getCell(c), dstRow.getCell(c));
        widths[c - 1] = Math.max(widths[c - 1], cellText(srcRow.getCell(c).value).length);
      }
      const refCell = dstRow.getCell(refCol);
      refCell.value = r.sourceRow;
      refCell.alignment = { vertical: 'top' };
      dstRow.commit();
      rowsTotal += 1;
    }

    // auto-fit column widths (clamped so a long note wraps instead of stretching forever)
    for (let c = 1; c <= refCol; c++) {
      ws.getColumn(c).width = Math.min(Math.max(widths[c - 1] + 2, 8), 48);
    }
  }

  let base = sanitizeFile(g.name);
  let fname = base;
  let n = 2;
  while (used.has(fname.toLowerCase())) fname = `${base} (${n++})`;
  used.add(fname.toLowerCase());
  const mainPath = path.join(OUT_DIR, `${fname}.xlsx`);
  let mainOk = false;
  try {
    await outWb.xlsx.writeFile(mainPath);
    written += 1;
    mainOk = true;
  } catch {
    skipped.push(fname); // file open in Excel / locked — skip it this run
  }
  // students who paid every course in one payment → also copy into תקינים
  if (mainOk && singleStudents.has(key)) {
    try {
      fs.copyFileSync(mainPath, path.join(OK_DIR, `${fname}.xlsx`));
      okWritten += 1;
    } catch {
      /* ignore */
    }
  }
}

console.log(`✅ נוצרו ${written} קבצי סטודנטים (${rowsTotal} שורות מקור) עם RTL, צבעים מקוריים ורוחב אוטומטי:`);
console.log(`   ${OUT_DIR}`);
console.log(`📁 מתוכם ${okWritten} "תקינים" (שילמו בתשלום אחד עבור כל קורס) → ${OK_DIR}`);
if (skipped.length) console.log(`⚠️  דילוג (פתוחים ב-Excel): ${skipped.join(', ')} — סגור אותם והרץ שוב.`);
await disconnectDB();
process.exit(0);
