import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * A stored copy of the generated signed-contract PDF, so it can be re-emailed later
 * from the "מיילים" page without re-generating it in the browser. One doc per
 * Registration. Kept in its own collection so the large base64 never loads with
 * ordinary Registration queries.
 */
const contractPdfSchema = new Schema(
  {
    registration: { type: Schema.Types.ObjectId, ref: 'Registration', unique: true, index: true },
    token: { type: String }, // the contract token (traceability)
    filename: { type: String },
    pdfBase64: { type: String }, // the PDF, base64 (no data: prefix)
    byteLength: { type: Number }, // length of the base64 string (rough size)
  },
  { timestamps: true },
);

export default mongoose.models.ContractPdf ||
  mongoose.model('ContractPdf', contractPdfSchema);
