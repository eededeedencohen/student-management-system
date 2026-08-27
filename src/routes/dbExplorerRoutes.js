import express from "express";
import { protect, requireSuperAdmin } from "../middleware/auth.js";
import * as ctrl from "../controllers/dbExplorerController.js";

const router = express.Router();

// עמוד "מסד הנתונים" - מנהל-העל (עדן) בלבד, קריאה בלבד
router.use(protect, requireSuperAdmin);

router.get("/schema", ctrl.schema);
router.get("/:collection/records", ctrl.records);
router.get("/:collection/records/:id", ctrl.record);

export default router;
