import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Course = קורס/מחזור. Sourced from קורסים.xlsx (the Gantt) and from deal rows.
 * `field` is the canonical course family (e.g. "נל\"פ פרקטישינר", "טראומה וחרדה")
 * while `name`/`cohortLabel` capture the specific cohort (e.g. "טראומה וחרדה 5/26").
 */
const courseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, index: true }, // שם הקורס/מחזור
    field: { type: String, trim: true, index: true }, // משפחת הקורס (canonical)
    cohortLabel: { type: String, trim: true }, // תווית מחזור, למשל 5/26
    rawNames: [{ type: String, trim: true }], // כל הוריאציות שנראו באקסלים
    startDate: { type: Date }, // מתאריך
    startDateRaw: { type: String },
    endDate: { type: Date }, // עד תאריך
    endDateRaw: { type: String },
    sessionsCount: { type: Number }, // כמות מפגשים
    location: { type: String, trim: true }, // מיקום (ר"ג + זום / זום בלבד)
    lecturer: { type: String, trim: true }, // מרצה
    weekday: { type: String, trim: true }, // יום בשבוע (א-ה)
    status: { type: String, trim: true, default: 'פעיל' }, // סטאטוס: פעיל / פתוח להרשמה / הסתיים
    price: { type: Number }, // מחיר מחירון (אופציונלי)
    notes: { type: String, trim: true },
    sourceFile: { type: String },
  },
  { timestamps: true }
);

export default mongoose.models.Course || mongoose.model('Course', courseSchema);
