import mongoose from 'mongoose';
import Registration from '../models/Registration.js';
import User from '../models/User.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parseDateQuery, bucketOf, GRANULARITIES, nowFromReq } from '../utils/dateRanges.js';

/**
 * Dashboard controller — KPIs for the manager (וגם נציג בודד בסקופ).
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
      throw ApiError.badRequest('מזהה נציג לא תקין');
    }
    return new Types.ObjectId(req.scopeRepId);
  }
  // מנהל: סינון אופציונלי לפי repId
  const { repId } = req.query;
  if (repId) {
    if (!Types.ObjectId.isValid(repId)) throw ApiError.badRequest('מזהה נציג לא תקין');
    return new Types.ObjectId(repId);
  }
  return null;
}

/** Build the base registration $match (sales only) with date + rep scope. */
function buildRegMatch(dateFilter, repId) {
  const match = { recordType: 'registration' };
  if (dateFilter) match.dealDate = dateFilter;
  if (repId) match.rep = repId;
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
  const regMatch = buildRegMatch(dateFilter, repId);

  /** aggregate one window into the headline numbers (+ status distribution). */
  const aggregateWindow = async (match) => {
    const rows = await Registration.aggregate([
      { $match: match },
      {
        $group: {
          _id: '$paymentStatus',
          deals: { $sum: 1 },
          salesAmount: { $sum: { $ifNull: ['$totalAmount', 0] } },
          collected: { $sum: { $ifNull: ['$totalPaid', 0] } },
          outstanding: { $sum: { $ifNull: ['$outstanding', 0] } },
          studentSet: { $addToSet: '$student' },
        },
      },
    ]);
    const out = { deals: 0, salesAmount: 0, collected: 0, outstanding: 0, statusDist: { paid: 0, partial: 0, unpaid: 0 }, students: new Set() };
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

  // תקופה קודמת — לחישוב דלתא בכרטיסי ה-KPI. הלקוח שולח ?prevFrom/?prevTo מפורשים
  // ("אותה נקודה בתקופה הקודמת" — הוגן לחלון של מתחילת-התקופה-עד-היום); בהיעדרם,
  // ברירת מחדל: חלון זהה באורכו צמוד אחורה.
  let prev = null;
  let prevFilter = null;
  if (req.query.prevFrom && req.query.prevTo) {
    const pf = new Date(req.query.prevFrom);
    const pt = new Date(req.query.prevTo);
    if (!Number.isNaN(pf.getTime()) && !Number.isNaN(pt.getTime())) prevFilter = { $gte: pf, $lt: pt };
  } else if (dateFilter?.$gte && dateFilter?.$lt) {
    const from = new Date(dateFilter.$gte);
    const to = new Date(dateFilter.$lt);
    prevFilter = { $gte: new Date(from - (to - from)), $lt: from };
  }
  if (prevFilter) {
    const p = await aggregateWindow(buildRegMatch(prevFilter, repId));
    prev = { deals: p.deals, salesAmount: round2(p.salesAmount), collected: round2(p.collected) };
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
 * הכנסות מתוזמנות קדימה: תשלומים עתידיים (paid=false) עם תאריך יעד, מקובצים לפי חודש,
 * לחצי השנה הקרובה. עסקאות בלבד (לא מבוטלות), בסקופ נציג/ה.
 */
export const upcoming = asyncHandler(async (req, res) => {
  const repId = resolveRepId(req);
  const now = nowFromReq(req);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 6, 1));

  const match = { recordType: 'registration' };
  if (repId) match.rep = repId;

  const rows = await Registration.aggregate([
    { $match: match },
    { $unwind: '$payments' },
    { $match: { 'payments.paid': false, 'payments.dueDate': { $gte: start, $lt: end } } },
    {
      $group: {
        _id: { y: { $year: '$payments.dueDate' }, m: { $month: '$payments.dueDate' } },
        amount: { $sum: '$payments.amount' },
        count: { $sum: 1 },
      },
    },
  ]);
  const byKey = new Map(rows.map((r) => [`${r._id.y}-${r._id.m}`, r]));
  const data = [];
  for (let i = 0; i < 6; i += 1) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1));
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`;
    const hit = byKey.get(k);
    data.push({
      key: k,
      label: `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`,
      amount: round2(hit?.amount || 0),
      count: hit?.count || 0,
    });
  }
  res.json({ success: true, data });
});

/**
 * GET /api/dashboard/by-course
 * העסקאות בתקופה מקובצות לפי קורס (מכירות + עסקאות), ממוין יורד — "מה נמכר".
 */
export const byCourse = asyncHandler(async (req, res) => {
  const dateFilter = parseDateQuery(req.query, nowFromReq(req));
  const repId = resolveRepId(req);
  const match = buildRegMatch(dateFilter, repId);

  const rows = await Registration.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$course',
        deals: { $sum: 1 },
        salesAmount: { $sum: { $ifNull: ['$totalAmount', 0] } },
        fallbackName: { $first: { $ifNull: ['$courseRaw', '$courseField'] } },
      },
    },
    { $sort: { salesAmount: -1 } },
    { $limit: 8 },
    { $lookup: { from: 'courses', localField: '_id', foreignField: '_id', as: 'course' } },
  ]);
  const data = rows.map((r) => ({
    name: r.course?.[0]?.name || r.fallbackName || 'ללא קורס',
    deals: r.deals,
    salesAmount: round2(r.salesAmount),
  }));
  res.json({ success: true, data });
});

/**
 * GET /api/dashboard/timeseries
 * ?granularity (day|week|month|quarter|half|year, default month)
 * ?metric (deals|salesAmount|collected|outstanding|registrants, default salesAmount)
 * Groups registrations by bucketOf(dealDate, granularity) in JS.
 */
export const timeseries = asyncHandler(async (req, res) => {
  const dateFilter = parseDateQuery(req.query, nowFromReq(req));
  const repId = resolveRepId(req);

  const granularity = req.query.granularity || 'month';
  if (!GRANULARITIES.includes(granularity)) {
    throw ApiError.badRequest(`granularity לא חוקי. ערכים אפשריים: ${GRANULARITIES.join(', ')}`);
  }

  const allowedMetrics = ['deals', 'salesAmount', 'collected', 'outstanding', 'registrants'];
  const metric = req.query.metric || 'salesAmount';
  if (!allowedMetrics.includes(metric)) {
    throw ApiError.badRequest(`metric לא חוקי. ערכים אפשריים: ${allowedMetrics.join(', ')}`);
  }

  const match = buildRegMatch(dateFilter, repId);
  // מושכים מסמכים רזים בלבד עם השדות הדרושים, ומקבצים ב-JS לפי bucketOf
  const docs = await Registration.find(match)
    .select('dealDate totalAmount totalPaid outstanding student')
    .lean();

  const buckets = new Map(); // key -> { key, label, start, value, studentSet }
  for (const r of docs) {
    if (!r.dealDate) continue; // ללא תאריך עסקה אי אפשר לשבץ לדלי
    const b = bucketOf(r.dealDate, granularity);
    let entry = buckets.get(b.key);
    if (!entry) {
      entry = { key: b.key, label: b.label, start: b.start, value: 0, studentSet: new Set() };
      buckets.set(b.key, entry);
    }
    switch (metric) {
      case 'deals':
        entry.value += 1;
        break;
      case 'salesAmount':
        entry.value += r.totalAmount || 0;
        break;
      case 'collected':
        entry.value += r.totalPaid || 0;
        break;
      case 'outstanding':
        entry.value += r.outstanding || 0;
        break;
      case 'registrants':
        if (r.student != null) entry.studentSet.add(String(r.student));
        break;
      default:
        break;
    }
  }

  const data = Array.from(buckets.values())
    .sort((a, b) => a.start - b.start)
    .map((e) => ({
      key: e.key,
      label: e.label,
      value: metric === 'registrants' ? e.studentSet.size : round2(e.value),
    }));

  res.json({ success: true, data });
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
  const userFilter = { role: 'rep', active: true };
  if (repId) userFilter._id = repId;
  const repUsers = await User.find(userFilter).select('name').lean();

  if (repUsers.length === 0) {
    return res.json({ success: true, data: [] });
  }

  const repIds = repUsers.map((u) => u._id);

  // --- מכירות לפי נציג (registrations בלבד) ---
  const salesMatch = { recordType: 'registration', rep: { $in: repIds } };
  if (dateFilter) salesMatch.dealDate = dateFilter;

  const salesRows = await Registration.aggregate([
    { $match: salesMatch },
    {
      $group: {
        _id: '$rep',
        deals: { $sum: 1 },
        salesAmount: { $sum: { $ifNull: ['$totalAmount', 0] } },
        collected: { $sum: { $ifNull: ['$totalPaid', 0] } },
        outstanding: { $sum: { $ifNull: ['$outstanding', 0] } },
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
