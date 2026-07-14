import express from "express";
import * as ctrl from "../controllers/externalController.js";

/**
 * מסלולים ציבוריים (ללא התחברות) - הטופס החיצוני והחוזה הדיגיטלי.
 * המשטח מצומצם בכוונה; החוזה נגיש רק דרך token אקראי.
 */
const router = express.Router();

router.get("/form-options", ctrl.formOptions);
router.post("/deals", ctrl.createDeal);
router.get("/contract/:token", ctrl.getContract);
router.post("/contract/:token/sign", ctrl.signContract);
router.get("/contract/:token/status", ctrl.contractStatus);

export default router;
