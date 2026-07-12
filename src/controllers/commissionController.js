import mongoose from 'mongoose';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import Registration from '../models/Registration.js';
import User from '../models/User.js';
import {
  GRANULARITIES,
  addDays,
  startOfDay,
  startOfWeek,
  startOfMonth,
  startOfQuarter,
  startOfHalf,
  startOfYear,
  nowFromReq,
} from '../utils/dateRanges.js';
import { applySince } from '../utils/dataScope.js';

/**
 * commissionController — חישוב שכר ועמלות לכל נציג/ה.
 *
 * כל החישובים סופרים אך ורק עסקאות אמיתיות: recordType === 'registration'
 * (לא פרסום / מעקב גבייה / אחר), בהתאם למוסכמת ההכנסות של המערכת.
 */

const SALARY_RATIO_MIN = 7.5; // יחס שכר-להכנסה רצוי (מינימום)
const SALARY_RATIO_MAX = 15; // יחס שכר-להכנסה רצוי (מקסימום)

const DAY = 86400000;

/**
 * Resolve the commission period into { dateFilter, baseMonths }:
 *   - The window is PERIOD-TO-DATE: it starts at the CALENDAR start of the
 *     period and ends today. "שבוע" on a Sunday counts only that Sunday;
 *     "חודש" on the 12th counts only the 1st–12th — it never spills into the
 *     previous week/month/quarter.
 *   - baseMonths → the elapsed part of the period as a fraction of a 30-day
 *     month (month on the 12th → 12/30), so the base salary and the
 *     salary/income ratio stay proportional to the days actually counted.
 * Honours an explicit ?from/?to (prorates the base by its day span / 30).
 */
function resolvePeriod(query, now) {
  if (query.from || query.to) {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    const filter = {};
    if (from) filter.$gte = from;
    if (to) filter.$lt = to;
    const days = from && to ? Math.max((to - from) / DAY, 0) : 30;
    return { dateFilter: Object.keys(filter).length ? filter : null, baseMonths: days / 30 };
  }
  const g = GRANULARITIES.includes(query.period) ? query.period : 'month';
  const end = addDays(startOfDay(now), 1); // exclusive upper bound = end of today
  let from;
  switch (g) {
    case 'day': from = startOfDay(now); break;
    case 'week': from = startOfWeek(now); break;
    case 'quarter': from = startOfQuarter(now); break;
    case 'half': from = startOfHalf(now); break;
    case 'year': from = startOfYear(now); break;
    case 'month':
    default: from = startOfMonth(now);
  }
  const baseMonths = Math.max((end - from) / DAY, 1) / 30;
  return { dateFilter: { $gte: from, $lt: end }, baseMonths };
}

/**
 * computeCommission — מחשב את סכום העמלה לפי תצורת העמלה של הנציג/ה.
 * תומך במדרגות (tiers): בוחר את המדרגה הגבוהה ביותר שתנאי הסף שלה (fromSales)
 * קטן/שווה לסכום המכירות; אם אין מדרגות מתאימות נופלים לאחוז הבסיסי (commissionRate).
 *
 * @param {number} salesAmount  סך המכירות בטווח
 * @param {object} commissionConfig  user.commission { baseSalary, commissionRate, tiers }
 * @returns {{ commissionRate:number, commissionAmount:number }}
 */
export function computeCommission(salesAmount, commissionConfig = {}) {
  const sales = Number(salesAmount) || 0;
  const baseRate = Number(commissionConfig.commissionRate) || 0;
  const tiers = Array.isArray(commissionConfig.tiers) ? commissionConfig.tiers : [];

  let rate = baseRate;
  if (tiers.length) {
    // ממיינים לפי סף עולה ובוחרים את המדרגה הגבוהה ביותר שמתקיימת
    const sorted = [...tiers].sort(
      (a, b) => (Number(a.fromSales) || 0) - (Number(b.fromSales) || 0)
    );
    let matched = null;
    for (const tier of sorted) {
      if ((Number(tier.fromSales) || 0) <= sales) matched = tier;
    }
    if (matched) rate = Number(matched.rate) || 0;
  }

  const commissionAmount = sales * rate;
  return { commissionRate: rate, commissionAmount };
}

/**
 * Build the aggregated commission row for a single user from their deals.
 * @param {object} user  Mongoose user doc (or plain object) with .commission
 * @param {{ salesAmount:number, collectedAmount:number, deals:number }} agg
 */
function buildCommissionRow(user, agg, baseMonths = 1) {
  const commissionConfig = user.commission || {};
  const salesAmount = agg.salesAmount || 0;
  const collectedAmount = agg.collectedAmount || 0;
  const deals = agg.deals || 0;
  const baseMonthly = Number(commissionConfig.baseSalary) || 0; // the configured MONTHLY base
  const base = Math.round(baseMonthly * baseMonths); // prorated to the selected period

  const { commissionRate, commissionAmount } = computeCommission(
    salesAmount,
    commissionConfig
  );
  const totalSalary = base + commissionAmount;
  // יחס שכר-להכנסה: כמה הכנסה (מכירות) מול כל שקל שכר. גבוה = משתלם.
  const salaryToIncomeRatio = totalSalary > 0 ? salesAmount / totalSalary : 0;
  const ratioHealthy =
    salaryToIncomeRatio >= SALARY_RATIO_MIN && salaryToIncomeRatio <= SALARY_RATIO_MAX;

  return {
    repId: user._id,
    repName: user.name,
    role: user.role,
    salesAmount,
    collectedAmount,
    deals,
    base, // prorated base for the period
    baseMonthly, // the configured monthly base (for reference/tooltip)
    baseMonths, // fraction of a month the period represents
    commissionRate,
    commissionAmount,
    totalSalary,
    salaryToIncomeRatio,
    ratioHealthy,
  };
}

/**
 * Aggregate registration deals per rep in the given date range.
 * Counts ONLY recordType === 'registration' (revenue convention).
 * @param {object|null} dateFilter  mongo date filter for dealDate (or null)
 * @param {string|null} repIdFilter  restrict to a single rep id (or null = all)
 * @returns {Promise<Map<string, {salesAmount,collectedAmount,deals}>>} keyed by rep id
 */
async function aggregateDeals(dateFilter, repIdFilter, req) {
  const match = { recordType: 'registration', rep: { $ne: null } };
  if (dateFilter) match.dealDate = dateFilter;
  if (repIdFilter) match.rep = new mongoose.Types.ObjectId(repIdFilter);
  if (req) applySince(req, match); // מוד "מ-2026 בלבד"

  const rows = await Registration.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$rep',
        salesAmount: { $sum: { $ifNull: ['$totalAmount', 0] } },
        collectedAmount: { $sum: { $ifNull: ['$totalPaid', 0] } },
        deals: { $sum: 1 },
      },
    },
  ]);

  const byRep = new Map();
  for (const r of rows) {
    byRep.set(String(r._id), {
      salesAmount: r.salesAmount || 0,
      collectedAmount: r.collectedAmount || 0,
      deals: r.deals || 0,
    });
  }
  return byRep;
}

/**
 * GET /api/commissions
 * Commission + salary summary per rep over the date range.
 * - Managers: every rep (optionally ?repId=…).
 * - Reps: only themselves (scopeToRep forces req.scopeRepId).
 * Query: ?period=… | ?from&?to
 * Sorted by salesAmount desc.
 */
export const list = asyncHandler(async (req, res) => {
  const { dateFilter, baseMonths } = resolvePeriod(req.query, nowFromReq(req));

  // קביעת היקף הנציגים: נציג רואה רק את עצמו; מנהל רואה הכל (או ?repId)
  let repIdFilter = null;
  if (req.scopeRepId) repIdFilter = req.scopeRepId;
  else if (req.query.repId) repIdFilter = req.query.repId;

  // שולפים את הנציגים הרלוונטיים (כולל מי שאין לו עסקאות בטווח -> שורה עם 0)
  const userQuery = repIdFilter ? { _id: repIdFilter } : { role: 'rep' };
  const users = await User.find(userQuery);

  const byRep = await aggregateDeals(dateFilter, repIdFilter, req);

  const data = users
    .map((user) =>
      buildCommissionRow(
        user,
        byRep.get(String(user._id)) || { salesAmount: 0, collectedAmount: 0, deals: 0 },
        baseMonths
      )
    )
    .sort((a, b) => b.salesAmount - a.salesAmount);

  res.json({ success: true, data, baseMonths });
});

/**
 * GET /api/commissions/:repId
 * Single-rep commission + salary detail.
 * Managers may view any rep; a rep may view only themselves.
 */
export const detail = asyncHandler(async (req, res) => {
  const { repId } = req.params;

  // נציג מורשה לראות אך ורק את עצמו
  if (req.scopeRepId && String(req.scopeRepId) !== String(repId)) {
    throw ApiError.forbidden('אין הרשאה לצפות בנתוני נציג/ה אחר/ת');
  }

  if (!mongoose.Types.ObjectId.isValid(repId)) {
    throw ApiError.badRequest('מזהה נציג/ה לא תקין');
  }

  const user = await User.findById(repId);
  if (!user) throw ApiError.notFound('נציג/ה לא נמצא/ה');

  const { dateFilter, baseMonths } = resolvePeriod(req.query, nowFromReq(req));
  const byRep = await aggregateDeals(dateFilter, repId, req);
  const agg = byRep.get(String(repId)) || {
    salesAmount: 0,
    collectedAmount: 0,
    deals: 0,
  };

  const data = buildCommissionRow(user, agg, baseMonths);
  res.json({ success: true, data });
});
