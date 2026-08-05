import express from "express";
import { protect, requireManager } from "../middleware/auth.js";
import * as ctrl from "../controllers/catalogController.js";

/**
 * קטלוג הקורסים (יקיר): מרצים, קורסים קטלוגיים ומחזורי קורס. מנהל בלבד.
 * הקריאות של רשימות זמינות גם לנציגות (לצורך שיוך מחזור בעמוד עריכת הנתונים)
 * דרך /api/data-review/cohorts - כאן הכול מנהלי.
 */
const router = express.Router();

router.use(protect, requireManager);

// מרצים
router.get("/teachers", ctrl.listTeachers);
router.post("/teachers", ctrl.createTeacher);
router.put("/teachers/:id", ctrl.updateTeacher);
router.delete("/teachers/:id", ctrl.deleteTeacher);

// קורסים קטלוגיים
router.get("/courses", ctrl.listCatalogCourses);
router.post("/courses", ctrl.createCatalogCourse);
router.put("/courses/:id", ctrl.updateCatalogCourse);
router.delete("/courses/:id", ctrl.deleteCatalogCourse);

// מחזורי קורס
router.get("/cohorts", ctrl.listCohorts);
router.post("/cohorts", ctrl.createCohort);
router.put("/cohorts/:id", ctrl.updateCohort);
router.delete("/cohorts/:id", ctrl.deleteCohort);

// רשומות האקסל של יקיר (למיפוי)
router.get("/source-courses", ctrl.listSourceCourses);
router.get("/source-courses/:id/source", ctrl.sourceCourseStyled);

export default router;
