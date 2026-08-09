import Quote from "../models/Quote.js";
import QuoteTemplate from "../models/QuoteTemplate.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { parseNumber, cleanStr } from "../utils/normalize.js";

/*
 * הצעות מחיר שמורות + טמפלטים - נגיש לכל משתמש מחובר (גם נציגות).
 * הצעה שייכת ליוצר/ת שלה: נציגה רואה ומנהלת רק את שלה, מנהל את כולן.
 * טמפלטים משותפים לכל הצוות; מחיקה - היוצר/ת או מנהל.
 */

const STATUSES = ["draft", "sent", "followup", "won", "lost"];

const uidOf = (req) =>
  req.user?._id && req.user._id !== "admin-token" ? req.user._id : undefined;

/** Escape a user string so it can be safely used inside a RegExp. */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** שדות הטופס הנשמרים בהצעה (מלבד סטטוס ובעלות). */
const STRING_FIELDS = [
  "quoteNo",
  "fullName",
  "phone",
  "idNumber",
  "courseName",
  "description",
  "sessionLength",
  "schedule",
  "place",
  "method",
  "startDate",
  "endDate",
  "recordedLine",
  "notes",
];

/** בונה עדכון נקי מגוף הבקשה - רק שדות שנשלחו. */
function quotePatch(body = {}) {
  const patch = {};
  for (const f of STRING_FIELDS) {
    if (body[f] !== undefined) patch[f] = cleanStr(body[f]) || "";
  }
  if (body.price !== undefined) patch.price = parseNumber(body.price) || 0;
  if (body.sessions !== undefined) {
    const n = parseNumber(body.sessions);
    patch.sessions = n > 0 ? Math.round(n) : undefined;
  }
  return patch;
}

/** נציגה נוגעת רק בהצעות שהיא יצרה. */
function ensureOwn(req, doc) {
  if (req.scopeRepId && String(doc.createdBy || "") !== req.scopeRepId) {
    throw ApiError.forbidden("אפשר לערוך רק הצעות מחיר שאת/ה יצרת");
  }
}

/** GET /api/quotes?q=&repId=&status= - נציגה: רק שלה; מנהל: הכול. */
export const list = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.scopeRepId) filter.createdBy = req.scopeRepId;
  else if (req.query.repId) filter.createdBy = req.query.repId;
  if (req.query.status && STATUSES.includes(req.query.status)) {
    filter.status = req.query.status;
  }
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(cleanStr(req.query.q)), "i");
    filter.$or = [{ fullName: rx }, { courseName: rx }, { quoteNo: rx }];
  }
  const rows = await Quote.find(filter).sort({ createdAt: -1 }).limit(300).lean();
  res.json({ success: true, data: rows });
});

/** POST /api/quotes - שמירת הצעה חדשה. */
export const create = asyncHandler(async (req, res) => {
  const patch = quotePatch(req.body);
  if (!patch.courseName && !patch.fullName) {
    throw ApiError.badRequest("להצעה שמורה נדרש לפחות שם קורס או שם מתעניין/ת");
  }
  const status = STATUSES.includes(req.body?.status) ? req.body.status : "draft";
  const doc = await Quote.create({
    ...patch,
    status,
    statusAt: new Date(),
    statusByName: req.user?.name || "",
    createdBy: uidOf(req),
    createdByName: req.user?.name || "",
  });
  res.json({ success: true, data: doc });
});

/** PUT /api/quotes/:id - עדכון תוכן ההצעה (שמירה חוזרת מהטופס). */
export const update = asyncHandler(async (req, res) => {
  const doc = await Quote.findById(req.params.id);
  if (!doc) throw ApiError.notFound("ההצעה לא נמצאה");
  ensureOwn(req, doc);
  Object.assign(doc, quotePatch(req.body));
  await doc.save();
  res.json({ success: true, data: doc });
});

/** PATCH /api/quotes/:id/status - עדכון הסטטוס הידני. */
export const setStatus = asyncHandler(async (req, res) => {
  const status = req.body?.status;
  if (!STATUSES.includes(status)) throw ApiError.badRequest("סטטוס לא מוכר");
  const doc = await Quote.findById(req.params.id);
  if (!doc) throw ApiError.notFound("ההצעה לא נמצאה");
  ensureOwn(req, doc);
  doc.status = status;
  doc.statusAt = new Date();
  doc.statusByName = req.user?.name || "";
  await doc.save();
  res.json({ success: true, data: doc });
});

/** DELETE /api/quotes/:id */
export const remove = asyncHandler(async (req, res) => {
  const doc = await Quote.findById(req.params.id);
  if (!doc) throw ApiError.notFound("ההצעה לא נמצאה");
  ensureOwn(req, doc);
  await doc.deleteOne();
  res.json({ success: true, data: { id: req.params.id } });
});

// ============================= טמפלטים =============================

const TEMPLATE_KEYS = [
  "courseName",
  "description",
  "price",
  "sessions",
  "sessionLength",
  "schedule",
  "place",
  "method",
  "recordedLine",
  "notes",
];

/** GET /api/quotes/templates - כל הטמפלטים השמורים (משותפים לצוות). */
export const listTemplates = asyncHandler(async (req, res) => {
  const rows = await QuoteTemplate.find().sort({ name: 1 }).lean();
  res.json({ success: true, data: rows });
});

/**
 * POST /api/quotes/templates - body { name, fields, overwrite? }.
 * fields מכיל רק את השדות שנבחרו (פר קורס = הכול, פר שדה = אחד). שם תפוס
 * נדחה, אלא אם overwrite=true - ואז הטמפלט הקיים מוחלף (משאב צוותי משותף).
 */
export const createTemplate = asyncHandler(async (req, res) => {
  const name = cleanStr(req.body?.name);
  if (!name) throw ApiError.badRequest("יש לתת שם לטמפלט");

  const fields = {};
  const src = req.body?.fields || {};
  for (const k of TEMPLATE_KEYS) {
    const v = src[k];
    if (v === undefined || v === null || v === "") continue;
    if (k === "price" || k === "sessions") {
      const n = parseNumber(v);
      if (n > 0) fields[k] = k === "sessions" ? Math.round(n) : n;
    } else {
      const s = cleanStr(v);
      if (s) fields[k] = s;
    }
  }
  if (Object.keys(fields).length === 0) {
    throw ApiError.badRequest("יש לכלול לפחות שדה אחד בטמפלט");
  }

  const existing = await QuoteTemplate.findOne({ name });
  if (existing && req.body?.overwrite !== true) {
    throw ApiError.badRequest(
      `טמפלט בשם "${name}" כבר קיים - אפשר להחליף אותו או לבחור שם אחר`,
    );
  }
  let doc;
  if (existing) {
    existing.fields = fields;
    existing.createdBy = uidOf(req);
    existing.createdByName = req.user?.name || "";
    doc = await existing.save();
  } else {
    doc = await QuoteTemplate.create({
      name,
      fields,
      createdBy: uidOf(req),
      createdByName: req.user?.name || "",
    });
  }
  res.json({ success: true, data: doc });
});

/** DELETE /api/quotes/templates/:id - היוצר/ת או מנהל. */
export const removeTemplate = asyncHandler(async (req, res) => {
  const doc = await QuoteTemplate.findById(req.params.id);
  if (!doc) throw ApiError.notFound("הטמפלט לא נמצא");
  const isOwner =
    doc.createdBy && String(doc.createdBy) === String(req.user?._id || "");
  if (req.user?.role !== "manager" && !isOwner) {
    throw ApiError.forbidden("מחיקת טמפלט - רק מי שיצר/ה אותו או מנהל");
  }
  await doc.deleteOne();
  res.json({ success: true, data: { id: req.params.id } });
});
