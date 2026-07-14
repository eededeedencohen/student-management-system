import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * רישום כניסות למערכת - מי נכנס ומתי. נכתב בכל התחברות (login-as/login) ומשמש
 * את מסך "פעילות התחברות" של מנהל-העל (עדן) בלבד, ורק בהרצה מקומית (localhost).
 */
const loginEventSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    name: { type: String },
    role: { type: String },
    superAdmin: { type: Boolean, default: false },
    at: { type: Date, default: Date.now, index: true },
    ip: { type: String },
    userAgent: { type: String },
  },
  { timestamps: false },
);

export default mongoose.models.LoginEvent ||
  mongoose.model("LoginEvent", loginEventSchema);
