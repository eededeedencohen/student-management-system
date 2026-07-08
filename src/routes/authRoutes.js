import express from 'express';
import { protect } from '../middleware/auth.js';
import * as ctrl from '../controllers/authController.js';

const router = express.Router();

// אין router.use(protect) גלובלי — login ורשימת המשתמשים לבחירה הם פומביים.
router.get('/users', ctrl.loginOptions); // PUBLIC — for the login picker
router.post('/login-as', ctrl.loginAs); // PUBLIC — passwordless pick-a-user sign-in
router.post('/login', ctrl.login); // PUBLIC

// המסלולים הבאים דורשים אימות.
router.get('/me', protect, ctrl.me);
router.post('/change-password', protect, ctrl.changePassword);

export default router;
