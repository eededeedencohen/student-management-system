import crypto from "crypto";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import User from "../models/User.js";

/** שם משתמש חוקי: אותיות אנגליות/ספרות/נקודה/מקף, 2-24 תווים. */
const USERNAME_RX = /^[a-z0-9._-]{2,24}$/;

/** מנרמל ובודק שם משתמש; זורק שגיאת קלט ברורה. ריק => undefined. */
async function normalizeUsername(raw, excludeId) {
  const u = String(raw || "").trim().toLowerCase();
  if (!u) return undefined;
  if (!USERNAME_RX.test(u)) {
    throw ApiError.badRequest("שם משתמש באנגלית בלבד: אותיות/ספרות/נקודה/מקף, 2-24 תווים");
  }
  const clash = await User.findOne({
    username: u,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).lean();
  if (clash) throw ApiError.badRequest(`שם המשתמש "${u}" כבר תפוס`);
  return u;
}

/**
 * userController - ניהול נציגות מכירה (reps) ומנהלים (managers).
 * נתיב בסיס: /api/reps
 * passwordHash תמיד מוסתר (select:false במודל), ולא מוחזר בתגובות.
 */

/** Build a plain commission object from raw input (defensive, ignores junk). */
function buildCommission(raw = {}) {
  const commission = {};
  if (raw.baseSalary !== undefined)
    commission.baseSalary = Number(raw.baseSalary) || 0;
  if (raw.commissionRate !== undefined)
    commission.commissionRate = Number(raw.commissionRate) || 0;
  if (Array.isArray(raw.tiers)) {
    commission.tiers = raw.tiers.map((t) => ({
      fromSales: Number(t?.fromSales) || 0,
      rate: Number(t?.rate) || 0,
    }));
  }
  return commission;
}

/**
 * GET /api/reps  (manager)
 * רשימת משתמשים. ברירת מחדל מסננת לפי role=rep; אפשר ?role=manager או ?role=all.
 * תומך גם ב-?active=true/false ובחיפוש חופשי ?q (שם/אימייל).
 */
export const list = asyncHandler(async (req, res) => {
  const filter = {};

  const role = req.query.role ?? "rep"; // ברירת מחדל: נציגות בלבד
  if (role && role !== "all") filter.role = role;

  if (req.query.active !== undefined) {
    filter.active = req.query.active === "true" || req.query.active === true;
  }

  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).trim(), "i");
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const users = await User.find(filter)
    .select("-passwordHash")
    .sort({ name: 1 });
  res.json({ success: true, data: users });
});

/**
 * GET /api/reps/:id  (protect)
 * נציג רשאי לשלוף רק את עצמו; אחרת forbidden. מנהל רשאי לשלוף כל אחד.
 */
export const getOne = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // נציג יכול לראות רק את עצמו
  if (req.user?.role === "rep" && String(req.user._id) !== String(id)) {
    throw ApiError.forbidden("נציג רשאי לצפות רק בנתונים של עצמו");
  }

  const user = await User.findById(id).select("-passwordHash");
  if (!user) throw ApiError.notFound("המשתמש לא נמצא");

  res.json({ success: true, data: user });
});

/**
 * POST /api/reps  (manager)
 * יצירת משתמש: {name,email,role,password,phone,commission}.
 * שימוש ב-new User() + setPassword() + save(), והחזרה ללא passwordHash.
 */
export const create = asyncHandler(async (req, res) => {
  const { name, username, email, role, password, phone, commission, aliases } =
    req.body || {};

  if (!name || !String(name).trim())
    throw ApiError.badRequest("שם הוא שדה חובה");
  const uname = await normalizeUsername(username);
  if (!uname) throw ApiError.badRequest("שם משתמש (באנגלית) הוא שדה חובה");
  if (!password || String(password).length < 6) {
    throw ApiError.badRequest("נדרשת סיסמה באורך 6 תווים לפחות");
  }
  if (role && !["manager", "rep"].includes(role)) {
    throw ApiError.badRequest("תפקיד לא תקין");
  }

  const user = new User({
    name: String(name).trim(),
    username: uname,
    email: email ? String(email).trim().toLowerCase() : undefined,
    role: role || "rep",
    phone: phone ? String(phone).trim() : undefined,
    aliases: Array.isArray(aliases) ? aliases : undefined,
    commission: buildCommission(commission),
  });
  await user.setPassword(String(password));
  await user.save();

  // החזרה ללא passwordHash
  const obj = user.toObject();
  delete obj.passwordHash;

  res.status(201).json({ success: true, data: obj });
});

/**
 * PUT /api/reps/:id  (manager)
 * עדכון שדות בסיסיים: name/email/phone/active/role.
 */
export const update = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("-passwordHash");
  if (!user) throw ApiError.notFound("המשתמש לא נמצא");

  const { name, username, email, phone, active, role } = req.body || {};

  if (username !== undefined) {
    const uname = await normalizeUsername(username, user._id);
    if (!uname) throw ApiError.badRequest("שם משתמש (באנגלית) הוא שדה חובה");
    user.username = uname;
  }
  if (name !== undefined) user.name = String(name).trim();
  if (email !== undefined)
    user.email = email ? String(email).trim().toLowerCase() : undefined;
  if (phone !== undefined)
    user.phone = phone ? String(phone).trim() : undefined;
  if (active !== undefined) user.active = active === true || active === "true";
  if (role !== undefined) {
    if (!["manager", "rep"].includes(role))
      throw ApiError.badRequest("תפקיד לא תקין");
    user.role = role;
  }

  await user.save();
  res.json({ success: true, data: user });
});

/**
 * PUT /api/reps/:id/commission  (manager)
 * עדכון הגדרות עמלה: {baseSalary, commissionRate, tiers}.
 */
export const updateCommission = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("-passwordHash");
  if (!user) throw ApiError.notFound("המשתמש לא נמצא");

  const commission = buildCommission(req.body || {});

  // מיזוג: שמירה על ערכים קיימים אם לא נשלחו
  user.commission = {
    baseSalary: commission.baseSalary ?? user.commission?.baseSalary ?? 0,
    commissionRate:
      commission.commissionRate ?? user.commission?.commissionRate ?? 0,
    tiers: commission.tiers ?? user.commission?.tiers ?? [],
  };

  await user.save();
  res.json({ success: true, data: user });
});

/**
 * DELETE /api/reps/:id  (manager)
 * מחיקה רכה: מסמן active=false (לא מוחק מה-DB כדי לשמר היסטוריה).
 */
export const remove = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select("-passwordHash");
  if (!user) throw ApiError.notFound("המשתמש לא נמצא");

  user.active = false;
  await user.save();

  res.json({ success: true, data: user });
});

/**
 * POST /api/reps/:id/password-reset-link  (manager)
 * מפיק קישור חד-פעמי להגדרת/איפוס סיסמה (בתוקף ל-3 ימים) עבור המשתמש.
 * הרשאות: מנהל מפיק לנציגות; קישור למנהל/מנהל-על - רק מנהל-העל רשאי.
 * מוחזר הטוקן הגולמי (נשמר רק hash); הקליינט מרכיב ממנו את כתובת העמוד.
 */
export const createPasswordResetLink = asyncHandler(async (req, res) => {
  const target = await User.findById(req.params.id).select("+passwordReset");
  if (!target) throw ApiError.notFound("המשתמש לא נמצא");
  if (!target.active) throw ApiError.badRequest("לא ניתן להפיק קישור למשתמש לא פעיל");

  // ההרשאה נקבעת לפי המשתמש האמיתי (impersonator אם קיים), לא לפי "צפייה בתור"
  const actor = req.impersonator || req.user;
  const actorIsSuper = actor?.superAdmin === true;
  if ((target.superAdmin || target.role === "manager") && !actorIsSuper) {
    throw ApiError.forbidden("רק מנהל-העל רשאי להפיק קישור איפוס למנהל");
  }

  const token = crypto.randomBytes(24).toString("base64url"); // 192 ביט - לא ניתן לניחוש
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  target.passwordReset = {
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt,
    createdAt: new Date(),
    createdByName: actor?.name || "",
  };
  await target.save();

  res.json({
    success: true,
    data: {
      token,
      expiresAt,
      name: target.name,
      username: target.username || "",
      phone: target.phone || "",
    },
  });
});
