import mongoose from 'mongoose';

const { Schema } = mongoose;

const cellSchema = new Schema(
  {
    v: { type: String, default: '' },
    bg: { type: String, default: null },
    color: { type: String, default: null },
    bold: { type: Boolean, default: false },
    italic: { type: Boolean, default: false },
    strike: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * SourceCourseBlock — יקיר's קורסים.xlsx is COLUMN-oriented: every course is a column
 * and the attribute labels ("שם הקורס", "מתאריך", "מרצה"…) sit in column A. This stores
 * one such column block, with styling, so the catalog page reads Mongo instead of
 * re-scanning the workbook on every request.
 */
const sourceCourseBlockSchema = new Schema(
  {
    file: { type: String, required: true },
    sheet: { type: String, default: '' },
    column: { type: Number }, // Excel column index of this course
    startRow: { type: Number }, // the "שם הקורס" row this block starts at
    courseName: { type: String, required: true, index: true }, // the value of "שם הקורס"
    entries: {
      type: [
        new Schema(
          { row: { type: Number }, label: cellSchema, value: cellSchema },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

// The sheet repeats blocks DOWN the page reusing the same column numbers, so the
// identity of a block is its course name (which is also how it is looked up).
sourceCourseBlockSchema.index({ file: 1, courseName: 1 }, { unique: true });

export default mongoose.models.SourceCourseBlock ||
  mongoose.model('SourceCourseBlock', sourceCourseBlockSchema);
