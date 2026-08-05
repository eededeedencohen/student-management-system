/**
 * Export controller - Excel (xlsx) downloads.
 * כל הדוחות יוצאים כקובץ אקסל מעוצב: גיליון מימין-לשמאל, כותרות צבועות וקפואות,
 * פסי זברה, רוחב עמודות לפי התוכן, פורמט ₪/תאריך, צביעת סטטוסים ושורת סיכום
 * (utils/excelExport.js).
 *
 * Reps are scoped to their own data via scopeToRep (req.scopeRepId).
 * Managers see everything and may narrow with ?repId.
 *
 * Revenue/registration reports count ONLY recordType==='registration'
 * (advertising / collection_followup / other are excluded) - see buildRegFilter.
 * The debtors report is the documented exception: it includes ANY record with
 * outstanding > 0 regardless of recordType.
 */
import Registration from "../models/Registration.js";
import Course from "../models/Course.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { parseDateQuery } from "../utils/dateRanges.js";
import { sendStyledWorkbook } from "../utils/excelExport.js";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

const PAYMENT_STATUS_HE = {
  paid: "שולם",
  partial: "חלקי",
  unpaid: "לא שולם",
};

/** Map an internal paymentStatus to its Hebrew label (fallback to raw). */
const statusLabel = (s) => PAYMENT_STATUS_HE[s] || s || "";

/** Hebrew yes/no for the takanon (signed-contract) flag. */
const yesNo = (v) => (v ? "כן" : "לא");

/** תאריך לתא אקסל אמיתי (מקבל פורמט dd/mm/yyyy בגיליון); null כשחסר. */
const asDate = (d) => {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
};

/** Round money to 2 decimals (avoid float noise in the sheet). */
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** תאריך הפקה לתת-הכותרת של כל דוח. */
const stamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Build the registrations filter, mirroring the registrations list endpoint.
 * - Rep scoping: reps forced to their own rep id; managers may pass ?repId.
 * - Date filter applied to dealDate when from/to/period present.
 * - By default only real registrations are counted.
 */
const buildRegFilter = (req, { onlyRegistrations = true } = {}) => {
  const filter = {};

  // recordType: revenue/registration reports exclude ads & follow-ups
  if (onlyRegistrations) filter.recordType = "registration";

  // rep scoping
  if (req.scopeRepId) {
    filter.rep = req.scopeRepId; // rep: locked to self
  } else if (req.query.repId) {
    filter.rep = req.query.repId; // manager: optional narrowing
  }

  // optional list-style filters
  if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
  if (req.query.courseField) filter.courseField = req.query.courseField;
  if (req.query.cohortLabel) filter.cohortLabel = req.query.cohortLabel;
  if (req.query.course) filter.course = req.query.course;
  if (req.query.needsReview === "true") filter.needsReview = true;

  // free-text search over name / id / course
  if (req.query.q) {
    const rx = new RegExp(
      String(req.query.q)
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
    filter.$or = [{ studentName: rx }, { idNumber: rx }, { courseRaw: rx }];
  }

  // date filter on dealDate
  const dateFilter = parseDateQuery(req.query);
  if (dateFilter) filter.dealDate = dateFilter;

  return filter;
};

/** תיאור הסינון שנבחר, לתת-הכותרת - שיהיה ברור מה בדיוק יש בקובץ. */
const describeRegFilters = async (req) => {
  const parts = [];
  if (req.query.repId && !req.scopeRepId) parts.push("נציגה מסוימת");
  if (req.scopeRepId) parts.push("הנתונים שלך בלבד");
  if (req.query.paymentStatus)
    parts.push(`סטטוס: ${statusLabel(req.query.paymentStatus)}`);
  if (req.query.course) {
    const c = await Course.findById(req.query.course)
      .select("name")
      .lean()
      .catch(() => null);
    if (c?.name) parts.push(`קורס: ${c.name}`);
  }
  if (req.query.from || req.query.to) {
    parts.push(
      `טווח: ${req.query.from || "ההתחלה"} עד ${req.query.to || "היום"}`,
    );
  }
  return parts.length
    ? `סינון: ${parts.join(" · ")}`
    : "ללא סינון - כל הנתונים";
};

/* ------------------------------------------------------------------ */
/* column layouts                                                     */
/* ------------------------------------------------------------------ */

// פריסת העמודות של דוח רישומים (משמשת גם את הדוח החודשי)
const REG_COLUMNS = [
  { header: "תאריך עסקה", key: "date", type: "date" },
  { header: "שם הנרשם/ת", key: "name" },
  { header: "ת.ז.", key: "idNumber" },
  { header: "קורס", key: "course" },
  { header: "מחזור", key: "cohort" },
  { header: "נציגה", key: "rep" },
  { header: 'סה"כ עסקה', key: "total", type: "money" },
  { header: "שולם", key: "paid", type: "money" },
  { header: "יתרה", key: "outstanding", type: "money" },
  { header: "סטטוס תשלום", key: "status", type: "status" },
  { header: "אופן תשלום", key: "method" },
  { header: "תקנון", key: "takanon", type: "bool" },
  { header: "הערות", key: "notes" },
];

const regRow = (r) => ({
  date: asDate(r.dealDate),
  name: r.studentName || "",
  idNumber: r.idNumber || "",
  course: r.courseRaw || r.courseField || "",
  cohort: r.cohortLabel || "",
  rep: r.repName || "",
  total: money(r.totalAmount),
  paid: money(r.totalPaid),
  outstanding: money(r.outstanding),
  status: statusLabel(r.paymentStatus),
  method: r.primaryPaymentMethod || "",
  takanon: yesNo(r.checklist?.signedTakanon),
  notes: r.notes || "",
});

/* ------------------------------------------------------------------ */
/* handlers                                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/export/registrations.xlsx
 * Same filters as the registrations list. Only recordType==='registration'.
 */
export const exportRegistrations = asyncHandler(async (req, res) => {
  const filter = buildRegFilter(req);
  const regs = await Registration.find(filter).sort({ dealDate: -1 }).lean();

  return sendStyledWorkbook(res, "רישומים", {
    sheetName: "רישומים",
    title: "כל הרישומים - מכללת ספרא",
    subtitle: `${await describeRegFilters(req)} · הופק: ${stamp()} · ${regs.length} רשומות`,
    columns: REG_COLUMNS,
    rows: regs.map(regRow),
    totals: ["total", "paid", "outstanding"],
  });
});

/**
 * GET /api/export/debtors.xlsx
 * Registrations with outstanding > 0 (חייבים). Intentionally includes ALL
 * recordTypes - this is the documented exception to the registration-only rule.
 */
export const exportDebtors = asyncHandler(async (req, res) => {
  // onlyRegistrations:false -> include collection follow-ups etc. that owe money
  const filter = buildRegFilter(req, { onlyRegistrations: false });
  filter.outstanding = { $gt: 0 };

  const regs = await Registration.find(filter)
    .sort({ nextPaymentDate: 1, dealDate: -1 })
    .lean();

  return sendStyledWorkbook(res, "חייבים", {
    sheetName: "חייבים",
    title: "חייבים - יתרות פתוחות לגבייה",
    subtitle: `כל רשומה עם חוב פתוח, ממוינת לפי מועד הגבייה הקרוב · הופק: ${stamp()} · ${regs.length} רשומות`,
    columns: [
      { header: "שם הנרשם/ת", key: "name" },
      { header: "קורס", key: "course" },
      { header: "נציגה", key: "rep" },
      { header: 'סה"כ עסקה', key: "total", type: "money" },
      { header: "שולם", key: "paid", type: "money" },
      { header: "חוב", key: "debt", type: "money" },
      { header: "מתי לגבות", key: "collect" },
      { header: "הערות גבייה", key: "note" },
    ],
    rows: regs.map((r) => ({
      name: r.studentName || "",
      course: r.courseRaw || r.courseField || "",
      rep: r.repName || "",
      total: money(r.totalAmount),
      paid: money(r.totalPaid),
      debt: money(r.outstanding),
      collect: r.nextPaymentDate
        ? asDate(r.nextPaymentDate)?.toLocaleDateString("he-IL") || ""
        : r.nextPaymentNote || "",
      note: r.nextPaymentNote && r.nextPaymentDate ? r.nextPaymentNote : "",
    })),
    totals: ["total", "paid", "debt"],
  });
});

/**
 * GET /api/export/course/:id/roster.xlsx
 * Roster for a course. :id is either a Course _id, OR pass
 * ?courseField=...&cohortLabel=... to match by family + cohort.
 */
export const exportCourseRoster = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // Only real registrations belong on a roster.
  const filter = { recordType: "registration" };

  // rep scoping still applies (a rep only exports their own students)
  if (req.scopeRepId) filter.rep = req.scopeRepId;
  else if (req.query.repId) filter.rep = req.query.repId;

  let course = null;
  const isObjectId = /^[a-f\d]{24}$/i.test(String(id));
  if (isObjectId) {
    course = await Course.findById(id).lean();
    if (!course) throw ApiError.notFound("הקורס לא נמצא");
    filter.course = course._id;
  } else {
    // fall back to courseField + cohortLabel matching
    const courseField = req.query.courseField || decodeURIComponent(id);
    if (!courseField)
      throw ApiError.badRequest("נדרש מזהה קורס או courseField");
    filter.courseField = courseField;
    if (req.query.cohortLabel) filter.cohortLabel = req.query.cohortLabel;
  }

  const regs = await Registration.find(filter).sort({ studentName: 1 }).lean();

  const baseName =
    course?.name || req.query.courseField || decodeURIComponent(id);
  return sendStyledWorkbook(res, `רשימת משתתפים - ${baseName}`, {
    sheetName: "משתתפים",
    title: `רשימת משתתפים - ${baseName}`,
    subtitle: `הופק: ${stamp()} · ${regs.length} משתתפים`,
    columns: [
      { header: "שם הנרשם/ת", key: "name" },
      { header: "ת.ז.", key: "idNumber" },
      { header: "נציגה", key: "rep" },
      { header: "סטטוס תשלום", key: "status", type: "status" },
      { header: "תקנון", key: "takanon", type: "bool" },
    ],
    rows: regs.map((r) => ({
      name: r.studentName || "",
      idNumber: r.idNumber || "",
      rep: r.repName || "",
      status: statusLabel(r.paymentStatus),
      takanon: yesNo(r.checklist?.signedTakanon),
    })),
  });
});

/**
 * GET /api/export/by-month.xlsx?month=YYYY-MM
 * All registrations whose dealDate falls in the given calendar month.
 * Uses the same column layout as the registrations export.
 */
export const exportByMonth = asyncHandler(async (req, res) => {
  const { month } = req.query;
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!m) throw ApiError.badRequest("נדרש פרמטר month בפורמט YYYY-MM");

  const year = parseInt(m[1], 10);
  const mon = parseInt(m[2], 10); // 1-12
  if (mon < 1 || mon > 12) throw ApiError.badRequest("חודש לא תקין");

  const from = new Date(Date.UTC(year, mon - 1, 1));
  const to = new Date(Date.UTC(year, mon, 1)); // exclusive: first of next month

  // registration-only revenue rows for the month
  const filter = {
    recordType: "registration",
    dealDate: { $gte: from, $lt: to },
  };
  if (req.scopeRepId) filter.rep = req.scopeRepId;
  else if (req.query.repId) filter.rep = req.query.repId;

  const regs = await Registration.find(filter).sort({ dealDate: -1 }).lean();

  const monthLabel = `${m[2]}/${m[1]}`;
  return sendStyledWorkbook(res, `דוח חודשי ${m[1]}-${m[2]}`, {
    sheetName: `${m[1]}-${m[2]}`,
    title: `דוח רישומים חודשי - ${monthLabel}`,
    subtitle: `כל העסקאות שנסגרו בחודש ${monthLabel} · הופק: ${stamp()} · ${regs.length} רשומות`,
    columns: REG_COLUMNS,
    rows: regs.map(regRow),
    totals: ["total", "paid", "outstanding"],
  });
});
