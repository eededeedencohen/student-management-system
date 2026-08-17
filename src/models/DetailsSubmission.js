import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * DetailsSubmission - הגשה אחת של טופס השלמת פרטים (DetailsForm).
 * אותם שדות כמו שלב "פרטים אישיים" בטופס העסקה; ההתאמה לסטודנט ברשימת
 * הנרשמים נעשית דינמית בעמוד הניהול (לפי ת.ז. / טלפון / שם) ולא נשמרת כאן.
 */
const detailsSubmissionSchema = new Schema(
  {
    form: {
      type: Schema.Types.ObjectId,
      ref: "DetailsForm",
      required: true,
      index: true,
    },
    cohort: { type: Schema.Types.ObjectId, ref: "CourseCohort", index: true },

    firstNameHe: { type: String, trim: true },
    lastNameHe: { type: String, trim: true },
    firstNameEn: { type: String, trim: true },
    lastNameEn: { type: String, trim: true },
    idNumber: { type: String, trim: true },
    gender: { type: String, enum: ["male", "female"] },
    title: { type: String, trim: true }, // .Mr / .Ms / .Mrs (רלוונטי לפרקטישינר)
    city: { type: String, trim: true },
    street: { type: String, trim: true },
    houseNumber: { type: String, trim: true },
    apartment: { type: String, trim: true },
    zip: { type: String, trim: true },
    addressNotes: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
  },
  { timestamps: true },
);

export default mongoose.models.DetailsSubmission ||
  mongoose.model("DetailsSubmission", detailsSubmissionSchema);
