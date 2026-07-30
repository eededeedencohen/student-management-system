import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * CatalogCourse (קורס קטלוגי) — the FIXED course definition (e.g. NLP, הדרכת הורים):
 * name, list price, default session count. Cohorts (CourseCohort) reference this.
 * Created from scratch by יקיר in the catalog admin page — deliberately a NEW
 * collection, separate from the legacy `Course` docs imported from the Excels
 * (those act as his "Excel entries" to be mapped onto catalog courses + cohorts).
 */
const catalogCourseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true }, // שם הקורס
    price: { type: Number, default: 0 }, // מחיר הקורס
    defaultSessionCount: { type: Number, default: 0 }, // ערך דיפולטיבי לכמות מפגשים
    notes: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export default mongoose.models.CatalogCourse ||
  mongoose.model('CatalogCourse', catalogCourseSchema);
