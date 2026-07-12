/**
 * materializeNotedPlans.js - "אם נקבע שכל חודש יעביר X, זה מה שיהיה":
 * הופך תוכניות תשלום שתועדו רק כהערה (בנתוני האקסלים) לתשלומים עתידיים מתוזמנים,
 * כך שייכנסו לתחזית התזרים החודשית ויאושרו אוטומטית במועדם.
 *
 * כללי הכללה (שמרניים):
 *   ✓ תוכנית מפורשת עם סכום/תדירות/יום ("4 חיובים של 1,500 כל 10 לחודש")
 *   ✓ הבטחה חד-פעמית עם תאריך עתידי/נוכחי ("היתרה בהעברה ב-12.7.26")
 *   ✗ הבטחת-עבר שלא קוימה ("ב-10.4 להסדיר" ואין תיעוד) - נשארת חוב פתוח לבירור
 *   ✗ אין תוכנית בכלל - נשאר במאגר "ללא מועד ודאי"
 *
 * אידמפוטנטי (מזוהה לפי source ייחודי). הרצה:  node src/scripts/materializeNotedPlans.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
const { connectDB, disconnectDB } = await import("../config/db.js");
const { default: Registration } = await import("../models/Registration.js");

const SRC = "הופרס אוטומטית מהתוכנית שתועדה בהערה";

/** התוכניות, כפי שנכתבו בהערות המקור - נאמנות למילה של הסטודנטים. */
const PLANS = [
  {
    ext: "D1294-1",
    who: "שני שמואלי אוחנה",
    method: "credit",
    note: "8 תשלומים של 1,000 בכ.א. כל 16 לחודש",
    items: [
      ["2026-07-16", 1000],
      ["2026-08-16", 1000],
      ["2026-09-16", 1000],
      ["2026-10-16", 1000],
      ["2026-11-16", 1000],
      ["2026-12-16", 1000],
      ["2027-01-16", 1000],
      ["2027-02-16", 1300],
    ],
  },
  {
    ext: "D1324-1",
    who: "טוהר אלימלך",
    method: "credit",
    note: "4 חיובים של 1,500 כל 10 לחודש",
    items: [
      ["2026-08-10", 1500],
      ["2026-09-10", 1500],
      ["2026-10-10", 1500],
      ["2026-11-10", 1500],
    ],
  },
  {
    ext: "D1183-2",
    who: "שירה גולדברט",
    method: "credit",
    note: "היתרה ב-3 תשלומים חודשיים (נותרו 2)",
    items: [
      ["2026-08-05", 493],
      ["2026-09-05", 494],
    ],
  },
  {
    ext: "D1238-2",
    who: "הדר בר אור · ייעוץ זוגי",
    method: "transfer",
    note: "10 תשלומים של 590 ₪ בהעברה (נותרו 7)",
    items: [
      ["2026-07-28", 590],
      ["2026-08-28", 590],
      ["2026-09-28", 590],
      ["2026-10-28", 590],
      ["2026-11-28", 590],
      ["2026-12-28", 590],
      ["2027-01-28", 590],
    ],
  },
  {
    ext: "D1238-1",
    who: "הדר בר אור · הדרכת הורים",
    method: "transfer",
    note: "העברה אחרונה של 590 (כל 28 לחודש)",
    items: [["2026-07-28", 590]],
  },
  {
    ext: "D1325-1",
    who: "קורל דואני",
    method: "transfer",
    note: "היתרה בהעברה ב-12.7.26",
    items: [["2026-07-12", 6320]],
  },
  {
    ext: "D1187-2",
    who: "דקלה יהודה",
    method: "credit",
    note: "היתרה (1,240) בעוד חודש",
    items: [["2026-07-16", 1240]],
  },
  {
    ext: "D1321-1",
    who: "ניצן נויה נעים",
    method: "credit",
    note: "היתרה בסוף אוגוסט",
    items: [["2026-08-31", 5150]],
  },
];

await connectDB();
let created = 0;
for (const plan of PLANS) {
  const reg = await Registration.findOne({ externalId: plan.ext });
  if (!reg) {
    console.log(`✗ ${plan.ext} לא נמצאה`);
    continue;
  }
  if (reg.payments.some((p) => p.source === SRC)) {
    console.log(`= ${plan.ext} (${plan.who}): כבר הופרס`);
    continue;
  }

  const scheduled = reg.payments
    .filter((p) => !p.paid)
    .reduce((a, p) => a + p.amount, 0);
  const remainder = reg.outstanding - scheduled;
  const planSum = plan.items.reduce((a, [, amt]) => a + amt, 0);
  if (Math.abs(planSum - remainder) > 1) {
    console.log(
      `✗ ${plan.ext} (${plan.who}): התוכנית (₪${planSum}) ≠ היתרה הלא-מתוזמנת (₪${remainder}) - דילוג`,
    );
    continue;
  }

  for (const [date, amount] of plan.items) {
    reg.payments.push({
      type: "installment",
      amount,
      method: plan.method,
      methodCategory: plan.method,
      dueDate: new Date(date),
      paid: false,
      note: `לפי התוכנית שסוכמה: ${plan.note}`,
      source: SRC,
    });
  }
  reg.reconciled = true;
  reg.reconcileNote = undefined;
  reg.nextPaymentNote = plan.note;
  reg.noteEntries.push({
    text: `התוכנית שבהערה הופרסה לתשלומים מתוזמנים (${plan.items.length} תשלומים, ₪${planSum.toLocaleString()})`,
    date: new Date("2026-07-12"),
    byName: "אוטומטי",
  });
  reg.recompute();
  await reg.save();
  created += plan.items.length;
  console.log(
    `✓ ${plan.ext} (${plan.who}): ${plan.items.length} תשלומים · ₪${planSum.toLocaleString()} · ${plan.items[0][0]} → ${plan.items[plan.items.length - 1][0]}`,
  );
}
console.log(`\nסה"כ נוצרו ${created} תשלומים מתוזמנים מתוך תוכניות מתועדות.`);
await disconnectDB();
process.exit(0);
