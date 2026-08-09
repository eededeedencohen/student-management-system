import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * Quote = הצעת מחיר שמורה. נשמרת מתוך מחולל ההצעות (/quotes) כדי שאפשר יהיה
 * לחזור אליה, להפיק שוב את ה-PDF ולעקוb אחרי מצבה בסטטוס ידני.
 * נציגה רואה ומנהלת את ההצעות שלה; מנהל רואה את כולן.
 * השדות משקפים 1:1 את טופס המחולל - תאריכים נשמרים כמחרוזות YYYY-MM-DD
 * כדי שהטעינה חזרה לטופס תהיה זהה למה שנשמר.
 */
const quoteSchema = new Schema(
  {
    quoteNo: { type: String, trim: true },
    // סטטוס ידני - הנציגה מעדכנת בעצמה איפה ההצעה עומדת
    status: {
      type: String,
      enum: ["draft", "sent", "followup", "won", "lost"],
      default: "draft",
      index: true,
    },
    statusAt: { type: Date }, // עדכון הסטטוס האחרון
    statusByName: { type: String },

    // פרטי המתעניין/ת
    fullName: { type: String, trim: true },
    phone: { type: String, trim: true },
    idNumber: { type: String, trim: true },

    // תוכן ההצעה
    courseName: { type: String, trim: true },
    description: { type: String, trim: true },
    price: { type: Number, default: 0 },
    sessions: { type: Number },
    sessionLength: { type: String, trim: true },
    schedule: { type: String, trim: true },
    place: { type: String, trim: true },
    method: { type: String, trim: true },
    startDate: { type: String, trim: true }, // YYYY-MM-DD (כמו בטופס)
    endDate: { type: String, trim: true },
    recordedLine: { type: String, trim: true },
    notes: { type: String, trim: true },

    // מי יצר - הבסיס להרשאות (נציגה רואה רק את שלה)
    createdBy: { type: Schema.Types.ObjectId, ref: "User", index: true },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true },
);

quoteSchema.index({ createdAt: -1 });

export default mongoose.models.Quote || mongoose.model("Quote", quoteSchema);
