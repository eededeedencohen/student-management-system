/**
 * auditMoney.js — בדיקה מקיפה של נכונות הכספים בכל הרשומות.
 * מאמת אינווריאנטים, ומצליב מול קבצי האקסל הגולמיים כדי לתפוס תאי-"יתרה" טקסטואליים.
 *   node src/scripts/auditMoney.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');
const { isNoisyNumber, cleanStr } = await import('../utils/normalize.js');

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../../');
const EPS = 1.0;

await connectDB();
const regs = await Registration.find({ recordType: 'registration' }).lean();
console.log(`\nבודק ${regs.length} עסקאות (recordType=registration)…\n`);

// ---- raw Excel: map sourceFile -> {row -> {balanceCell, finalCell}} ----
const COLS = { balanceDue: 8, finalBalance: 11 };
const raw = {};
for (const file of ['מורן.xlsx', 'מיכל.xlsx']) {
  try {
    const wb = XLSX.readFile(path.join(DATA_DIR, file));
    const ws = wb.Sheets[wb.SheetNames.find((n) => n === '924' || n === 'גיליון1') || wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
    raw[file] = rows;
  } catch (e) {
    console.warn('cannot read', file, e.message);
  }
}

const violations = { inv: [], neg: [], over: [], status: [], noisyBad: [] };
let total0 = 0;
let noisyCells = 0;
let sumTotal = 0, sumPaid = 0, sumOut = 0;

for (const r of regs) {
  const t = r.totalAmount || 0;
  const paid = r.totalPaid || 0;
  const out = r.outstanding || 0;

  if (paid < -EPS) violations.neg.push(r);
  if (out < -EPS) violations.neg.push(r);

  if (t > 0) {
    sumTotal += t; sumPaid += paid; sumOut += out;
    // INV1: paid + outstanding == total
    if (Math.abs(paid + out - t) > EPS) violations.inv.push({ r, expected: t - paid, got: out });
    // INV3: outstanding never exceeds total
    if (out > t + EPS) violations.over.push(r);
    // INV5: status consistency
    const expStatus = out <= 0.5 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    if (r.paymentStatus !== expStatus) violations.status.push({ r, expStatus });
  } else {
    total0 += 1;
  }

  // cross-check raw balance cells: if the source cell was prose, outstanding must NOT
  // equal a small number derived from that text — it must equal total - paid.
  const sheet = raw[r.sourceFile];
  if (sheet && r.sourceRow) {
    const row = sheet[r.sourceRow - 1] || [];
    const balCell = cleanStr(row[COLS.balanceDue]);
    const finCell = cleanStr(row[COLS.finalBalance]);
    if (isNoisyNumber(balCell) || isNoisyNumber(finCell)) {
      noisyCells += 1;
      if (t > 0 && Math.abs(out - (t - paid)) > EPS) {
        violations.noisyBad.push({ r, balCell });
      }
    }
  }
}

const show = (arr, fmt) => arr.slice(0, 6).forEach((x) => console.log('     ' + fmt(x)));

console.log('═══════════════ תוצאות הבדיקה ═══════════════');
console.log(`✔ עסקאות עם סכום ידוע (total>0): ${regs.length - total0}`);
console.log(`• עסקאות ללא סכום במקור (total=0): ${total0}  (לא ניתן להחיל אינווריאנט)`);
console.log(`• תאי "יתרה" טקסטואליים שזוהו במקור: ${noisyCells}`);
console.log('');
console.log(`INV1  paid+outstanding==total  → הפרות: ${violations.inv.length}`);
show(violations.inv, (x) => `${x.r.sourceFile}#${x.r.sourceRow} ${x.r.studentName}: total=${x.r.totalAmount} paid=${x.r.totalPaid} out=${x.r.outstanding} (צפוי ${x.expected})`);
console.log(`INV3  outstanding<=total      → הפרות: ${violations.over.length}`);
show(violations.over, (r) => `${r.sourceFile}#${r.sourceRow} ${r.studentName}: out=${r.outstanding} > total=${r.totalAmount}`);
console.log(`INV2  ערכים שליליים           → הפרות: ${violations.neg.length}`);
console.log(`INV5  סטטוס תשלום עקבי         → הפרות: ${violations.status.length}`);
show(violations.status, (x) => `${x.r.sourceFile}#${x.r.sourceRow} ${x.r.studentName}: status=${x.r.paymentStatus} (צפוי ${x.expStatus})`);
console.log(`BUG   תאים טקסטואליים עם יתרה שגויה → הפרות: ${violations.noisyBad.length}`);
show(violations.noisyBad, (x) => `${x.r.sourceFile}#${x.r.sourceRow} ${x.r.studentName}: out=${x.r.outstanding} | תא מקור="${x.balCell}"`);
console.log('');
console.log('─ פילוח כספי (total>0 בלבד) ─');
console.log(`  סה"כ עסקאות: ${Math.round(sumTotal).toLocaleString()} ₪`);
console.log(`  נגבה:        ${Math.round(sumPaid).toLocaleString()} ₪`);
console.log(`  בחוץ:        ${Math.round(sumOut).toLocaleString()} ₪`);
console.log(`  בדיקת איזון: נגבה+בחוץ = ${Math.round(sumPaid + sumOut).toLocaleString()} ₪  (צריך = סה"כ ${Math.round(sumTotal).toLocaleString()} ₪) → ${Math.abs(sumPaid + sumOut - sumTotal) < 5 ? 'תקין ✔' : 'פער!'}`);

await disconnectDB();
process.exit(0);
