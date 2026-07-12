import mongoose from "mongoose";
import Goal from "../models/Goal.js";
import Registration from "../models/Registration.js";
import Lead from "../models/Lead.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { nowFromReq } from "../utils/dateRanges.js";

/**
 * Goals / Milestones controller - ניהול יעדים ואבני דרך.
 * Managers create/update/delete goals; everyone can read goals in scope and
 * inspect progress. Progress compares the actual metric against the time
 * elapsed in the goal's period to flag on_track / at_risk / behind.
 */

const { Types } = mongoose;

const toObjectId = (id) => {
  if (id && Types.ObjectId.isValid(String(id)))
    return new Types.ObjectId(String(id));
  return null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whitelisted fields a manager may set when creating/updating a goal. */
const GOAL_FIELDS = [
  "title",
  "rep",
  "scope",
  "metric",
  "targetValue",
  "periodType",
  "startDate",
  "endDate",
  "workingDays",
  "notes",
  "active",
];

const pickGoalFields = (body = {}) => {
  const out = {};
  for (const f of GOAL_FIELDS) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  return out;
};

/**
 * Compute the "actual" value for a goal's metric over the goal's period.
 * Revenue/sales/deals are counted from registrations with
 * recordType==='registration' only (advertising / collection_followup / other
 * are excluded). closeRate = won deals / leads received in the same window.
 */
const computeActual = async (goal) => {
  const repId = toObjectId(goal.rep);
  // יעד צוותי (scope==='team' או ללא rep) = כלל העסקאות; יעד אישי = רק של הנציג/ה
  const baseMatch = {
    recordType: "registration",
    dealDate: { $gte: goal.startDate, $lte: goal.endDate },
  };
  if (goal.scope === "rep" && repId) baseMatch.rep = repId;

  if (goal.metric === "salesAmount") {
    const [row] = await Registration.aggregate([
      { $match: baseMatch },
      { $group: { _id: null, value: { $sum: "$totalAmount" } } },
    ]);
    return row?.value || 0;
  }

  if (goal.metric === "dealsCount") {
    return Registration.countDocuments(baseMatch);
  }

  if (goal.metric === "collectedAmount") {
    const [row] = await Registration.aggregate([
      { $match: baseMatch },
      { $group: { _id: null, value: { $sum: "$totalPaid" } } },
    ]);
    return row?.value || 0;
  }

  if (goal.metric === "closeRate") {
    // אחוז סגירה = עסקאות שנסגרו / כמות הלידים שהתקבלו בתקופה (0..1)
    const deals = await Registration.countDocuments(baseMatch);

    // Leads in window: individual leads by receivedDate, or aggregate counts by period.
    const leadMatch = {
      $or: [
        {
          isAggregate: { $ne: true },
          receivedDate: { $gte: goal.startDate, $lte: goal.endDate },
        },
        {
          isAggregate: true,
          periodStart: { $lte: goal.endDate },
          periodEnd: { $gte: goal.startDate },
        },
      ],
    };
    if (goal.scope === "rep" && repId) leadMatch.rep = repId;

    const [row] = await Lead.aggregate([
      { $match: leadMatch },
      {
        $group: {
          _id: null,
          // ספירת לידים: בודדים נחשבים 1, צבירה לפי count
          value: {
            $sum: { $cond: ["$isAggregate", { $ifNull: ["$count", 0] }, 1] },
          },
        },
      },
    ]);
    const leads = row?.value || 0;
    return leads > 0 ? deals / leads : 0;
  }

  return 0;
};

/**
 * Build the progress object for a single goal: actual, pct, elapsedPct,
 * expectedByNow, status and remaining.
 */
const buildProgress = async (goal, refDate = new Date()) => {
  const actual = await computeActual(goal);
  const target = goal.targetValue || 0;
  const pct = target > 0 ? actual / target : 0;

  // אחוז התקדמות הזמן בתקופה. אם הוגדרו ימי עבודה - לפי הימים שחלפו ביחס לסה"כ;
  // אחרת לפי ימים קלנדריים. תמיד נחתך לטווח 0..1.
  const start = new Date(goal.startDate).getTime();
  const end = new Date(goal.endDate).getTime();
  const now = refDate.getTime();
  let elapsedPct = 0;
  if (goal.workingDays && goal.workingDays > 0) {
    const elapsedDays = Math.max(0, (now - start) / DAY_MS);
    elapsedPct = elapsedDays / goal.workingDays;
  } else {
    const totalMs = end - start;
    elapsedPct = totalMs > 0 ? (now - start) / totalMs : 1;
  }
  elapsedPct = Math.min(1, Math.max(0, elapsedPct));

  const expectedByNow = target * elapsedPct;

  // סטטוס: בקצב / בסיכון / מאחור
  let status;
  if (pct >= elapsedPct - 0.05) status = "on_track";
  else if (elapsedPct > 0.8 && pct < 0.8) status = "at_risk";
  else status = "behind";

  const remaining = target - actual;

  return {
    goal,
    actual,
    targetValue: target,
    pct,
    elapsedPct,
    expectedByNow,
    status,
    remaining,
  };
};

/**
 * GET /api/goals
 * List goals. Manager: all goals (optional ?rep, ?active filters).
 * Rep: own goals + team-scoped goals.
 */
export const list = asyncHandler(async (req, res) => {
  const filter = {};

  if (req.query.active !== undefined) {
    filter.active = req.query.active === "true" || req.query.active === true;
  }

  if (req.scopeRepId) {
    // נציג/ה: יעדים אישיים שלו/ה + יעדים צוותיים
    filter.$or = [{ rep: toObjectId(req.scopeRepId) }, { scope: "team" }];
  } else if (req.query.rep) {
    // מנהל עם סינון אופציונלי לפי נציג/ה
    filter.rep = toObjectId(req.query.rep);
  }

  const goals = await Goal.find(filter).sort({
    active: -1,
    endDate: -1,
    createdAt: -1,
  });
  res.json({ success: true, data: goals, total: goals.length });
});

/** GET /api/goals/:id */
export const getOne = asyncHandler(async (req, res) => {
  const goal = await Goal.findById(req.params.id);
  if (!goal) throw ApiError.notFound("היעד לא נמצא");

  // נציג/ה רשאי/ת לראות רק יעד אישי שלו/ה או יעד צוותי
  if (
    req.scopeRepId &&
    goal.scope !== "team" &&
    String(goal.rep) !== String(req.scopeRepId)
  ) {
    throw ApiError.forbidden("אין הרשאה לצפות ביעד זה");
  }

  res.json({ success: true, data: goal });
});

/** POST /api/goals (manager) */
export const create = asyncHandler(async (req, res) => {
  const data = pickGoalFields(req.body);

  if (
    data.targetValue === undefined ||
    data.targetValue === null ||
    data.targetValue === ""
  ) {
    throw ApiError.badRequest("חובה להזין ערך יעד (targetValue)");
  }
  if (!data.startDate || !data.endDate) {
    throw ApiError.badRequest("חובה להזין תאריך התחלה וסיום ליעד");
  }
  // יעד אישי מחייב נציג/ה; יעד צוותי מתעלם מ-rep
  if (data.scope === "team") data.rep = null;

  const goal = await Goal.create(data);
  res.status(201).json({ success: true, data: goal });
});

/** PUT /api/goals/:id (manager) */
export const update = asyncHandler(async (req, res) => {
  const data = pickGoalFields(req.body);
  if (data.scope === "team") data.rep = null;

  const goal = await Goal.findByIdAndUpdate(req.params.id, data, {
    new: true,
    runValidators: true,
  });
  if (!goal) throw ApiError.notFound("היעד לא נמצא");
  res.json({ success: true, data: goal });
});

/** DELETE /api/goals/:id (manager) */
export const remove = asyncHandler(async (req, res) => {
  const goal = await Goal.findByIdAndDelete(req.params.id);
  if (!goal) throw ApiError.notFound("היעד לא נמצא");
  res.json({ success: true, data: goal });
});

/**
 * GET /api/goals/progress
 * For each active goal in scope, return its computed progress.
 * Manager: all active goals (optional ?repId). Rep: own + team goals (scoped).
 */
export const progress = asyncHandler(async (req, res) => {
  const filter = { active: true };

  if (req.scopeRepId) {
    // נציג/ה: יעדים אישיים + צוותיים
    filter.$or = [{ rep: toObjectId(req.scopeRepId) }, { scope: "team" }];
  } else if (req.query.repId) {
    // מנהל: סינון אופציונלי לנציג/ה ספציפי/ת (כולל יעדים צוותיים)
    filter.$or = [{ rep: toObjectId(req.query.repId) }, { scope: "team" }];
  }

  const goals = await Goal.find(filter).sort({ endDate: -1, createdAt: -1 });
  const refDate = nowFromReq(req); // honours the "view as of" date override
  const data = await Promise.all(goals.map((g) => buildProgress(g, refDate)));

  res.json({ success: true, data, total: data.length });
});
