import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Expense = הוצאה. Fixed/recurring or variable. Used by the cash-flow forecast.
 * Advertising rows that appeared inside the reps' Excel sheets are imported here.
 */
const expenseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true }, // תיאור ההוצאה
    category: { type: String, trim: true, default: 'כללי' }, // קטגוריה (פרסום, שכר, שכירות...)
    amount: { type: Number, default: 0 }, // סכום
    vatIncluded: { type: Boolean, default: true }, // האם הסכום כולל מע"מ
    type: { type: String, enum: ['fixed', 'variable'], default: 'variable' }, // קבועה/משתנה
    // חזרתיות להוצאה קבועה
    recurrence: {
      type: String,
      enum: ['none', 'monthly', 'quarterly', 'yearly'],
      default: 'none',
    },
    dayOfMonth: { type: Number }, // יום בחודש לחיוב (להוצאה חוזרת)
    date: { type: Date }, // תאריך ההוצאה (להוצאה חד-פעמית)
    dateRaw: { type: String },
    startDate: { type: Date }, // ממתי ההוצאה החוזרת פעילה
    endDate: { type: Date },
    notes: { type: String, trim: true },
    sourceFile: { type: String },
    sourceSheet: { type: String },
    sourceRow: { type: Number },
  },
  { timestamps: true }
);

export default mongoose.models.Expense || mongoose.model('Expense', expenseSchema);
