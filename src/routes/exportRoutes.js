import express from 'express';
import { protect, scopeToRep } from '../middleware/auth.js';
import * as ctrl from '../controllers/exportController.js';

const router = express.Router();

// כל נתיבי הייצוא דורשים התחברות; נציגות מוגבלות לנתונים שלהן (scopeToRep).
router.use(protect);
router.use(scopeToRep);

router.get('/registrations.xlsx', ctrl.exportRegistrations);
router.get('/debtors.xlsx', ctrl.exportDebtors);
router.get('/course/:id/roster.xlsx', ctrl.exportCourseRoster);
router.get('/by-month.xlsx', ctrl.exportByMonth);

export default router;
