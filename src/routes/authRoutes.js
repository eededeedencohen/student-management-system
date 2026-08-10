import express from "express";
import { protect, requireSuperAdmin } from "../middleware/auth.js";
import { rateLimit } from "../utils/rateLimit.js";
import * as ctrl from "../controllers/authController.js";

const router = express.Router();

// אין router.use(protect) גלובלי - login הוא פומבי.
router.get("/users", ctrl.loginOptions); // PUBLIC - משמש את "צפייה בתור" (הרשימה עצמה מזערית)
router.post("/login-as", ctrl.loginAs); // RETIRED - מחזיר הסבר שהכניסה דורשת סיסמה
router.post("/login", rateLimit({ windowMs: 10 * 60_000, max: 60, key: "login" }), ctrl.login); // PUBLIC
// עמוד איפוס/הגדרת סיסמה דרך קישור חד-פעמי (PUBLIC, מוגבל בקצב)
router.get("/password-reset/:token", ctrl.resetInfo);
router.post(
  "/password-reset/:token",
  rateLimit({ windowMs: 10 * 60_000, max: 30, key: "pwreset" }),
  ctrl.resetPassword,
);

// המסלולים הבאים דורשים אימות.
router.get("/me", protect, ctrl.me);
router.post("/change-password", protect, ctrl.changePassword);
// פעילות התחברות - מנהל-העל (עדן) בלבד, בכל סביבה (גם בענן).
router.get("/login-activity", protect, requireSuperAdmin, ctrl.loginActivity);

export default router;
