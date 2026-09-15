import express from "express";
import { protect, requireManager } from "../middleware/auth.js";
import * as ctrl from "../controllers/certificateController.js";

/**
 * מחוללי התעודות - מנהל בלבד (יקיר/עדן), כמו שאר הקטלוג.
 * הנכסים מוגשים מכאן ולא מ-server/public כי הריפו ציבורי.
 */
const router = express.Router();

router.use(protect, requireManager);

router.get("/manifest", ctrl.manifest);
router.get("/assets/:sha", ctrl.asset);

router.get("/roster/:cohortId", ctrl.roster);

router.get("/batch/:cohortId/:generator", ctrl.getBatch);
router.put("/batch/:cohortId/:generator", ctrl.saveBatch);

router.get("/signatures", ctrl.listSignatures);
router.get("/signatures/:id/image", ctrl.signatureImage);
router.post("/signatures", ctrl.saveSignature);
router.delete("/signatures/:id", ctrl.deleteSignature);

export default router;
