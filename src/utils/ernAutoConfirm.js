import Registration from "../models/Registration.js";
import { applyDueErn, isErnPayment, shouldAutoConfirm } from "./ernRules.js";

export { applyDueErn, isErnPayment, shouldAutoConfirm };

/**
 * אישור אוטומטי לתשלומי הוראת קבע (ERN) שהגיע מועדם - הריצה התקופתית.
 *
 * החוק עצמו ב-utils/ernRules.js (owner rule 2026-08-27: רק הו"ק). אותו חוק נאכף גם
 * בכל שמירה של עסקה (pre-save במודל), כך שעסקה שנוצרת/נערכת עם הו"ק שמועדה כבר עבר
 * מסומנת מיד; הריצה כאן סוגרת את מה שהגיע מועדו מאז (רצה בעליית השרת + כל שעה,
 * server.js). הרצה ידנית: node src/scripts/ernAutoConfirm.js
 *
 * (עד 2026-08-27 האישור האוטומטי חל על כל אמצעי. מה שכבר סומן אז לא בוטל - נוגעים
 * רק בתשלומים פתוחים.)
 */
export async function autoConfirmDueErn(now = new Date()) {
  // סינון גס במסד (הו"ק פתוחה שמועדה עבר); ההכרעה הסופית ב-shouldAutoConfirm
  const regs = await Registration.find({
    payments: {
      $elemMatch: {
        paid: false,
        canceled: { $ne: true },
        noAutoConfirm: { $ne: true },
        dueDate: { $lte: now },
        $or: [
          { methodCategory: "ern" },
          { method: /^ern$|הו"ק|הו״ק|הוראת קבע/i },
        ],
      },
    },
  });

  let flipped = 0;
  const touched = [];
  for (const reg of regs) {
    const n = applyDueErn(reg, now);
    if (n > 0) {
      reg.recompute();
      await reg.save();
      flipped += n;
      touched.push(`${reg.externalId || reg._id} (${reg.studentName})`);
    }
  }
  return { flipped, deals: touched };
}
