import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

/**
 * Styled reads from the reps'/יקיר's ORIGINAL Excel workbooks (project root) so the
 * editing pages can show exactly what was written — including fill colors, font
 * colors and bold — verbatim.
 *
 * Verified against the real files: fills arrive as argb (FFFFFF00 yellow,
 * FF00FF00 green...), fonts as argb or theme+tint. Theme colors are resolved with
 * the standard Office palette (close enough visually; the files mostly use argb).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/utils → three levels up = project root, where the xlsx files live
const EXCEL_DIR = process.env.EXCEL_DIR || path.resolve(__dirname, '../../..');

// Standard Office theme palette (indices 0-9: lt1, dk1, lt2, dk2, accent1-6)
const THEME_RGB = [
  'FFFFFF', '000000', 'E7E6E6', '44546A',
  '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47',
];

const applyTint = (hex, tint) => {
  if (!tint) return hex;
  const ch = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const out = ch.map((c) => {
    const v = tint > 0 ? c + (255 - c) * tint : c * (1 + tint);
    return Math.max(0, Math.min(255, Math.round(v)));
  });
  return out.map((c) => c.toString(16).padStart(2, '0')).join('');
};

/** exceljs color object → CSS hex ("#RRGGBB") or null. */
const colorToCss = (c) => {
  if (!c) return null;
  if (c.argb) {
    const argb = String(c.argb).toUpperCase();
    if (argb.length !== 8 || argb.startsWith('00')) return null; // fully transparent
    return `#${argb.slice(2)}`;
  }
  if (c.theme !== undefined) {
    const base = THEME_RGB[c.theme];
    if (!base) return null;
    return `#${applyTint(base, c.tint || 0)}`;
  }
  return null;
};

const pad2 = (n) => String(n).padStart(2, '0');

/** Cell text — dates as DD/MM/YYYY instead of the raw JS Date string. */
const cellText = (cell) => {
  const val = cell.value;
  const d = val instanceof Date ? val : val?.result instanceof Date ? val.result : null;
  if (d && !Number.isNaN(d.getTime())) {
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
  const t = String(cell.text ?? '');
  // תאים פתולוגיים (למשל מחרוזת נקודה-פסיק ארוכה שנשארה בקובץ) לא ישברו את התצוגה
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
};

/** A single cell → plain style/value object for the client. */
const cellToJson = (cell) => {
  const fill = cell.fill?.type === 'pattern' ? colorToCss(cell.fill.fgColor) : null;
  const font = cell.font || {};
  return {
    v: cellText(cell),
    bg: fill,
    color: colorToCss(font.color),
    bold: Boolean(font.bold),
    italic: Boolean(font.italic),
    strike: Boolean(font.strike),
  };
};

// Parsed-workbook cache: the files are static during a session and exceljs parsing
// is the slow part. Keyed by basename; invalidated when the file's mtime changes.
const wbCache = new Map();

async function loadWorkbook(sourceFile) {
  const base = path.basename(String(sourceFile || ''));
  if (!base.toLowerCase().endsWith('.xlsx')) throw new Error('קובץ מקור לא נתמך');
  const full = path.join(EXCEL_DIR, base);
  if (!fs.existsSync(full)) throw new Error(`קובץ המקור "${base}" לא נמצא`);
  const mtime = fs.statSync(full).mtimeMs;
  const hit = wbCache.get(base);
  if (hit && hit.mtime === mtime) return hit.promise;
  const promise = (async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(full);
    return wb;
  })();
  // כישלון קריאה לא נשמר במטמון — אחרת תקלה חולפת אחת "הורגת" את התצוגה לכל החיים
  promise.catch(() => {
    if (wbCache.get(base)?.promise === promise) wbCache.delete(base);
  });
  wbCache.set(base, { mtime, promise });
  return promise;
}

const pickSheet = (wb, sheetName) =>
  (sheetName && wb.getWorksheet(sheetName)) || wb.worksheets[0];

/** Last meaningful column of a row (bounded), so blank tails don't bloat the payload. */
const lastUsedCol = (row, cap = 24) => {
  let last = 0;
  for (let c = 1; c <= cap; c += 1) {
    const t = cellText(row.getCell(c));
    if (t && String(t).trim() !== '') last = c;
  }
  return last;
};

/**
 * Rows from a workbook WITH styling. Returns { headers, rows } where headers is the
 * styled header row (row 1) and rows = [{ row, cells: [...] }] for the requested rows.
 */
export async function getStyledRows(sourceFile, sheetName, rowNumbers) {
  const wb = await loadWorkbook(sourceFile);
  const ws = pickSheet(wb, sheetName);
  if (!ws) throw new Error('הגיליון לא נמצא');

  const headerRow = ws.getRow(1);
  const width = Math.max(lastUsedCol(headerRow), 1);
  const rowToJson = (r) => {
    const row = ws.getRow(r);
    const cells = [];
    for (let c = 1; c <= width; c += 1) cells.push(cellToJson(row.getCell(c)));
    return cells;
  };

  const wanted = [...new Set(rowNumbers)]
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= ws.rowCount)
    .sort((a, b) => a - b)
    .slice(0, 30); // sanity cap

  return {
    file: path.basename(sourceFile),
    sheet: ws.name,
    headers: rowToJson(1),
    rows: wanted.map((r) => ({ row: r, cells: rowToJson(r) })),
  };
}

/**
 * יקיר's קורסים.xlsx is COLUMN-oriented (each course is a column; attribute labels
 * sit in column A). Find the column whose header cell matches one of `names` and
 * return a vertical label/value block with styling.
 */
export async function getStyledColumnByName(sourceFile, names) {
  const wb = await loadWorkbook(sourceFile);
  const targets = names.map((n) => String(n || '').trim()).filter(Boolean);
  if (!targets.length) return null;

  for (const ws of wb.worksheets) {
    const maxR = Math.min(ws.rowCount, 80);
    for (let r = 1; r <= maxR; r += 1) {
      const row = ws.getRow(r);
      for (let c = 2; c <= Math.min(ws.columnCount, 40); c += 1) {
        const t = String(row.getCell(c).text || '').trim();
        if (!t || !targets.includes(t)) continue;
        // hit: collect the vertical block for column c, labels from column A.
        // הגיליון בנוי בלוקים החוזרים על עצמם (כל בלוק פותח ב"שם הקורס"), ולכן
        // מתחילים בשורת ההתאמה עצמה ועוצרים כשמתחיל הבלוק הבא — אחרת נגררים
        // לתוך הפלט נתונים של קורסים אחרים.
        const blockStart = String(ws.getRow(r).getCell(1).text || '').trim();
        const entries = [];
        let emptyStreak = 0;
        for (let rr = r; rr <= Math.min(ws.rowCount, r + 24); rr += 1) {
          const label = cellToJson(ws.getRow(rr).getCell(1));
          const value = cellToJson(ws.getRow(rr).getCell(c));
          if (rr > r && blockStart && label.v?.trim() === blockStart) break; // הבלוק הבא
          const empty = !label.v?.trim() && !value.v?.trim();
          emptyStreak = empty ? emptyStreak + 1 : 0;
          if (emptyStreak >= 3) break;
          if (!empty) entries.push({ row: rr, label, value });
        }
        return { file: path.basename(sourceFile), sheet: ws.name, column: c, entries };
      }
    }
  }
  return null;
}

/**
 * Low-level access for the importer (scripts/importExcelSource.js): the parsed workbook
 * plus the exact same cell→JSON converter the request path uses, so what we store in
 * Mongo is identical to what the live reader would have produced.
 */
export const _internals = { loadWorkbook, cellToJson, lastUsedCol };
