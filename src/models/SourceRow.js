import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * A single styled cell copied out of a rep's original workbook.
 * Colors are already resolved to CSS hex by utils/excelStyled.js.
 */
const cellSchema = new Schema(
  {
    v: { type: String, default: '' }, // the displayed text
    bg: { type: String, default: null }, // fill color, "#RRGGBB"
    color: { type: String, default: null }, // font color
    bold: { type: Boolean, default: false },
    italic: { type: Boolean, default: false },
    strike: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * SourceRow — one ROW of an original Excel workbook, WITH its styling, stored in Mongo.
 *
 * Why: the editing pages need to show the reps exactly what they wrote (colors and all),
 * but parsing a 1000-row .xlsx per request is slow and depends on the files sitting next
 * to the server. `scripts/importExcelSource.js` parses each workbook ONCE into this
 * collection, so the pages read plain Mongo documents.
 *
 * `row` is the real Excel row number (header = row 1), so it lines up with
 * Registration.sourceRow / SourceRef.sourceRow.
 */
const sourceRowSchema = new Schema(
  {
    file: { type: String, required: true, index: true }, // e.g. "מורן.xlsx"
    sheet: { type: String, default: '' },
    row: { type: Number, required: true }, // 1-based Excel row number
    isHeader: { type: Boolean, default: false }, // row 1 of the sheet
    cells: { type: [cellSchema], default: [] },
  },
  { timestamps: true },
);

// One document per file+sheet+row; the lookup is always by this triple.
sourceRowSchema.index({ file: 1, sheet: 1, row: 1 }, { unique: true });

export default mongoose.models.SourceRow || mongoose.model('SourceRow', sourceRowSchema);
