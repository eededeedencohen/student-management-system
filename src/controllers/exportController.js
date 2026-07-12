/**
 * Export controller - Excel (xlsx) downloads.
 * כל הדוחות יוצאים כקובץ אקסל עם כותרות עמודות בעברית.
 *
 * Reps are scoped to their own data via scopeToRep (req.scopeRepId).
 * Managers see everything and may narrow with ?repId.
 *
 * Revenue/registration reports count ONLY recordType==='registration'
 * (advertising / collection_followup / other are excluded) - see buildRegFilter.
 * The debtors report is the documented exception: it includes ANY record with
 * outstanding > 0 regardless of recordType.
 */
import XLSX from "xlsx";
import Registration from "../models/Registration.js";
import Course from "../models/Course.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { parseDateQuery } from "../utils/dateRanges.js";

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

/** Format a Date as dd/mm/yyyy (UTC) for sheet cells; '' when missing. */
const fmtDate = (date) => {
  if (!date) return "";
  const x = new Date(date);
  if (Number.isNaN(x.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(x.getUTCDate())}/${pad(x.getUTCMonth() + 1)}/${x.getUTCFullYear()}`;
};

/** Round money to 2 decimals (avoid float noise in the sheet). */
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

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

/**
 * Build a workbook from rows (array of plain objects with Hebrew keys) and
 * stream it back as an .xlsx attachment with a UTF-8 (RFC 5987) filename.
 */
const sendWorkbook = (res, { rows, sheetName = "Sheet1", fileName }) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{}]);
  // Sheet names are capped at 31 chars by the xlsx format.
  XLSX.utils.book_append_sheet(wb, ws, String(sheetName).slice(0, 31));
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}.xlsx`,
  );
  return res.send(buffer);
};

/* ------------------------------------------------------------------ */
/* handlers                                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/export/registrations.xlsx
 * Same filters as the registrations list. Only recordType==='registration'.
 * Columns (Hebrew): תאריך, שם הנרשם, ת.ז., קורס, מחזור, נציגה, סה"כ עסקה,
 *   שולם, יתרה, סטטוס תשלום, אופן תשלום, תקנון, הערות.
 */
export const exportRegistrations = asyncHandler(async (req, res) => {
  const filter = buildRegFilter(req);
  const regs = await Registration.find(filter).sort({ dealDate: -1 }).lean();

  const rows = regs.map((r) => ({
    תאריך: fmtDate(r.dealDate),
    "שם הנרשם": r.studentName || "",
    "ת.ז.": r.idNumber || "",
    קורס: r.courseRaw || r.courseField || "",
    מחזור: r.cohortLabel || "",
    נציגה: r.repName || "",
    'סה"כ עסקה': money(r.totalAmount),
    שולם: money(r.totalPaid),
    יתרה: money(r.outstanding),
    "סטטוס תשלום": statusLabel(r.paymentStatus),
    "אופן תשלום": r.primaryPaymentMethod || "",
    תקנון: yesNo(r.checklist?.signedTakanon),
    הערות: r.notes || "",
    "תאריך מקורי": r.dealDateRaw || "",
    "קובץ מקור": r.sourceFile || "",
    "גליון מקור": r.sourceSheet || "",
    "שורת מקור": r.sourceRow || "",
  }));

  return sendWorkbook(res, {
    rows,
    sheetName: "רישומים",
    fileName: "registrations",
  });
});

/**
 * GET /api/export/debtors.xlsx
 * Registrations with outstanding > 0 (חייבים). Intentionally includes ALL
 * recordTypes - this is the documented exception to the registration-only rule.
 * Columns (Hebrew): שם, קורס, נציגה, סה"כ, שולם, חוב, מתי לגבות.
 */
export const exportDebtors = asyncHandler(async (req, res) => {
  // onlyRegistrations:false -> include collection follow-ups etc. that owe money
  const filter = buildRegFilter(req, { onlyRegistrations: false });
  filter.outstanding = { $gt: 0 };

  const regs = await Registration.find(filter)
    .sort({ nextPaymentDate: 1, dealDate: -1 })
    .lean();

  const rows = regs.map((r) => ({
    שם: r.studentName || "",
    קורס: r.courseRaw || r.courseField || "",
    נציגה: r.repName || "",
    'סה"כ': money(r.totalAmount),
    שולם: money(r.totalPaid),
    חוב: money(r.outstanding),
    "מתי לגבות": fmtDate(r.nextPaymentDate) || r.nextPaymentNote || "",
    "קובץ מקור": r.sourceFile || "",
    "שורת מקור": r.sourceRow || "",
  }));

  return sendWorkbook(res, { rows, sheetName: "חייבים", fileName: "debtors" });
});

/**
 * GET /api/export/course/:id/roster.xlsx
 * Roster for a course. :id is either a Course _id, OR pass
 * ?courseField=...&cohortLabel=... to match by family + cohort.
 * Columns (Hebrew): שם הנרשם, ת.ז., נציגה, סטטוס תשלום.
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

  const rows = regs.map((r) => ({
    "שם הנרשם": r.studentName || "",
    "ת.ז.": r.idNumber || "",
    נציגה: r.repName || "",
    "סטטוס תשלום": statusLabel(r.paymentStatus),
    "קובץ מקור": r.sourceFile || "",
    "שורת מקור": r.sourceRow || "",
  }));

  const baseName =
    course?.name || req.query.courseField || decodeURIComponent(id);
  const fileName = `roster-${baseName}`;
  return sendWorkbook(res, { rows, sheetName: "משתתפים", fileName });
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

  const rows = regs.map((r) => ({
    תאריך: fmtDate(r.dealDate),
    "שם הנרשם": r.studentName || "",
    "ת.ז.": r.idNumber || "",
    קורס: r.courseRaw || r.courseField || "",
    מחזור: r.cohortLabel || "",
    נציגה: r.repName || "",
    'סה"כ עסקה': money(r.totalAmount),
    שולם: money(r.totalPaid),
    יתרה: money(r.outstanding),
    "סטטוס תשלום": statusLabel(r.paymentStatus),
    "אופן תשלום": r.primaryPaymentMethod || "",
    תקנון: yesNo(r.checklist?.signedTakanon),
    הערות: r.notes || "",
    "תאריך מקורי": r.dealDateRaw || "",
    "קובץ מקור": r.sourceFile || "",
    "גליון מקור": r.sourceSheet || "",
    "שורת מקור": r.sourceRow || "",
  }));

  return sendWorkbook(res, {
    rows,
    sheetName: `${m[1]}-${m[2]}`,
    fileName: `registrations-${m[1]}-${m[2]}`,
  });
});
