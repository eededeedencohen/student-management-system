import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * עותק PDF של הצעת מחיר, לשליחה בוואטסאפ: ההודעה נושאת קישור ציבורי
 * (token אקראי, לא ניתן לניחוש) שמגיש את הקובץ עצמו - הלקוח מקבל PDF,
 * לא עמוד HTML. מסמך אחד לכל הצעה (שליחה חוזרת מחליפה את הקובץ, הקישור
 * נשאר יציב). אוסף נפרד כדי שה-base64 הגדול לא ייטען עם שאילתות הצעות רגילות.
 */
const quotePdfSchema = new Schema(
  {
    quote: { type: Schema.Types.ObjectId, ref: "Quote", unique: true, index: true },
    token: { type: String, index: true },
    filename: { type: String },
    pdfBase64: { type: String }, // ה-PDF, base64 (בלי קידומת data:)
    byteLength: { type: Number },
  },
  { timestamps: true },
);

export default mongoose.models.QuotePdf ||
  mongoose.model("QuotePdf", quotePdfSchema);
