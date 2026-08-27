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
import { excludeTestOnly } from "../utils/testOnlyScope.js";
import { COLLECTED_AT, collectedAtOf } from "../utils/collectedAt.js";
import {
  HELD_CONTRACT_EXPR,
  HELD_RECEIPT_EXPR,
  HELD_EXPR,
  DEAL_HELD_EXPR,
  holdReasonOf,
  dealHoldReason,
} from "../utils/premiumHold.js";

/** ?strict=1 - "מצב מחמיר": גבייה של חוזה לא חתום / העברה בלי אסמכתא לא נספרת. */
const strictOf = (query) => ["1", "true"].includes(String(query?.strict || ""));

/**
 * commissionController - חישוב שכר ועמלות לכל נציג/ה.
 *
 * כל החישובים סופרים אך ורק עסקאות אמיתיות: recordType === 'registration'
 * (לא פרסום / מעקב גבייה / אחר), בהתאם למוסכמת ההכנסות של המערכת.
 */

const SALARY_RATIO_MIN = 7.5; // יחס שכר-להכנסה רצוי (מינימום)
const SALARY_RATIO_MAX = 15; // יחס שכר-להכנסה רצוי (מקסימום)

const DAY = 86400000;
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
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
 *     "חודש" on the 12th counts only the 1st-12th - it never spills into the
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
 * Build the aggregated commission row for a single user.
 * @param {object} user  Mongoose user doc (or plain object) with .commission
 * @param {{ salesAmount:number, deals:number, outstandingAmount:number,
 *           collectedAmount:number, paymentsCount:number, collectedDeals:number }} agg
 *   salesAmount/deals/outstandingAmount = עסקאות שנסגרו בתקופה (לפי dealDate);
 *   collectedAmount/paymentsCount/collectedDeals = תשלומים שנגבו בתקופה (לפי מועד הגבייה).
 */
function buildCommissionRow(user, agg, baseMonths = 1, strict = false) {
  const commissionConfig = user.commission || {};

  // מצב מחמיר (owner 2026-08-27): עסקה שהחוזה שלה טרם נחתם, או שיש בה העברה בלי
  // אסמכתא, "מוחזקת" - לא נספרת במכירות/עסקאות/יתרה של התקופה ("המכירות לא נחשבות
  // אם הן מוחזקות או לא מאושרות"), כדי שהיחס שכר/הכנסה יחושב על אותו בסיס כמו השכר.
  const salesGross = money(agg.salesAmount || 0);
  const heldSalesAmount = money(agg.heldSalesAmount || 0);
  const heldDealsCount = agg.heldDealsCount || 0;
  const salesAmount = strict ? money(salesGross - heldSalesAmount) : salesGross;
  const dealsGross = agg.deals || 0;
  const deals = strict ? Math.max(dealsGross - heldDealsCount, 0) : dealsGross;
  const outstandingBase = strict
    ? (agg.outstandingAmount || 0) - (agg.heldOutstandingAmount || 0)
    : agg.outstandingAmount || 0;

  // וגבייה של עסקה כזו (או העברה בלי אסמכתא) "מוחזקת" - לא נכנסת לבסיס הפרמיה עד
  // שהעניין יוסדר. במצב רגיל הכל נספר.
  const collectedGross = money(agg.collectedAmount || 0); // כל מה שנגבה בתקופה
  const heldContractAmount = money(agg.heldContractAmount || 0);
  const heldReceiptAmount = money(agg.heldReceiptAmount || 0);
  const heldAmount = money(heldContractAmount + heldReceiptAmount);
  const heldCount =
    (agg.heldContractCount || 0) + (agg.heldReceiptCount || 0);
  const collectedAmount = strict
    ? money(collectedGross - heldAmount)
    : collectedGross;
  const paymentsCount = strict
    ? Math.max((agg.paymentsCount || 0) - heldCount, 0)
    : agg.paymentsCount || 0;
  const collectedDeals = strict
    ? agg.clearDeals || 0
    : agg.collectedDeals || 0;
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

  // "מתוך" (owner 2026-08-27): השכר אילו גם התשלומים שמועדם הגיע בתקופה וטרם נגבו
  // (אשראי/העברה/מזומן שממתינים לאישור, הו"ק שהופסקה...) היו מאושרים. המדרגה נבחרת
  // מחדש לפי הבסיס הפוטנציאלי - כלומר זה השכר המקסימלי שהתקופה יכולה להניב.
  const scheduledUncollected = money(agg.scheduledUncollected || 0);
  // הפוטנציאל כולל גם את המוחזק (במצב מחמיר) - "מתוך" = הכל נגבה והכל הוסדר
  const potentialCollected = money(collectedGross + scheduledUncollected);
  const potential = computeCommission(potentialCollected, commissionConfig);
  const potentialTotalSalary = money(base + potential.commissionAmount);

  return {
    repId: user._id,
    repName: user.name,
    role: user.role,
    strict,
    salesAmount, // מכירות התקופה (במצב מחמיר בלי העסקאות המוחזקות)
    salesGross, // כל מכירות התקופה, כולל המוחזקות
    heldSalesAmount, // מכירות של עסקאות מוחזקות (חוזה ממתין / העברה בלי אסמכתא)
    heldDealsCount,
    dealsGross,
    collectedAmount, // בסיס הפרמיה = התשלומים שנגבו בתקופה (לפי מועד הגבייה, מכל העסקאות; במצב מחמיר בלי המוחזק)
    collectedGross, // כל מה שנגבה בתקופה, כולל המוחזק
    heldAmount, // מוחזק במצב מחמיר (במצב רגיל - למידע בלבד, נספר)
    heldCount,
    heldContractAmount,
    heldContractCount: agg.heldContractCount || 0,
    heldReceiptAmount,
    heldReceiptCount: agg.heldReceiptCount || 0,
    paymentsCount, // כמה תשלומים נספרו בתקופה
    collectedDeals, // מכמה עסקאות שונות
    uncollectedAmount: money(outstandingBase), // יתרה פתוחה של עסקאות התקופה (במצב מחמיר בלי המוחזקות)
    scheduledUncollected, // תשלומים שמועדם בתקופה וטרם נגבו (מכל העסקאות)
    scheduledUncollectedCount: agg.scheduledUncollectedCount || 0,
    potentialCollected, // בסיס הפרמיה אילו גם הם היו נגבים
    potentialCommissionRate: potential.commissionRate,
    potentialCommissionAmount: money(potential.commissionAmount),
    potentialTotalSalary, // "מתוך" - השכר אילו הכל היה נגבה
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
 * Aggregate the deals SOLD per rep in the given date range (by dealDate).
 * Counts ONLY recordType === 'registration' (revenue convention).
 * @returns {Promise<Map<string, {salesAmount,deals,outstandingAmount}>>} keyed by rep id
 */
async function aggregateDeals(dateFilter, repIdFilter, req) {
  const match = { recordType: "registration", rep: { $ne: null } };
  if (dateFilter) match.dealDate = dateFilter;
  if (repIdFilter) match.rep = new mongoose.Types.ObjectId(repIdFilter);
  if (req) applySince(req, match); // מוד "מ-2026 בלבד"

  const amt = { $ifNull: ["$totalAmount", 0] };
  const out = { $ifNull: ["$outstanding", 0] };
  const rows = await Registration.aggregate([
    { $match: match },
    // עסקה מוחזקת (מצב מחמיר, utils/premiumHold.js) - נצבר תמיד, מופחת רק ב-strict
    { $addFields: { dealHeld: DEAL_HELD_EXPR } },
    {
      $group: {
        _id: "$rep",
        salesAmount: { $sum: amt },
        outstandingAmount: { $sum: out },
        deals: { $sum: 1 },
        heldSalesAmount: { $sum: { $cond: ["$dealHeld", amt, 0] } },
        heldOutstandingAmount: { $sum: { $cond: ["$dealHeld", out, 0] } },
        heldDealsCount: { $sum: { $cond: ["$dealHeld", 1, 0] } },
      },
    },
  ]);

  const byRep = new Map();
  for (const r of rows) {
    byRep.set(String(r._id), {
      salesAmount: r.salesAmount || 0,
      outstandingAmount: r.outstandingAmount || 0,
      deals: r.deals || 0,
      heldSalesAmount: r.heldSalesAmount || 0,
      heldOutstandingAmount: r.heldOutstandingAmount || 0,
      heldDealsCount: r.heldDealsCount || 0,
    });
  }
  return byRep;
}

/**
 * Aggregate the money COLLECTED per rep in the given date range - the commission
 * base. בסיס מזומן (owner rule 2026-08-26: "השכר מורכב מהתשלומים שנגבו באותו החודש"):
 * כל תשלום ששולם (paid, לא בוטל) שמועד הגבייה שלו בטווח נספר לנציגת העסקה,
 * בלי קשר למועד סגירת העסקה - ERN של עסקה מיולי שנגבה באוגוסט נספר באוגוסט.
 * @returns {Promise<Map<string, {collectedAmount,paymentsCount,collectedDeals}>>}
 */
async function aggregateCollected(dateFilter, repIdFilter, req) {
  const rows = await aggregatePaymentsInWindow(dateFilter, repIdFilter, req, true);
  const byRep = new Map();
  for (const r of rows) {
    byRep.set(String(r._id), {
      collectedAmount: r.amount || 0,
      paymentsCount: r.count || 0,
      collectedDeals: r.dealsCount || 0,
      // "מוחזק" (מצב מחמיר): חוזה לא חתום / העברה בלי אסמכתא
      heldContractAmount: r.heldContractAmount || 0,
      heldContractCount: r.heldContractCount || 0,
      heldReceiptAmount: r.heldReceiptAmount || 0,
      heldReceiptCount: r.heldReceiptCount || 0,
      clearDeals: r.clearDealsCount || 0, // עסקאות עם תשלום נספר גם במצב מחמיר
    });
  }
  return byRep;
}

/**
 * Payments whose collection date falls in the range but that are NOT collected yet
 * (paid=false, not canceled) - the "טרם נגבה" rows of the breakdown. Feeds the
 * "מתוך" figure: what the salary would be if they were all confirmed.
 * @returns {Promise<Map<string, {scheduledUncollected,scheduledUncollectedCount}>>}
 */
async function aggregateScheduledUncollected(dateFilter, repIdFilter, req) {
  const rows = await aggregatePaymentsInWindow(dateFilter, repIdFilter, req, false);
  const byRep = new Map();
  for (const r of rows) {
    byRep.set(String(r._id), {
      scheduledUncollected: r.amount || 0,
      scheduledUncollectedCount: r.count || 0,
    });
  }
  return byRep;
}

/**
 * Shared pipeline: one row per rep summing the payments whose collection date
 * (COLLECTED_AT: dueDate -> date -> confirmedAt -> dealDate) is in the range.
 * `paid` = true -> collected payments; false -> scheduled and still open.
 */
async function aggregatePaymentsInWindow(dateFilter, repIdFilter, req, paid) {
  const match = { recordType: "registration", rep: { $ne: null } };
  if (repIdFilter) match.rep = new mongoose.Types.ObjectId(repIdFilter);
  if (req) applySince(req, match); // מוד "מ-2026 בלבד" (לפי תאריך העסקה)

  const pipeline = [
    { $match: match },
    { $unwind: "$payments" },
    {
      $match: {
        "payments.paid": paid ? true : { $ne: true },
        "payments.canceled": { $ne: true },
      },
    },
    { $addFields: { collectedAt: COLLECTED_AT } },
  ];
  if (dateFilter) pipeline.push({ $match: { collectedAt: dateFilter } });
  const amt = { $ifNull: ["$payments.amount", 0] };
  const group = {
    _id: "$rep",
    amount: { $sum: amt },
    count: { $sum: 1 },
    dealIds: { $addToSet: "$_id" },
  };
  if (paid) {
    // פירוק ה"מוחזק" של המצב המחמיר (utils/premiumHold.js) - נצבר תמיד, מופחת רק ב-strict
    Object.assign(group, {
      heldContractAmount: { $sum: { $cond: [HELD_CONTRACT_EXPR, amt, 0] } },
      heldContractCount: { $sum: { $cond: [HELD_CONTRACT_EXPR, 1, 0] } },
      heldReceiptAmount: { $sum: { $cond: [HELD_RECEIPT_EXPR, amt, 0] } },
      heldReceiptCount: { $sum: { $cond: [HELD_RECEIPT_EXPR, 1, 0] } },
      clearDealIds: { $addToSet: { $cond: [HELD_EXPR, null, "$_id"] } },
    });
  }
  pipeline.push(
    { $group: group },
    {
      $project: {
        amount: 1,
        count: 1,
        dealsCount: { $size: "$dealIds" },
        heldContractAmount: 1,
        heldContractCount: 1,
        heldReceiptAmount: 1,
        heldReceiptCount: 1,
        clearDealsCount: {
          $size: {
            $filter: {
              input: { $ifNull: ["$clearDealIds", []] },
              as: "d",
              cond: { $ne: ["$$d", null] },
            },
          },
        },
      },
    },
  );
  return Registration.aggregate(pipeline);
}

/** מאחד מכירות (לפי תאריך עסקה), גבייה וגבייה ממתינה (לפי מועד תשלום) לשורה אחת לכל נציג/ה. */
async function aggregateForReps(dateFilter, repIdFilter, req) {
  const [sold, collected, scheduled] = await Promise.all([
    aggregateDeals(dateFilter, repIdFilter, req),
    aggregateCollected(dateFilter, repIdFilter, req),
    aggregateScheduledUncollected(dateFilter, repIdFilter, req),
  ]);
  const merged = new Map();
  for (const key of new Set([
    ...sold.keys(),
    ...collected.keys(),
    ...scheduled.keys(),
  ])) {
    merged.set(key, {
      salesAmount: 0,
      deals: 0,
      outstandingAmount: 0,
      collectedAmount: 0,
      paymentsCount: 0,
      collectedDeals: 0,
      scheduledUncollected: 0,
      scheduledUncollectedCount: 0,
      ...(sold.get(key) || {}),
      ...(collected.get(key) || {}),
      ...(scheduled.get(key) || {}),
    });
  }
  return merged;
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

  // שולפים את הנציגים הרלוונטיים (כולל מי שאין לו עסקאות בטווח -> שורה עם 0).
  // נציגת "פעיל לטסטים" מוסתרת מהרשימה הרחבה; בסקופ עצמי (repIdFilter) היא כן.
  const userQuery = repIdFilter
    ? { _id: repIdFilter }
    : { role: "rep", ...excludeTestOnly(req) };
  const users = await User.find(userQuery);

  const byRep = await aggregateForReps(dateFilter, repIdFilter, req);
  const strict = strictOf(req.query);

  const data = users
    .map((user) =>
      buildCommissionRow(
        user,
        byRep.get(String(user._id)) || {},
        baseMonths,
        strict,
      ),
    )
    .sort((a, b) => b.salesAmount - a.salesAmount);

  res.json({ success: true, data, baseMonths, strict });
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
  const byRep = await aggregateForReps(dateFilter, repId, req);
  const data = buildCommissionRow(
    user,
    byRep.get(String(repId)) || {},
    baseMonths,
    strictOf(req.query),
  );
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

  // "נגבה" = לפי מועד הגבייה של כל תשלום (בסיס מזומן); עסקאות/מכירות = לפי תאריך העסקה
  // לגבייה: מסננים עסקאות רק לפי נציגה/סוג (ומוד 2026), והחודש נקבע לפי מועד התשלום
  const collectedMatch = { recordType: "registration", rep: match.rep };
  applySince(req, collectedMatch);
  // מצב מחמיר (?strict=1): גבייה מוחזקת (חוזה לא חתום / העברה בלי אסמכתא) לא נספרת
  const strictStages = strictOf(req.query)
    ? [{ $match: { $expr: { $not: [HELD_EXPR] } } }]
    : [];
  // ומכירות/עסקאות בלי העסקאות המוחזקות (חוזה ממתין / העברה בלי אסמכתא)
  const strictDealStages = strictOf(req.query)
    ? [{ $match: { $expr: { $not: [DEAL_HELD_EXPR] } } }]
    : [];
  const rows =
    metric === "collected"
      ? await Registration.aggregate([
          { $match: collectedMatch },
          { $unwind: "$payments" },
          { $match: { "payments.paid": true, "payments.canceled": { $ne: true } } },
          ...strictStages,
          { $addFields: { collectedAt: COLLECTED_AT } },
          { $match: { collectedAt: { $gte: effFrom, $lt: to } } },
          {
            $group: {
              _id: { rep: "$rep", y: { $year: "$collectedAt" }, m: { $month: "$collectedAt" } },
              collected: { $sum: { $ifNull: ["$payments.amount", 0] } },
            },
          },
        ])
      : await Registration.aggregate([
          { $match: match },
          ...strictDealStages,
          {
            $group: {
              _id: {
                rep: "$rep",
                y: { $year: "$dealDate" },
                m: { $month: "$dealDate" },
              },
              deals: { $sum: 1 },
              salesAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
            },
          },
        ]);

  // sidecar יציב (סדר הצטרפות = _id) לצבעים עקביים
  const userQuery = repIdFilter
    ? { _id: repIdFilter }
    : { role: "rep", ...excludeTestOnly(req) };
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
  const strict = strictOf(req.query);
  const match = {
    recordType: "registration",
    rep: new mongoose.Types.ObjectId(repId),
  };
  applySince(req, match); // מוד "מ-2026 בלבד" (לפי תאריך העסקה)

  // כל עסקאות הנציג/ה - הפירוט הוא לפי תשלומים שמועד הגבייה שלהם בטווח, מכל עסקה
  const deals = await Registration.find(match)
    .select(
      "externalId studentName student courseRaw courseField course coursesInfo dealDate totalAmount totalPaid outstanding paymentStatus payments contract.token contract.status",
    )
    .populate("course", "name")
    .lean();

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const inRange = (d) => {
    if (!d) return false;
    if (!dateFilter) return true;
    const t = new Date(d);
    if (dateFilter.$gte && t < dateFilter.$gte) return false;
    if (dateFilter.$lt && t >= dateFilter.$lt) return false;
    return true;
  };
  const courseNameOf = (d) =>
    d.coursesInfo?.length > 1
      ? d.coursesInfo.map((ci) => ci.name).join(" + ")
      : d.course?.name || d.courseRaw || d.courseField || "";

  // שורה לכל תשלום שמועדו בטווח: נגבה (נספר) או מתוזמן שלא נגבה (לא נספר, למידע)
  const rows = [];
  for (const d of deals) {
    for (const p of d.payments || []) {
      if (p.canceled) continue;
      const collectedAt = collectedAtOf(p, d);
      if (!inRange(collectedAt)) continue;
      // "מוחזק" (מצב מחמיר): חוזה לא חתום / העברה בלי אסמכתא - מסומן תמיד, מופחת רק ב-strict
      const hold = holdReasonOf(p, d);
      rows.push({
        id: `${d._id}:${p._id}`,
        dealId: d._id,
        externalId: d.externalId,
        student: d.student,
        studentName: d.studentName,
        course: courseNameOf(d),
        dealDate: d.dealDate,
        collectedAt,
        method: p.methodCategory || p.method || "",
        type: p.type || "",
        amount: round2(p.amount || 0),
        paid: Boolean(p.paid),
        hold,
        counted: Boolean(p.paid) && !(strict && hold),
        confirmedByName: p.confirmedByName || "",
        note: p.note || "",
      });
    }
  }
  rows.sort((a, b) => new Date(b.collectedAt) - new Date(a.collectedAt));

  const collectedTotal = rows.filter((r) => r.counted).reduce((a, r) => a + r.amount, 0);
  const scheduledUncollected = rows.filter((r) => !r.paid).reduce((a, r) => a + r.amount, 0);
  const heldRows = rows.filter((r) => r.paid && r.hold);
  const heldTotal = heldRows.reduce((a, r) => a + r.amount, 0);
  // מכירות בתקופה (לפי תאריך עסקה) - להשוואה בלבד, לא בסיס הפרמיה.
  // במצב מחמיר עסקה מוחזקת (חוזה ממתין / העברה בלי אסמכתא) לא נספרת במכירות.
  const periodDeals = deals.filter((d) => inRange(d.dealDate));
  const heldPeriodDeals = periodDeals.filter((d) => dealHoldReason(d));
  const soldInPeriod = strict
    ? periodDeals.filter((d) => !dealHoldReason(d))
    : periodDeals;
  const salesTotal = soldInPeriod.reduce((a, d) => a + (d.totalAmount || 0), 0);
  const heldSalesTotal = heldPeriodDeals.reduce((a, d) => a + (d.totalAmount || 0), 0);
  // האחוז נבחר לפי הכסף שנגבה (כסף שטרם נגבה לא מקפיץ מדרגה)
  const { commissionRate } = computeCommission(collectedTotal, user.commission || {});

  const items = rows.map((r) => ({
    ...r,
    premiumContribution: r.counted ? round2(r.amount * commissionRate) : 0,
  }));

  res.json({
    success: true,
    data: {
      repId: String(user._id),
      repName: user.name,
      strict,
      commissionRate,
      salesTotal: round2(salesTotal),
      soldCount: soldInPeriod.length,
      heldSalesTotal: round2(heldSalesTotal), // מכירות התקופה של עסקאות מוחזקות
      heldSalesCount: heldPeriodDeals.length,
      collectedTotal: round2(collectedTotal), // בסיס הפרמיה = תשלומים שנגבו בתקופה (במצב מחמיר בלי המוחזק)
      scheduledUncollected: round2(scheduledUncollected), // תשלומים שמועדם בטווח וטרם נגבו
      heldTotal: round2(heldTotal), // נגבה אבל מוחזק (חוזה לא חתום / חסרה אסמכתא)
      heldCount: heldRows.length,
      heldContractTotal: round2(heldRows.filter((r) => r.hold === "contract").reduce((a, r) => a + r.amount, 0)),
      heldReceiptTotal: round2(heldRows.filter((r) => r.hold === "receipt").reduce((a, r) => a + r.amount, 0)),
      premiumTotal: round2(collectedTotal * commissionRate),
      countedCount: items.filter((x) => x.counted).length,
      notCountedCount: items.filter((x) => !x.paid).length,
      dealsCount: new Set(items.filter((x) => x.counted).map((x) => String(x.dealId))).size,
      items,
    },
  });
});
