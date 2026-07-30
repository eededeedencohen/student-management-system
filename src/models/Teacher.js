import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Teacher (מרצה) — defined by יקיר before assigning to course cohorts.
 * ת.ז. אינה נגישה לו כרגע, ולכן ה"מפתח" העסקי הוא הטלפון (unique).
 */
const teacherSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true, index: true }, // שם מלא
    phone: { type: String, required: true, trim: true, unique: true }, // טלפון — PK עסקי
    email: { type: String, required: true, trim: true, lowercase: true }, // מייל
    idNumber: { type: String, trim: true }, // ת.ז. (אופציונלי בשלב זה)
    notes: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export default mongoose.models.Teacher || mongoose.model('Teacher', teacherSchema);
