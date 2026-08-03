import express from "express";
import { protect, requireManager } from "../middleware/auth.js";
import * as ctrl from "../controllers/expenseController.js";

const router = express.Router();

router.use(protect); // כל המסלולים דורשים אימות

// הוצאות = נתוני הנהלה (סכומים, קטגוריות) — גם הצפייה למנהל בלבד.
// עמוד התזרים שמשתמש בהן הוא ממילא managerOnly בקליינט.
router.get("/", requireManager, ctrl.list);

// יצירה/עדכון/מחיקה - למנהל בלבד
router.post("/", requireManager, ctrl.create);
router.put("/:id", requireManager, ctrl.update);
router.delete("/:id", requireManager, ctrl.remove);

export default router;
