import mongoose from "mongoose";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import Registration from "../models/Registration.js";
import User from "../models/User.js";
import "../models/Course.js"; // רישום סכמת Course עבור populate('course') ב-breakdown
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
} from "../utils/dateRanges.js";
import { applySince } from "../utils/dataScope.js";

/**
 * commissionController - חישוב שכר ועמלות לכל נציג/ה.
 *
 * כל החישובים סופרים אך ורק עסקאות אמיתיות: recordType === 'registration'
 * (לא פרסום / מעקב גבייה / אחר), בהתאם למוסכמת ההכנסות של המערכת.
 */

const SALARY_RATIO_MIN = 7.5; // יחס שכר-להכנסה רצוי (מינימום)
const SALARY_RATIO_MAX = 15; // יחס שכר-להכנסה רצוי (מקסימום)

const DAY = 86400000;
// Base salary is MONTHLY; each granularity carries its FULL length in (30-day) months -
// half year = ×6, week = 7/30 of the monthly base - regardless of how much of it has elapsed.
const PERIOD_MONTHS = {
  day: 1 / 30,
  week: 7 / 30,
  month: 1,
  quarter: 3,
  half: 6,
  year: 12,
};

/**
 * Resolve the commission period into { dateFilter, baseMonths }:
 *   - The window is PERIOD-TO-DATE: it starts at the CALENDAR start of the
 *     period and ends today. "שבוע" on a Sunday counts only that Sunday;
 *     "חודש" on the 12th counts only the 1st–12th - it never spills into the
 *     previous week/month/quarter.
 *   - baseMonths → the FULL period length relative to a month (PERIOD_MONTHS),
 *     not the elapsed part: half = base ×6, week = base ×7/30.
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
    return {
      dateFilter: Object.keys(filter).length ? filter : null,
      baseMonths: days / 30,
    };
  }
  const g = GRANULARITIES.includes(query.period) ? query.period : "month";
  const end = addDays(startOfDay(now), 1); // exclusive upper bound = end of today
  let from;
  switch (g) {
    case "day":
      from = startOfDay(now);
      break;
    case "week":
      from = startOfWeek(now);
      break;
    case "quarter":
      from = startOfQuarter(now);
      break;
    case "half":
      from = startOfHalf(now);
      break;
    case "year":
      from = startOfYear(now);
      break;
    case "month":
    default:
      from = startOfMonth(now);
  }
  return { dateFilter: { $gte: from, $lt: end }, baseMonths: PERIOD_MONTHS[g] };
}

/**
 * computeCommission - מחשב את סכום הפרמיה לפי תצורת הפרמיה של הנציג/ה.
 *
 * הבסיס הוא הכסף שנגבה בפועל (baseAmount = collected), ולא סך המכירות: עסקה
 * שנמכרה אך טרם נגבתה אינה נכנסת לפרמיה, וגבייה חלקית מזכה בפרמיה יחסית בלבד.
 * המדרגות (tiers) נבחרות אף הן לפי הכסף שנגבה, כך שכסף שטרם נגבה לא "מקפיץ"
 * את הנציג/ה למדרגה גבוהה יותר.
 *
 * @param {number} baseAmount  בסיס הפרמיה = הכסף שנגבה בפועל בטווח
 * @param {object} commissionConfig  user.commission { baseSalary, commissionRate, tiers }
 * @returns {{ commissionRate:number, commissionAmount:number }}
 */
export function computeCommission(baseAmount, commissionConfig = {}) {
  const base = Number(baseAmount) || 0;
  const baseRate = Number(commissionConfig.commissionRate) || 0;
  const tiers = Array.isArray(commissionConfig.tiers)
    ? commissionConfig.tiers
    : [];

  let rate = baseRate;
  if (tiers.length) {
    // ממיינים לפי סף עולה ובוחרים את המדרגה הגבוהה ביותר שמתקיימת (לפי הנגבה)
    const sorted = [...tiers].sort(
      (a, b) => (Number(a.fromSales) || 0) - (Number(b.fromSales) || 0),
    );
    let matched = null;
    for (const tier of sorted) {
      if ((Number(tier.fromSales) || 0) <= base) matched = tier;
    }
    if (matched) rate = Number(matched.rate) || 0;
  }

  const commissionAmount = base * rate;
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

  // הפרמיה מחושבת על הכסף שנגבה בפועל - לא על סך המכירות (עסקאות שטרם נגבו
  // אינן נכנסות; גבייה חלקית מזכה בפרמיה יחסית).
  const { commissionRate, commissionAmount } = computeCommission(
    collectedAmount,
    commissionConfig,
  );
  const totalSalary = base + commissionAmount;
  // יחס שכר-להכנסה: כמה הכנסה (מכירות) מול כל שקל שכר. גבוה = משתלם.
  const salaryToIncomeRatio = totalSalary > 0 ? salesAmount / totalSalary : 0;
  const ratioHealthy =
    salaryToIncomeRatio >= SALARY_RATIO_MIN &&
    salaryToIncomeRatio <= SALARY_RATIO_MAX;

  return {
    repId: user._id,
    repName: user.name,
    role: user.role,
    salesAmount,
    collectedAmount, // בסיס הפרמיה = הכסף שנגבה בפועל
    uncollectedAmount: Math.round((salesAmount - collectedAmount) * 100) / 100,
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
  const match = { recordType: "registration", rep: { $ne: null } };
  if (dateFilter) match.dealDate = dateFilter;
  if (repIdFilter) match.rep = new mongoose.Types.ObjectId(repIdFilter);
  if (req) applySince(req, match); // מוד "מ-2026 בלבד"

  const rows = await Registration.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$rep",
        salesAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
        collectedAmount: { $sum: { $ifNull: ["$totalPaid", 0] } },
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
  const userQuery = repIdFilter ? { _id: repIdFilter } : { role: "rep" };
  const users = await User.find(userQuery);

  const byRep = await aggregateDeals(dateFilter, repIdFilter, req);

  const data = users
    .map((user) =>
      buildCommissionRow(
        user,
        byRep.get(String(user._id)) || {
          salesAmount: 0,
          collectedAmount: 0,
          deals: 0,
        },
        baseMonths,
      ),
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
    throw ApiError.forbidden("אין הרשאה לצפות בנתוני נציג/ה אחר/ת");
  }

  if (!mongoose.Types.ObjectId.isValid(repId)) {
    throw ApiError.badRequest("מזהה נציג/ה לא תקין");
  }

  const user = await User.findById(repId);
  if (!user) throw ApiError.notFound("נציג/ה לא נמצא/ה");

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

/**
 * GET /api/commissions/trend?months=12&metric=deals|salesAmount|collected
 * מגמת ביצועים חודש-מול-חודש להשוואה בין נציגות: לכל חודש, ערך המדד לכל נציג/ה
 * (ברירת מחדל: כמות עסקאות). מחזיר גם sidecar יציב של הנציגות (לפי סדר הצטרפות)
 * כדי שהצבע יהיה קבוע לכל נציגה. נציג/ה רואה רק את עצמו/ה; מנהל את כולן (או ?repId).
 */
export const trend = asyncHandler(async (req, res) => {
  const now = nowFromReq(req);
  const monthsBack = Math.min(
    Math.max(parseInt(req.query.months, 10) || 12, 2),
    24,
  );
  const metric = ["deals", "salesAmount", "collected"].includes(req.query.metric)
    ? req.query.metric
    : "deals";

  let repIdFilter = null;
  if (req.scopeRepId) repIdFilter = req.scopeRepId;
  else if (req.query.repId) repIdFilter = req.query.repId;

  const curMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (monthsBack - 1), 1),
  );
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const match = {
    recordType: "registration",
    rep: { $ne: null },
    dealDate: { $gte: from, $lt: to },
  };
  if (repIdFilter) match.rep = new mongoose.Types.ObjectId(repIdFilter);
  applySince(req, match); // מוד "מ-2026 בלבד" - מצמצם את $gte ל-1.1.2026 בלי לגעת ב-$lt
  const effFrom = match.dealDate.$gte; // תחילת הטווח בפועל (אחרי קיצוץ 2026)

  const rows = await Registration.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          rep: "$rep",
          y: { $year: "$dealDate" },
          m: { $month: "$dealDate" },
        },
        deals: { $sum: 1 },
        salesAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
        collected: { $sum: { $ifNull: ["$totalPaid", 0] } },
      },
    },
  ]);

  // sidecar יציב (סדר הצטרפות = _id) לצבעים עקביים
  const userQuery = repIdFilter ? { _id: repIdFilter } : { role: "rep" };
  const repUsers = await User.find(userQuery)
    .select("name")
    .sort({ _id: 1 })
    .lean();
  const reps = repUsers.map((u) => ({
    repId: String(u._id),
    repName: u.name,
  }));

  // בניית רשימת החודשים; 0 מפורש לכל נציגה כדי שהקווים יימשכו דרך חודשים ריקים
  const pad = (n) => String(n).padStart(2, "0");
  const months = [];
  const idx = new Map();
  let cur = new Date(Date.UTC(effFrom.getUTCFullYear(), effFrom.getUTCMonth(), 1));
  while (cur <= curMonthStart) {
    const key = `${cur.getUTCFullYear()}-${pad(cur.getUTCMonth() + 1)}`;
    const row = { key, label: `${pad(cur.getUTCMonth() + 1)}/${String(cur.getUTCFullYear()).slice(2)}` };
    for (const r of reps) row[r.repId] = 0;
    idx.set(key, months.length);
    months.push(row);
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  for (const r of rows) {
    const i = idx.get(`${r._id.y}-${pad(r._id.m)}`);
    if (i === undefined) continue;
    const repKey = String(r._id.rep);
    if (!(repKey in months[i])) continue; // עסקה של משתמש שאינו ב-sidecar (למשל מנהל)
    months[i][repKey] = metric === "deals" ? r.deals : round2(r[metric] || 0);
  }

  res.json({
    success: true,
    data: {
      months,
      reps,
      metric,
      currentMonthKey: `${curMonthStart.getUTCFullYear()}-${pad(curMonthStart.getUTCMonth() + 1)}`,
    },
  });
});

/**
 * GET /api/commissions/:repId/breakdown
 * פירוט הפרמיה: כל עסקאות הנציג/ה בטווח, וכמה נגבה מכל אחת. רק כסף שנגבה בפועל
 * נכנס לפרמיה (contribution = collected × rate); עסקה שטרם נגבתה מסומנת ואינה
 * תורמת. משמש את מודל הפירוט בעמוד הפרמיות. מנהל רואה כל נציג/ה; נציג/ה רק עצמו/ה.
 */
export const breakdown = asyncHandler(async (req, res) => {
  const { repId } = req.params;
  if (req.scopeRepId && String(req.scopeRepId) !== String(repId)) {
    throw ApiError.forbidden("אין הרשאה לצפות בנתוני נציג/ה אחר/ת");
  }
  if (!mongoose.Types.ObjectId.isValid(repId)) {
    throw ApiError.badRequest("מזהה נציג/ה לא תקין");
  }
  const user = await User.findById(repId).lean();
  if (!user) throw ApiError.notFound("נציג/ה לא נמצא/ה");

  const { dateFilter } = resolvePeriod(req.query, nowFromReq(req));
  const match = {
    recordType: "registration",
    rep: new mongoose.Types.ObjectId(repId),
  };
  if (dateFilter) match.dealDate = dateFilter;
  applySince(req, match); // מוד "מ-2026 בלבד"

  const deals = await Registration.find(match)
    .select(
      "externalId studentName student courseRaw courseField course dealDate totalAmount totalPaid outstanding paymentStatus",
    )
    .populate("course", "name")
    .sort({ dealDate: -1 })
    .lean();

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const collectedTotal = deals.reduce((a, d) => a + (d.totalPaid || 0), 0);
  const salesTotal = deals.reduce((a, d) => a + (d.totalAmount || 0), 0);
  // האחוז נבחר לפי הכסף שנגבה (כסף שטרם נגבה לא מקפיץ מדרגה)
  const { commissionRate } = computeCommission(
    collectedTotal,
    user.commission || {},
  );

  const items = deals.map((d) => {
    const collected = round2(d.totalPaid || 0);
    const counted = collected > 0.5; // רק כסף שנגבה בפועל נכנס לפרמיה
    return {
      id: d._id,
      externalId: d.externalId,
      student: d.student,
      studentName: d.studentName,
      course: d.course?.name || d.courseRaw || d.courseField || "",
      dealDate: d.dealDate,
      totalAmount: round2(d.totalAmount || 0),
      collected,
      outstanding: round2(d.outstanding || 0),
      paymentStatus: d.paymentStatus,
      counted,
      premiumContribution: round2(collected * commissionRate),
    };
  });

  res.json({
    success: true,
    data: {
      repId: String(user._id),
      repName: user.name,
      commissionRate,
      salesTotal: round2(salesTotal),
      collectedTotal: round2(collectedTotal), // בסיס הפרמיה
      uncollectedTotal: round2(salesTotal - collectedTotal),
      premiumTotal: round2(collectedTotal * commissionRate),
      countedCount: items.filter((x) => x.counted).length,
      notCountedCount: items.filter((x) => !x.counted).length,
      items,
    },
  });
});
