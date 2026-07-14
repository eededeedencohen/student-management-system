import express from 'express';
import { protect, scopeToRep } from '../middleware/auth.js';
import * as ctrl from '../controllers/commissionController.js';

const router = express.Router();

router.use(protect); // כל המסלולים דורשים התחברות
router.use(scopeToRep); // נציג רואה רק את עצמו; מנהל רואה הכל

router.get('/', ctrl.list);
router.get('/trend', ctrl.trend); // מגמת עסקאות חודש-מול-חודש (לפני /:repId!)
router.get('/:repId/breakdown', ctrl.breakdown); // פירוט הפרמיה לפי עסקאות (מודל)
router.get('/:repId', ctrl.detail);

export default router;
