import express from 'express';
import { protect, scopeToRep } from '../middleware/auth.js';
import * as ctrl from '../controllers/dashboardController.js';

const router = express.Router();

// כל מסכי הדאשבורד דורשים התחברות + סקופ לנציג (נציג רואה רק את עצמו)
router.use(protect);
router.use(scopeToRep);

router.get('/summary', ctrl.summary);
router.get('/timeseries', ctrl.timeseries);
router.get('/reps', ctrl.reps);

export default router;
