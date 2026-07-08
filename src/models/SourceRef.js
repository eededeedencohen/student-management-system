import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * SourceRef — temporary traceability bridge during the migration to the v2 deal format.
 * Links a deal (Registration) — or a single payment inside it — back to the exact Excel
 * row it originated from, WITHOUT storing that reference on the deal itself.
 *
 *   kind='deal'    → { deal, sourceFile, sourceRow }
 *   kind='payment' → { deal, payment (subdoc _id), sourceFile, sourceRow }
 *
 * Once all legacy data is corrected into the clean format this collection can be dropped.
 */
const sourceRefSchema = new Schema(
  {
    deal: { type: Schema.Types.ObjectId, ref: 'Registration', index: true, required: true },
    payment: { type: Schema.Types.ObjectId, default: null, index: true }, // payment subdoc _id (null = deal-level)
    kind: { type: String, enum: ['deal', 'payment'], default: 'deal', index: true },
    sourceFile: { type: String },
    sourceSheet: { type: String },
    sourceRow: { type: Number },
    note: { type: String, trim: true },
  },
  { timestamps: true }
);

sourceRefSchema.index({ deal: 1, payment: 1 });

export default mongoose.models.SourceRef || mongoose.model('SourceRef', sourceRefSchema);
