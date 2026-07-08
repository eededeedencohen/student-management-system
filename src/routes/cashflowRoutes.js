import express from 'express';
import { protect, requireManager } from '../middleware/auth.js';
import * as ctrl from '../controllers/cashflowController.js';

const router = express.Router();

// כל מסלולי תזרים המזומנים דורשים התחברות + הרשאת מנהל
router.use(protect);
router.use(requireManager);

router.get('/forecast', ctrl.forecast);

export default router;
