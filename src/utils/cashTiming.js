/**
 * תזמון מזומן — מתי כסף שנגבה מהלקוח מגיע בפועל לחשבון העסק.
 *
 * חוק עסקי (הוגדר 13/07/2026): חיוב בכרטיס אשראי נסלק לחשבון ב-7 בחודש
 * העוקב לחיוב. עסקה שחויבה בפברואר ⇒ הכסף נכנס ב-7 במרץ. זה חל על כל
 * תשלום אשראי — גם חיוב עבר (ממתין לסליקה) וגם חיוב עתידי מתוזמן.
 * כל שאר האמצעים (הו"ק/העברה/מזומן) נחשבים נכנסים במועד התשלום עצמו.
 */

// יום הסליקה של חברת האשראי - קבוע. ה-7 הוא תמיד יום סליקת האשראי.
export const CREDIT_CLEARING_DAY = 7;

/** מועד הסליקה של חיוב אשראי: ה-7 בחודש שאחרי מועד החיוב (קבוע). */
export function creditClearingDate(chargeDate) {
  const d = new Date(chargeDate);
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, CREDIT_CLEARING_DAY),
  );
}

/** האם תשלום הוא חיוב אשראי (לפי method, עם נפילה ל-methodCategory). */
export function isCreditPayment(payment) {
  return (payment?.method || payment?.methodCategory || "") === "credit";
}

/**
 * מועד המזומן של תשלום בודד: מתי הכסף שלו נכנס (או ייכנס) לחשבון.
 * החיוב עצמו מעוגן ל-dueDate (גם תשלומים ששולמו נושאים dueDate בסכמה).
 * מחזיר null כשאין תאריך לעגן אליו.
 */
export function cashDateOf(payment, fallbackDate = null) {
  const charge = payment?.dueDate || fallbackDate;
  if (!charge) return null;
  return isCreditPayment(payment)
    ? creditClearingDate(charge)
    : new Date(charge);
}
