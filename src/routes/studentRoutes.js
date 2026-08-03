import express from 'express';
import { protect, requireManager, scopeToRep } from '../middleware/auth.js';
import * as ctrl from '../controllers/studentController.js';

const router = express.Router();

router.use(protect); // כל המסלולים דורשים התחברות
router.use(scopeToRep); // נציגה רואה רק תלמידים מהעסקאות שלה, עם הכסף שלה בלבד

router.get('/', ctrl.list);
router.get('/:id', ctrl.getOne);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
// מחיקת תלמיד/ה גוררת מחיקת כל העסקאות - למנהלים בלבד
router.delete('/:id', requireManager, ctrl.remove);

export default router;
