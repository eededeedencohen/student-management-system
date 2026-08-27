/**
 * מועד הגבייה של תשלום - הכלל האחיד לכל "נגבה בתקופה" (דשבורד, פרמיות):
 * החיוב מעוגן ל-dueDate (גם תשלומים ששולמו נושאים dueDate; ERN אוטומטי מקבל
 * confirmedAt=dueDate), עם נפילה לתאריך legacy, לאישור הידני, ולבסוף לתאריך העסקה.
 * owner rule 2026-08-26: "השכר מורכב מהתשלומים שנגבו באותו החודש" - וכך גם "נגבה" בדשבורד.
 */

/** ביטוי אגרגציה - אחרי $unwind של payments. */
export const COLLECTED_AT = {
  $ifNull: [
    "$payments.dueDate",
    { $ifNull: ["$payments.date", { $ifNull: ["$payments.confirmedAt", "$dealDate"] }] },
  ],
};

/** אותו כלל ב-JS. */
export const collectedAtOf = (p, reg) =>
  p.dueDate || p.date || p.confirmedAt || reg?.dealDate || null;

/** שלבי אגרגציה משותפים: פריסת התשלומים שנגבו (שולמו, לא בוטלו) עם מועד הגבייה. */
export const COLLECTED_PAYMENT_STAGES = [
  { $unwind: "$payments" },
  { $match: { "payments.paid": true, "payments.canceled": { $ne: true } } },
  { $addFields: { collectedAt: COLLECTED_AT } },
];
