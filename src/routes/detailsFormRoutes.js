import express from "express";
import { protect, requireFormsAccess } from "../middleware/auth.js";
import * as ctrl from "../controllers/detailsFormController.js";

/**
 * ניהול טפסי השלמת פרטים (עמוד "ניהול טפסים") - מנהלים + בעלת formsAccess
 * (מיכל). הצד הציבורי (צפייה בטופס והגשה) נמצא ב-externalRoutes תחת /api/public.
 */
const router = express.Router();

router.use(protect, requireFormsAccess);

router.get("/", ctrl.adminList);
router.post("/", ctrl.createForm);
// הצלבה של הגשה שלא זוהתה לסטודנט במאגר
router.get("/students", ctrl.searchStudents);
router.get("/students/:id", ctrl.studentForLink);
router.post("/submissions/:id/link", ctrl.linkSubmission);
router.post("/submissions/:id/unlink", ctrl.unlinkSubmission);
router.delete("/submissions/:id", ctrl.deleteSubmission);
router.delete("/:id", ctrl.deleteForm);

export default router;
