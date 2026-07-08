import express from 'express';
import { protect, scopeToRep } from '../middleware/auth.js';
import * as ctrl from '../controllers/registrationController.js';

const router = express.Router();

router.use(protect); // כל המסלולים דורשים התחברות
router.use(scopeToRep); // נציגות רואות רק את הרישומים שלהן; מנהל רואה הכול

// list + filters
router.get('/', ctrl.list);
// חייבים — registrations with outstanding>0 (before /:id so it isn't captured as an id)
router.get('/debtors', ctrl.debtors);
router.get('/:id', ctrl.detail);

router.post('/', ctrl.create);
router.put('/:id', ctrl.update);

// money + checklist sub-actions
router.post('/:id/payments', ctrl.addPayment);
router.patch('/:id/checklist', ctrl.updateChecklist);

// installment plan (v1 legacy): confirm / un-confirm a single scheduled payment (✓)
router.patch('/:id/installments/:index/confirm', ctrl.confirmInstallment);
router.patch('/:id/installments/:index/unconfirm', ctrl.unconfirmInstallment);

// unified payment (v2): mark / unmark a payment as collected ("סמן כשולם")
router.patch('/:id/payments/:paymentId/pay', ctrl.markPaymentPaid);
router.patch('/:id/payments/:paymentId/unpay', ctrl.unmarkPaymentPaid);

router.delete('/:id', ctrl.remove);

export default router;
