import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * אסמכתת העברה בנקאית - תמונת האישור של תשלום ספציפי בעסקה.
 * נשמרת באוסף נפרד (כמו ContractPdf) כדי שה-base64 הגדול לא ייטען עם כל
 * שליפת עסקה; על התשלום עצמו נשמרים רק receiptImage (דגל) ומספר האסמכתא.
 */
const paymentReceiptSchema = new Schema(
  {
    registration: {
      type: Schema.Types.ObjectId,
      ref: "Registration",
      required: true,
    },
    paymentId: { type: Schema.Types.ObjectId, required: true }, // _id של התשלום במערך payments
    imageDataUrl: { type: String }, // data:image/...;base64,...
    byteLength: { type: Number }, // אורך המחרוזת (גודל משוער)
    uploadedAt: { type: Date },
    uploadedByName: { type: String },
  },
  { timestamps: true },
);

paymentReceiptSchema.index({ registration: 1, paymentId: 1 }, { unique: true });

export default mongoose.model("PaymentReceipt", paymentReceiptSchema);
