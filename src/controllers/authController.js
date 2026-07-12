import User from "../models/User.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { signToken } from "../utils/token.js";

/**
 * Build the public user payload returned to the client.
 * מחזיר רק שדות מותרים (ללא passwordHash).
 */
const publicUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  superAdmin: user.superAdmin === true,
  commission: user.commission,
});

/**
 * GET /api/auth/users  (PUBLIC)
 * Minimal list of active users for the login picker: { _id, name, role, email }.
 * Managers first, then reps by name. Internal tool - exposes only names/roles/emails.
 */
export const loginOptions = asyncHandler(async (req, res) => {
  const users = await User.find({ active: true })
    .select("name role email")
    .sort({ role: 1, name: 1 })
    .lean();
  res.json({ success: true, data: users });
});

/**
 * POST /api/auth/login-as  (PUBLIC)
 * body: { userId }
 * Passwordless sign-in by picking a user (internal tool - no password step).
 * Returns a token + user, exactly like /login.
 */
export const loginAs = asyncHandler(async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) throw ApiError.badRequest("יש לבחור משתמש");
  const user = await User.findById(userId);
  if (!user || !user.active)
    throw ApiError.unauthorized("המשתמש לא קיים או לא פעיל");

  const token = signToken({ id: user._id, role: user.role });
  res.json({ success: true, data: { token, user: publicUser(user) } });
});

/**
 * POST /api/auth/login  (PUBLIC)
 * body: { email, password }
 * מאמת אימייל+סיסמה ומחזיר טוקן + פרטי משתמש.
 */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    throw ApiError.badRequest("יש להזין אימייל וסיסמה");
  }

  // passwordHash מוגדר select:false במודל - חובה לבקש אותו במפורש.
  const user = await User.findOne({
    email: String(email).toLowerCase().trim(),
  }).select("+passwordHash");

  // אותו מסר שגיאה גם כשהמשתמש לא קיים וגם כשהסיסמה שגויה (לא לחשוף קיום משתמש).
  if (!user || !user.active) {
    throw ApiError.unauthorized("אימייל או סיסמה שגויים");
  }

  const ok = await user.verifyPassword(password);
  if (!ok) {
    throw ApiError.unauthorized("אימייל או סיסמה שגויים");
  }

  const token = signToken({ id: user._id, role: user.role });

  res.json({
    success: true,
    data: {
      token,
      user: publicUser(user),
    },
  });
});

/**
 * GET /api/auth/me  (protect)
 * מחזיר את פרטי המשתמש המחובר (ללא passwordHash).
 */
export const me = asyncHandler(async (req, res) => {
  const u = req.user; // effective user (may be an impersonated user)
  // req.user יכול להיות מסמך Mongoose (התחברות רגילה) או אובייקט stub (admin-token).
  const data =
    typeof u?.toObject === "function"
      ? (() => {
          const obj = u.toObject();
          delete obj.passwordHash;
          return obj;
        })()
      : { ...u };

  // The REAL signed-in user decides whether the "view as" switcher is available.
  const real = req.impersonator || req.user;
  data.canImpersonate = real?.superAdmin === true;
  data.impersonating = req.impersonator
    ? { _id: String(u._id), name: u.name, role: u.role }
    : null;
  if (req.impersonator) data.realName = req.impersonator.name;

  res.json({ success: true, data });
});

/**
 * POST /api/auth/change-password  (protect)
 * body: { currentPassword, newPassword }
 * מאמת את הסיסמה הנוכחית ומעדכן לסיסמה חדשה.
 */
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    throw ApiError.badRequest("יש להזין סיסמה נוכחית וסיסמה חדשה");
  }
  if (String(newPassword).length < 6) {
    throw ApiError.badRequest("הסיסמה החדשה חייבת להכיל לפחות 6 תווים");
  }

  // משתמש admin-token אינו משתמש אמיתי במסד - אין לו סיסמה לשנות.
  if (req.user?.isAdminToken || !req.user?._id) {
    throw ApiError.forbidden("לא ניתן לשנות סיסמה עבור משתמש זה");
  }

  // טוענים מחדש עם passwordHash (req.user נטען ללא השדה הזה).
  const user = await User.findById(req.user._id).select("+passwordHash");
  if (!user) {
    throw ApiError.notFound("המשתמש לא נמצא");
  }

  const ok = await user.verifyPassword(currentPassword);
  if (!ok) {
    throw ApiError.unauthorized("הסיסמה הנוכחית שגויה");
  }

  await user.setPassword(newPassword);
  await user.save();

  res.json({ success: true, data: { message: "הסיסמה עודכנה בהצלחה" } });
});
