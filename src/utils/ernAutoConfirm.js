import Registration from "../models/Registration.js";

/**
 * אישור אוטומטי לתשלומי הוראת קבע (ERN) שהגיע מועדם.
 *
 * חוק עסקי (הבעלים, 2026-08-27): רק הו"ק נגבית אוטומטית - ברגע שיש הוראת קבע הכסף יורד
 * ביום החיוב גם בלי ✓ ידני. כל תשלום עתידי אחר (חיוב אשראי מתוזמן, העברה שהובטחה
 * לתאריך, מזומן) נשאר פתוח עד שנציג/ה מסמן/ת אותו ידנית כשהכסף נכנס; בדשבורד הוא
 * מופיע בקבוצה "לאשר גבייה" אחרי שמועדו עבר.
 * (עד 2026-08-27 האישור האוטומטי חל על כל אמצעי. מה שכבר סומן אז לא בוטל - הפונקציה
 * נוגעת רק בתשלומים פתוחים.)
 *
 * חריג: הוראה שהופסקה (ההערה מכילה "הופסק") - נשארת פתוחה לטיפול ידני.
 * תיקון ידני תמיד אפשרי דרך "בטל" בעמוד הסטודנט.
 *
 * רץ בעליית השרת + פעם ביום (server.js), והרצה ידנית:
 *   node src/scripts/ernAutoConfirm.js
 */

/** האם התשלום הוא הוראת קבע - לפי הקטגוריה (v2), ולחלופין לפי טקסט האמצעי הגולמי. */
export function isErnPayment(p) {
  const category = String(p?.methodCategory || "").toLowerCase();
  const method = String(p?.method || "");
  return (
    category === "ern" ||
    /^ern$/i.test(method.trim()) ||
    /הו"ק|הו״ק|הוראת קבע/.test(method)
  );
}

export async function autoConfirmDueErn(now = new Date()) {
  const regs = await Registration.find({
    payments: { $elemMatch: { paid: false, dueDate: { $lte: now } } },
  });

  let flipped = 0;
  const touched = [];
  for (const reg of regs) {
    let changed = false;
    for (const p of reg.payments) {
      if (p.paid) continue;
      if (p.canceled) continue; // בוטל בביטול עסקה - לא גובים
      if (!isErnPayment(p)) continue; // רק הו"ק נגבית אוטומטית; השאר מאושרים ידנית
      if (!p.dueDate || new Date(p.dueDate) > now) continue;
      if (/הופסק/.test(p.note || "")) continue; // הוראה שהופסקה - לא נכנס כסף
      p.paid = true;
      p.confirmedByName = "אוטומטי - נגבה במועד שסוכם";
      p.confirmedAt = new Date(p.dueDate); // הכסף נכנס ביום שנקבע
      changed = true;
      flipped += 1;
    }
    if (changed) {
      reg.recompute();
      await reg.save();
      touched.push(`${reg.externalId || reg._id} (${reg.studentName})`);
    }
  }
  return { flipped, deals: touched };
}
