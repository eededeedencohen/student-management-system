import express from 'express';
import { protect, requireManager } from '../middleware/auth.js';
import * as ctrl from '../controllers/courseController.js';
import { coursesOverview } from '../controllers/catalogController.js';

const router = express.Router();

router.use(protect); // כל המסלולים דורשים התחברות

router.get('/', ctrl.list);
router.get('/gantt', ctrl.gantt);
// עמוד "קורסים": מרצים/קורסים/מחזורים כמו בקטלוג (לנציגה - כסף שלה בלבד)
router.get('/overview', coursesOverview);
router.get('/:id', ctrl.get);

router.post('/', requireManager, ctrl.create);
router.put('/:id', requireManager, ctrl.update);
router.delete('/:id', requireManager, ctrl.remove);

export default router;
