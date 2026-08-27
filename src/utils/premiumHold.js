/**
 * "מצב מחמיר" בעמוד הפרמיות (owner rule 2026-08-27): תשלום שנגבה אינו נספר לפרמיה
 * כל עוד העניין לא הוסדר:
 *   contract - לעסקה יש חוזה מהמערכת (token) שטרם נחתם (status != "signed")
 *   receipt  - העברה בנקאית ששולמה בלי אסמכתא מלאה (תמונה + מספר), מחתך ההשקה 4/8/2026
 * עסקאות בלי רשומת חוזה בכלל (ייבוא מאקסל / עסקה מהירה - חוזה נייר מחוץ למערכת) אינן
 * מוחזקות. במצב רגיל הכל נספר כרגיל.
 *
 * הכלל קיים פעמיים - JS (breakdown) וביטויי אגרגציה (list/detail/trend); הבדיקה
 * verify-commission-strict.mjs מוודאת שהם מסכימים.
 */

export const RECEIPTS_LAUNCH = new Date("2026-08-04T00:00:00Z");
export const HOLD_HE = { contract: "חוזה לא נחתם", receipt: "חסרה אסמכתא" };

/** לעסקה יש חוזה מהמערכת שטרם נחתם. */
export function contractPending(deal) {
  const c = deal?.contract;
  return Boolean(c?.token) && c.status !== "signed";
}

export function isTransferPayment(p) {
  return p?.methodCategory === "transfer" || p?.method === "transfer";
}

/** העברה ששולמה בלי אסמכתא מלאה, ומועדה (או אישורה) אחרי חתך ההשקה. */
export function receiptMissing(p) {
  if (!p?.paid || !isTransferPayment(p)) return false;
  const full =
    Boolean(p.receiptImage) && Boolean(String(p.receiptReference || "").trim());
  if (full) return false;
  const anchor = Math.max(
    p.dueDate ? new Date(p.dueDate).getTime() : 0,
    p.confirmedAt ? new Date(p.confirmedAt).getTime() : 0,
  );
  return anchor >= RECEIPTS_LAUNCH.getTime();
}

/** null | "contract" | "receipt" - למה התשלום מוחזק במצב מחמיר. */
export function holdReasonOf(p, deal) {
  if (!p?.paid || p.canceled) return null;
  if (contractPending(deal)) return "contract";
  if (receiptMissing(p)) return "receipt";
  return null;
}

/**
 * רמת העסקה (owner 2026-08-27: "המכירות לא נחשבות אם הן מוחזקות או לא מאושרות"):
 * עסקה מוחזקת = החוזה שלה ממתין, או שיש בה העברה ששולמה בלי אסמכתא. במצב מחמיר היא
 * לא נספרת במכירות/עסקאות/יתרה של התקופה, כך שהיחס שכר/הכנסה מחושב על אותו בסיס.
 */
export function dealHoldReason(deal) {
  if (contractPending(deal)) return "contract";
  if ((deal?.payments || []).some((p) => !p.canceled && receiptMissing(p)))
    return "receipt";
  return null;
}

// --- אותו כלל כביטויי אגרגציה ------------------------------------------------
const EPOCH = new Date(0);
export const CONTRACT_PENDING_EXPR = {
  $and: [
    { $gt: [{ $strLenCP: { $ifNull: ["$contract.token", ""] } }, 0] },
    { $ne: ["$contract.status", "signed"] },
  ],
};
/** ביטוי "העברה בלי אסמכתא" לתשלום שנתיב השדות שלו מתחיל ב-P ("$payments." אחרי $unwind, "$$p." בתוך $map). */
const receiptMissingExpr = (P) => ({
  $and: [
    { $eq: [`${P}paid`, true] },
    {
      $or: [
        { $eq: [`${P}methodCategory`, "transfer"] },
        { $eq: [`${P}method`, "transfer"] },
      ],
    },
    {
      $not: [
        {
          $and: [
            { $eq: [`${P}receiptImage`, true] },
            {
              $gt: [
                {
                  $strLenCP: {
                    $trim: { input: { $ifNull: [`${P}receiptReference`, ""] } },
                  },
                },
                0,
              ],
            },
          ],
        },
      ],
    },
    {
      $gte: [
        {
          $max: [
            { $ifNull: [`${P}dueDate`, EPOCH] },
            { $ifNull: [`${P}confirmedAt`, EPOCH] },
          ],
        },
        RECEIPTS_LAUNCH,
      ],
    },
  ],
});
export const RECEIPT_MISSING_EXPR = receiptMissingExpr("$payments.");
/** רמת העסקה (לפני $unwind): חוזה ממתין או תשלום כלשהו שהוא העברה בלי אסמכתא. */
export const DEAL_HELD_EXPR = {
  $or: [
    CONTRACT_PENDING_EXPR,
    {
      $anyElementTrue: [
        {
          $map: {
            input: { $ifNull: ["$payments", []] },
            as: "p",
            in: {
              $and: [{ $ne: ["$$p.canceled", true] }, receiptMissingExpr("$$p.")],
            },
          },
        },
      ],
    },
  ],
};
const PAID_LIVE = {
  $and: [
    { $eq: ["$payments.paid", true] },
    { $ne: ["$payments.canceled", true] },
  ],
};
export const HELD_CONTRACT_EXPR = { $and: [PAID_LIVE, CONTRACT_PENDING_EXPR] };
export const HELD_RECEIPT_EXPR = {
  $and: [PAID_LIVE, { $not: [CONTRACT_PENDING_EXPR] }, RECEIPT_MISSING_EXPR],
};
export const HELD_EXPR = { $or: [HELD_CONTRACT_EXPR, HELD_RECEIPT_EXPR] };
