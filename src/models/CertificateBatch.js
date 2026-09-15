import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * מצב העבודה של מחולל תעודות עבור מחזור אחד.
 *
 * הבעלים ביקש שהעריכה במחולל (שמות, ת.ז., נוסחים) תהיה "זמנית" - כלומר
 * לא תיגע ב-Student/Registration. לכן היא נשמרת כאן:
 *
 *   settings  - הגדרות משותפות לכל התעודות בקבוצה (מועד, כיתובי חתימה,
 *               בחירת חתימה, היסטי מיקום/גודל). המקבילה ל-localStorage
 *               "settings" במחוללים העצמאיים.
 *   people[]  - שורה לכל מקבל/ת תעודה: המקור (registration/student) והשדות
 *               שנדרסו ידנית. שדה שלא נדרס נגזר מהנתונים החיים בכל טעינה,
 *               כך שתיקון אמיתי בכרטיס התלמיד/ה כן מחלחל.
 *
 * מסמך אחד לכל צירוף (cohort, generator).
 */
const certPersonSchema = new Schema(
  {
    // מי זה - לפחות אחד מהשניים קיים
    registration: { type: Schema.Types.ObjectId, ref: "Registration" },
    student: { type: Schema.Types.ObjectId, ref: "Student" },
    // מפתח יציב לשורה גם כשאין רישום (למשל שם שהוזן ידנית)
    key: { type: String, required: true },
    // דריסות ידניות בלבד: {nameHe, nameEn, id, titleHe, titleEn, prof, ...}
    overrides: { type: Schema.Types.Mixed, default: {} },
    // אילו עמודים להפיק עבורו (he/en/track) - תלוי מחולל
    include: { type: Schema.Types.Mixed, default: {} },
    excluded: { type: Boolean, default: false }, // הוסר/ה מהקבוצה
    order: { type: Number, default: 0 },
  },
  { _id: false },
);

const certificateBatchSchema = new Schema(
  {
    cohort: { type: Schema.Types.ObjectId, ref: "CourseCohort", required: true, index: true },
    generator: { type: String, required: true }, // horim | nlp | trauma | master
    settings: { type: Schema.Types.Mixed, default: {} },
    people: { type: [certPersonSchema], default: [] },
    updatedByName: { type: String },
  },
  { timestamps: true },
);

certificateBatchSchema.index({ cohort: 1, generator: 1 }, { unique: true });

export default mongoose.models.CertificateBatch ||
  mongoose.model("CertificateBatch", certificateBatchSchema);
