import ExcelJS from "exceljs";

/**
 * excelExport - בניית קובצי ייצוא קריאים בעברית.
 *
 * כל גיליון נבנה מימין לשמאל (rightToLeft) עם שורת כותרת צבועה וקפואה, פסי זברה,
 * גבולות דקים, רוחב עמודה שמותאם לתוכן, פורמטים למספרים/כספים/תאריכים, צביעת
 * סטטוסים, שורת סיכום ו-AutoFilter - כך שהקובץ שנפתח באקסל קריא מיד, בלי סידור ידני.
 *
 * columns: [{ header, key, type?, width? }]
 *   type: 'text' (ברירת מחדל) | 'money' | 'int' | 'date' | 'status' | 'bool'
 * rows: אובייקטים עם אותם keys. תאריכים מועברים כ-Date (או null).
 */

// צבעי המותג של המערכת (theme.js: primary #0f766e)
const BRAND = "FF0F766E"; // teal - רקע כותרות
const BRAND_DARK = "FF115E59";
const ZEBRA = "FFF2F7F6"; // ירקרק-אפור עדין לשורות מפוספסות
const BORDER = "FFD5DEDC";
const TITLE_BG = "FFE6F2F0";

// צביעת ערכי סטטוס תשלום - רקע פסטל + פונט כהה תואם
const STATUS_STYLES = {
  שולם: { bg: "FFDCFCE7", font: "FF166534" },
  חלקי: { bg: "FFFEF9C3", font: "FF854D0E" },
  "לא שולם": { bg: "FFFEE2E2", font: "FF991B1B" },
};

const thinBorder = {
  top: { style: "thin", color: { argb: BORDER } },
  bottom: { style: "thin", color: { argb: BORDER } },
  left: { style: "thin", color: { argb: BORDER } },
  right: { style: "thin", color: { argb: BORDER } },
};

/**
 * רוחב עמודה לפי התוכן בפועל: אורך הכותרת או הערך הארוך ביותר. תווים עבריים
 * רחבים מעט מלטיניים באקסל, לכן מקדם 1.15. נתחם כדי שעמודת "הערות" לא תשתלט.
 */
// מינימום 10 ולא 9: רוחב 9 הוא ברירת המחדל של exceljs ולכן מושמט מהקובץ בכתיבה,
// והעמודה נפתחת באקסל ברוחב 8.43 הצר מדי לכותרות מודגשות בעברית.
const fitWidth = (header, values, { min = 10, max = 42 } = {}) => {
  const lens = [
    String(header || "").length * 1.2,
    ...values.map((v) => String(v ?? "").length),
  ];
  const longest = Math.max(...lens, 0);
  const hebrewFactor = 1.15;
  return Math.min(Math.max(Math.ceil(longest * hebrewFactor) + 2, min), max);
};

const CELL_ALIGN = {
  money: { horizontal: "center", vertical: "middle" },
  int: { horizontal: "center", vertical: "middle" },
  date: { horizontal: "center", vertical: "middle" },
  status: { horizontal: "center", vertical: "middle" },
  bool: { horizontal: "center", vertical: "middle" },
  text: { horizontal: "right", vertical: "middle", wrapText: true },
};

/**
 * בונה Workbook מעוצב. מחזיר את ה-workbook (לשליחה או לבדיקה).
 * title/subtitle מוצגים בראש הגיליון כדי שיהיה ברור מה בדיוק יוצא ומתי.
 */
export const buildStyledWorkbook = ({
  sheetName = "גיליון",
  title,
  subtitle,
  columns,
  rows,
  totals = [], // keys של עמודות money לסיכום בשורה אחרונה
}) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "מכללת ספרא";
  wb.created = new Date();

  const ws = wb.addWorksheet(String(sheetName).slice(0, 31), {
    views: [{ rightToLeft: true }],
    properties: { defaultRowHeight: 18 },
  });

  const nCols = columns.length;
  let rowIdx = 1;

  // --- שורת כותרת ראשית (מוזגה על כל הרוחב) ---
  if (title) {
    ws.mergeCells(rowIdx, 1, rowIdx, nCols);
    const c = ws.getCell(rowIdx, 1);
    c.value = title;
    c.font = {
      name: "Arial",
      size: 14,
      bold: true,
      color: { argb: BRAND_DARK },
    };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TITLE_BG } };
    c.alignment = { horizontal: "right", vertical: "middle" };
    ws.getRow(rowIdx).height = 26;
    rowIdx += 1;
  }
  if (subtitle) {
    ws.mergeCells(rowIdx, 1, rowIdx, nCols);
    const c = ws.getCell(rowIdx, 1);
    c.value = subtitle;
    c.font = {
      name: "Arial",
      size: 10,
      italic: true,
      color: { argb: "FF64748B" },
    };
    c.alignment = { horizontal: "right", vertical: "middle" };
    rowIdx += 1;
  }

  // --- שורת כותרות העמודות ---
  const headerRowIdx = rowIdx;
  const headerRow = ws.getRow(headerRowIdx);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = {
      name: "Arial",
      size: 11,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND } };
    cell.alignment = {
      horizontal: "center",
      vertical: "middle",
      wrapText: true,
    };
    cell.border = thinBorder;
  });
  headerRow.height = 22;
  rowIdx += 1;

  // --- שורות הנתונים ---
  const firstDataRow = rowIdx;
  rows.forEach((r, i) => {
    const row = ws.getRow(rowIdx);
    columns.forEach((col, cI) => {
      const cell = row.getCell(cI + 1);
      const v = r[col.key];
      const type = col.type || "text";

      if (type === "money") {
        cell.value = typeof v === "number" ? v : Number(v) || 0;
        cell.numFmt = '#,##0 "₪";[Red]-#,##0 "₪"';
      } else if (type === "int") {
        cell.value = v === "" || v == null ? "" : Number(v);
      } else if (type === "date") {
        cell.value =
          v instanceof Date && !Number.isNaN(v.getTime()) ? v : v || "";
        if (cell.value instanceof Date) cell.numFmt = "dd/mm/yyyy";
      } else {
        cell.value = v == null ? "" : v;
      }

      cell.font = { name: "Arial", size: 11, color: { argb: "FF1F2937" } };
      cell.alignment = CELL_ALIGN[type] || CELL_ALIGN.text;
      cell.border = thinBorder;
      // פסי זברה - קריאות בשורות ארוכות
      if (i % 2 === 1) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: ZEBRA },
        };
      }
      // צביעת סטטוס (שולם/חלקי/לא שולם)
      if (type === "status" && STATUS_STYLES[v]) {
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: STATUS_STYLES[v].bg },
        };
        cell.font = {
          name: "Arial",
          size: 11,
          bold: true,
          color: { argb: STATUS_STYLES[v].font },
        };
      }
    });
    rowIdx += 1;
  });

  // --- אין נתונים ---
  if (rows.length === 0) {
    ws.mergeCells(rowIdx, 1, rowIdx, nCols);
    const c = ws.getCell(rowIdx, 1);
    c.value = "אין נתונים לייצוא לפי הסינון שנבחר";
    c.font = {
      name: "Arial",
      size: 11,
      italic: true,
      color: { argb: "FF64748B" },
    };
    c.alignment = { horizontal: "center", vertical: "middle" };
    rowIdx += 1;
  }

  // --- שורת סיכום לעמודות כספיות ---
  if (totals.length && rows.length) {
    const row = ws.getRow(rowIdx);
    columns.forEach((col, cI) => {
      const cell = row.getCell(cI + 1);
      cell.border = {
        ...thinBorder,
        top: { style: "double", color: { argb: BRAND } },
      };
      if (cI === 0) {
        cell.value = `סה"כ (${rows.length} שורות)`;
        cell.font = {
          name: "Arial",
          size: 11,
          bold: true,
          color: { argb: BRAND_DARK },
        };
        cell.alignment = { horizontal: "right", vertical: "middle" };
      } else if (totals.includes(col.key)) {
        const colLetter = ws.getColumn(cI + 1).letter;
        cell.value = {
          formula: `SUM(${colLetter}${firstDataRow}:${colLetter}${rowIdx - 1})`,
        };
        cell.numFmt = '#,##0 "₪";[Red]-#,##0 "₪"';
        cell.font = {
          name: "Arial",
          size: 11,
          bold: true,
          color: { argb: BRAND_DARK },
        };
        cell.alignment = { horizontal: "center", vertical: "middle" };
      }
    });
    row.height = 20;
  }

  // --- רוחבי עמודות לפי תוכן, הקפאת כותרת ופילטר ---
  columns.forEach((col, i) => {
    const values = rows.map((r) => {
      const v = r[col.key];
      if (col.type === "money") return "9,999,999 ₪";
      if (col.type === "date") return "99/99/9999";
      return v;
    });
    ws.getColumn(i + 1).width = col.width || fitWidth(col.header, values);
  });
  ws.views = [
    {
      rightToLeft: true,
      state: "frozen",
      ySplit: headerRowIdx,
      activeCell: "A1",
    },
  ];
  ws.autoFilter = {
    from: { row: headerRowIdx, column: 1 },
    to: { row: headerRowIdx, column: nCols },
  };

  return wb;
};

/** שולח workbook כ-attachment עם שם קובץ בעברית (RFC 5987). */
export const sendStyledWorkbook = async (res, fileName, opts) => {
  const wb = buildStyledWorkbook(opts);
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}.xlsx`,
  );
  return res.send(Buffer.from(buffer));
};
