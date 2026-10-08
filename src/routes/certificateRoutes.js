import express from "express";
import { protect, requireManager, requireTracksAccess } from "../middleware/auth.js";
import * as ctrl from "../controllers/certificateController.js";

/**
 * מחוללי התעודות - מנהל בלבד (יקיר/עדן), כמו שאר הקטלוג.
 * הנכסים מוגשים מכאן ולא מ-server/public כי הריפו ציבורי.
 * חריג: עמוד "מגמות מקצועיות" (רשימת הנרשמים + שמירת המגמות) פתוח גם לבעלת
 * tracksAccess (מיכל) - לכן שני הנתיבים האלה יושבים לפני שער המנהל.
 */
const router = express.Router();

router.use(protect);

router.get("/roster/:cohortId", requireTracksAccess, ctrl.roster);
router.put("/tracks/:cohortId", requireTracksAccess, ctrl.saveTracks);

router.use(requireManager);

router.get("/manifest", ctrl.manifest);
router.get("/assets/:sha", ctrl.asset);

router.get("/batch/:cohortId/:generator", ctrl.getBatch);
router.put("/batch/:cohortId/:generator", ctrl.saveBatch);

router.get("/signatures", ctrl.listSignatures);
router.get("/signatures/:id/image", ctrl.signatureImage);
router.post("/signatures", ctrl.saveSignature);
router.delete("/signatures/:id", ctrl.deleteSignature);

export default router;
