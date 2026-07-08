/**
 * lookupRow.js — שולף רשומה לפי שורת המקור באקסל, ומציג גם את השורה הגולמית מהקובץ.
 * שימוש:
 *   node src/scripts/lookupRow.js <שורה> [קובץ]
 * דוגמה:
 *   node src/scripts/lookupRow.js 52            (ברירת מחדל: מורן.xlsx)
 *   node src/scripts/lookupRow.js 494 מיכל.xlsx
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');
const { default: Expense } = await import('../models/Expense.js');
// import (and thereby register) the referenced models so .populate() works
await import('../models/User.js');
await import('../models/Course.js');
await import('../models/Student.js');

const row = parseInt(process.argv[2] || '52', 10);
const file = process.argv[3] || 'מורן.xlsx';
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../../');

await connectDB();

// 1) the stored DB record (registration, or expense if the row was advertising)
const reg = await Registration.findOne({ sourceFile: file, sourceRow: row })
  .populate('rep', 'name')
  .populate('course', 'name field')
  .lean();
const exp = reg ? null : await Expense.findOne({ sourceFile: file, sourceRow: row }).lean();
const dbDoc = reg || exp;

console.log('\n================ DB RECORD :: ' + file + ' שורה ' + row + ' ================');
if (!dbDoc) console.log('(לא נמצאה רשומה במסד עבור שורה זו)');
else console.log(JSON.stringify(dbDoc, null, 2));

// 2) the raw Excel row (1-based row -> 0-based index row-1; row 1 = header)
const wb = XLSX.readFile(path.join(DATA_DIR, file));
const sheetName = dbDoc?.sourceSheet && wb.Sheets[dbDoc.sourceSheet] ? dbDoc.sourceSheet : wb.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: null, raw: false });
const header = rows[0] || [];
const raw = rows[row - 1] || [];

console.log('\n================ RAW EXCEL :: ' + file + ' / גליון ' + sheetName + ' / שורה ' + row + ' ================');
let any = false;
header.forEach((h, i) => {
  const v = raw[i];
  if (v !== null && v !== undefined && String(v).trim() !== '') {
    any = true;
    console.log('  עמודה ' + i + ' [' + (h || '—') + ']: ' + v);
  }
});
if (!any) console.log('(השורה ריקה בקובץ)');

await disconnectDB();
process.exit(0);
