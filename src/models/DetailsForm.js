import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * DetailsForm - טופס השלמת פרטים אישיים לנרשמי מחזור (עמוד "ניהול טפסים").
 * טופס אחד לכל מחזור; הסטודנטים ממלאים דרך קישור ציבורי עם token אקראי,
 * וההגשות נשמרות כ-DetailsSubmission.
 */
const detailsFormSchema = new Schema(
  {
    cohort: {
      type: Schema.Types.ObjectId,
      ref: "CourseCohort",
      required: true,
      unique: true,
    },
    token: { type: String, required: true, unique: true, index: true },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true },
);

export default mongoose.models.DetailsForm ||
  mongoose.model("DetailsForm", detailsFormSchema);
