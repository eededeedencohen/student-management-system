import express from "express";
import { protect, requireManager } from "../middleware/auth.js";
import * as ctrl from "../controllers/userController.js";

const router = express.Router();

router.use(protect); // כל הנתיבים דורשים התחברות

// GET /:id - protect בלבד; הבקרה אוכפת שנציג רואה רק את עצמו (אחרת forbidden)
router.get("/:id", ctrl.getOne);

// שאר הפעולות מותרות למנהל בלבד
router.get("/", requireManager, ctrl.list);
router.post("/", requireManager, ctrl.create);
router.put("/:id", requireManager, ctrl.update);
router.put("/:id/commission", requireManager, ctrl.updateCommission);
router.delete("/:id", requireManager, ctrl.remove);

export default router;
