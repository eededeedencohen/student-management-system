import express from "express";
import { protect, requireManager, scopeToRep } from "../middleware/auth.js";
import * as ctrl from "../controllers/goalController.js";

const router = express.Router();

router.use(protect); // כל המסלולים דורשים התחברות

// progress קודם ל-/:id כדי שלא ייקלט כפרמטר
router.get("/progress", scopeToRep, ctrl.progress);

router.get("/", scopeToRep, ctrl.list);
router.get("/:id", scopeToRep, ctrl.getOne);

// יצירה/עדכון/מחיקה - מנהל בלבד
router.post("/", requireManager, ctrl.create);
router.put("/:id", requireManager, ctrl.update);
router.delete("/:id", requireManager, ctrl.remove);

export default router;
