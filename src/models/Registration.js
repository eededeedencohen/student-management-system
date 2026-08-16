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
    // בוטל במסגרת ביטול עסקה: לא ייגבה (ידנית או אוטומטית) ולא נספר ביתרה.
    // נשמר ברשומה (ולא נמחק) כדי שההיסטוריה והחוזה יישארו שלמים.
    canceled: { type: Boolean },
    // נוצר בתוך חלון ביטול העסקה (למשל דמי ביטול) - בשחזור העסקה תשלום כזה
    // שטרם נגבה מוסר, כי הוא היה חלק מהסדר הביטול בלבד.
    addedOnCancel: { type: Boolean },
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
    // --- אסמכתת העברה בנקאית (v2): העברה ששולמה מחייבת תמונה + מספר ---------
    receiptReference: { type: String, trim: true }, // מספר אסמכתא
    receiptImage: { type: Boolean }, // צורפה תמונה? (התמונה עצמה ב-PaymentReceipt)
    receiptUploadedAt: { type: Date },
    receiptUploadedByName: { type: String },
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

// החזר מתוכנן ללקוח במסגרת ביטול עסקה: כמה, מתי, והאם כבר בוצע.
// מופיע בתזרים כהוצאה צפויה בתאריך היעד עד שמסומן refunded.
const refundSchema = new Schema(
  {
    amount: { type: Number, default: 0 },
    dueDate: { type: Date }, // מתי להחזיר
    note: { type: String, trim: true },
    sourcePaymentId: { type: String }, // התשלום ששולם שממנו נגזר ההחזר (אם רלוונטי)
    refunded: { type: Boolean, default: false }, // ההחזר בוצע בפועל
    refundedAt: { type: Date },
    refundedByName: { type: String },
  },
  { _id: true },
);

// ביטול עסקה: מתי, מי, למה, ואילו החזרים נקבעו. קיום canceledAt הוא המקור
// היחיד לאמת - הוא זה שמפעיל את חוקי הביטול ב-recompute ובתזרים.
const cancellationSchema = new Schema(
  {
    canceledAt: { type: Date },
    by: { type: Schema.Types.ObjectId, ref: "User" },
    byName: { type: String },
    note: { type: String, trim: true }, // הערת הביטול (חובה בביטול)
    refunds: { type: [refundSchema], default: [] },
  },
  { _id: false },
);

const checklistSchema = new Schema(
  {
    signedTakanon: { type: Boolean, default: false }, // נחתם תקנון
    addedToCourseWhatsapp: { type: Boolean, default: false }, // נכנס/ה לקבוצת הקורס
    addedToAlumniWhatsapp: { type: Boolean, default: false }, // נכנס/ה לקבוצת הבוגרים
    invoiceIssued: { type: Boolean, default: false }, // הוצאה חשבונית
    // עסקת חבילה: מעקב "קבוצת קורס" נפרד לכל קורס. key = אינדקס הקורס
    // ב-coursesInfo (הסדר קבוע מרגע היצירה). addedToCourseWhatsapp הכללי
    // מסונכרן אוטומטית ב-recompute = כל הקבוצות סומנו.
    courseGroups: {
      type: [
        new Schema(
          {
            key: { type: String },
            name: { type: String },
            added: { type: Boolean, default: false },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
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
    signedVia: { type: String }, // "upload" = הועלה חוזה חתום ידנית (סריקה); ריק = חתימה דיגיטלית
    emailedAt: { type: Date }, // מתי נשלח עותק PDF חתום ללקוח (למניעת שליחה כפולה)
    emailedTo: { type: String }, // כתובת המייל שאליה נשלח העותק
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
    // שיוך רשמי למחזור קורס (CourseCohort) - נקבע בעמוד עריכת הנתונים ע"י הנציגה
    cohort: { type: Schema.Types.ObjectId, ref: "CourseCohort", index: true },
    // עסקת חבילה מהטופס החיצוני: כל המחזורים שנבחרו; `cohort` נשאר הראשי.
    cohortsAll: [{ type: Schema.Types.ObjectId, ref: "CourseCohort" }],
    // סנאפשוט שמות הקורסים לחוזה (שם + מחזור לכל קורס בעסקה) - כך החוזה
    // מציג את כל הקורסים גם אם רשומות הקטלוג ישתנו אחרי היצירה
    coursesInfo: {
      type: [
        new Schema(
          {
            name: { type: String },
            cohortLabel: { type: String },
            // אופן ההשתתפות של הקורס הזה בעסקה (זום/פרונטלי) - בעסקת חבילה
            // ייתכנו אופנים שונים בין הקורסים
            deliveryMode: { type: String },
          },
          { _id: false },
        ),
      ],
      default: undefined,
    },
    // אופן ההשתתפות של הנרשם/ת: זום או פרונטלי. נקבע בטופס החיצוני - במחזור
    // "לפי בחירה" (hybrid) זו הבחירה של הנרשם/ת; במחזור קבוע זה האופן של המחזור.
    deliveryMode: { type: String, enum: ["zoom", "frontal"] },

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

    // --- ביטול עסקה (recordType הופך ל-cancelled; ניתן לשחזור) ---
    cancellation: { type: cancellationSchema },

    // לוח תשלומים צפוי (פריסת אשראי/ERN) - נוצר מהפירוט הטקסטואלי + שורות "N/M".
    installmentPlan: { type: [installmentSchema], default: [] },

    // בדיקת התאמה: האם נגבה+עתידי = סה"כ העסקה. unbalanced -> reconcileNote מסביר.
    reconciled: { type: Boolean, default: true, index: true },
    reconcileNote: { type: String },

    // --- עריכת נתונים ישנים: האם הנציגה עברה על העסקה, השלימה ואישרה אותה ---
    dataReview: {
      status: { type: String, enum: ["pending", "done"], default: "pending" },
      by: { type: Schema.Types.ObjectId, ref: "User" },
      byName: { type: String },
      at: { type: Date },
    },

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
  // עסקת חבילה: הדגל הכללי "קבוצת קורס" = כל קבוצות הקורסים סומנו
  if (c0.courseGroups?.length) {
    c0.addedToCourseWhatsapp = c0.courseGroups.every((g) => g.added);
  }
  const checklistComplete = Boolean(
    c0.signedTakanon && c0.addedToCourseWhatsapp && c0.addedToAlumniWhatsapp,
  );

  // --- v2: total & status are DERIVED from the unified payments list ---
  if (this.schemaVersion === 2) {
    const isCancelled = Boolean(this.cancellation?.canceledAt);
    // תשלום שבוטל בביטול עסקה אינו חלק מהחשבון - לא בגבייה ולא ביתרה
    const pays = (this.payments || []).filter((p) => !p.canceled);
    const paymentsSum = pays.reduce((s, p) => s + (p.amount || 0), 0);
    const collected = pays.reduce(
      (s, p) => s + (p.paid ? p.amount || 0 : 0),
      0,
    );
    // explicit dealPrice (JSON import) wins - the recorded payments may not cover the
    // whole deal (missing money / future plan only noted in text); else derive from payments.
    // עסקה מבוטלת: הסכום האפקטיבי הוא מה שנשאר בתוקף (שולם + מה שסוכם שעוד
    // ייגבה), לא המחיר המקורי - כך היתרה משקפת רק כסף שבאמת ייגבה.
    const total = isCancelled
      ? paymentsSum
      : this.dealPrice > 0
        ? this.dealPrice
        : paymentsSum;
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

  // --- v1 legacy ---
  const paid = (this.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
  this.totalPaid = paid || this.advancePaid || 0;
  // Outstanding = total − collected when the deal total is known; otherwise fall back
  // to the (clean) balance columns. Mirrors the import logic in importExcel.js.
  if (this.cancellation?.canceledAt)
    this.outstanding = 0; // עסקה ישנה שבוטלה: אין יתרה לגבייה (החזרים ב-cancellation)
  else if (this.totalAmount > 0)
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
