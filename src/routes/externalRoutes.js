import express from "express";
import * as ctrl from "../controllers/externalController.js";
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

export default router;
