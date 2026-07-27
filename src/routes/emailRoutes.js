import express from 'express';
import { protect, requireSuperAdmin } from '../middleware/auth.js';
import * as ctrl from '../controllers/emailController.js';

const router = express.Router();

// The OAuth callback is a top-level browser redirect from Google — it carries no
// Bearer token, so it is authenticated by the signed `state` inside the controller
// (verifyOAuthState), NOT by `protect`. It MUST stay before the router-wide protect.
router.get('/oauth/callback', ctrl.oauthCallback);

// Everything else is for the super-admin (עדן) only.
router.use(protect, requireSuperAdmin);

router.get('/status', ctrl.status);
router.get('/oauth/url', ctrl.oauthUrl);
router.post('/disconnect', ctrl.disconnect);
router.get('/recipients', ctrl.recipients);
router.post('/send', ctrl.send);

// חוזים חתומים: רשימה + שליחה חוזרת של עותק ה-PDF (מנהל-העל)
router.get('/signed-contracts', ctrl.signedContracts);
router.post('/signed-contracts/resend', ctrl.resendSignedContracts);

export default router;
