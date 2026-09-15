import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * נכס קבוע של מחולל התעודות: רקע התעודה, חותמת, לוגו או קובץ פונט.
 *
 * הנכסים חולצו מקובצי המחוללים העצמאיים (src/scripts/extractCertAssets.mjs)
 * ומוזנים לכאן פעם אחת (src/scripts/seedCertAssets.mjs). הם לא יושבים בגיט:
 * הריפו ציבורי, ואלה תבניות התעודה הריקות והחתימות המקוריות של המרצים.
 *
 * הנתונים נשמרים כ-Buffer (BinData) ולא כ-base64 - חוסך 33% נפח במסד שצפוף.
 * ה-sha הוא גם המפתח וגם ה-cache key: הנכס לא משתנה לעולם, ולכן ה-endpoint
 * מגיש אותו עם Cache-Control immutable.
 */
const certificateAssetSchema = new Schema(
  {
    sha: { type: String, required: true, unique: true }, // 16 תווים מ-sha256 של הבייטים
    kind: { type: String, enum: ["font", "image"], required: true },
    mime: { type: String, required: true }, // font/ttf, image/png ...
    bytes: { type: Number, required: true },
    data: { type: Buffer, required: true },
    // לאיזה מחולל ובאיזה תפקיד - לתיעוד ולניקוי; נכס אחד יכול לשמש כמה מחוללים
    usedBy: [{ generator: String, role: String }],
  },
  { timestamps: true },
);

export default mongoose.models.CertificateAsset ||
  mongoose.model("CertificateAsset", certificateAssetSchema);
