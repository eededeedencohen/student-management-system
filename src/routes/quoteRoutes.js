import express from "express";
import { protect, scopeToRep } from "../middleware/auth.js";
import * as ctrl from "../controllers/quoteController.js";

const router = express.Router();

router.use(protect); // כל משתמש מחובר - גם נציגות
router.use(scopeToRep); // נציגה רואה/מנהלת רק את ההצעות שלה

// טמפלטים - לפני /:id כדי ש"templates" לא ייתפס כמזהה
router.get("/templates", ctrl.listTemplates);
router.post("/templates", ctrl.createTemplate);
router.delete("/templates/:id", ctrl.removeTemplate);

router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.put("/:id", ctrl.update);
router.patch("/:id/status", ctrl.setStatus);
router.post("/:id/pdf", ctrl.uploadQuotePdf); // עותק PDF לשליחה בוואטסאפ
router.delete("/:id", ctrl.remove);

export default router;
