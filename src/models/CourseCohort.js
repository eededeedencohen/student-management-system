import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One session (מפגש) of a cohort. Location falls back to the cohort's default
 * when empty — each session can still override it.
 */
const sessionSchema = new Schema(
  {
    date: { type: Date, required: true }, // תאריך המפגש
    startTime: { type: String, trim: true }, // "17:30"
    endTime: { type: String, trim: true },
    location: { type: String, trim: true }, // ריק = מיקום ברירת המחדל של המחזור
    note: { type: String, trim: true },
  },
  { _id: true },
);

export const COHORT_STATUSES = ['active', 'future', 'ended', 'cancelled'];

/**
 * CourseCohort (מחזור קורס) — a concrete run of a CatalogCourse: lecturer, default
 * location, the session list, status and registration flag. `sourceCourse` links
 * back to the legacy Course doc (יקיר's Excel entry) it was defined from.
 */
const courseCohortSchema = new Schema(
  {
    catalogCourse: {
      type: Schema.Types.ObjectId,
      ref: 'CatalogCourse',
      required: true,
      index: true,
    },
    label: { type: String, trim: true }, // תווית מחזור, למשל "5/26" או "מאי 2026"
    // הרשומה המקורית מהאקסל של יקיר (Course doc) שממנה הוגדר המחזור — אם קיימת
    sourceCourse: {
      type: Schema.Types.ObjectId,
      ref: 'Course',
      index: true,
      unique: true,
      sparse: true,
    },
    // מחזור יכול להיות מועבר בידי יותר ממרצה אחד (למשל "עמר לוין + אביטל דניאל"
    // באקסל של יקיר). זהו השדה הקנוני.
    teachers: { type: [{ type: Schema.Types.ObjectId, ref: 'Teacher' }], default: [], index: true },
    // שדה המרצה הבודד המקורי — נשמר מסונכרן ל-teachers[0] לתאימות לאחור.
    teacher: { type: Schema.Types.ObjectId, ref: 'Teacher', index: true },
    defaultLocation: { type: String, trim: true }, // מיקום דיפולטיבי למפגשים
    // אופן קיום המחזור: זום / פרונטלי / hybrid = הנרשם בוחר בין שניהם
    deliveryMode: { type: String, enum: ['zoom', 'frontal', 'hybrid'] },
    sessions: { type: [sessionSchema], default: [] },
    status: {
      type: String,
      enum: COHORT_STATUSES, // פעיל / עתידי / נגמר / בוטל
      default: 'future',
      index: true,
    },
    registrationOpen: { type: Boolean, default: false }, // הרשמה פתוחה
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

// מחזור שנגמר או בוטל לא יכול להיות בהרשמה פתוחה — נאכף גם במודל, לא רק ב-UI.
courseCohortSchema.pre('validate', function closeRegistrationWhenOver(next) {
  if (this.status === 'ended' || this.status === 'cancelled') {
    this.registrationOpen = false;
  }
  next();
});

// שומר על teachers (הקנוני) ו-teacher (הישן) מסונכרנים בשני הכיוונים, כדי שמסמכים
// שנוצרו לפני ריבוי המרצים ימשיכו לעבוד וכדי שכל קורא של teacher יקבל את הראשון.
courseCohortSchema.pre('validate', function syncTeacherFields(next) {
  if ((!this.teachers || this.teachers.length === 0) && this.teacher) {
    this.teachers = [this.teacher];
  }
  if (this.teachers?.length) {
    const seen = new Set();
    this.teachers = this.teachers.filter((t) => {
      const k = String(t);
      if (seen.has(k)) return false; // אותו מרצה פעמיים באותו מחזור
      seen.add(k);
      return true;
    });
  }
  this.teacher = this.teachers?.[0] || null;
  next();
});

export default mongoose.models.CourseCohort ||
  mongoose.model('CourseCohort', courseCohortSchema);
