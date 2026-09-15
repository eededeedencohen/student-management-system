import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * חתימה סרוקה/מצוירת לשימוש בתעודות.
 *
 * ברוב המקרים החתימה שייכת למרצה - לכל מרצה חתימה עברית ו/או אנגלית
 * (`lang` הוא שפת התעודה שעליה חותמים). חתימה בלי `teacher` היא ערך חופשי
 * בגלריה (למשל חתימת מנכ"ל שאינו מרצה).
 *
 * התמונה נשמרת כאן ולא על Teacher כדי שרשימת המרצים (שנטענת בכל כניסה
 * לעמוד הקורסים) תישאר קלה - אותו דפוס כמו PaymentReceipt מול Registration.
 */
const certificateSignatureSchema = new Schema(
  {
    name: { type: String, required: true, trim: true }, // "אורטל כהן - עברית"
    teacher: { type: Schema.Types.ObjectId, ref: "Teacher", index: true },
    lang: { type: String, enum: ["he", "en"], required: true },
    imageDataUrl: { type: String, required: true }, // data:image/png;base64,...
    byteLength: { type: Number },
    uploadedAt: { type: Date, default: Date.now },
    uploadedByName: { type: String },
  },
  { timestamps: true },
);

// למרצה - חתימה אחת לכל שפה. חתימות ללא מרצה אינן מוגבלות.
certificateSignatureSchema.index(
  { teacher: 1, lang: 1 },
  { unique: true, partialFilterExpression: { teacher: { $exists: true, $type: "objectId" } } },
);

export default mongoose.models.CertificateSignature ||
  mongoose.model("CertificateSignature", certificateSignatureSchema);
