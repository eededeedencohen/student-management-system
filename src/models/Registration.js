import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Registration = עסקה / רישום. One document per deal row in the reps' Excel files.
 * Holds the money, payment plan, collection status, and the registration checklist.
 */
const paymentSchema = new Schema(
  {
    // --- v2 unified payment ---------------------------------------------------
    // A payment can already be collected, or scheduled for the future (paid=false,
    // dueDate ahead). "סמן כשולם" flips paid=true and stamps confirmedBy/At.
    type: { type: String, enum: ["advance", "installment", "one_time"] }, // מקדמה / תשלומים / חד-פעמי
    amount: { type: Number, default: 0 },
    method: { type: String, trim: true }, // raw method text OR v2 category (credit/ern/cash/transfer)
    methodCategory: { type: String }, // credit | transfer | cash | ern | financing | combined | other
    dueDate: { type: Date }, // v2: scheduled date (past or future)
    paid: { type: Boolean, default: false }, // v2: has it been collected?
    confirmedBy: { type: Schema.Types.ObjectId, ref: "User" }, // who pressed "סמן כשולם"
    confirmedByName: { type: String },
    confirmedAt: { type: Date },
    // --- legacy fields (v1 imported deals) ------------------------------------
    installments: { type: Number }, // מספר תשלומים (לכ.א.)
    date: { type: Date }, // actual paid date (legacy)
    dateRaw: { type: String },
    note: { type: String, trim: true },
    kind: { type: String, enum: ["advance", "balance", "extra"] },
    source: { type: String }, // רפרנס: מאיזו שורה/הערה במקור הגיע התשלום
  },
  { _id: true }, // v2 payments need a stable id so they can be marked paid / referenced
);

// One dated note in a deal's note log (v2: "הערה - רשימת הערות עם תאריכים").
const noteEntrySchema = new Schema(
  {
    text: { type: String, trim: true },
    date: { type: Date, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: "User" },
    byName: { type: String },
  },
  { _id: true },
);

const checklistSchema = new Schema(
  {
    signedTakanon: { type: Boolean, default: false }, // נחתם תקנון
    addedToCourseWhatsapp: { type: Boolean, default: false }, // נכנס/ה לקבוצת הקורס
    addedToAlumniWhatsapp: { type: Boolean, default: false }, // נכנס/ה לקבוצת הבוגרים
    invoiceIssued: { type: Boolean, default: false }, // הוצאה חשבונית
  },
  { _id: false },
);

// חוזה דיגיטלי: קישור ייחודי (token) שבו הלקוח קורא את החוזה וחותם ביד/עכבר.
// חתימה מעדכנת אוטומטית את checklist.signedTakanon של העסקה.
const contractSchema = new Schema(
  {
    token: { type: String }, // מזהה ייחודי לקישור הציבורי (אקראי, לא ניתן לניחוש)
    status: { type: String, enum: ["pending", "signed"], default: "pending" },
    createdAt: { type: Date },
    viewedAt: { type: Date }, // צפייה ראשונה של הלקוח בחוזה
    signedAt: { type: Date },
    signerName: { type: String }, // השם שהוקלד באישור החתימה
    signatureDataUrl: { type: String }, // תמונת החתימה (data URL)
  },
  { _id: false },
);

// One scheduled installment in a payment plan (e.g. ERN/credit "1/6", due 15/07/2026).
const installmentSchema = new Schema(
  {
    index: { type: Number }, // 1-based position in the plan
    count: { type: Number }, // total installments in the plan (N of "i/N")
    label: { type: String }, // "1/6"
    dueDate: { type: Date }, // when it should be collected
    amount: { type: Number, default: 0 },
    method: { type: String }, // ern | credit | transfer
    status: { type: String, enum: ["pending", "paid"], default: "pending" },
    paidAt: { type: Date }, // when actually collected
    confirmedBy: { type: Schema.Types.ObjectId, ref: "User" }, // who pressed ✓
    confirmedByName: { type: String },
    sourceRow: { type: Number }, // marker row in the Excel that recorded it (if imported)
  },
  { _id: false },
);

const registrationSchema = new Schema(
  {
    // --- relations ---
    student: { type: Schema.Types.ObjectId, ref: "Student", index: true },
    studentName: { type: String, trim: true, index: true }, // שם הנרשם/ת (raw, always kept)
    idNumber: { type: String, trim: true },
    lead: { type: Schema.Types.ObjectId, ref: "Lead", index: true }, // הליד שממנו נסגרה העסקה
    // עסקה משולבת (שני קורסים בעסקה אחת): כל הקורסים; `course` נשאר הראשי.
    coursesAll: [{ type: Schema.Types.ObjectId, ref: "Course" }],
    rep: { type: Schema.Types.ObjectId, ref: "User", index: true }, // נציגת המכירות
    repName: { type: String, trim: true },
    registeredByRaw: { type: String, trim: true }, // "נרשמה ע"י" כפי שהופיע
    course: { type: Schema.Types.ObjectId, ref: "Course", index: true },
    courseRaw: { type: String, trim: true }, // שם הקורס כפי שהופיע
    courseField: { type: String, trim: true }, // משפחת הקורס (canonical)
    cohortLabel: { type: String, trim: true }, // מחזור, למשל 9/25

    // --- dates ---
    dealDate: { type: Date, index: true }, // תאריך עסקה
    dealDateRaw: { type: String },
    dateAssumed: { type: Boolean, default: false }, // האם השנה הושלמה בהנחה (מורן ללא שנה)

    // --- format version ---
    // 1 = legacy imported row; 2 = clean deal entered via the new form. v2 derives
    // total & status from `payments` (see recompute) and stores no manual total.
    schemaVersion: { type: Number, default: 1, index: true },
    discountPercent: { type: Number, default: 0 }, // אחוז הנחה של העסקה
    noteEntries: { type: [noteEntrySchema], default: [] }, // הערות עם תאריכים (v2)
    // v2: explicit deal price (after discount). When set, it IS the deal total even if the
    // recorded payments don't cover it (missing money / a future plan noted only in text).
    // When absent, the total is derived from the payments (form-created deals).
    dealPrice: { type: Number },
    // סכום שנמחל/נסגר כהנחה בדיעבד (או יתרת עסקה שבוטלה) - מקטין את היתרה לגבייה
    // בלי לשנות את מחיר העסקה. עסקה "שולם" במקור עם פער מחיר → הפער נרשם כאן.
    writeOff: { type: Number, default: 0 },
    externalId: { type: String, index: true }, // e.g. "D1324-1" from the unified JSON dataset

    // --- money ---
    totalAmount: { type: Number, default: 0 }, // סה"כ עסקה (v2: derived-and-cached = sum of payments)
    amountExVat: { type: Number }, // סה"כ בקיזוז מע"מ
    vatAmount: { type: Number }, // סה"כ מע"מ
    advancePaid: { type: Number, default: 0 }, // שולמה מקדמה בסך
    balanceDue: { type: Number, default: 0 }, // יתרה לתשלום (כפי שנרשם)
    finalBalance: { type: Number, default: 0 }, // יתרה סופית לתשלום
    totalPaid: { type: Number, default: 0 }, // מחושב
    outstanding: { type: Number, default: 0 }, // מחושב: כמה עוד בחוץ
    payments: { type: [paymentSchema], default: [] },
    primaryPaymentMethod: { type: String, trim: true }, // אופן התשלום הראשי (raw)
    paymentCategory: { type: String }, // credit | transfer | cash | ern | financing | combined | other
    installments: { type: Number }, // מספר תשלומים
    paymentStatus: {
      type: String,
      enum: ["paid", "partial", "unpaid"],
      default: "unpaid",
      index: true,
    },
    nextPaymentDate: { type: Date }, // מתי לגבות את היתרה
    nextPaymentNote: { type: String, trim: true },

    // --- checklist & flags ---
    checklist: { type: checklistSchema, default: () => ({}) },
    checklistComplete: { type: Boolean, default: false },
    // --- חוזה דיגיטלי (טופס חיצוני) ---
    contract: { type: contractSchema },

    // לוח תשלומים צפוי (פריסת אשראי/ERN) - נוצר מהפירוט הטקסטואלי + שורות "N/M".
    installmentPlan: { type: [installmentSchema], default: [] },

    // בדיקת התאמה: האם נגבה+עתידי = סה"כ העסקה. unbalanced -> reconcileNote מסביר.
    reconciled: { type: Boolean, default: true, index: true },
    reconcileNote: { type: String },

    // --- classification (data is messy: some rows are ads / follow-ups) ---
    recordType: {
      type: String,
      // 'cancelled' = עסקה שלא בוצעה/בוטלה (נשמרת לתיעוד; לא נספרת כהכנסה)
      enum: [
        "registration",
        "collection_followup",
        "advertising",
        "refund",
        "cancelled",
        "other",
      ],
      default: "registration",
      index: true,
    },
    needsReview: { type: Boolean, default: false, index: true }, // לבדיקה ידנית

    notes: { type: String, trim: true }, // הערות
    sourceFile: { type: String, index: true }, // קובץ מקור
    sourceSheet: { type: String },
    sourceRow: { type: Number }, // מספר שורה במקור (לעקיבות)
  },
  { timestamps: true },
);

/** Recompute derived money + status fields. */
registrationSchema.methods.recompute = function recompute() {
  const c0 = this.checklist || {};
  const checklistComplete = Boolean(
    c0.signedTakanon && c0.addedToCourseWhatsapp && c0.addedToAlumniWhatsapp,
  );

  // --- v2: total & status are DERIVED from the unified payments list ---
  if (this.schemaVersion === 2) {
    const pays = this.payments || [];
    const paymentsSum = pays.reduce((s, p) => s + (p.amount || 0), 0);
    const collected = pays.reduce(
      (s, p) => s + (p.paid ? p.amount || 0 : 0),
      0,
    );
    // explicit dealPrice (JSON import) wins - the recorded payments may not cover the
    // whole deal (missing money / future plan only noted in text); else derive from payments.
    const total = this.dealPrice > 0 ? this.dealPrice : paymentsSum;
    this.totalAmount = total; // derived-and-cached so existing queries/aggregations keep working
    this.totalPaid = collected;
    // writeOff = residual forgiven as a discount (or a cancelled deal's balance) - it
    // closes the gap between price and money without pretending money arrived.
    this.outstanding = Math.max(total - collected - (this.writeOff || 0), 0);
    if (total > 0 && this.outstanding <= 0.5) this.paymentStatus = "paid";
    else if (collected > 0) this.paymentStatus = "partial";
    else this.paymentStatus = "unpaid";
    // next charge = earliest still-unpaid dueDate (drives cash-flow / "next payment").
    const nextDue = pays
      .filter((p) => !p.paid && p.dueDate)
      .map((p) => +new Date(p.dueDate))
      .sort((a, b) => a - b)[0];
    this.nextPaymentDate = nextDue ? new Date(nextDue) : undefined;
    this.checklistComplete = checklistComplete;
    return this;
  }

  // --- v1 legacy (unchanged) ---
  const paid = (this.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
  this.totalPaid = paid || this.advancePaid || 0;
  // Outstanding = total − collected when the deal total is known; otherwise fall back
  // to the (clean) balance columns. Mirrors the import logic in importExcel.js.
  if (this.totalAmount > 0)
    this.outstanding = Math.max(this.totalAmount - this.totalPaid, 0);
  else if (this.finalBalance > 0) this.outstanding = this.finalBalance;
  else this.outstanding = this.balanceDue > 0 ? this.balanceDue : 0;
  if (this.totalAmount > 0 && this.outstanding <= 0.5)
    this.paymentStatus = "paid";
  else if (this.totalPaid > 0) this.paymentStatus = "partial";
  else this.paymentStatus = "unpaid";
  const c = this.checklist || {};
  this.checklistComplete = Boolean(
    c.signedTakanon && c.addedToCourseWhatsapp && c.addedToAlumniWhatsapp,
  );
  return this;
};

registrationSchema.index({ dealDate: 1, rep: 1 });
registrationSchema.index({ courseField: 1, dealDate: 1 });

export default mongoose.models.Registration ||
  mongoose.model("Registration", registrationSchema);
