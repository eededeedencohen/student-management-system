import mongoose from 'mongoose';
import Registration from '../models/Registration.js';
import Lead from '../models/Lead.js';
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

/**
 * Count leads in range/scope. Aggregate docs contribute their `count`,
 * individual leads contribute 1 each. Dates use receivedDate, falling back to
 * periodStart for aggregate rows that only carry a period.
 * Returns a number (0 if none).
 */
async function countLeads(dateFilter, repId) {
  const match = {};
  if (repId) match.rep = repId;
  if (dateFilter) {
    // ליד בודד לפי receivedDate; ליד מצרפי לפי periodStart
    match.$or = [{ receivedDate: dateFilter }, { isAggregate: true, periodStart: dateFilter }];
  }
  const rows = await Lead.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: {
          $sum: { $cond: [{ $eq: ['$isAggregate', true] }, { $ifNull: ['$count', 0] }, 1] },
        },
      },
    },
  ]);
  return rows[0]?.total || 0;
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

  const [agg] = await Registration.aggregate([
    { $match: regMatch },
    {
      $group: {
        _id: null,
        deals: { $sum: 1 },
        salesAmount: { $sum: { $ifNull: ['$totalAmount', 0] } },
        collected: { $sum: { $ifNull: ['$totalPaid', 0] } },
        outstanding: { $sum: { $ifNull: ['$outstanding', 0] } },
        // distinct students: ערכים יכולים להיות null אם אין קישור לתלמיד
        studentSet: { $addToSet: '$student' },
      },
    },
  ]);

  const deals = agg?.deals || 0;
  const salesAmount = round2(agg?.salesAmount || 0);
  const collected = round2(agg?.collected || 0);
  const outstanding = round2(agg?.outstanding || 0);

  // נרשמים ייחודיים: סופרים מזהי תלמיד שאינם null/חסרים
  const registrants = (agg?.studentSet || []).filter((s) => s != null).length;

  const avgBasket = deals > 0 ? round2(salesAmount / deals) : 0;

  const leadsCount = await countLeads(dateFilter, repId);
  // אם אין לידים בכלל — אחוז סגירה לא מוגדר
  const closeRate = leadsCount > 0 ? round2(deals / leadsCount) : null;

  res.json({
    success: true,
    data: {
      registrants,
      deals,
      salesAmount,
      collected,
      outstanding,
      avgBasket,
      closeRate,
    },
  });
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

  // --- לידים לפי נציג (לחישוב אחוז סגירה) ---
  const leadMatch = { rep: { $in: repIds } };
  if (dateFilter) {
    leadMatch.$or = [{ receivedDate: dateFilter }, { isAggregate: true, periodStart: dateFilter }];
  }
  const leadRows = await Lead.aggregate([
    { $match: leadMatch },
    {
      $group: {
        _id: '$rep',
        leads: {
          $sum: { $cond: [{ $eq: ['$isAggregate', true] }, { $ifNull: ['$count', 0] }, 1] },
        },
      },
    },
  ]);
  const leadsByRep = new Map(leadRows.map((r) => [String(r._id), r.leads]));

  const data = repUsers
    .map((u) => {
      const s = salesByRep.get(String(u._id)) || {};
      const deals = s.deals || 0;
      const salesAmount = round2(s.salesAmount || 0);
      const collected = round2(s.collected || 0);
      const outstanding = round2(s.outstanding || 0);
      const avgBasket = deals > 0 ? round2(salesAmount / deals) : 0;
      const leads = leadsByRep.get(String(u._id)) || 0;
      const closeRate = leads > 0 ? round2(deals / leads) : null;
      return {
        repId: String(u._id),
        repName: u.name,
        deals,
        salesAmount,
        collected,
        outstanding,
        avgBasket,
        leads,
        closeRate,
      };
    })
    .sort((a, b) => b.salesAmount - a.salesAmount);

  res.json({ success: true, data });
});
