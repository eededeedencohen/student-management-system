import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/studentController.js';

const router = express.Router();

router.use(protect); // כל המסלולים דורשים התחברות

router.get('/', ctrl.list);
router.get('/:id', ctrl.getOne);
router.post('/', ctrl.create);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);

export default router;
