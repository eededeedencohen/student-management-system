import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Student = פרטי התלמיד/ה. Personal details are unified here (one record per person),
 * while each purchase lives in a Registration that references this student.
 */
const studentSchema = new Schema(
  {
    // Human-friendly sequential id (1..N) — the "ID מבצע העסקה" while there are no ת.ז.
    // numbers yet. Assigned on create and backfilled for existing students.
    studentNumber: { type: Number, index: true, unique: true, sparse: true },
    fullName: { type: String, required: true, trim: true, index: true }, // שם מלא כפי שהופיע
    firstName: { type: String, trim: true }, // שם פרטי
    lastName: { type: String, trim: true }, // שם משפחה
    hebrewName: { type: String, trim: true }, // שם בעברית
    englishName: { type: String, trim: true }, // שם באנגלית
    idNumber: { type: String, trim: true, index: true }, // ת.ז. (סינתטית 1001+ לפי סדר כרונולוגי, כמו ב-JSON)
    realIdNumber: { type: String, trim: true }, // ת.ז. אמיתית — רק למי שידועה במקור
    mobile: { type: String, trim: true }, // נייד
    email: { type: String, trim: true, lowercase: true }, // מייל
    city: { type: String, trim: true }, // עיר
    street: { type: String, trim: true }, // רחוב
    houseNumber: { type: String, trim: true }, // מספר בית
    apartment: { type: String, trim: true }, // דירה
    notes: { type: String, trim: true },
    sourceFile: { type: String }, // קובץ מקור בייבוא
  },
  { timestamps: true }
);

studentSchema.index({ fullName: 1, idNumber: 1 });

export default mongoose.models.Student || mongoose.model('Student', studentSchema);
