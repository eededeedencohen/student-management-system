import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/dataReviewController.js';

/**
 * "עריכת נתונים" — כל נציגה מתקנת את הנתונים הישנים שלה. ההיקף (rep scope) נאכף
 * בקונטרולר לפי req.user.role, כך שנציגה רואה ומעדכנת רק את העסקאות שלה.
 */
const router = express.Router();

router.use(protect);

router.get('/deals', ctrl.listDeals);
router.get('/cohorts', ctrl.listCohortOptions);
router.get('/deals/:id/source', ctrl.dealSource);
router.get('/deals/:id', ctrl.getDeal); // רענון כרטיס בודד אחרי שמירה
router.put('/students/:id', ctrl.updateStudent);
router.put('/deals/:id/payments', ctrl.updatePayments);
router.put('/deals/:id/cohort', ctrl.assignCohort);
router.post('/deals/:id/approve', ctrl.approveDeal);

export default router;
