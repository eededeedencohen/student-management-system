import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * QuoteTemplate = טמפלט שמור להצעות מחיר, בנוסף לטמפלטים הקבועים שבקוד.
 * `fields` מכיל רק את השדות שנבחרו בשמירה - כך טמפלט יכול להיות קורס שלם
 * (כל השדות) או שדה בודד (למשל רק "מקום" או רק "הערות"). בהחלה נדרסים רק
 * השדות שהטמפלט כולל. הטמפלטים משותפים לכל הצוות; מחיקה - היוצר/ת או מנהל.
 */
const quoteTemplateSchema = new Schema(
  {
    name: { type: String, trim: true, required: true },
    fields: {
      courseName: { type: String, trim: true },
      description: { type: String, trim: true },
      price: { type: Number },
      sessions: { type: Number },
      sessionLength: { type: String, trim: true },
      schedule: { type: String, trim: true },
      place: { type: String, trim: true },
      method: { type: String, trim: true },
      recordedLine: { type: String, trim: true },
      notes: { type: String, trim: true },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true },
);

quoteTemplateSchema.index({ name: 1 }, { unique: true });

export default mongoose.models.QuoteTemplate ||
  mongoose.model("QuoteTemplate", quoteTemplateSchema);
