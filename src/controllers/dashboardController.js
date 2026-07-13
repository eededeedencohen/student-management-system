import mongoose from "mongoose";
import Registration from "../models/Registration.js";
import User from "../models/User.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import {
  parseDateQuery,
  bucketOf,
  GRANULARITIES,
  nowFromReq,
} from "../utils/dateRanges.js";
import { applySince } from "../utils/dataScope.js";
import { cashDateOf } from "../utils/cashTiming.js";

/**
 * Dashboard controller - KPIs for the manager (וגם נציג בודד בסקופ).
 *
 * NOTE on filtering: sales metrics count ONLY recordType === 'registration'
 * (advertising / collection_followup / other are excluded). This is applied to
 * every aggregation below via the shared `recordType: 'registration'` match.
 */

const { Types } = mongoose;

/**
 * Resolve which rep to constrain to.
 * - Reps are auto-scoped to themselves (req.scopeRepId set by scopeToRep).
 * - Managers (scopeRepId null) may optionally pass ?repId to focus one rep.
 * Returns an ObjectId or null (no rep constraint).
 */
function resolveRepId(req) {
  // נציג: תמיד רואה רק את עצמו
  if (req.scopeRepId) {
    if (!Types.ObjectId.isValid(req.scopeRepId)) {
      throw ApiError.badRequest("מזהה נציג לא תקין");
    }
    return new Types.ObjectId(req.scopeRepId);
  }
  // מנהל: סינון אופציונלי לפי repId
  const { repId } = req.query;
  if (repId) {
    if (!Types.ObjectId.isValid(repId))
      throw ApiError.badRequest("מזהה נציג לא תקין");
    return new Types.ObjectId(repId);
  }
  return null;
}

/** Build the base registration $match (sales only) with date + rep scope. */
function buildRegMatch(dateFilter, repId, req) {
  const match = { recordType: "registration" };
  if (dateFilter) match.dealDate = dateFilter;
  if (repId) match.rep = repId;
  if (req) applySince(req, match); // מוד "מ-2026 בלבד"
  return match;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * GET /api/dashboard/summary
 * Headline KPIs for the selected range + scope.
 */
export const summary = asyncHandler(async (req, res) => {
  const dateFilter = parseDateQuery(req.query, nowFromReq(req));
  const repId = resolveRepId(req);
  const regMatch = buildRegMatch(dateFilter, repId, req);

  /** aggregate one window into the headline numbers (+ status distribution). */
  const aggregateWindow = async (match) => {
    const rows = await Registration.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$paymentStatus",
          deals: { $sum: 1 },
          salesAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
          collected: { $sum: { $ifNull: ["$totalPaid", 0] } },
          outstanding: { $sum: { $ifNull: ["$outstanding", 0] } },
          studentSet: { $addToSet: "$student" },
        },
      },
    ]);
    const out = {
      deals: 0,
      salesAmount: 0,
      collected: 0,
      outstanding: 0,
      statusDist: { paid: 0, partial: 0, unpaid: 0 },
      students: new Set(),
    };
    for (const r of rows) {
      out.deals += r.deals;
      out.salesAmount += r.salesAmount;
      out.collected += r.collected;
      out.outstanding += r.outstanding;
      if (out.statusDist[r._id] !== undefined) out.statusDist[r._id] = r.deals;
      for (const s of r.studentSet) if (s != null) out.students.add(String(s));
    }
    return out;
  };

  const cur = await aggregateWindow(regMatch);

  // תקופה קודמת - לחישוב דלתא בכרטיסי ה-KPI. הלקוח שולח ?prevFrom/?prevTo מפורשים
  // ("אותה נקודה בתקופה הקודמת" - הוגן לחלון של מתחילת-התקופה-עד-היום); בהיעדרם,
  // ברירת מחדל: חלון זהה באורכו צמוד אחורה.
  let prev = null;
  let prevFilter = null;
  if (req.query.prevFrom && req.query.prevTo) {
    const pf = new Date(req.query.prevFrom);
    const pt = new Date(req.query.prevTo);
    if (!Number.isNaN(pf.getTime()) && !Number.isNaN(pt.getTime()))
      prevFilter = { $gte: pf, $lt: pt };
  } else if (dateFilter?.$gte && dateFilter?.$lt) {
    const from = new Date(dateFilter.$gte);
    const to = new Date(dateFilter.$lt);
    prevFilter = { $gte: new Date(from - (to - from)), $lt: from };
  }
  if (prevFilter) {
    const p = await aggregateWindow(buildRegMatch(prevFilter, repId, req));
    prev = {
      deals: p.deals,
      salesAmount: round2(p.salesAmount),
      collected: round2(p.collected),
    };
  }

  res.json({
    success: true,
    data: {
      registrants: cur.students.size,
      deals: cur.deals,
      salesAmount: round2(cur.salesAmount),
      collected: round2(cur.collected),
      outstanding: round2(cur.outstanding),
      avgBasket: cur.deals > 0 ? round2(cur.salesAmount / cur.deals) : 0,
      statusDist: cur.statusDist,
      prev,
    },
  });
});

/**
 * GET /api/dashboard/upcoming
 * הכנסות מתוזמנות קדימה: תשלומים עתידיים (paid=false), מקובצים לפי חודש
 * קבלת הכסף (אשראי נסלק ב-7 בחודש העוקב לחיוב; שאר האמצעים במועד התשלום),
 * לחצי השנה הקרובה. עסקאות בלבד (לא מבוטלות), בסקופ נציג/ה.
 */
export const upcoming = asyncHandler(async (req, res) => {
  const repId = resolveRepId(req);
  const now = nowFromReq(req);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 6, 1),
  );
  // חיוב אשראי מהחודש שלפני החלון נסלק בתוכו - מרחיבים את השאיפה חודש אחורה
  const chargeFrom = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );

  const match = { recordType: "registration" };
  if (repId) match.rep = repId;
  applySince(req, match); // מוד "מ-2026 בלבד"

  const payments = await Registration.aggregate([
    { $match: match },
    { $unwind: "$payments" },
    {
      $match: {
        "payments.paid": false,
        "payments.dueDate": { $gte: chargeFrom, $lt: end },
      },
    },
    {
      $project: {
        amount: "$payments.amount",
        dueDate: "$payments.dueDate",
        method: "$payments.method",
        methodCategory: "$payments.methodCategory",
      },
    },
  ]);
  // קיבוץ לפי חודש קבלת הכסף בפועל
  const byKey = new Map();
  for (const p of payments) {
    const cash = cashDateOf(p);
    if (!cash || cash < start || cash >= end) continue;
    const k = `${cash.getUTCFullYear()}-${cash.getUTCMonth() + 1}`;
    const cur = byKey.get(k) || { amount: 0, count: 0 };
    cur.amount += Number(p.amount) || 0;
    cur.count += 1;
    byKey.set(k, cur);
  }
  const data = [];
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1),
    );
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    const hit = byKey.get(k);
    data.push({
      key: k,
      label: `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`,
      amount: round2(hit?.amount || 0),
      count: hit?.count || 0,
    });
  }
  res.json({ success: true, data });
});

/**
 * GET /api/dashboard/upcoming-detail?from&to
 * פירוט התשלומים העתידיים (paid=false) שמועדם בטווח - מזין את מודל
 * הפירוט של גרף "הכנסות מתוזמנות". רשומות בלבד, בסקופ נציג/ה, מוד 2026.
 */
export const upcomingDetail = asyncHandler(async (req, res) => {
  const repId = resolveRepId(req);
  const from = new Date(req.query.from);
  const to = new Date(req.query.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw ApiError.badRequest("from/to נדרשים (YYYY-MM-DD)");
  }
  // חיוב אשראי מהחודש הקודם נסלק בטווח - מרחיבים את השאיפה חודש אחורה
  const chargeFrom = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1),
  );

  const match = { recordType: "registration" };
  if (repId) match.rep = repId;
  applySince(req, match); // מוד "מ-2026 בלבד"

  const rows = await Registration.aggregate([
    { $match: match },
    { $unwind: "$payments" },
    {
      $match: {
        "payments.paid": false,
        "payments.dueDate": { $gte: chargeFrom, $lt: to },
      },
    },
    {
      $project: {
        student: 1,
        studentName: 1,
        repName: 1,
        course: 1,
        courseRaw: 1,
        amount: "$payments.amount",
        dueDate: "$payments.dueDate",
        method: "$payments.method",
        methodCategory: "$payments.methodCategory",
        note: "$payments.note",
      },
    },
    { $sort: { dueDate: 1, studentName: 1 } },
    {
      $lookup: {
        from: "courses",
        localField: "course",
        foreignField: "_id",
        as: "courseDoc",
      },
    },
  ]);

  // מסננים לפי חודש קבלת הכסף בפועל (אשראי → סליקה ב-7 בחודש העוקב)
  const data = rows
    .map((r) => ({ ...r, cashDate: cashDateOf(r) }))
    .filter((r) => r.cashDate && r.cashDate >= from && r.cashDate < to)
    .map((r) => ({
      dealId: r._id,
      student: r.student,
      studentName: r.studentName,
      repName: r.repName,
      courseName: r.courseDoc?.[0]?.name || r.courseRaw || null,
      amount: round2(r.amount || 0),
      dueDate: r.dueDate,
      cashDate: r.cashDate,
      method: r.method || null,
      note: r.note || null,
    }));
  data.sort((a, b) => new Date(a.cashDate) - new Date(b.cashDate));
  res.json({
    success: true,
    data,
    total: data.length,
    sum: round2(data.reduce((a, x) => a + (x.amount || 0), 0)),
  });
});

/**
 * GET /api/dashboard/by-course
 * העסקאות בתקופה מקובצות לפי קורס (מכירות + עסקאות), ממוין יורד - "מה נמכר".
 */
export const byCourse = asyncHandler(async (req, res) => {
  const dateFilter = parseDateQuery(req.query, nowFromReq(req));
  const repId = resolveRepId(req);
  const match = buildRegMatch(dateFilter, repId, req);

  const rows = await Registration.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$course",
        deals: { $sum: 1 },
        salesAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
        fallbackName: { $first: { $ifNull: ["$courseRaw", "$courseField"] } },
      },
    },
    { $sort: { salesAmount: -1 } },
    { $limit: 8 },
    {
      $lookup: {
        from: "courses",
        localField: "_id",
        foreignField: "_id",
        as: "course",
      },
    },
  ]);
  const data = rows.map((r) => ({
    courseId: r._id ? String(r._id) : null, // להצלבה עם ספירת הרשומים החיה בלקוח
    name: r.course?.[0]?.name || r.fallbackName || "ללא קורס",
    deals: r.deals,
    salesAmount: round2(r.salesAmount),
  }));
  res.json({ success: true, data });
});

/**
 * GET /api/dashboard/timeseries
 * ?granularity (day|week|month|quarter|half|year, default month)
 * ?metric (deals|salesAmount|collected|outstanding|registrants, default salesAmount)
 * ?byRep=1 - בנוסף לסך הכללי, פירוק כל דלי לפי נציג/ה (byRep: { repId: value })
 *            + sidecar `reps`: כל הנציגות בסדר יציב (לפי _id = סדר יצירה), גם אלה
 *            בלי נתונים בטווח - כדי שצבע של נציגה לא ישתנה כשהפילטר משתנה,
 *            ושנציגות חדשות (3, 4…) יקבלו אוטומטית את המשבצת הבאה.
 * Groups registrations by bucketOf(dealDate, granularity) in JS.
 */
export const timeseries = asyncHandler(async (req, res) => {
  const dateFilter = parseDateQuery(req.query, nowFromReq(req));
  const repId = resolveRepId(req);
  const byRepMode = req.query.byRep === "1" || req.query.byRep === "true";

  const granularity = req.query.granularity || "month";
  if (!GRANULARITIES.includes(granularity)) {
    throw ApiError.badRequest(
      `granularity לא חוקי. ערכים אפשריים: ${GRANULARITIES.join(", ")}`,
    );
  }

  const allowedMetrics = [
    "deals",
    "salesAmount",
    "collected",
    "outstanding",
    "registrants",
  ];
  const metric = req.query.metric || "salesAmount";
  if (!allowedMetrics.includes(metric)) {
    throw ApiError.badRequest(
      `metric לא חוקי. ערכים אפשריים: ${allowedMetrics.join(", ")}`,
    );
  }

  /** תרומת עסקה אחת למדד (registrants נצבר כ-set בנפרד). */
  const contributionOf = (r) => {
    switch (metric) {
      case "deals":
        return 1;
      case "salesAmount":
        return r.totalAmount || 0;
      case "collected":
        return r.totalPaid || 0;
      case "outstanding":
        return r.outstanding || 0;
      default:
        return 0;
    }
  };

  const match = buildRegMatch(dateFilter, repId, req);
  // מושכים מסמכים רזים בלבד עם השדות הדרושים, ומקבצים ב-JS לפי bucketOf
  const docs = await Registration.find(match)
    .select("dealDate totalAmount totalPaid outstanding student rep")
    .lean();

  const UNASSIGNED = "unassigned";
  let hasUnassigned = false;
  const buckets = new Map(); // key -> { key, label, start, value, studentSet, perRep }
  for (const r of docs) {
    if (!r.dealDate) continue; // ללא תאריך עסקה אי אפשר לשבץ לדלי
    const b = bucketOf(r.dealDate, granularity);
    let entry = buckets.get(b.key);
    if (!entry) {
      entry = {
        key: b.key,
        label: b.label,
        start: b.start,
        value: 0,
        studentSet: new Set(),
        perRep: new Map(), // repId -> { value, studentSet }
      };
      buckets.set(b.key, entry);
    }
    if (metric === "registrants") {
      if (r.student != null) entry.studentSet.add(String(r.student));
    } else {
      entry.value += contributionOf(r);
    }
    if (byRepMode) {
      const rk = r.rep ? String(r.rep) : UNASSIGNED;
      if (rk === UNASSIGNED) hasUnassigned = true;
      let per = entry.perRep.get(rk);
      if (!per) {
        per = { value: 0, studentSet: new Set() };
        entry.perRep.set(rk, per);
      }
      if (metric === "registrants") {
        if (r.student != null) per.studentSet.add(String(r.student));
      } else {
        per.value += contributionOf(r);
      }
    }
  }

  const data = Array.from(buckets.values())
    .sort((a, b) => a.start - b.start)
    .map((e) => {
      const out = {
        key: e.key,
        label: e.label,
        value: metric === "registrants" ? e.studentSet.size : round2(e.value),
      };
      if (byRepMode) {
        out.byRep = {};
        for (const [rk, per] of e.perRep) {
          out.byRep[rk] =
            metric === "registrants" ? per.studentSet.size : round2(per.value);
        }
      }
      return out;
    });

  if (!byRepMode) {
    return res.json({ success: true, data });
  }

  // sidecar יציב של כל הנציגות (כולל לא-פעילות, שעסקאות ישנות עדיין מפנות אליהן)
  const repUsers = await User.find({ role: "rep" })
    .select("name")
    .sort({ _id: 1 })
    .lean();
  const reps = repUsers.map((u) => ({ repId: String(u._id), repName: u.name }));
  if (hasUnassigned) reps.push({ repId: UNASSIGNED, repName: "ללא שיוך" });

  res.json({ success: true, data, reps });
});

/**
 * GET /api/dashboard/reps
 * Per-rep performance in range. Managers see all active reps; a scoped rep sees
 * only themselves. Sorted by salesAmount desc.
 */
export const reps = asyncHandler(async (req, res) => {
  const dateFilter = parseDateQuery(req.query, nowFromReq(req));
  const repId = resolveRepId(req);

  // אילו נציגים להציג: נציג בסקופ -> רק הוא; מנהל -> כל הנציגים הפעילים (או repId נבחר)
  const userFilter = { role: "rep", active: true };
  if (repId) userFilter._id = repId;
  const repUsers = await User.find(userFilter).select("name").lean();

  if (repUsers.length === 0) {
    return res.json({ success: true, data: [] });
  }

  const repIds = repUsers.map((u) => u._id);

  // --- מכירות לפי נציג (registrations בלבד) ---
  const salesMatch = { recordType: "registration", rep: { $in: repIds } };
  if (dateFilter) salesMatch.dealDate = dateFilter;

  const salesRows = await Registration.aggregate([
    { $match: salesMatch },
    {
      $group: {
        _id: "$rep",
        deals: { $sum: 1 },
        salesAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
        collected: { $sum: { $ifNull: ["$totalPaid", 0] } },
        outstanding: { $sum: { $ifNull: ["$outstanding", 0] } },
      },
    },
  ]);
  const salesByRep = new Map(salesRows.map((r) => [String(r._id), r]));

  const data = repUsers
    .map((u) => {
      const s = salesByRep.get(String(u._id)) || {};
      const deals = s.deals || 0;
      const salesAmount = round2(s.salesAmount || 0);
      const collected = round2(s.collected || 0);
      const outstanding = round2(s.outstanding || 0);
      const avgBasket = deals > 0 ? round2(salesAmount / deals) : 0;
      return {
        repId: String(u._id),
        repName: u.name,
        deals,
        salesAmount,
        collected,
        outstanding,
        avgBasket,
      };
    })
    .sort((a, b) => b.salesAmount - a.salesAmount);

  res.json({ success: true, data });
});
