/**
 * importExcel.js - מייבא את שלושת קבצי האקסל למסד הנתונים (MongoDB).
 *
 *   node src/scripts/importExcel.js
 *
 * הסקריפט:
 *   1. קורא את מורן.xlsx, מיכל.xlsx, קורסים.xlsx
 *   2. מנרמל את הנתונים (שמות קורסים, אופן תשלום, תאריכים, מספרים)
 *   3. יוצר Users (מנהל + 2 נציגות), Courses, Students, Registrations, Expenses
 *   4. מנקה ייבוא קודם (לפי sourceFile) כדי שאפשר להריץ שוב בבטחה
 *
 * הערה על שנים: לקובץ של מורן אין שנה בתאריכים ("1/2"). אנו משלימים שנה לפי
 * סדר השורות (rollover כשהחודש "חוזר אחורה") ומסמנים dateAssumed=true.
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { connectDB, disconnectDB } = await import("../config/db.js");
const { default: User } = await import("../models/User.js");
const { default: Student } = await import("../models/Student.js");
const { default: Course } = await import("../models/Course.js");
const { default: Registration } = await import("../models/Registration.js");
const { default: Expense } = await import("../models/Expense.js");
const {
  parseNumber,
  parseDate,
  normalizeCourse,
  parsePaymentMethod,
  splitName,
  isYes,
  cleanStr,
  isNoisyNumber,
  parseInstallmentPlan,
  parseInstallmentMarker,
} = await import("../utils/normalize.js");

/** Build dated installment items from a parsed plan. */
const buildInstallmentItems = (plan, { dealDate, remaining }) => {
  const { count, amount, dayOfMonth, startRaw, method } = plan;
  const per =
    amount && amount > 0
      ? amount
      : remaining > 0
        ? Math.round((remaining / count) * 100) / 100
        : 0;
  const base = dealDate || new Date();
  // Day of month: honor a day specified in the note; otherwise credit-card defaults to
  // the 7th (the credit company charges on the 7th), and other methods fall back to the
  // deal's own day.
  let day = dayOfMonth;
  if (day == null) day = method === "credit" ? 7 : base.getUTCDate();
  // Build a date on (year, month, day) clamping the day to the month's length so a "31"
  // never rolls into the next month (e.g. Feb).
  const monthDay = (y, m) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last)));
  };
  const fromDate = startRaw ? parseDate(startRaw).date : null;
  let startY = (fromDate || base).getUTCFullYear();
  let startM = (fromDate || base).getUTCMonth();
  if (!fromDate && monthDay(startY, startM) < base) startM += 1; // day already passed this month
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      index: i + 1,
      count,
      label: `${i + 1}/${count}`,
      dueDate: monthDay(startY, startM + i),
      amount: per,
      method,
      status: "pending",
    });
  }
  // Snap the plan to sum EXACTLY to the remaining balance: a rounded per-installment from
  // the note (e.g. 11×500=5,500) rarely equals the real balance (5,400), so absorb the
  // small difference into the last installment. A LARGE gap (≈ a whole installment) means a
  // missing deposit/component - leave it so the deal stays flagged as unbalanced.
  const sum = items.reduce((s, it) => s + it.amount, 0);
  const diff = Math.round((remaining - sum) * 100) / 100;
  if (items.length && Math.abs(diff) > 0.5 && Math.abs(diff) <= per + 0.5) {
    const last = items[items.length - 1];
    last.amount = Math.round((last.amount + diff) * 100) / 100;
  }
  return items;
};

const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "../../../");

const readSheet = (file, sheetName) => {
  const wb = XLSX.readFile(path.join(DATA_DIR, file));
  const sn = sheetName || wb.SheetNames[0];
  const ws = wb.Sheets[sn];
  const rows = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: null,
    raw: false,
  });
  return { rows, sheetName: sn };
};

const nonEmpty = (row) =>
  row && row.some((c) => c !== null && String(c).trim() !== "");

/** Build the payments array + derived money fields from raw deal columns. */
const buildMoney = ({
  total,
  advance,
  method1,
  advDateRaw,
  balanceDue,
  paidDateRaw,
  method2,
  finalBalance,
  paidInFull,
  hasFuturePlan,
  sourceFile,
  sourceRow,
}) => {
  const payments = [];
  const advDate = parseDate(advDateRaw);
  const paidDate = parseDate(paidDateRaw);
  const m1 = parsePaymentMethod(method1);
  const m2 = parsePaymentMethod(method2);

  if (advance > 0) {
    payments.push({
      amount: advance,
      method: m1.raw,
      methodCategory: m1.category,
      installments: m1.installments,
      date: advDate.date,
      dateRaw: advDate.raw,
      kind: "advance",
      source: `מקדמה (עמ' "שולמה מקדמה") · ${sourceFile} שורה ${sourceRow}`,
    });
  }
  // The balance is counted as COLLECTED only when (a) there is NO future installment plan
  // for it, AND (b) there is real evidence it happened: an explicit "paid on" date, or text
  // stating it was paid in full. When a future ERN/credit plan exists, the balance is NOT
  // yet collected - only the deposit is; the installment markers fold in real collections.
  let secondPaid = 0;
  if (!hasFuturePlan) {
    if (paidInFull) {
      secondPaid = Math.max(total - advance, 0);
    } else if (paidDate.date) {
      secondPaid =
        balanceDue > 0
          ? Math.max(balanceDue - finalBalance, 0)
          : Math.max(total - advance - finalBalance, 0);
    }
  }
  if (secondPaid > 0) {
    payments.push({
      amount: secondPaid,
      method: m2.raw || m1.raw,
      methodCategory: m2.category || m1.category,
      installments: m2.installments,
      date: paidDate.date,
      dateRaw: paidDate.raw,
      kind: "balance",
      source: paidInFull
        ? `יתרה (זוהה "שולם במלואו" בטקסט) · ${sourceFile} שורה ${sourceRow}`
        : `יתרה (עמ' "יתרה/שולמה בתאריך") · ${sourceFile} שורה ${sourceRow}`,
    });
  }

  const totalPaid =
    payments.reduce((s, p) => s + p.amount, 0) || (advance > 0 ? advance : 0);
  // Outstanding = how much of the deal is still uncollected = total − collected.
  let outstanding;
  if (paidInFull) outstanding = 0;
  else if (total > 0) outstanding = Math.max(total - totalPaid, 0);
  else if (finalBalance > 0) outstanding = finalBalance;
  else outstanding = balanceDue > 0 ? balanceDue : 0;

  let paymentStatus = "unpaid";
  if (total > 0 && outstanding <= 0.5) paymentStatus = "paid";
  else if (totalPaid > 0) paymentStatus = "partial";

  return {
    payments,
    totalPaid,
    outstanding,
    paymentStatus,
    primaryCategory: m1.category,
    installments: m1.installments,
  };
};

const run = async () => {
  console.log("-".repeat(60));
  console.log("📥  Safra Excel → MongoDB import");
  console.log("    data dir:", DATA_DIR);
  await connectDB();

  // 1) wipe previous import (idempotent) – only rows we created
  const del = await Promise.all([
    Registration.deleteMany({ sourceFile: { $exists: true } }),
    Course.deleteMany({ sourceFile: { $exists: true } }),
    Expense.deleteMany({ sourceFile: { $exists: true } }),
    Student.deleteMany({ sourceFile: { $exists: true } }),
  ]);
  console.log(
    `🧹  cleared prior import → reg:${del[0].deletedCount} course:${del[1].deletedCount} exp:${del[2].deletedCount} stud:${del[3].deletedCount}`,
  );

  // 2) users (manager + reps) – upsert by name
  const upsertUser = async (name, role, extra = {}) => {
    const doc = await User.findOneAndUpdate(
      { name },
      { $setOnInsert: { name, role, ...extra } },
      { new: true, upsert: true },
    );
    return doc;
  };
  const manager = await upsertUser("עדן", "manager", {
    email: "eededeedencohen@gmail.com",
  });
  const moran = await upsertUser("מורן", "rep", { aliases: ["מורן"] });
  const michal = await upsertUser("מיכל פרייס", "rep", {
    aliases: ["מיכל", "מיכל פרייס"],
  });
  console.log(
    `👤  users → manager:${manager.name}  reps: ${moran.name}, ${michal.name}`,
  );

  // 3) courses (catalog) from קורסים.xlsx → sheet "לפי ימות השבוע"
  const courseDocs = [];
  try {
    const { rows } = readSheet("קורסים.xlsx", "לפי ימות השבוע");
    const WEEKDAY = { 1: "א", 2: "ב", 3: "ג", 4: "ד", 5: "ה" };
    const LABELS = {
      מתאריך: "startDateRaw",
      "עד תאריך": "endDateRaw",
      "כמות מפגשים": "sessions",
      מיקום: "location",
      מרצה: "lecturer",
      סטאטוס: "status",
    };
    let block = null; // { [col]: courseObj }
    const flush = () => {
      if (!block) return;
      for (const c of Object.keys(block)) courseDocs.push(block[c]);
      block = null;
    };
    for (const row of rows) {
      const label = cleanStr(row?.[0]);
      if (label === "שם הקורס") {
        flush();
        block = {};
        for (let c = 1; c <= 5; c++) {
          const nm = cleanStr(row[c]);
          if (nm) {
            const norm = normalizeCourse(nm);
            block[c] = {
              name: nm,
              field: norm.field,
              cohortLabel: norm.cohortLabel,
              rawNames: [nm],
              weekday: WEEKDAY[c],
              status: "פעיל",
              sourceFile: "קורסים.xlsx",
            };
          }
        }
      } else if (block && LABELS[label]) {
        const key = LABELS[label];
        for (let c = 1; c <= 5; c++) {
          if (!block[c]) continue;
          const v = cleanStr(row[c]);
          if (key === "startDateRaw") {
            const d = parseDate(v);
            block[c].startDate = d.date;
            block[c].startDateRaw = d.raw;
          } else if (key === "endDateRaw") {
            const d = parseDate(v);
            block[c].endDate = d.date;
            block[c].endDateRaw = d.raw;
          } else if (key === "sessions") {
            block[c].sessionsCount = parseNumber(v) || undefined;
          } else {
            block[c][key] = v || block[c][key];
          }
        }
      }
    }
    flush();
  } catch (e) {
    console.warn("⚠️  could not parse course catalog:", e.message);
  }
  // Sanity-correct year typos in course end dates. These courses run ≤ ~7 months, so an
  // end date > 300 days after the start is almost certainly a mistyped year (e.g. the
  // source literally has "18.8.27" for טראנס וסוגסטיה starting 30.6.26 → should be 18.8.26).
  const DAY_MS = 86400000;
  let courseDateFixes = 0;
  for (const c of courseDocs) {
    if (c.startDate && c.endDate && c.endDate - c.startDate > 300 * DAY_MS) {
      const fixed = new Date(c.endDate);
      fixed.setUTCFullYear(fixed.getUTCFullYear() - 1);
      if (fixed > c.startDate && fixed - c.startDate <= 300 * DAY_MS) {
        c.endDate = fixed;
        c.endDateRaw = `${c.endDateRaw || ""} (שנה תוקנה אוט')`.trim();
        courseDateFixes += 1;
      }
    }
  }
  if (courseDateFixes)
    console.log(`🩹  course end-date year typos corrected: ${courseDateFixes}`);

  const insertedCourses = courseDocs.length
    ? await Course.insertMany(courseDocs)
    : [];
  const courseByKey = new Map();
  insertedCourses.forEach((c) =>
    courseByKey.set(`${c.field}|${c.cohortLabel}`, c._id),
  );
  console.log(`📚  courses imported: ${insertedCourses.length}`);

  // 4) deal rows → registrations / expenses / students
  const registrations = [];
  const expenses = [];
  const studentMap = new Map(); // key -> studentObj

  const processFile = ({
    file,
    sheetName,
    rep,
    hasYear,
    cols,
    fallbackYear,
  }) => {
    const { rows, sheetName: sn } = readSheet(file, sheetName);
    const data = rows.slice(1); // drop header
    let count = 0;
    let skipped = 0;

    data.forEach((row, idx) => {
      if (!nonEmpty(row)) return;
      let name = cleanStr(row[cols.name]);
      // Malformed rows: the name sometimes spilled into the ת.ז. column (col 2). Recover it.
      if (!name && cols.idNumber != null) {
        const alt = cleanStr(row[cols.idNumber]);
        if (/[א-ת]/.test(alt) && !/^\d/.test(alt)) name = alt;
      }
      if (!name) return; // skip totals / blank rows
      // skip obvious non-student "totals" sentinel (name empty handled above)

      const totalCell = cleanStr(row[cols.total]);
      // A "total" like "1/5" is an installment marker (payment 1 of 5), NOT a deal total.
      const isInstallmentMarker = /^\d{1,2}\s*\/\s*\d{1,2}\s*$/.test(totalCell);
      const total = isInstallmentMarker ? 0 : parseNumber(row[cols.total]);
      const advance = parseNumber(row[cols.advance]);
      // The "balance" columns sometimes hold prose (e.g. "יתרה להתקשר ב-30.7בבוקר").
      // A number embedded in free text must NEVER be used as a money figure - treat such
      // a cell as unknown (0); the prose is preserved in notes and the row flagged.
      const balanceNoisy = isNoisyNumber(cleanStr(row[cols.balanceDue]));
      const finalNoisy = isNoisyNumber(cleanStr(row[cols.finalBalance]));
      const balanceDue = balanceNoisy ? 0 : parseNumber(row[cols.balanceDue]);
      const finalBalance = finalNoisy ? 0 : parseNumber(row[cols.finalBalance]);
      // A row without a deal total is NOT a sale - we do not fabricate one (that would
      // re-inflate revenue). It is reclassified below as a collection/annotation row.
      const dealTotal = total > 0 ? total : 0;
      let courseRaw = cleanStr(row[cols.course]);
      // A marker can live in the total column ("5/6") while the course cell says only "ERN".
      // Merge it so the marker is recognised for linking to the plan.
      if (isInstallmentMarker && !parseInstallmentMarker(courseRaw)) {
        courseRaw = `${courseRaw} ${totalCell}`.trim();
      }
      const norm = normalizeCourse(courseRaw);

      // Date. Michal's sheet has real years. Moran's has none (just "d/m") and the
      // rows are NOT chronological, so we assume a single configurable year for all
      // of her rows and flag dateAssumed=true (parseDate sets assumedYear when the
      // string carries no year). Change via SEED_MORAN_YEAR and re-import.
      const dateRes = hasYear
        ? parseDate(row[cols.date])
        : parseDate(row[cols.date], fallbackYear);

      // advertising rows → expenses
      if (norm.recordType === "advertising") {
        expenses.push({
          name: courseRaw || name,
          category: "פרסום",
          amount: total || advance,
          vatIncluded: true,
          type: "variable",
          date: dateRes.date,
          dateRaw: dateRes.raw,
          notes: cleanStr(row[cols.notes]),
          sourceFile: file,
          sourceSheet: sn,
          sourceRow: idx + 2,
        });
        return;
      }

      // Skip separator / empty rows: a name but NO course, NO ת.ז. and NO money.
      // These are section dividers Moran wrote in the sheet, e.g. "February 2025".
      const idNumber =
        cols.idNumber != null ? cleanStr(row[cols.idNumber]) : "";
      const hasAnyMoney =
        total > 0 || advance > 0 || balanceDue > 0 || finalBalance > 0;
      if (!courseRaw && !idNumber && !hasAnyMoney) {
        skipped += 1;
        return;
      }

      // Reclassify rows whose true nature hides in the ת.ז./total/notes columns, and
      // detect "paid in full" prose so a balance recorded in Hebrew text is still counted.
      const paidDateCell = cleanStr(row[cols.paidDate]);
      const notesCell = cols.notes != null ? cleanStr(row[cols.notes]) : "";
      const balCellRaw = cleanStr(row[cols.balanceDue]);
      const finCellRaw = cleanStr(row[cols.finalBalance]);
      // Phrases that mean the WHOLE balance was already collected.
      const PAID_FULL =
        /סיימ.? לשלם|סיים לשלם|אין( יותר)? יתרה|אין יתרת|הכל שולם|שולם הכל|היתרה שולמה|שולמה היתרה|שילמ.? הכל|אין חוב|שולם במלואו|שולמה במלואה/;

      let recordType = norm.recordType;
      let extraReview = norm.needsReview;
      let paidInFull = false;
      if (
        /החזר|ביטול/.test(idNumber) ||
        total < 0 ||
        advance < 0 ||
        /^(?:החזר|ביטול|זיכוי)/.test(paidDateCell)
      ) {
        // full cancellation / refund (negative money, or refund word in the id/paid column)
        recordType = "refund";
        extraReview = true;
      } else if (
        /המשך/.test(idNumber) ||
        /המשך/.test(courseRaw) ||
        isInstallmentMarker
      ) {
        recordType = "collection_followup";
      } else {
        if (
          PAID_FULL.test(paidDateCell) ||
          PAID_FULL.test(notesCell) ||
          PAID_FULL.test(balCellRaw) ||
          PAID_FULL.test(finCellRaw)
        ) {
          paidInFull = true;
        }
        // a partial credit/refund note ("בוצע זיכוי 1,600") -> keep the deal but flag for review
        if (/החזר|ביטול|זיכוי|מבטל/.test(`${paidDateCell} ${notesCell}`))
          extraReview = true;
      }

      // A row with NO deal amount (even after inference) is a collection / annotation row,
      // never a standalone sale.
      if (recordType === "registration" && !(dealTotal > 0)) {
        recordType = "collection_followup";
        extraReview = true;
      }

      // Detect a future installment plan BEFORE computing money: when the balance is to be
      // collected via future ERN/credit installments it is NOT yet collected - only the
      // deposit is. The installment markers reflect the actual collection over time.
      // Read the plan from the FINANCIAL note/balance/2nd-method text FIRST (that is where
      // the real plan is described, e.g. "ERN 6 תשלומים"), and only fall back to the main
      // payment-method cell last - otherwise "כ.א. 2 תשלומים" wrongly wins over "ERN 6".
      const planParsed =
        recordType === "registration" && dealTotal > 0
          ? parseInstallmentPlan(
              `${notesCell} ${balCellRaw} ${finCellRaw} ${cleanStr(row[cols.method2])} ${paidDateCell} ${cleanStr(row[cols.method1])}`,
            )
          : null;

      const money = buildMoney({
        total: dealTotal,
        advance,
        method1: row[cols.method1],
        advDateRaw: row[cols.advDate],
        balanceDue,
        paidDateRaw: row[cols.paidDate],
        method2: row[cols.method2],
        finalBalance,
        paidInFull,
        hasFuturePlan: Boolean(planParsed),
        sourceFile: file,
        sourceRow: idx + 2,
      });

      // A refund is money returned, not a receivable - it must never look like
      // outstanding debt (it would otherwise pollute the debtors list & forecast).
      if (recordType === "refund") {
        money.outstanding = 0;
        money.totalPaid = 0;
      }

      // notes: combine notes col + any overflow text from date / balance columns
      const noteParts = [];
      let rowNeedsReview = extraReview;
      const notesCol = cols.notes != null ? cleanStr(row[cols.notes]) : "";
      if (notesCol) noteParts.push(notesCol);
      // Moran's "paid date" column sometimes holds a textual note instead of a date
      if (!parseDate(row[cols.paidDate]).date) {
        const t = cleanStr(row[cols.paidDate]);
        if (t && t.length > 4) noteParts.push(t);
      }
      // "balance to pay" / "final balance" columns sometimes hold prose (e.g. "נשאר 750 לשלם")
      const balRaw = cleanStr(row[cols.balanceDue]);
      if (isNoisyNumber(balRaw)) {
        noteParts.push(balRaw);
        rowNeedsReview = true;
      }
      if (isNoisyNumber(cleanStr(row[cols.finalBalance])))
        rowNeedsReview = true;

      const checklist = {
        signedTakanon: cols.takanon != null ? isYes(row[cols.takanon]) : false,
        addedToCourseWhatsapp: false,
        addedToAlumniWhatsapp: false,
        invoiceIssued:
          cols.invoice != null ? Boolean(cleanStr(row[cols.invoice])) : false,
      };

      // Expected installment plan = the future balance (dealTotal − deposit) split out.
      // Only when there IS a future balance to collect (a paid-upfront deal needs no plan).
      let installmentPlan = [];
      if (planParsed && dealTotal - advance > 0.5) {
        installmentPlan = buildInstallmentItems(planParsed, {
          dealDate: dateRes.date,
          remaining: dealTotal - advance,
        });
      }

      registrations.push({
        studentName: name,
        idNumber,
        rep: rep._id,
        repName: rep.name,
        registeredByRaw:
          cols.registeredBy != null ? cleanStr(row[cols.registeredBy]) : "",
        courseRaw,
        courseField: norm.field,
        cohortLabel: norm.cohortLabel,
        course:
          courseByKey.get(`${norm.field}|${norm.cohortLabel}`) || undefined,
        dealDate: dateRes.date,
        dealDateRaw: dateRes.raw,
        dateAssumed: Boolean(dateRes.assumedYear),
        totalAmount: dealTotal,
        amountExVat:
          cols.exVat != null
            ? parseNumber(row[cols.exVat]) || undefined
            : undefined,
        vatAmount:
          cols.vat != null
            ? parseNumber(row[cols.vat]) || undefined
            : undefined,
        advancePaid: advance,
        balanceDue,
        finalBalance,
        totalPaid: money.totalPaid,
        outstanding: money.outstanding,
        payments: money.payments,
        primaryPaymentMethod: cleanStr(row[cols.method1]),
        paymentCategory: money.primaryCategory,
        installments: money.installments,
        paymentStatus: money.paymentStatus,
        nextPaymentNote: money.outstanding > 0 ? noteParts.join(" | ") : "",
        checklist,
        checklistComplete: false,
        installmentPlan,
        recordType,
        needsReview: rowNeedsReview,
        notes: noteParts.join(" | "),
        sourceFile: file,
        sourceSheet: sn,
        sourceRow: idx + 2, // +1 header, +1 to 1-based
      });
      count += 1;
    });
    console.log(
      `   • ${file}: ${count} registrations parsed, ${skipped} empty/separator rows skipped`,
    );
  };

  // Moran columns (sheet גיליון1) – no ID, no VAT, no year in dates
  const MORAN_YEAR = Number(process.env.SEED_MORAN_YEAR) || 2025;
  console.log(
    `ℹ️  מורן: שנה משוערת לתאריכים = ${MORAN_YEAR} (ניתן לשנות עם SEED_MORAN_YEAR)`,
  );
  processFile({
    file: "מורן.xlsx",
    sheetName: "גיליון1",
    rep: moran,
    hasYear: false,
    fallbackYear: MORAN_YEAR,
    cols: {
      date: 0,
      name: 1,
      course: 2,
      total: 4,
      advance: 5,
      method1: 6,
      advDate: 7,
      balanceDue: 8,
      paidDate: 9,
      method2: 10,
      finalBalance: 11,
      idNumber: null,
      exVat: null,
      vat: null,
      invoice: null,
      registeredBy: null,
      takanon: null,
      notes: null,
    },
  });

  // Michal columns (sheet 924) – richer: ID, VAT, registeredBy, takanon, notes
  processFile({
    file: "מיכל.xlsx",
    sheetName: "924",
    rep: michal,
    hasYear: true,
    cols: {
      date: 0,
      name: 1,
      idNumber: 2,
      course: 3,
      total: 4,
      advance: 5,
      method1: 6,
      advDate: 7,
      balanceDue: 8,
      paidDate: 9,
      method2: 10,
      finalBalance: 11,
      exVat: 12,
      vat: 13,
      invoice: 14,
      registeredBy: 15,
      takanon: 16,
      notes: 17,
    },
  });

  // 3a) Canonical student key with FUZZY name matching: unify rows whose name is a token
  //     subset of a fuller name (e.g. "סימון גביש" ⊂ "סימון גביש ביטון"), so a person whose
  //     surname was written inconsistently is ONE student and their collections link.
  const normName = (s) => cleanStr(s).replace(/\s+/g, " ");
  const tokensOf = (n) => n.split(" ").filter(Boolean);
  const allNames = [
    ...new Set(
      registrations.map((r) => normName(r.studentName)).filter(Boolean),
    ),
  ];
  const canonicalOf = new Map();
  for (const a of allNames) {
    const ta = tokensOf(a);
    let best = a;
    if (ta.length >= 2) {
      for (const b of allNames) {
        if (b === a) continue;
        const tb = tokensOf(b);
        if (
          tb.length > tokensOf(best).length &&
          ta.every((t) => tb.includes(t))
        )
          best = b;
      }
    }
    canonicalOf.set(a, best);
  }
  for (const r of registrations) {
    r._studentKey =
      canonicalOf.get(normName(r.studentName)) ||
      normName(r.studentName) ||
      null;
  }

  // 3b) DE-SNAPSHOT. The reps re-list the SAME deal as its balance evolves (a running
  //     ledger), so one deal appears as several near-identical rows. Collapse rows sharing
  //     (student-name, courseField, total): keep the most-progressed snapshot (max paid;
  //     tie → latest date) and reclassify the rest as superseded (excluded from revenue).
  const snapNorm = (s) => cleanStr(s).replace(/\s+/g, " ");
  const snapGroups = new Map();
  for (const r of registrations) {
    if (r.recordType !== "registration" || !(r.totalAmount > 0)) continue;
    const key = `${r._studentKey}||${r.courseField || r.courseRaw}||${Math.round(r.totalAmount)}`;
    const g = snapGroups.get(key) || [];
    g.push(r);
    snapGroups.set(key, g);
  }
  let snapshotsDropped = 0;
  for (const g of snapGroups.values()) {
    if (g.length < 2) continue;
    g.sort(
      (a, b) =>
        (b.totalPaid || 0) - (a.totalPaid || 0) ||
        (b.dealDate ? +new Date(b.dealDate) : 0) -
          (a.dealDate ? +new Date(a.dealDate) : 0),
    );
    for (let i = 1; i < g.length; i++) {
      g[i].recordType = "other";
      g[i].needsReview = true;
      g[i].notes = `סנאפשוט קודם של העסקה (אוחד) | ${g[i].notes || ""}`.trim();
    }
    snapshotsDropped += g.length - 1;
  }
  console.log(`🗂️  snapshots collapsed: ${snapshotsDropped}`);

  // 4a) Some deals describe the plan on a SEPARATE follow-up row ("המשך גביה") rather
  //     than on the deal itself (e.g. טוהר). Pull such a plan onto the parent deal.
  let crossRowPlans = 0;
  for (const parent of registrations) {
    if (parent.recordType !== "registration" || parent.outstanding <= 0.5)
      continue;
    if (parent.installmentPlan && parent.installmentPlan.length) continue;
    const others = registrations.filter(
      (r) => r !== parent && r._studentKey === parent._studentKey,
    );
    for (const o of others) {
      const plan = parseInstallmentPlan(
        `${o.notes || ""} ${o.courseRaw || ""} ${o.nextPaymentNote || ""}`,
      );
      if (plan) {
        parent.installmentPlan = buildInstallmentItems(plan, {
          dealDate: parent.dealDate,
          remaining: parent.outstanding,
        });
        crossRowPlans += 1;
        break;
      }
    }
  }

  // 4b-pre) If a student has "N/M" markers but the parent deal has NO plan (the deal row
  //         never stated the installment terms - e.g. תמיר), synthesise the plan FROM the
  //         markers: count = M, amount = the marker amount, day/start from the first marker.
  const markersByStudent = new Map();
  for (const r of registrations) {
    const mk = parseInstallmentMarker(r.courseRaw);
    if (mk) {
      const arr = markersByStudent.get(r._studentKey) || [];
      arr.push({ r, mk });
      markersByStudent.set(r._studentKey, arr);
    }
  }
  for (const [key, arr] of markersByStudent) {
    const count = arr[0].mk.count;
    const parent = registrations.find(
      (d) =>
        d.recordType === "registration" &&
        d._studentKey === key &&
        d.totalAmount > 0 &&
        !(d.installmentPlan || []).length &&
        d.outstanding > 0.5,
    );
    if (!parent) continue;
    const per = arr.map((x) => x.r.advancePaid).find((a) => a > 0) || 0;
    const method = /ern/i.test(arr[0].r.courseRaw) ? "ern" : "credit";
    const stamps = arr
      .map((x) => x.r.dealDate)
      .filter(Boolean)
      .map((d) => +new Date(d))
      .sort((a, b) => a - b);
    const start = stamps.length ? new Date(stamps[0]) : parent.dealDate;
    parent.installmentPlan = buildInstallmentItems(
      {
        count,
        amount: per > 0 ? per : null,
        dayOfMonth: start ? new Date(start).getUTCDate() : null,
        startRaw: null,
        method,
      },
      {
        dealDate: start,
        remaining: Math.max(parent.totalAmount - parent.advancePaid, 0),
      },
    );
  }

  // 4b) Link "ERN N/M" marker rows to their parent deal's installment plan: mark that
  //     installment paid, fold its payment into the parent (reducing outstanding), and
  //     reclassify the marker as a follow-up so it is not counted as a separate sale.
  const plansByStudent = new Map(); // studentKey -> [parent regs that have a plan]
  for (const r of registrations) {
    if (r.installmentPlan && r.installmentPlan.length) {
      const arr = plansByStudent.get(r._studentKey) || [];
      arr.push(r);
      plansByStudent.set(r._studentKey, arr);
    }
  }
  let linkedMarkers = 0;
  for (const r of registrations) {
    const marker = parseInstallmentMarker(r.courseRaw);
    if (!marker) continue;
    const candidates = plansByStudent.get(r._studentKey) || [];
    // A collected installment cannot belong to a deal opened AFTER the collection date.
    const rDate = r.dealDate ? +new Date(r.dealDate) : Infinity;
    const dated = candidates.filter(
      (p) => (p.dealDate ? +new Date(p.dealDate) : -Infinity) <= rDate,
    );
    const pool = dated.length ? dated : candidates;
    const parent =
      pool.find((p) => p.installmentPlan.length === marker.count) || pool[0];
    if (!parent) continue;
    // A combined marker ("1+2+3/6") collected several installments in one row - split its
    // amount across them.
    const perAmt =
      (r.advancePaid > 0 ? r.advancePaid : 0) / marker.indices.length;
    for (const idx of marker.indices) {
      const item = parent.installmentPlan[idx - 1];
      if (item && item.status !== "paid") {
        const amt = perAmt > 0 ? perAmt : item.amount;
        item.status = "paid";
        item.paidAt = r.dealDate || null;
        item.amount = amt || item.amount;
        item.sourceRow = r.sourceRow;
        item.confirmedByName = r.repName || "";
        parent.payments.push({
          amount: amt,
          method: item.method,
          methodCategory: item.method,
          date: r.dealDate || null,
          kind: "balance",
          note: `תשלום ${item.label}`,
          source: `שורת גבייה "${r.courseRaw}" · ${r.sourceFile} שורה ${r.sourceRow}`,
        });
      }
    }
    r.recordType = "collection_followup"; // the marker is a follow-up, not a new sale
    linkedMarkers += 1;
  }
  // 4c) Fold prose collection rows ("המשך גביה" / "המשך שכ"ל") into the parent deal - but
  //     only up to the parent's REMAINING balance, so a follow-up that merely re-describes
  //     an already-recorded balance (e.g. a gemach transfer replacing the planned balance)
  //     is NOT double-counted.
  const remainingOf = new Map();
  for (const d of registrations) {
    if (d.recordType !== "registration") continue;
    const own = d.payments.reduce((s, p) => s + (p.amount || 0), 0);
    remainingOf.set(d, d.totalAmount > 0 ? d.totalAmount - own : Infinity);
  }
  let foldedFollowups = 0;
  let typoCorrections = 0;
  // Process folds in chronological order so the running balance decrements correctly and
  // Michal's stated-balance self-correction (below) fires against the right remaining.
  const followupRows = registrations
    .filter((r) => r.recordType === "collection_followup")
    .sort(
      (a, b) =>
        (a.dealDate ? +new Date(a.dealDate) : 0) -
        (b.dealDate ? +new Date(b.dealDate) : 0),
    );
  for (const r of followupRows) {
    if (parseInstallmentMarker(r.courseRaw)) continue; // "N/M" markers handled in 4b
    const amt = r.totalPaid || r.advancePaid || 0;
    if (amt <= 0) continue;
    const rDate = r.dealDate ? +new Date(r.dealDate) : Infinity;
    const deals = registrations.filter(
      (d) => d.recordType === "registration" && d._studentKey === r._studentKey,
    );
    // A payment cannot belong to a deal that was opened AFTER the payment date.
    const eligible = deals.filter(
      (d) => (d.dealDate ? +new Date(d.dealDate) : -Infinity) <= rDate,
    );
    const dealPool = eligible.length ? eligible : deals;
    const parent =
      dealPool.find((d) => (remainingOf.get(d) || 0) > 0.5) || dealPool[0];
    if (!parent) continue;
    const rem = remainingOf.get(parent);
    if (rem !== Infinity && rem <= 0.5) continue; // parent already fully accounted - skip re-description
    // Fold amount = the paid amount, capped at the remaining balance. BUT if the amount
    // OVERSHOOTS the remaining while Michal recorded a valid stated balance on this row
    // (balanceDue = "יתרה לתשלום"), trust her running balance instead - the amount cell is a
    // typo (e.g. row 408: amount shows 4690, but balance drops 1830→1370, i.e. a 460 payment).
    let fold;
    const stated = r.balanceDue || 0; // 0 if the cell was noisy/absent
    if (
      rem !== Infinity &&
      amt > rem + 0.5 &&
      stated > 0 &&
      stated < rem - 0.5
    ) {
      fold = rem - stated; // derive the real payment from the balance drop
      typoCorrections += 1;
    } else {
      fold = rem === Infinity ? amt : Math.min(amt, rem);
    }
    if (fold <= 0) continue;
    parent.payments.push({
      amount: fold,
      method: r.paymentCategory || "",
      methodCategory: r.paymentCategory || "",
      date: r.dealDate || null,
      kind: "balance",
      note: `גבייה (${r.courseRaw || "המשך"})`,
      source:
        `שורת גבייה · ${r.sourceFile} שורה ${r.sourceRow}` +
        (fold !== amt
          ? ` · סכום תוקן מ-${amt} ל-${Math.round(fold)} לפי שרשרת היתרה`
          : "") +
        (r.notes ? " · " + r.notes : ""),
    });
    if (rem !== Infinity) remainingOf.set(parent, rem - fold);
    foldedFollowups += 1;
  }

  // Recompute EVERY deal from its (now complete) payments. Collected is capped at the deal
  // total so double-recorded collections can never push outstanding negative.
  for (const p of registrations) {
    if (p.recordType === "registration") {
      const paidSum =
        p.payments.reduce((s, x) => s + (x.amount || 0), 0) ||
        (p.advancePaid > 0 ? p.advancePaid : 0);
      p.totalPaid =
        p.totalAmount > 0 ? Math.min(paidSum, p.totalAmount) : paidSum;
      if (p.totalAmount > 0)
        p.outstanding = Math.max(p.totalAmount - p.totalPaid, 0);
      p.paymentStatus =
        p.totalAmount > 0 && p.outstanding <= 0.5
          ? "paid"
          : p.totalPaid > 0
            ? "partial"
            : "unpaid";
      // Normalise the plan to the money: a fully-collected deal has no pending installments;
      // otherwise the PENDING installments must sum to the outstanding (absorb a folded
      // collection that wasn't a discrete installment into the last pending installment -
      // only a small gap; a large gap stays so the deal is flagged unbalanced).
      const plan = p.installmentPlan || [];
      if (p.outstanding <= 0.5) {
        for (const it of plan) {
          if (it.status !== "paid") {
            it.status = "paid";
            it.confirmedByName = it.confirmedByName || "(שולם)";
          }
        }
      } else if (plan.length) {
        const pend = plan.filter((it) => it.status !== "paid");
        const pendSum = pend.reduce((s, it) => s + (it.amount || 0), 0);
        const gap = Math.round((p.outstanding - pendSum) * 100) / 100;
        const per = pend.length ? pend[0].amount || 0 : 0;
        if (pend.length && Math.abs(gap) > 0.5 && Math.abs(gap) <= per + 0.5) {
          const last = pend[pend.length - 1];
          last.amount = Math.round((last.amount + gap) * 100) / 100;
        }
      }
    } else {
      // collection / annotation rows are not receivables - they fold into a deal.
      p.outstanding = 0;
    }
  }
  console.log(
    `📎  prose collection rows folded into parent deals: ${foldedFollowups} (typo-corrected via balance chain: ${typoCorrections})`,
  );

  // 4d) Reconciliation flag per deal: collected + future == total (or collected == total).
  //     Unbalanced deals are flagged + needsReview so they surface in the app for review.
  let unbalanced = 0;
  for (const p of registrations) {
    if (p.recordType !== "registration") {
      p.reconciled = true;
      continue;
    }
    const total = p.totalAmount || 0;
    const paid = p.totalPaid || 0;
    const out = p.outstanding || 0;
    const pending = (p.installmentPlan || [])
      .filter((i) => i.status !== "paid")
      .reduce((s, i) => s + (i.amount || 0), 0);
    let note = "";
    if (paid > total + 1)
      note = `נגבה (${Math.round(paid)}) גדול מסה"כ (${Math.round(total)})`;
    else if (p.installmentPlan && p.installmentPlan.length) {
      if (Math.abs(paid + pending - total) > 50)
        note = `נגבה+עתידי (${Math.round(paid + pending)}) ≠ סה"כ (${Math.round(total)})`;
    } else if (out > 1 && !p.nextPaymentNote && !p.notes) {
      note = "יתרה פתוחה ללא פריסה ולא הערת גבייה";
    }
    p.reconciled = !note;
    p.reconcileNote = note;
    if (note) {
      p.needsReview = true;
      unbalanced += 1;
    }
  }
  console.log(
    `⚖️  reconciliation: ${registrations.filter((r) => r.recordType === "registration").length - unbalanced} balanced, ${unbalanced} flagged`,
  );
  const plannedCount = registrations.filter(
    (r) => r.installmentPlan && r.installmentPlan.length,
  ).length;
  console.log(
    `🔗  installment plans: ${plannedCount} deals (${crossRowPlans} from follow-up rows) | markers linked: ${linkedMarkers}`,
  );

  // 5) Build student docs from the canonical keys assigned in 3a (the fullest spelling of
  //    the name is the display name). Only a digit-bearing value with no letters is a real
  //    ת.ז.; reject text like "גבייה"/"ERN".
  const cleanId = (id) =>
    id && !/[א-תA-Za-z]/.test(id) && /\d/.test(id) ? id : "";
  for (const r of registrations) {
    const key = r._studentKey;
    if (!key) continue;
    const id = cleanId(r.idNumber);
    if (!studentMap.has(key)) {
      const { firstName, lastName } = splitName(key);
      studentMap.set(key, {
        fullName: key,
        firstName,
        lastName,
        idNumber: id,
        sourceFile: r.sourceFile,
      });
    } else if (id && !studentMap.get(key).idNumber) {
      studentMap.get(key).idNumber = id; // backfill a real id onto the merged student
    }
  }
  const studentKeys = [...studentMap.keys()];
  const studentDocs = [...studentMap.values()];
  const insertedStudents = studentDocs.length
    ? await Student.insertMany(studentDocs)
    : [];
  const studentIdByKey = new Map();
  insertedStudents.forEach((s, i) => studentIdByKey.set(studentKeys[i], s._id)); // insertMany preserves order
  registrations.forEach((r) => {
    if (r._studentKey) r.student = studentIdByKey.get(r._studentKey);
    delete r._studentKey;
  });

  const insertedRegs = registrations.length
    ? await Registration.insertMany(registrations)
    : [];
  const insertedExpenses = expenses.length
    ? await Expense.insertMany(expenses)
    : [];

  // 6) summary
  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const byRep = {};
  const byType = {};
  insertedRegs.forEach((r) => {
    byType[r.recordType] = (byType[r.recordType] || 0) + 1;
    if (r.recordType !== "registration") return; // money sums only over real deals
    const k = r.repName || "-";
    byRep[k] = byRep[k] || { deals: 0, total: 0, paid: 0, out: 0 };
    byRep[k].deals += 1;
    byRep[k].total += r.totalAmount || 0;
    byRep[k].paid += r.totalPaid || 0;
    byRep[k].out += r.outstanding || 0;
  });

  console.log("\n" + "=".repeat(60));
  console.log("✅  IMPORT COMPLETE");
  console.log(`   students:      ${insertedStudents.length}`);
  console.log(`   courses:       ${insertedCourses.length}`);
  console.log(`   registrations: ${insertedRegs.length}`);
  console.log(`   expenses(ads): ${insertedExpenses.length}`);
  console.log("   ─ per rep ─");
  Object.entries(byRep).forEach(([k, v]) =>
    console.log(
      `     ${k}: ${v.deals} deals | סה"כ ${v.total.toLocaleString()} ₪ | נגבה ${v.paid.toLocaleString()} ₪ | בחוץ ${v.out.toLocaleString()} ₪`,
    ),
  );
  console.log("   ─ by record type ─");
  Object.entries(byType).forEach(([k, v]) => console.log(`     ${k}: ${v}`));
  const needsReview = insertedRegs.filter((r) => r.needsReview).length;
  const assumedYear = insertedRegs.filter((r) => r.dateAssumed).length;
  const realRegs = insertedRegs.filter((r) => r.recordType === "registration");
  console.log(
    `   ⚑ needsReview: ${needsReview}   |   ⚑ year-assumed (Moran): ${assumedYear}`,
  );
  console.log(
    `   revenue (real deals only): ${sum(realRegs, (r) => r.totalAmount).toLocaleString()} ₪`,
  );
  console.log(
    `   collected: ${Math.round(sum(realRegs, (r) => r.totalPaid)).toLocaleString()} ₪  |  outstanding: ${Math.round(sum(realRegs, (r) => r.outstanding)).toLocaleString()} ₪`,
  );
  console.log("=".repeat(60));

  await disconnectDB();
  process.exit(0);
};

run().catch((err) => {
  console.error("❌  import failed:", err);
  process.exit(1);
});
