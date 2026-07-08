import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Lead bookkeeping for close-rate calculations (אחוז סגירה ביחס לכמות הלידים).
 * The Excel files don't contain leads, so these are entered/tracked in the system.
 * Either log individual leads, or record an aggregate count per rep per period.
 */
const leadSchema = new Schema(
  {
    rep: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    repName: { type: String, trim: true },
    // individual lead (optional)
    name: { type: String, trim: true },
    phone: { type: String, trim: true },
    source: { type: String, trim: true }, // מקור הליד (TOCHAT, פייסבוק וכו')
    status: {
      type: String,
      enum: ['new', 'contacted', 'in_progress', 'won', 'lost'],
      default: 'new',
      index: true,
    },
    receivedDate: { type: Date, index: true },
    convertedRegistration: { type: Schema.Types.ObjectId, ref: 'Registration' },
    // aggregate mode: a bulk count of leads received in a period
    isAggregate: { type: Boolean, default: false },
    count: { type: Number, default: 1 }, // כמות לידים (במצב צבירה)
    periodStart: { type: Date },
    periodEnd: { type: Date },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

export default mongoose.models.Lead || mongoose.model('Lead', leadSchema);
