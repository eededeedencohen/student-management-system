import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Goal = יעד / אבן דרך. A target for a rep (or the whole team / manager) over a
 * period. The dashboard compares actual progress vs. the time elapsed in the period
 * to decide if the rep is "on track" / "behind" / "at risk".
 */
const goalSchema = new Schema(
  {
    title: { type: String, trim: true }, // כותרת היעד
    rep: { type: Schema.Types.ObjectId, ref: 'User', index: true }, // null = יעד צוותי/מנהל
    scope: { type: String, enum: ['rep', 'team'], default: 'rep' },
    metric: {
      type: String,
      enum: ['salesAmount', 'dealsCount', 'collectedAmount', 'closeRate'],
      default: 'salesAmount',
    }, // מדד: ש"ח מכירות / כמות עסקאות / סכום שנגבה / אחוז סגירה
    targetValue: { type: Number, required: true }, // ערך היעד
    periodType: {
      type: String,
      enum: ['month', 'quarter', 'half', 'year', 'custom'],
      default: 'month',
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    workingDays: { type: Number }, // ימי עבודה בתקופה (לחישוב "האם בקצב")
    notes: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.models.Goal || mongoose.model('Goal', goalSchema);
