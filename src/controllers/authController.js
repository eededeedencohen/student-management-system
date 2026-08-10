import crypto from "crypto";
import User from "../models/User.js";
import LoginEvent from "../models/LoginEvent.js";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { signToken } from "../utils/token.js";

/** רישום כניסה/חזרה (best-effort) - לעולם לא מפיל את הבקשה עצמה. */
async function recordLogin(req, user, kind = "login") {
  try {
    const fwd = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    await LoginEvent.create({
      user: user._id,
      name: user.name,
      role: user.role,
      superAdmin: user.superAdmin === true,
      kind,
      at: new Date(),
      ip: fwd || req.socket?.remoteAddress || "",
      userAgent: req.headers["user-agent"] || "",
    });
  } catch {
    /* לוג כניסות הוא מִשְׁני - לא נכשל בגללו */
  }
}

const RESUME_THROTTLE_MS = 30 * 60 * 1000; // resume נרשם לכל היותר פעם בחצי שעה

/**
 * רישום "חזרה למערכת" (resume): הטוקן תקף 30 יום, ולכן פתיחת האפליקציה בלי
 * מסך התחברות היא הכניסה המעשית של רוב המשתמשים - בלי זה יומן הכניסות מפספס
 * אותן לגמרי (בדיוק מה שקרה עם יקיר). נרשם עבור המשתמש האמיתי (לא מתחזה),
 * מרוסן לחצי שעה, ולעולם אינו מפיל את הבקשה.
 */
async function recordResumeThrottled(req, realUser) {
  try {
    if (!realUser?._id || realUser.isAdminToken) return;
    const last = await LoginEvent.findOne({ user: realUser._id })
      .sort({ at: -1 })
      .select("at")
      .lean();
    if (last && Date.now() - new Date(last.at).getTime() < RESUME_THROTTLE_MS)
      return;
    await recordLogin(req, realUser, "resume");
  } catch {
    /* לוג כניסות הוא מִשְׁני */
  }
}

/**
 * Build the public user payload returned to the client.
 * מחזיר רק שדות מותרים (ללא passwordHash).
 */
const publicUser = (user) => ({
  _id: user._id,
  name: user.name,
  username: user.username || "",
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
 * POST /api/auth/login-as  (PUBLIC, RETIRED)
 * הכניסה ללא סיסמה בוטלה - מאז מעבר המערכת לשם משתמש + סיסמה. הנקודה נשארת
 * רק כדי שקליינטים ישנים (טאב פתוח עם גרסה קודמת) יקבלו הסבר ברור.
 */
export const loginAs = asyncHandler(async () => {
  throw ApiError.unauthorized(
    "הכניסה ללא סיסמה בוטלה - יש לרענן את הדף ולהתחבר עם שם משתמש וסיסמה",
  );
});

/**
 * POST /api/auth/login  (PUBLIC)
 * body: { username, password }  (username = השם באנגלית; אימייל מתקבל גם הוא)
 * מאמת שם משתמש+סיסמה ומחזיר טוקן + פרטי משתמש.
 */
export const login = asyncHandler(async (req, res) => {
  const { username, email, password } = req.body || {};
  const ident = String(username || email || "").toLowerCase().trim();
  if (!ident || !password) {
    throw ApiError.badRequest("יש להזין שם משתמש וסיסמה");
  }

  // passwordHash מוגדר select:false במודל - חובה לבקש אותו במפורש.
  const user = await User.findOne({
    $or: [{ username: ident }, { email: ident }],
  }).select("+passwordHash");

  // אותו מסר שגיאה גם כשהמשתמש לא קיים וגם כשהסיסמה שגויה (לא לחשוף קיום משתמש).
  if (!user || !user.active) {
    throw ApiError.unauthorized("שם משתמש או סיסמה שגויים");
  }

  // משתמש קיים אך ללא סיסמה מוגדרת - הכוונה ברורה במקום כישלון סתמי
  if (!user.passwordHash) {
    throw ApiError.unauthorized(
      "טרם הוגדרה סיסמה למשתמש זה - יש לבקש ממנהל קישור להגדרת סיסמה",
    );
  }

  const ok = await user.verifyPassword(password);
  if (!ok) {
    throw ApiError.unauthorized("שם משתמש או סיסמה שגויים");
  }

  await recordLogin(req, user);
  const token = signToken({ id: user._id, role: user.role });

  res.json({
    success: true,
    data: {
      token,
      user: publicUser(user),
    },
  });
});

/* ------------------------------------------------------------------ */
/* קישורי איפוס/הגדרת סיסמה                                            */
/* ------------------------------------------------------------------ */

const RESET_LINK_TTL_MS = 3 * 24 * 60 * 60 * 1000; // הקישור בתוקף ל-3 ימים
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

/** מאתר משתמש לפי טוקן איפוס בתוקף; זורק שגיאה אחידה אם לא נמצא/פג. */
async function findByResetToken(token) {
  const t = String(token || "").trim();
  if (t.length < 20) throw ApiError.notFound("הקישור אינו תקין או שפג תוקפו");
  const user = await User.findOne({
    "passwordReset.tokenHash": hashToken(t),
    "passwordReset.expiresAt": { $gt: new Date() },
    active: true,
  }).select("+passwordReset +passwordHash");
  if (!user) throw ApiError.notFound("הקישור אינו תקין או שפג תוקפו");
  return user;
}

/**
 * GET /api/auth/password-reset/:token  (PUBLIC)
 * פרטי הקישור לתצוגה בעמוד האיפוס: למי הוא שייך ומתי פג.
 */
export const resetInfo = asyncHandler(async (req, res) => {
  const user = await findByResetToken(req.params.token);
  res.json({
    success: true,
    data: {
      name: user.name,
      username: user.username || "",
      expiresAt: user.passwordReset.expiresAt,
    },
  });
});

/**
 * POST /api/auth/password-reset/:token  (PUBLIC)
 * body: { password }
 * מגדיר סיסמה חדשה דרך הקישור ומוחק את הטוקן (חד-פעמי).
 */
export const resetPassword = asyncHandler(async (req, res) => {
  const user = await findByResetToken(req.params.token);
  const password = String(req.body?.password || "");
  if (password.length < 6) {
    throw ApiError.badRequest("הסיסמה חייבת להכיל לפחות 6 תווים");
  }
  await user.setPassword(password);
  user.passwordReset = undefined; // הקישור נשרף עם השימוש
  await user.save();
  await recordLogin(req, user, "password-reset");
  res.json({ success: true, data: { username: user.username || "", name: user.name } });
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
  // חזרה לאפליקציה עם טוקן שמור = כניסה מעשית - נרשמת ביומן (מרוסן לחצי שעה)
  await recordResumeThrottled(req, real);
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
  // במצב "צפייה בתור" req.user הוא המשתמש המתחזה - אסור לשנות לו סיסמה בטעות.
  if (req.impersonator) {
    throw ApiError.forbidden('לא ניתן לשנות סיסמה במצב "צפייה בתור" - יש לחזור לזהות האמיתית');
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

/**
 * GET /api/auth/login-activity  (super-admin only, any environment)
 * מתי כל נציג/ה או מנהל (מלבד מנהל-העל עצמו) נכנס/ה למערכת: סיכום לכל משתמש
 * (כניסה אחרונה + מספר כניסות) + רשימת הכניסות האחרונות. הגישה מוגבלת ע"י
 * requireSuperAdmin בשכבת המסלול.
 */
export const loginActivity = asyncHandler(async (req, res) => {
  // מנהל-העל (עדן) לא מופיע ברשימה - היא מיועדת לראות אחרים.
  const supers = await User.find({ superAdmin: true }).select("_id").lean();
  const superIds = supers.map((u) => u._id);

  const users = await User.find({
    active: true,
    superAdmin: { $ne: true },
  })
    .select("name role")
    .lean();

  // סיכום לכל משתמש: כניסה אחרונה (מסך התחברות), נראה/תה לאחרונה (כל פעילות),
  // ומספר כניסות. resume = חזרה עם טוקן שמור, נספרת כ"נראה לאחרונה".
  const agg = await LoginEvent.aggregate([
    { $match: { user: { $nin: superIds } } },
    {
      $group: {
        _id: "$user",
        lastSeenAt: { $max: "$at" },
        lastLoginAt: {
          $max: { $cond: [{ $ne: ["$kind", "resume"] }, "$at", null] },
        },
        loginCount: {
          $sum: { $cond: [{ $ne: ["$kind", "resume"] }, 1, 0] },
        },
        seenCount: { $sum: 1 },
      },
    },
  ]);
  const byUser = new Map(agg.map((r) => [String(r._id), r]));

  const summary = users
    .map((u) => {
      const hit = byUser.get(String(u._id));
      return {
        userId: String(u._id),
        name: u.name,
        role: u.role,
        lastLoginAt: hit?.lastLoginAt || null,
        lastSeenAt: hit?.lastSeenAt || null,
        loginCount: hit?.loginCount || 0,
        seenCount: hit?.seenCount || 0,
      };
    })
    .sort((a, b) => {
      if (!a.lastSeenAt) return 1;
      if (!b.lastSeenAt) return -1;
      return new Date(b.lastSeenAt) - new Date(a.lastSeenAt);
    });

  const events = await LoginEvent.find({ user: { $nin: superIds } })
    .sort({ at: -1 })
    .limit(200)
    .lean();

  res.json({
    success: true,
    data: {
      summary,
      events: events.map((e) => ({
        id: String(e._id),
        userId: e.user ? String(e.user) : null,
        name: e.name,
        role: e.role,
        kind: e.kind || "login",
        at: e.at,
        ip: e.ip || "",
        userAgent: e.userAgent || "",
      })),
    },
  });
});
