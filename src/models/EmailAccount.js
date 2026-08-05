import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * The single Google account connected for outbound email (עדן connects it once).
 * A singleton: one document keyed `key:'primary'`. Tokens are `select:false` so they
 * are never returned by accident - only the status endpoint's whitelisted fields go out.
 */
const emailAccountSchema = new Schema(
  {
    key: { type: String, default: "primary", unique: true, index: true },
    email: { type: String, trim: true, lowercase: true }, // the connected Gmail address
    accessToken: { type: String, select: false },
    refreshToken: { type: String, select: false },
    expiryDate: { type: Date }, // when the current access token expires
    scope: { type: String },
    connectedById: { type: String }, // the super-admin who connected it
    connectedByName: { type: String },
    connectedAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.models.EmailAccount ||
  mongoose.model("EmailAccount", emailAccountSchema);
