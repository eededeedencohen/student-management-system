import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import {
  startOfMonth,
  startOfDay,
  addMonths,
  addDays,
  bucketOf,
  nowFromReq,
} from "../utils/dateRanges.js";
import { applySince } from "../utils/dataScope.js";
import {
  cashDateOf,
  creditClearingDate,
  isCreditPayment,
} from "../utils/cashTiming.js";
import Registration from "../models/Registration.js";
import Expense from "../models/Expense.js";

/*
 * Cashflow forecast controller.
 * Manager-only domain (the route layer enforces requireManager).
 *
 * The forecast walks month-by-month from `from`..`to` and projects:
 *   - expected INCOME from registrations that still have outstanding balances
 *   - expected EXPENSE from fixed/recurring + variable expenses
 *
 * Documented assumptions (see helpers below):
 *   A1. Income comes only from registrations with outstanding > 0.
 *       We deliberately do NOT restrict to recordType==='registration' here:
 *       any record carrying real outstanding money is cash we still expect to
 *       collect (per convention #6, the "debtors/outstanding" exception).
 *   A2. Installment deals paid by 'ern' (הוראת קבע) or 'credit' with
 *       installments>1 spread the outstanding evenly over `installments`
 *       upcoming months. Everything else lands as a lump in a single month.
 *   A3. The anchor month for income is nextPaymentDate; if missing/in the past
 *       relative to the first forecast month, we start at the first forecast
 *       month so we never forecast money "in the past".
 *   A4. VAT: when vat=false we strip VAT. Income uses the real
 *       amountExVat/totalAmount ratio when both are present, else /1.18.
 *       Expenses divide by 1.18 only when vatIncluded is true.
 */

const VAT_DIVISOR = 1.18; // 18% VAT (Israel)
const MONTH_KEY = (date) => bucketOf(date, "month").key; // "YYYY-MM"

const pad2 = (n) => String(n).padStart(2, "0");
/** מפתח יציב לתאריך (YYYY-MM-DD, UTC). */
const DATE_KEY = (d) =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/** Build the ordered list of buckets covering [from, to]:
 *  - month (default): חודשים קלנדריים רגילים (MM/YYYY).
 *  - day (?granularity=day): דלי לכל יום.
 *  Returns array of {key,label,start} plus a key->index map. */
function buildBuckets(from, to, granularity = "month") {
  const buckets = [];
  const index = new Map();
  const push = (b) => {
    index.set(b.key, buckets.length);
    buckets.push({
      key: b.key,
      label: b.label,
      start: b.start,
      expectedIncome: 0,
      expectedExpense: 0,
    });
  };
  // Guard against pathological ranges so we never loop unbounded
  // (day mode is capped at ~400 days; the client asks for far less).
  let safety = 0;
  if (granularity === "day") {
    let cursor = startOfDay(from);
    const last = startOfDay(to);
    while (cursor <= last && safety < 400) {
      push(bucketOf(cursor, "day"));
      cursor = addDays(cursor, 1);
      safety += 1;
    }
  } else {
    let cursor = startOfMonth(from);
    const last = startOfMonth(to);
    while (cursor <= last && safety < 600) {
      push(bucketOf(cursor, "month"));
      cursor = addMonths(cursor, 1);
      safety += 1;
    }
  }
  return { buckets, index };
}

/** Convert a VAT-inclusive registration outstanding amount to ex-VAT.
 *  Uses the deal's own ratio when available, else the flat /1.18. */
function exVatIncome(outstanding, reg) {
  if (reg.amountExVat > 0 && reg.totalAmount > 0) {
    return outstanding * (reg.amountExVat / reg.totalAmount);
  }
  return outstanding / VAT_DIVISOR;
}

// Payment methods whose future timing is PREDICTABLE: credit-card & ERN (הוראת קבע)
// charge the balance remaining after the deposit in fixed monthly installments
// (e.g. 6,000 balance / 12 = 500 every month). Bank-transfer / cash / combined have
// UNKNOWN timing - often paid at once, sometimes in parts - so we must NOT fake a
// monthly schedule for them; their outstanding goes into a separate "unscheduled" pool.
const SCHEDULED_CATEGORIES = new Set(["credit", "ern"]);

/** Determine the anchor month-start for a registration's income, clamped so we
 *  never place expected income before the first forecast month (A3). */
function incomeAnchor(reg, firstMonthStart) {
  const anchor = reg.nextPaymentDate
    ? startOfMonth(reg.nextPaymentDate)
    : firstMonthStart;
  return anchor < firstMonthStart ? firstMonthStart : anchor;
}

/**
 * Attribute one registration's outstanding income.
 *  - credit / ERN  → spread the remaining balance over `installments` equal monthly
 *    charges (predictable cashflow).
 *  - transfer / cash / combined / unspecified → timing unknown → add to the
 *    `unscheduled` pool (reported separately, never placed in a specific month).
 */
function attributeIncome(
  reg,
  buckets,
  index,
  firstMonthStart,
  includeVat,
  unscheduled,
  keyOf = MONTH_KEY,
) {
  // v2 deals carry explicit future payments with real dueDates → place each unpaid
  // payment in the bucket its CASH actually arrives (credit clears on the configured
  // day of the following month; other methods land on the due date). Overdue ones
  // clamp to the first bucket. This is the precise, correct path.
  if (reg.schemaVersion === 2) {
    let scheduledSum = 0;
    for (const p of reg.payments || []) {
      if (p.paid) continue;
      const amt = Number(p.amount) || 0;
      if (amt <= 0) continue;
      scheduledSum += amt;
      const amount = includeVat ? amt : exVatIncome(amt, reg);
      const cash = cashDateOf(p); // אשראי → סליקה ב-7 לחודש העוקב (קבוע)
      let at = cash || firstMonthStart;
      if (at < firstMonthStart) at = firstMonthStart; // never forecast in the past
      const idx = index.get(keyOf(at));
      if (idx !== undefined) buckets[idx].expectedIncome += amount; // beyond the window → dropped
    }
    // יתרה שאין לה תשלומים עתידיים מתועדים (תוכנית שקיימת רק בהערה, או חוב בלי פריסה) -
    // כסף אמיתי שמגיע לעסק אך מועדו לא ידוע ⇒ נכנס למאגר "ללא מועד ידוע", לא נעלם.
    const remainder = (Number(reg.outstanding) || 0) - scheduledSum;
    if (remainder > 0.5) {
      const amount = includeVat ? remainder : exVatIncome(remainder, reg);
      unscheduled.total += amount;
      const key = reg.paymentCategory || "unknown";
      unscheduled.byCategory[key] = (unscheduled.byCategory[key] || 0) + amount;
    }
    return;
  }

  const gross = Number(reg.outstanding) || 0;
  if (gross <= 0) return;
  const amount = includeVat ? gross : exVatIncome(gross, reg);
  const cat = reg.paymentCategory || "";

  if (SCHEDULED_CATEGORIES.has(cat)) {
    const spread = Number(reg.installments) > 1 ? Number(reg.installments) : 1;
    const per = amount / spread;
    let monthStart = incomeAnchor(reg, firstMonthStart);
    // אשראי: החיוב בחודש העוגן, אבל הכסף נסלק רק בחודש העוקב
    if (cat === "credit") monthStart = addMonths(monthStart, 1);
    for (let i = 0; i < spread; i += 1) {
      const idx = index.get(keyOf(monthStart));
      // installments running past `to` fall outside the shown window
      if (idx !== undefined) buckets[idx].expectedIncome += per;
      monthStart = addMonths(monthStart, 1);
    }
  } else {
    unscheduled.total += amount;
    const key = cat || "unknown";
    unscheduled.byCategory[key] = (unscheduled.byCategory[key] || 0) + amount;
  }
}

/** עסקאות מבוטלות שנגבה עליהן כסף והוא לא הוסדר (לא הועבר/לא ויתרו עליו) - החזר ממתין. */
async function findRefundsDue(req) {
  const filter = { recordType: "cancelled", totalPaid: { $gt: 0 } };
  applySince(req, filter);
  const rows = await Registration.find(filter)
    .select(
      "externalId student studentName courseRaw courseField repName dealDate totalPaid noteEntries notes",
    )
    .lean();
  const SETTLED = /עבר[ה]? ל|הועבר|לא ביקש|ויתר|קוזז|הוחזר/;
  return rows
    .filter(
      (r) =>
        !SETTLED.test(
          [r.notes, ...(r.noteEntries || []).map((n) => n.text)].join(" "),
        ),
    )
    .map((r) => ({
      student: r.student,
      studentName: r.studentName,
      externalId: r.externalId,
      course: r.courseRaw || r.courseField || "",
      repName: r.repName || "",
      dealDate: r.dealDate,
      amount: r.totalPaid,
      note:
        (r.noteEntries || [])
          .map((n) => n.text)
          .find((t) => /ביטול|לבדיקה/.test(t || "")) || "עסקה בוטלה",
    }));
}

/** Strip VAT from an expense amount when requested and the amount includes it. */
function expenseAmount(exp, includeVat) {
  const amt = Number(exp.amount) || 0;
  if (!includeVat && exp.vatIncluded) return amt / VAT_DIVISOR;
  return amt;
}

/** True if a recurring expense is active in the given month-start, honoring
 *  startDate/endDate and the recurrence cadence (monthly/quarterly/yearly). */
function recurrenceHitsMonth(exp, monthStart) {
  if (exp.startDate && monthStart < startOfMonth(exp.startDate)) return false;
  if (exp.endDate && monthStart > startOfMonth(exp.endDate)) return false;

  if (exp.recurrence === "monthly") return true;

  // For quarterly/yearly we step the cadence forward from the anchor month
  // (startDate, else the month itself) and check alignment by month-distance.
  const anchor = exp.startDate ? startOfMonth(exp.startDate) : monthStart;
  const monthsApart =
    (monthStart.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (monthStart.getUTCMonth() - anchor.getUTCMonth());
  if (monthsApart < 0) return false;
  if (exp.recurrence === "quarterly") return monthsApart % 3 === 0;
  if (exp.recurrence === "yearly") return monthsApart % 12 === 0;
  return false;
}

/**
 * Attribute all expenses (fixed/recurring + variable one-offs) into buckets.
 * כל הוצאה משובצת לפי תאריך החיוב שלה בפועל (חוזרת: יום-בחודש שלה, ברירת
 * מחדל ה-1) דרך אותו keyOf של ההכנסות - כך היא נופלת לחודש-התזרים הנכון גם
 * כשהעמודות מעוגנות לאמצע חודש קלנדרי.
 */
function attributeExpenses(expenses, buckets, index, includeVat, keyOf) {
  if (buckets.length === 0) return;
  const windowStart = buckets[0].start;
  const windowEndMonth = addMonths(
    startOfMonth(buckets[buckets.length - 1].start),
    1,
  );
  for (const exp of expenses) {
    const recurring =
      exp.recurrence === "monthly" ||
      exp.recurrence === "quarterly" ||
      exp.recurrence === "yearly";

    if (recurring) {
      const amt = expenseAmount(exp, includeVat);
      const day = Math.min(Math.max(parseInt(exp.dayOfMonth, 10) || 1, 1), 28);
      // מופעים על פני החודשים הקלנדריים שנוגעים בחלון (בתוספת חודש בכל צד)
      let m = addMonths(startOfMonth(windowStart), -1);
      while (m <= windowEndMonth) {
        if (recurrenceHitsMonth(exp, m)) {
          const at = new Date(
            Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), day),
          );
          const idx = index.get(keyOf(at));
          if (idx !== undefined) buckets[idx].expectedExpense += amt;
        }
        m = addMonths(m, 1);
      }
    } else if (exp.date) {
      // Variable one-off: counts in the bucket of its date if within range.
      const idx = index.get(keyOf(exp.date));
      if (idx !== undefined)
        buckets[idx].expectedExpense += expenseAmount(exp, includeVat);
    }
  }
}

/**
 * GET /api/cashflow/forecast
 * Query: ?from, ?to (default today..+6 months), ?vat=true|false (default true),
 *        ?granularity=month|day (ברירת מחדל month; day = תצוגה לפי ימים ספציפיים,
 *        שבה רואים בדיוק באיזה יום בחודש הכסף נכנס - למשל יום הסליקה).
 */
export const forecast = asyncHandler(async (req, res) => {
  // --- resolve the forecast window ---
  const now = nowFromReq(req); // honours the "view as of" date override
  const from = req.query.from ? new Date(req.query.from) : startOfMonth(now);
  let to = req.query.to
    ? new Date(req.query.to)
    : addMonths(startOfMonth(now), 6);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw ApiError.badRequest("תאריך from/to לא תקין");
  }
  if (to < from) throw ApiError.badRequest("to חייב להיות אחרי from");

  const granularity = req.query.granularity === "day" ? "day" : "month";
  const keyOf =
    granularity === "day" ? (d) => bucketOf(d, "day").key : (d) => MONTH_KEY(d);

  // מצב "הצג הכול": הטווח מתרחב אוטומטית עד חודש קבלת-הכסף האחרונה (מועד
  // סליקה לאשראי, מועד תשלום לשאר), כך שכל העמודות המתוארכות מוצגות ורק
  // אחריהן עמודת "תאריך לא ידוע".
  if (req.query.full === "1") {
    const lastFilter = {
      outstanding: { $gt: 0 },
      recordType: { $in: ["registration", "collection_followup"] },
    };
    applySince(req, lastFilter);
    const rows = await Registration.find(lastFilter).select("payments").lean();
    let last = null;
    for (const r of rows) {
      for (const p of r.payments || []) {
        if (p.paid || !p.dueDate) continue;
        const cash = cashDateOf(p);
        if (cash && (!last || cash > last)) last = cash;
      }
    }
    if (last && last > to) to = last;
  }

  // vat=true (default) keeps VAT; vat=false strips it.
  const includeVat = req.query.vat !== "false";

  const { buckets, index } = buildBuckets(from, to, granularity);
  const firstMonthStart = buckets.length
    ? buckets[0].start
    : startOfMonth(from);

  // --- INCOME: registrations with outstanding money still to collect ---
  // (debtors/outstanding exception to convention #6 → include all recordTypes)
  // Receivables only: real registrations + ongoing collection follow-ups.
  // (refunds were zeroed at import; advertising / "other" are not income.)
  const unscheduled = { total: 0, byCategory: {} };
  const debtorsFilter = {
    outstanding: { $gt: 0 },
    recordType: { $in: ["registration", "collection_followup"] },
  };
  applySince(req, debtorsFilter); // מוד "מ-2026 בלבד"
  const debtors = await Registration.find(debtorsFilter)
    .select(
      "outstanding totalAmount amountExVat installments paymentCategory nextPaymentDate schemaVersion payments",
    )
    .lean();
  for (const reg of debtors) {
    attributeIncome(
      reg,
      buckets,
      index,
      firstMonthStart,
      includeVat,
      unscheduled,
      keyOf,
    );
  }

  // --- INCOME: חיובי אשראי שכבר בוצעו וממתינים לסליקה (ה-7 בחודש העוקב) ---
  // הלקוח כבר חויב (paid=true), אבל הכסף מגיע לחשבון רק במועד הסליקה - אם
  // מועד הסליקה בתוך החלון, זו הכנסה צפויה אמיתית שקודם לא הופיעה בשום מקום.
  // חיובים מהחודש שלפני תחילת החלון הם המוקדמים ביותר שנסלקים בתוכו.
  const creditClearing = { total: 0, count: 0 };
  {
    // גבול רחב (תחילת החודש הקלנדרי הקודם) - הסינון המדויק נעשה לפי מועד הסליקה
    const chargeFrom = addMonths(startOfMonth(firstMonthStart), -1);
    const clearingFilter = {
      schemaVersion: 2,
      recordType: { $in: ["registration", "collection_followup"] },
      payments: {
        $elemMatch: {
          paid: true,
          method: "credit",
          dueDate: { $gte: chargeFrom },
        },
      },
    };
    applySince(req, clearingFilter);
    const clearingDeals = await Registration.find(clearingFilter)
      .select("totalAmount amountExVat payments")
      .lean();
    for (const reg of clearingDeals) {
      for (const p of reg.payments || []) {
        if (!p.paid || !isCreditPayment(p) || !p.dueDate) continue;
        const amt = Number(p.amount) || 0;
        if (amt <= 0) continue;
        const clearing = creditClearingDate(p.dueDate);
        if (clearing < firstMonthStart) continue; // נסלק לפני החלון - כבר בבנק
        const idx = index.get(keyOf(clearing));
        if (idx === undefined) continue; // מעבר לקצה החלון
        const amount = includeVat ? amt : exVatIncome(amt, reg);
        buckets[idx].expectedIncome += amount;
        creditClearing.total += amount;
        creditClearing.count += 1;
      }
    }
  }

  // --- EXPENSE: recurring (any cadence) always, plus variable one-offs in range ---
  const expenses = await Expense.find({
    $or: [
      { recurrence: { $in: ["monthly", "quarterly", "yearly"] } },
      {
        date: {
          $gte: firstMonthStart,
          $lt: addMonths(
            buckets.length
              ? buckets[buckets.length - 1].start
              : firstMonthStart,
            1,
          ),
        },
      },
    ],
  })
    .select("amount vatIncluded recurrence dayOfMonth date startDate endDate")
    .lean();
  attributeExpenses(expenses, buckets, index, includeVat, keyOf);

  // --- finalize: round, compute net + running cumulative + totals ---
  const round2 = (n) => Math.round(n * 100) / 100;
  let cumulative = 0;
  const totals = { income: 0, expense: 0, net: 0 };
  const months = buckets.map((b) => {
    const expectedIncome = round2(b.expectedIncome);
    const expectedExpense = round2(b.expectedExpense);
    const net = round2(expectedIncome - expectedExpense);
    cumulative = round2(cumulative + net);
    totals.income += expectedIncome;
    totals.expense += expectedExpense;
    return {
      key: b.key,
      label: b.label,
      expectedIncome,
      expectedExpense,
      net,
      cumulative,
    };
  });
  totals.income = round2(totals.income); // scheduled (credit/ERN) income within the window
  totals.expense = round2(totals.expense);
  totals.net = round2(totals.income - totals.expense);

  // Outstanding money whose collection timing is unknown (bank transfer / cash / combined).
  const unscheduledIncome = {
    total: round2(unscheduled.total),
    byCategory: Object.fromEntries(
      Object.entries(unscheduled.byCategory).map(([k, v]) => [k, round2(v)]),
    ),
  };

  // החזרים ממתינים: כסף ששולם על עסקאות שבוטלו וצריך לחזור - יוצא ללא תאריך ידוע
  const refundItems = await findRefundsDue(req);
  const refundsDue = {
    total: round2(refundItems.reduce((a, x) => a + x.amount, 0)),
    count: refundItems.length,
  };

  res.json({
    success: true,
    data: {
      months,
      totals,
      unscheduledIncome,
      refundsDue,
      granularity,
      // כסף שכבר חויב באשראי וממתין לסליקה בתוך החלון (נכלל בעמודות)
      creditClearing: {
        total: round2(creditClearing.total),
        count: creditClearing.count,
      },
    },
  });
});


/**
 * GET /api/cashflow/month-detail?month=YYYY-MM&windowFrom=YYYY-MM-DD&vat=true|false
 * הפירוט מאחורי עמודת-חודש בתחזית: אילו תשלומים (של אילו תלמידים/עסקאות) מרכיבים את
 * ההכנסה הצפויה, ואילו הוצאות את ההוצאה הצפויה. משתמש באותם כללים בדיוק כמו התחזית:
 * תשלום עתידי משובץ לחודש של תאריך היעד שלו; תשלום שמועדו עבר נצמד לחודש הראשון בחלון.
 */
export const monthDetail = asyncHandler(async (req, res) => {
  const raw = String(req.query.month || "");
  let monthStart;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    // תאריך של יום (לחיצה על עמודת-יום): החודש הקלנדרי שמכיל אותו
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw ApiError.badRequest("חודש לא תקין");
    monthStart = startOfMonth(d);
  } else if (/^\d{4}-\d{2}$/.test(raw)) {
    const [y, mo] = raw.split("-").map(Number);
    monthStart = new Date(Date.UTC(y, mo - 1, 1));
  } else {
    throw ApiError.badRequest("חודש לא תקין (פורמט YYYY-MM או YYYY-MM-DD)");
  }
  const monthEnd = addMonths(monthStart, 1);
  const includeVat = req.query.vat !== "false";
  const windowFrom = req.query.windowFrom
    ? startOfMonth(new Date(req.query.windowFrom))
    : null;
  // האם זהו החודש הראשון בחלון המוצג? אם כן - תשלומים שמועדם עבר "נצמדים" אליו
  const isFirstMonth =
    windowFrom && windowFrom.getTime() === monthStart.getTime();

  const round2 = (n) => Math.round(n * 100) / 100;
  const debtorsFilter = {
    outstanding: { $gt: 0 },
    recordType: { $in: ["registration", "collection_followup"] },
  };
  applySince(req, debtorsFilter);
  const debtors = await Registration.find(debtorsFilter)
    .select(
      "externalId student studentName courseRaw courseField repName outstanding totalAmount amountExVat installments paymentCategory nextPaymentDate schemaVersion payments",
    )
    .lean();

  const income = [];
  for (const reg of debtors) {
    if (reg.schemaVersion === 2) {
      for (const p of reg.payments || []) {
        if (p.paid) continue;
        const amt = Number(p.amount) || 0;
        if (amt <= 0) continue;
        // השיבוץ לעמודה נעשה לפי מועד קבלת הכסף (אשראי → סליקה ב-7 לחודש העוקב)
        const cash = p.dueDate ? cashDateOf(p) : null;
        const inBucket = cash && cash >= monthStart && cash < monthEnd;
        // תשלום שמועד הכסף שלו עבר (או חסר תאריך) נצמד לעמודה הראשונה בלבד
        const clampedHere =
          isFirstMonth && (!cash || (windowFrom && cash < windowFrom));
        if (!inBucket && !clampedHere) continue;
        income.push({
          student: reg.student,
          studentName: reg.studentName,
          course: reg.courseRaw || reg.courseField || "",
          repName: reg.repName || "",
          method: p.method || p.methodCategory || "",
          note: p.note || "",
          dueDate: p.dueDate,
          cashDate: cash,
          overdue: Boolean(cash && windowFrom && cash < windowFrom),
          amount: round2(includeVat ? amt : exVatIncome(amt, reg)),
        });
      }
    } else if (SCHEDULED_CATEGORIES.has(reg.paymentCategory || "")) {
      // עסקת legacy (v1): פריסה משוערת - היתרה מחולקת שווה בין התשלומים
      const spread =
        Number(reg.installments) > 1 ? Number(reg.installments) : 1;
      const gross = Number(reg.outstanding) || 0;
      const amount = includeVat ? gross : exVatIncome(gross, reg);
      let cursor = incomeAnchor(reg, windowFrom || monthStart);
      // אשראי: הכסף נסלק בחודש העוקב לחיוב (כמו בתחזית)
      if ((reg.paymentCategory || "") === "credit")
        cursor = addMonths(cursor, 1);
      for (let i = 0; i < spread; i += 1) {
        if (cursor >= monthStart && cursor < monthEnd) {
          income.push({
            student: reg.student,
            studentName: reg.studentName,
            course: reg.courseRaw || reg.courseField || "",
            repName: reg.repName || "",
            method: reg.paymentCategory,
            note: `הערכה: תשלום ${i + 1}/${spread} מהיתרה`,
            dueDate: null,
            overdue: false,
            amount: round2(amount / spread),
          });
        }
        cursor = addMonths(cursor, 1);
      }
    }
  }

  // --- חיובי אשראי שכבר בוצעו ונסלקים בעמודה הזו (ה-7 בחודש) - כמו בתחזית ---
  {
    // גבולות רחבים סביב העמודה - הסינון המדויק לפי מועד הסליקה נעשה בהמשך
    const chargeFrom = addMonths(startOfMonth(monthStart), -1);
    const chargeTo = startOfMonth(monthEnd);
    const clearingFilter = {
      schemaVersion: 2,
      recordType: { $in: ["registration", "collection_followup"] },
      payments: {
        $elemMatch: {
          paid: true,
          method: "credit",
          dueDate: { $gte: chargeFrom, $lt: chargeTo },
        },
      },
    };
    applySince(req, clearingFilter);
    const clearingDeals = await Registration.find(clearingFilter)
      .select(
        "student studentName courseRaw courseField repName totalAmount amountExVat payments",
      )
      .lean();
    for (const reg of clearingDeals) {
      for (const p of reg.payments || []) {
        if (!p.paid || !isCreditPayment(p) || !p.dueDate) continue;
        const amt = Number(p.amount) || 0;
        if (amt <= 0) continue;
        const clearing = creditClearingDate(p.dueDate);
        if (clearing < monthStart) continue;
        if (clearing >= monthEnd) continue;
        income.push({
          student: reg.student,
          studentName: reg.studentName,
          course: reg.courseRaw || reg.courseField || "",
          repName: reg.repName || "",
          method: "credit",
          note: "ממתין לסליקה - הלקוח כבר חויב",
          dueDate: p.dueDate,
          cashDate: clearing,
          overdue: false,
          pendingClearing: true,
          amount: round2(includeVat ? amt : exVatIncome(amt, reg)),
        });
      }
    }
  }
  income.sort((a, b) => b.amount - a.amount);

  // --- הוצאות החודש ---
  const expenses = await Expense.find({
    $or: [
      { recurrence: { $in: ["monthly", "quarterly", "yearly"] } },
      { date: { $gte: monthStart, $lt: monthEnd } },
    ],
  }).lean();
  const expenseItems = [];
  for (const exp of expenses) {
    let hits = false;
    if (exp.recurrence && exp.recurrence !== "none") {
      // הוצאה חוזרת שייכת לעמודה אם תאריך החיוב שלה (יום-בחודש) נופל בטווח שלה
      const day = Math.min(Math.max(parseInt(exp.dayOfMonth, 10) || 1, 1), 28);
      const candidates = [
        startOfMonth(monthStart),
        addMonths(startOfMonth(monthStart), 1),
      ];
      for (const m of candidates) {
        if (!recurrenceHitsMonth(exp, m)) continue;
        const at = new Date(
          Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), day),
        );
        if (at >= monthStart && at < monthEnd) {
          hits = true;
          break;
        }
      }
    } else if (exp.date) {
      hits = new Date(exp.date) >= monthStart && new Date(exp.date) < monthEnd;
    }
    if (!hits) continue;
    expenseItems.push({
      name: exp.name,
      category: exp.category || "",
      recurrence: exp.recurrence || "none",
      amount: round2(expenseAmount(exp, includeVat)),
    });
  }
  expenseItems.sort((a, b) => b.amount - a.amount);

  res.json({
    success: true,
    data: {
      month: req.query.month,
      bucketStart: DATE_KEY(monthStart), // תחילת חודש-התזרים שנפתר בפועל
      income,
      expenses: expenseItems,
      totals: {
        income: round2(income.reduce((a, x) => a + x.amount, 0)),
        expense: round2(expenseItems.reduce((a, x) => a + x.amount, 0)),
      },
    },
  });
});

/**
 * GET /api/cashflow/unscheduled-detail?vat=true|false
 * הפירוט מאחורי "לגבייה - ללא מועד ודאי": כל עסקה שיש לה יתרה שאינה מכוסה בתשלומים
 * עתידיים מתועדים - כמה, באיזה אמצעי, ולמה אין מועד (תוכנית בהערה בלבד / אין פריסה).
 * אותה לוגיקה בדיוק כמו התחזית (attributeIncome), כך שהסכום תואם 1:1 לקוביה.
 */
export const unscheduledDetail = asyncHandler(async (req, res) => {
  const includeVat = req.query.vat !== "false";
  const round2 = (n) => Math.round(n * 100) / 100;

  const debtorsFilter = {
    outstanding: { $gt: 0 },
    recordType: { $in: ["registration", "collection_followup"] },
  };
  applySince(req, debtorsFilter);
  const debtors = await Registration.find(debtorsFilter)
    .select(
      "externalId student studentName courseRaw courseField repName dealDate outstanding totalAmount totalPaid amountExVat installments paymentCategory nextPaymentNote schemaVersion payments noteEntries",
    )
    .lean();

  const items = [];
  for (const reg of debtors) {
    let remainder = 0;
    if (reg.schemaVersion === 2) {
      const scheduled = (reg.payments || [])
        .filter((p) => !p.paid)
        .reduce((a, p) => a + (p.amount || 0), 0);
      remainder = (Number(reg.outstanding) || 0) - scheduled;
    } else if (!SCHEDULED_CATEGORIES.has(reg.paymentCategory || "")) {
      remainder = Number(reg.outstanding) || 0; // legacy לא-מתוזמן
    }
    if (remainder <= 0.5) continue;

    // הסיבה: תוכנית שמופיעה רק בהערה, או אין תיעוד בכלל
    const planNote =
      reg.nextPaymentNote ||
      (reg.noteEntries || [])
        .map((n) => n.text)
        .find((t) => /בהמשך|תשלומים|לחודש|פריסה/.test(t || ""));
    items.push({
      student: reg.student,
      studentName: reg.studentName,
      externalId: reg.externalId,
      course: reg.courseRaw || reg.courseField || "",
      repName: reg.repName || "",
      method: reg.paymentCategory || "unknown",
      dealDate: reg.dealDate,
      totalAmount: reg.totalAmount,
      totalPaid: reg.totalPaid,
      amount: round2(includeVat ? remainder : exVatIncome(remainder, reg)),
      planNote: planNote || null,
      reason: planNote
        ? "תוכנית קיימת בהערה בלבד - ללא תאריכים מתועדים"
        : "אין פריסה או תוכנית מתועדת",
    });
  }
  items.sort((a, b) => b.amount - a.amount);
  const refunds = await findRefundsDue(req);
  res.json({
    success: true,
    data: {
      items,
      total: round2(items.reduce((a, x) => a + x.amount, 0)),
      byCategory: items.reduce((m, x) => {
        m[x.method] = round2((m[x.method] || 0) + x.amount);
        return m;
      }, {}),
      refunds,
      refundsTotal: round2(refunds.reduce((a, x) => a + x.amount, 0)),
    },
  });
});
