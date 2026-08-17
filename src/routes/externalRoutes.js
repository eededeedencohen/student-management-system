import express from "express";
import * as ctrl from "../controllers/externalController.js";
import {
  publicQuotePdf,
  publicQuoteView,
} from "../controllers/quoteController.js";
import {
  publicFormInfo,
  publicFormSubmit,
} from "../controllers/detailsFormController.js";
import { rateLimit } from "../utils/rateLimit.js";

/**
 * מסלולים ציבוריים (ללא התחברות) - הטופס החיצוני והחוזה הדיגיטלי.
 * המשטח מצומצם בכוונה; החוזה נגיש רק דרך token אקראי. הפעולות המשנות מוגבלות
 * בקצב לפי IP כדי לצמצם ניצול לרעה (הן ציבוריות ומפעילות שליחת מייל דרך Gmail).
 */
const router = express.Router();

router.get("/form-options", ctrl.formOptions);
router.post("/deals", rateLimit({ windowMs: 10 * 60_000, max: 40, key: "deals" }), ctrl.createDeal);
router.get("/contract/:token", ctrl.getContract);
router.post("/contract/:token/sign", rateLimit({ windowMs: 10 * 60_000, max: 60, key: "sign" }), ctrl.signContract);
router.post(
  "/contract/:token/email",
  rateLimit({ windowMs: 60 * 60_000, max: 30, key: "cemail" }),
  ctrl.emailSignedContract,
);
router.get("/contract/:token/status", ctrl.contractStatus);
router.get("/contract/:token/pdf", ctrl.downloadSignedContractPdf); // הורדת העותק החתום ע"י החותם
router.get("/quote-pdf/:token", publicQuotePdf); // קובץ ה-PDF של הצעת מחיר (תצוגה/הורדה)
router.get("/quote/:token", publicQuoteView); // נתוני ההצעה לעמוד התצוגה הציבורי
// טופס השלמת פרטים אישיים לנרשמי מחזור (עמוד "ניהול טפסים")
router.get("/details-form/:token", publicFormInfo);
router.post(
  "/details-form/:token",
  rateLimit({ windowMs: 10 * 60_000, max: 60, key: "detailsform" }),
  publicFormSubmit,
);

export default router;
