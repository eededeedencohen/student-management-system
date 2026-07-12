/**
 * applyJulyUpdate.js - דלתא מהקבצים המעודכנים (יולי 2026):
 *   "מיכל - פרטי מרשמים.xlsx" (שורות 496-507) + "מורן פרטי נרשמים.xlsx" (עדכוני יולי).
 * מיושם על המסד שנבנה מ-students.json, לפי חוקי התשלומים:
 *   אשראי = כל הכסף מיד · ERN לפי לוח · "סיימה לשלם" עם פער = writeOff.
 *
 * אידמפוטנטי: כל שינוי מזוהה לפי source-label ייחודי / externalId - ריצה חוזרת לא תכפיל.
 *   node src/scripts/applyJulyUpdate.js
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { connectDB, disconnectDB } = await import("../config/db.js");
const { default: Registration } = await import("../models/Registration.js");
const { default: Student } = await import("../models/Student.js");
const { default: Course } = await import("../models/Course.js");
const { default: User } = await import("../models/User.js");
const { default: SourceRef } = await import("../models/SourceRef.js");
const { splitName } = await import("../utils/normalize.js");

const MICHAL_F = "מיכל - פרטי מרשמים.xlsx";
const MORAN_F = "מורן פרטי נרשמים.xlsx";
const src = (f, row) => `${f} שורה ${row}`;

await connectDB();
const michal = await User.findOne({ name: "מיכל פרייס" }).lean();
const moran = await User.findOne({ name: "מורן" }).lean();
const courseByName = new Map(
  (await Course.find({}).lean()).map((c) => [c.name, c]),
);
const C = (name) => {
  const c = courseByName.get(name);
  if (!c) throw new Error(`קורס לא נמצא: ${name}`);
  return c;
};

const log = [];
const addMonthsClamped = (iso, i) => {
  const b = new Date(iso);
  const last = new Date(
    Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + i + 1, 0),
  ).getUTCDate();
  return new Date(
    Date.UTC(
      b.getUTCFullYear(),
      b.getUTCMonth() + i,
      Math.min(b.getUTCDate(), last),
    ),
  );
};

/** הוספת תשלום לעסקה קיימת (מדלג אם ה-source כבר קיים). */
async function addPayment(externalId, p, expect) {
  const reg = await Registration.findOne({ externalId });
  if (!reg) throw new Error(`עסקה לא נמצאה: ${externalId}`);
  if (reg.payments.some((x) => x.source === p.source))
    return log.push(`= ${externalId}: תשלום ${p.source} כבר קיים`);
  reg.payments.push({ methodCategory: p.method, paid: true, ...p });
  if (p.writeOffAfter) {
    reg.writeOff = (reg.writeOff || 0) + p.writeOffAfter.amount;
    reg.noteEntries.push({
      text: p.writeOffAfter.note,
      date: p.dueDate,
      byName: "עדכון יולי 2026",
    });
  }
  if (p.nextNote !== undefined) reg.nextPaymentNote = p.nextNote;
  reg.recompute();
  await reg.save();
  await SourceRef.create({
    deal: reg._id,
    payment: reg.payments[reg.payments.length - 1]._id,
    kind: "payment",
    sourceFile: p.sourceFile,
    sourceRow: p.sourceRow,
  });
  if (
    expect &&
    (Math.abs(reg.totalPaid - expect.paid) > 1 ||
      Math.abs(reg.outstanding - expect.out) > 1)
  ) {
    throw new Error(
      `${externalId}: אחרי העדכון paid=${reg.totalPaid}/out=${reg.outstanding}, ציפיתי ${expect.paid}/${expect.out}`,
    );
  }
  log.push(
    `✓ ${externalId} (${reg.studentName}): +₪${p.amount} → paid=${reg.totalPaid} out=${reg.outstanding}${reg.writeOff ? " wo=" + reg.writeOff : ""} [${reg.paymentStatus}]`,
  );
}

/** סימון תשלום ERN קיים כשולם לפי רישום הנציגה (מדלג אם כבר שולם). */
async function confirmErn(externalId, label, fileRow) {
  const reg = await Registration.findOne({ externalId });
  if (!reg) throw new Error(`עסקה לא נמצאה: ${externalId}`);
  const p = reg.payments.find(
    (x) => x.method === "ern" && (x.note || "").includes(label),
  );
  if (!p) throw new Error(`${externalId}: לא נמצא תשלום ${label}`);
  if (p.paid) return log.push(`= ${externalId}: ${label} כבר מסומן שולם`);
  p.paid = true;
  p.confirmedByName = "מיכל (רישום מקור)";
  p.confirmedAt = new Date();
  p.source = `${p.source || ""} · אושר: ${src(MICHAL_F, fileRow)}`.replace(
    /^ · /,
    "",
  );
  reg.recompute();
  await reg.save();
  log.push(
    `✓ ${externalId} (${reg.studentName}): ${label} סומן שולם → paid=${reg.totalPaid} out=${reg.outstanding}`,
  );
}

/** יצירת סטודנט+עסקה חדשים (מדלג אם ה-externalId קיים). */
async function newDeal({
  studentNumber,
  name,
  rep,
  dealDate,
  price,
  courses,
  courseRaw,
  payments,
  writeOff = 0,
  writeOffNote,
  nextNote,
  fileRef,
}) {
  const externalId = `D${studentNumber}-1`;
  if (await Registration.findOne({ externalId }))
    return log.push(`= ${externalId} (${name}) כבר קיים`);
  let stu = await Student.findOne({ fullName: name });
  if (!stu) {
    const { firstName, lastName } = splitName(name);
    stu = await Student.create({
      studentNumber,
      fullName: name,
      firstName,
      lastName,
      idNumber: String(studentNumber),
      sourceFile: fileRef.file,
    });
  }
  const courseDocs = courses.map(C);
  const noteEntries = [];
  if (writeOffNote)
    noteEntries.push({
      text: writeOffNote,
      date: new Date(dealDate),
      byName: "עדכון יולי 2026",
    });
  const catCount = {};
  payments.forEach((x) => {
    catCount[x.method] = (catCount[x.method] || 0) + 1;
  });
  const reg = new Registration({
    schemaVersion: 2,
    externalId,
    student: stu._id,
    studentName: name,
    idNumber: String(studentNumber),
    rep: rep._id,
    repName: rep.name,
    course: courseDocs[0]._id,
    coursesAll:
      courseDocs.length > 1 ? courseDocs.map((c) => c._id) : undefined,
    courseRaw,
    courseField: courseDocs[0].field,
    cohortLabel: courseDocs[0].cohortLabel,
    dealDate: new Date(dealDate),
    dealPrice: price,
    writeOff,
    payments: payments.map((x) => ({ methodCategory: x.method, ...x })),
    paymentCategory: Object.entries(catCount).sort((a, b) => b[1] - a[1])[0][0],
    recordType: "registration",
    reconciled: true,
    noteEntries,
    nextPaymentNote: nextNote,
    sourceFile: fileRef.file,
    sourceRow: fileRef.row,
  });
  reg.recompute();
  await reg.save();
  await SourceRef.create({
    deal: reg._id,
    kind: "deal",
    sourceFile: fileRef.file,
    sourceRow: fileRef.row,
  });
  log.push(
    `✓ חדש: ${externalId} ${name} · ${courseRaw} · ₪${price} → paid=${reg.totalPaid} out=${reg.outstanding}${writeOff ? " wo=" + writeOff : ""} [${reg.paymentStatus}]`,
  );
}

try {
  // ============ א. תשלומים על עסקאות קיימות (מיכל) ============
  await addPayment(
    "D1183-2",
    {
      // שירה גולדברט · מאסטר תרפי: חיוב 1 מתוך 3
      type: "installment",
      method: "credit",
      amount: 493,
      dueDate: new Date("2026-07-05"),
      note: "חיוב 1/3 של היתרה · נותרו לגבייה עוד 2 תשלומים",
      source: src(MICHAL_F, 496),
      sourceFile: MICHAL_F,
      sourceRow: 496,
    },
    { paid: 1493, out: 987 },
  );

  await addPayment(
    "D1324-1",
    {
      // טוהר אלימלך: גבייה 1/5 - ₪1,500 באשראי
      type: "installment",
      method: "credit",
      amount: 1500,
      dueDate: new Date("2026-07-12"),
      note: "גבייה 1/5 · עוד 6,000 ב-10 לכל חודש",
      source: src(MICHAL_F, 507),
      sourceFile: MICHAL_F,
      sourceRow: 507,
      nextNote: "עוד ₪6,000: 4 חיובים של 1,500 כל 10 לחודש",
    },
    { paid: 3800, out: 6000 },
  );

  await addPayment(
    "D1199-1",
    {
      // חנה תורג'מן: גבייה ₪500
      type: "one_time",
      method: "credit",
      amount: 500,
      dueDate: new Date("2026-07-10"),
      note: "גבייה · יתרה לתשלום 1,000 ₪",
      source: src(MICHAL_F, 506),
      sourceFile: MICHAL_F,
      sourceRow: 506,
    },
    { paid: 4900, out: 1000 },
  );

  // ============ ב. אישורי ERN שנרשמו אצל מיכל ============
  await confirmErn("D1290-1", "ERN 3/6", 501); // תמיר גוטמן
  await confirmErn("D1286-1", "ERN 3/11", 502); // אורי כהן
  await confirmErn("D1310-1", "ERN 2/6", 503); // אביגיל אור
  await confirmErn("D1307-1", "ERN 2/5", 499); // רונן ניסים סלוק (צפוי: כבר שולם אוטומטית)
  await confirmErn("D1305-1", "ERN 2/5", 500); // יניב חיים סלוק (צפוי: כבר שולם אוטומטית)

  // ============ ג. עדכוני מורן על עסקאות קיימות ============
  await addPayment(
    "D1228-1",
    {
      // דנה אזולאי: ₪1,000 (יתרה 1700→700)
      type: "one_time",
      method: "transfer",
      amount: 1000,
      dueDate: new Date("2026-07-01"),
      note: "עדכון יולי: יתרה ירדה ל-700 ₪ (תאריך משוער)",
      source: src(MORAN_F, 138),
      sourceFile: MORAN_F,
      sourceRow: 138,
    },
    { paid: 4700, out: 700 },
  );

  await addPayment(
    "D1238-1",
    {
      // הדר בר אור · הדרכת הורים: "נותרו 2"→"נותר 1"
      type: "installment",
      method: "transfer",
      amount: 590,
      dueDate: new Date("2026-06-28"),
      note: "העברה חודשית · נותר עוד תשלום 1 (תאריך משוער)",
      source: src(MORAN_F, 156),
      sourceFile: MORAN_F,
      sourceRow: 156,
    },
    { paid: 5310, out: 590 },
  );

  await addPayment(
    "D1238-2",
    {
      // הדר בר אור · ייעוץ זוגי: "נותרו 9"→"נותרו 8"
      type: "installment",
      method: "transfer",
      amount: 590,
      dueDate: new Date("2026-06-28"),
      note: "העברה חודשית 590 · נותרו עוד 8 (תאריך משוער)",
      source: src(MORAN_F, 147),
      sourceFile: MORAN_F,
      sourceRow: 147,
    },
    { paid: 1180, out: 4720 },
  );
  await addPayment(
    "D1238-2",
    {
      // ...ובחלק "July 2026": "נותרו עוד 7"
      type: "installment",
      method: "transfer",
      amount: 590,
      dueDate: new Date("2026-07-05"),
      note: "העברה חודשית 590 · נותרו עוד 7 (תאריך משוער)",
      source: src(MORAN_F, 157),
      sourceFile: MORAN_F,
      sourceRow: 157,
    },
    { paid: 1770, out: 4130 },
  );

  await addPayment(
    "D1264-1",
    {
      // ג'ונה איברהים: שילמה עוד 4,000 ו"סיימה לשלם" (פער 1,000 = הנחה)
      type: "one_time",
      method: "credit",
      amount: 4000,
      dueDate: new Date("2026-07-05"),
      note: 'עדכון יולי: סה"כ שולם 5,000 · "סיימה לשלם" (תאריך משוער)',
      source: src(MORAN_F, 162),
      sourceFile: MORAN_F,
      sourceRow: 162,
      writeOffAfter: {
        amount: 1000,
        note: "הפרש ₪1,000 מהמחיר נסגר כהנחה (במקור: סיימה לשלם)",
      },
    },
    { paid: 5000, out: 0 },
  );

  await addPayment(
    "D1220-1",
    {
      // אריאלה גלסמית כהן: העברת 657 נוספת + "סיימה לשלם" (פער 1,315 = הנחה)
      type: "installment",
      method: "transfer",
      amount: 657,
      dueDate: new Date("2026-07-09"),
      note: 'העברה חודשית 657 · "סיימה לשלם" (תאריך משוער)',
      source: src(MORAN_F, 165),
      sourceFile: MORAN_F,
      sourceRow: 165,
      writeOffAfter: {
        amount: 1315,
        note: "הפרש ₪1,315 מהמחיר נסגר כהנחה (במקור: סיימה לשלם, יתרה 0)",
      },
    },
    { paid: 4685, out: 0 },
  );

  // נטלי דיגמי: היתרה לא השתנתה - רק מועד חיוב הבא (15/7)
  const natali = await Registration.findOne({ externalId: "D1317-1" });
  if (natali && natali.nextPaymentNote !== "חיוב הבא: 15/7") {
    natali.nextPaymentNote = "חיוב הבא: 15/7";
    await natali.save();
    log.push(`✓ D1317-1 (נטלי דיגמי): עודכן מועד חיוב הבא - 15/7`);
  }

  // ============ ד. עסקאות חדשות ============
  // מורן (לפי חלק "July 2026"):
  await newDeal({
    studentNumber: 1328,
    name: "מירב בית הלחמי",
    rep: moran,
    dealDate: "2026-07-01",
    price: 5900,
    courses: ["NLP פרקטישינר 9/26"],
    courseRaw: "נלפ ספטמבר",
    payments: [
      {
        type: "one_time",
        method: "credit",
        amount: 5500,
        dueDate: new Date("2026-07-01"),
        paid: true,
        note: "סיימה לשלם",
        source: src(MORAN_F, 160),
        sourceFile: MORAN_F,
        sourceRow: 160,
      },
    ],
    writeOff: 400,
    writeOffNote: "הפרש ₪400 מהמחיר נסגר כהנחה (במקור: סיימה לשלם)",
    fileRef: { file: MORAN_F, row: 160 },
  });
  await newDeal({
    studentNumber: 1329,
    name: "שרית אהרוני",
    rep: moran,
    dealDate: "2026-07-01",
    price: 5900,
    courses: ["ייעוץ זוגי 6/26"],
    courseRaw: "ייעוץ זוגי",
    payments: [
      {
        type: "one_time",
        method: "credit",
        amount: 5900,
        dueDate: new Date("2026-07-01"),
        paid: true,
        note: "סיימה לשלם",
        source: src(MORAN_F, 161),
        sourceFile: MORAN_F,
        sourceRow: 161,
      },
    ],
    fileRef: { file: MORAN_F, row: 161 },
  });
  await newDeal({
    studentNumber: 1330,
    name: "גליה קוטאי",
    rep: moran,
    dealDate: "2026-07-05",
    price: 5900,
    courses: ["ייעוץ זוגי 6/26"],
    courseRaw: "ייעוץ זוגי",
    payments: [
      {
        type: "one_time",
        method: "credit",
        amount: 5900,
        dueDate: new Date("2026-07-05"),
        paid: true,
        note: "סיימה לשלם",
        source: src(MORAN_F, 163),
        sourceFile: MORAN_F,
        sourceRow: 163,
      },
    ],
    fileRef: { file: MORAN_F, row: 163 },
  });
  await newDeal({
    studentNumber: 1331,
    name: "נעמי ביטון",
    rep: moran,
    dealDate: "2026-07-05",
    price: 4000,
    courses: ["הדרכת הורים 5/26"],
    courseRaw: "הדרכת הורים מאי",
    payments: [
      {
        type: "one_time",
        method: "transfer",
        amount: 4000,
        dueDate: new Date("2026-07-05"),
        paid: true,
        note: "סיימה לשלם",
        source: src(MORAN_F, 164),
        sourceFile: MORAN_F,
        sourceRow: 164,
      },
    ],
    fileRef: { file: MORAN_F, row: 164 },
  });
  // מיכל:
  await newDeal({
    studentNumber: 1332,
    name: "יונה דוד",
    rep: michal,
    dealDate: "2026-07-06",
    price: 5500,
    courses: ['נל"פ פרקטישינר 7/26'],
    courseRaw: "נלפ פרקט 7/26",
    payments: [
      {
        type: "installment",
        method: "credit",
        amount: 5500,
        dueDate: new Date("2026-07-06"),
        paid: true,
        installments: 6,
        note: "פריסת אשראי ל-6 תשלומים - הכסף נכנס מיידית",
        source: src(MICHAL_F, 497),
        sourceFile: MICHAL_F,
        sourceRow: 497,
      },
    ],
    fileRef: { file: MICHAL_F, row: 497 },
  });
  await newDeal({
    studentNumber: 1333,
    name: "היידי לופז",
    rep: michal,
    dealDate: "2026-07-07",
    price: 4000,
    courses: ['נל"פ פרקטישינר 7/26'],
    courseRaw: "נלפ פרקט 7/26",
    payments: [
      {
        type: "one_time",
        method: "transfer",
        amount: 4000,
        dueDate: new Date("2026-07-07"),
        paid: true,
        source: src(MICHAL_F, 498),
        sourceFile: MICHAL_F,
        sourceRow: 498,
      },
    ],
    fileRef: { file: MICHAL_F, row: 498 },
  });
  // משה רוזנבלט - עסקה משולבת: מקדמה 500 באשראי + ERN ‏10×930 (הראשון נגבה)
  const moshePays = [
    {
      type: "advance",
      method: "credit",
      amount: 500,
      dueDate: new Date("2026-07-09"),
      paid: true,
      note: "מקדמה",
      source: src(MICHAL_F, 504),
      sourceFile: MICHAL_F,
      sourceRow: 504,
    },
  ];
  for (let i = 0; i < 10; i += 1) {
    moshePays.push({
      type: "installment",
      method: "ern",
      amount: 930,
      installments: 10,
      dueDate: addMonthsClamped("2026-07-09", i),
      paid: i === 0,
      note: `ERN ${i + 1}/10`,
      source: src(MICHAL_F, i === 0 ? 505 : 504),
      sourceFile: MICHAL_F,
      sourceRow: i === 0 ? 505 : 504,
    });
  }
  await newDeal({
    studentNumber: 1334,
    name: "משה רוזנבלט",
    rep: michal,
    dealDate: "2026-07-09",
    price: 9800,
    courses: ['נל"פ פרקטישינר 7/26', "NLP מאסטר (מחזור לא משובץ)"],
    courseRaw: "נלפ פרקט. 7/26 + מאסטר",
    payments: moshePays,
    nextNote: "היתרה ב-10 תשלומי ERN של 930 ₪ (9 לחודש)",
    fileRef: { file: MICHAL_F, row: 504 },
  });

  console.log("\n================ סיכום עדכון יולי ================");
  log.forEach((l) => console.log("  " + l));

  // אימות מצרפי
  const [agg] = await Registration.aggregate([
    { $match: { recordType: { $ne: "cancelled" } } },
    {
      $group: {
        _id: null,
        total: { $sum: "$totalAmount" },
        paid: { $sum: "$totalPaid" },
        out: { $sum: "$outstanding" },
        n: { $sum: 1 },
      },
    },
  ]);
  console.log(
    `\nמצב מצרפי (עסקאות פעילות): ${agg.n} עסקאות · נרכש ₪${agg.total.toLocaleString()} · נגבה ₪${agg.paid.toLocaleString()} · יתרה ₪${agg.out.toLocaleString()}`,
  );
} catch (err) {
  console.error(
    "💥 שגיאה - העדכון נעצר (מה שהוחל נשאר, ריצה חוזרת תמשיך מאותה נקודה):",
  );
  console.error(err);
  process.exitCode = 1;
}

await disconnectDB();
process.exit(process.exitCode || 0);
