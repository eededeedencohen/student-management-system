import Expense from '../models/Expense.js';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import { parseDateQuery } from '../utils/dateRanges.js';
import { parseNumber, cleanStr } from '../utils/normalize.js';

/**
 * Expenses domain (/api/expenses) = ניהול הוצאות.
 * הוצאות הן נתוני הנהלה בלבד — אין כאן scopeToRep (אין רפ "בעל" של הוצאה).
 * צפייה פתוחה לכל משתמש מאומת; יצירה/עדכון/מחיקה למנהל בלבד (נאכף ב-routes).
 */

const TYPES = ['fixed', 'variable'];
const RECURRENCES = ['none', 'monthly', 'quarterly', 'yearly'];

/**
 * Build a clean expense payload from the request body.
 * Used by both create and update so validation/normalisation stays in one place.
 * On update we only touch keys the caller actually sent (partial update).
 */
const buildPayload = (body, { partial = false } = {}) => {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('name')) out.name = cleanStr(body.name);
  if (has('category')) out.category = cleanStr(body.category) || 'כללי';
  if (has('amount')) out.amount = parseNumber(body.amount);
  if (has('vatIncluded')) out.vatIncluded = Boolean(body.vatIncluded);

  if (has('type')) {
    const type = cleanStr(body.type);
    if (type && !TYPES.includes(type)) {
      throw ApiError.badRequest(`type חייב להיות אחד מ: ${TYPES.join(', ')}`);
    }
    if (type) out.type = type;
  }

  if (has('recurrence')) {
    const recurrence = cleanStr(body.recurrence);
    if (recurrence && !RECURRENCES.includes(recurrence)) {
      throw ApiError.badRequest(`recurrence חייב להיות אחד מ: ${RECURRENCES.join(', ')}`);
    }
    if (recurrence) out.recurrence = recurrence;
  }

  if (has('dayOfMonth')) {
    const dom = parseNumber(body.dayOfMonth);
    if (dom < 1 || dom > 31) throw ApiError.badRequest('dayOfMonth חייב להיות בין 1 ל-31');
    out.dayOfMonth = dom;
  }

  if (has('date')) out.date = body.date ? new Date(body.date) : undefined;
  if (has('dateRaw')) out.dateRaw = cleanStr(body.dateRaw);
  if (has('startDate')) out.startDate = body.startDate ? new Date(body.startDate) : undefined;
  if (has('endDate')) out.endDate = body.endDate ? new Date(body.endDate) : undefined;
  if (has('notes')) out.notes = cleanStr(body.notes);

  // ביצירה name הוא שדה חובה (כמו במודל)
  if (!partial && !out.name) throw ApiError.badRequest('name (תיאור ההוצאה) הוא שדה חובה');

  return out;
};

/**
 * GET /api/expenses
 * Filters: ?type, ?category, ?from&?to (on the `date` field). Sorted date desc.
 */
export const list = asyncHandler(async (req, res) => {
  const { type, category } = req.query;
  const filter = {};

  if (type) {
    if (!TYPES.includes(type)) {
      throw ApiError.badRequest(`type חייב להיות אחד מ: ${TYPES.join(', ')}`);
    }
    filter.type = type;
  }
  if (category) filter.category = category;

  // סינון לפי טווח תאריכים על שדה date
  const dateFilter = parseDateQuery(req.query);
  if (dateFilter) filter.date = dateFilter;

  // newest first; nulls (recurring expenses without a single date) sink to the end
  const data = await Expense.find(filter).sort({ date: -1, createdAt: -1 });

  res.json({ success: true, data });
});

/**
 * POST /api/expenses (manager)
 */
export const create = asyncHandler(async (req, res) => {
  const payload = buildPayload(req.body, { partial: false });
  const expense = await Expense.create(payload);
  res.status(201).json({ success: true, data: expense });
});

/**
 * PUT /api/expenses/:id (manager)
 */
export const update = asyncHandler(async (req, res) => {
  const payload = buildPayload(req.body, { partial: true });

  const expense = await Expense.findByIdAndUpdate(req.params.id, payload, {
    new: true,
    runValidators: true,
  });
  if (!expense) throw ApiError.notFound('הוצאה לא נמצאה');

  res.json({ success: true, data: expense });
});

/**
 * DELETE /api/expenses/:id (manager)
 */
export const remove = asyncHandler(async (req, res) => {
  const expense = await Expense.findByIdAndDelete(req.params.id);
  if (!expense) throw ApiError.notFound('הוצאה לא נמצאה');

  res.json({ success: true, data: { id: expense._id } });
});
