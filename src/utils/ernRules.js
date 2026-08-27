/**
 * חוק הוראת הקבע (ERN) - ללא תלות במודלים, כדי שגם המודל וגם הריצה התקופתית ישתמשו בו.
 *
 * owner rule 2026-08-27: רק הו"ק נגבית אוטומטית. הוראת קבע שמועדה עבר נחשבת שנגבתה
 * ביום החיוב גם בלי ✓ ידני (סומכים על ההוראה בבנק). כל אמצעי אחר (אשראי/העברה/מזומן)
 * נשאר פתוח עד סימון ידני.
 *
 * מתי לא מאשרים אוטומטית:
 *   - "הופסק" בהערה (הוראה שבוטלה בבנק)
 *   - noAutoConfirm (נציג/ה ביטל/ה ידנית סימון "שולם" = הכסף לא ירד; הזזת התאריך מחדשת)
 *   - canceled (בוטל במסגרת ביטול עסקה)
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

/** האם תשלום זה צריך להיות מסומן כנגבה אוטומטית נכון לרגע `now`. */
export function shouldAutoConfirm(p, now = new Date()) {
  if (!p || p.paid) return false;
  if (p.canceled) return false;
  if (p.noAutoConfirm) return false;
  if (!isErnPayment(p)) return false;
  if (!p.dueDate || new Date(p.dueDate) > now) return false;
  if (/הופסק/.test(p.note || "")) return false;
  return true;
}

export const AUTO_CONFIRM_STAMP = "אוטומטי - נגבה במועד שסוכם";

/**
 * מסמן במסמך (בלי שמירה) את כל תשלומי ההו"ק שמועדם עבר. מחזיר כמה סומנו.
 * הקורא אחראי ל-recompute() + save() כשהתוצאה גדולה מאפס.
 */
export function applyDueErn(reg, now = new Date()) {
  let flipped = 0;
  for (const p of reg?.payments || []) {
    if (!shouldAutoConfirm(p, now)) continue;
    p.paid = true;
    p.confirmedBy = undefined;
    p.confirmedByName = AUTO_CONFIRM_STAMP;
    p.confirmedAt = new Date(p.dueDate); // הכסף נכנס ביום שנקבע
    flipped += 1;
  }
  return flipped;
}
