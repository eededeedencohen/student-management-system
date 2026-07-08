import express from 'express';
import { protect, scopeToRep } from '../middleware/auth.js';
import * as ctrl from '../controllers/leadController.js';

const router = express.Router();

router.use(protect); // all lead routes require auth
router.use(scopeToRep); // reps locked to their own leads via req.scopeRepId

router.get('/stats', ctrl.stats); // before '/:id' to avoid route shadowing
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

export default router;
