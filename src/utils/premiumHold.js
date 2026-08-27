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

// --- אותו כלל כביטויי אגרגציה: אחרי { $unwind: "$payments" } ---------------
const EPOCH = new Date(0);
export const CONTRACT_PENDING_EXPR = {
  $and: [
    { $gt: [{ $strLenCP: { $ifNull: ["$contract.token", ""] } }, 0] },
    { $ne: ["$contract.status", "signed"] },
  ],
};
export const RECEIPT_MISSING_EXPR = {
  $and: [
    { $eq: ["$payments.paid", true] },
    {
      $or: [
        { $eq: ["$payments.methodCategory", "transfer"] },
        { $eq: ["$payments.method", "transfer"] },
      ],
    },
    {
      $not: [
        {
          $and: [
            { $eq: ["$payments.receiptImage", true] },
            {
              $gt: [
                {
                  $strLenCP: {
                    $trim: {
                      input: { $ifNull: ["$payments.receiptReference", ""] },
                    },
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
            { $ifNull: ["$payments.dueDate", EPOCH] },
            { $ifNull: ["$payments.confirmedAt", EPOCH] },
          ],
        },
        RECEIPTS_LAUNCH,
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
