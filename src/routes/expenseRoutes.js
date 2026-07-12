import express from "express";
import { protect, requireManager } from "../middleware/auth.js";
import * as ctrl from "../controllers/expenseController.js";

const router = express.Router();

router.use(protect); // כל המסלולים דורשים אימות

// צפייה פתוחה לכל משתמש מאומת
router.get("/", ctrl.list);

// יצירה/עדכון/מחיקה - למנהל בלבד
router.post("/", requireManager, ctrl.create);
router.put("/:id", requireManager, ctrl.update);
router.delete("/:id", requireManager, ctrl.remove);

export default router;
