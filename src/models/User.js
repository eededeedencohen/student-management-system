import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const { Schema } = mongoose;

/**
 * User = sales reps (נציגות מכירה) + manager (מנהל מכירות).
 * Commission config lets the system compute each rep's salary (base + %).
 */
const commissionSchema = new Schema(
  {
    baseSalary: { type: Number, default: 0 }, // בסיס
    commissionRate: { type: Number, default: 0 }, // אחוז עמלה מהמכירות (0-1)
    // אבני דרך/מדרגות עמלה אופציונליות: מעל סכום מכירות X -> אחוז Y
    tiers: [
      {
        fromSales: { type: Number, default: 0 },
        rate: { type: Number, default: 0 },
      },
    ],
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true, index: true },
    passwordHash: { type: String, select: false },
    role: { type: String, enum: ['manager', 'rep'], default: 'rep', index: true },
    // super-admin may "view as" (impersonate) any user from within the app.
    superAdmin: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    phone: { type: String, trim: true },
    // כינויים/שמות חלופיים שמופיעים באקסלים (לזיהוי בעת ייבוא)
    aliases: [{ type: String, trim: true }],
    commission: { type: commissionSchema, default: () => ({}) },
  },
  { timestamps: true }
);
userSchema.methods.setPassword = async function setPassword(plain) {
  this.passwordHash = await bcrypt.hash(plain, 10);
};

userSchema.methods.verifyPassword = async function verifyPassword(plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

export default mongoose.models.User || mongoose.model('User', userSchema);