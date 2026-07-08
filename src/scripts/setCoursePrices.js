/**
 * setCoursePrices.js — derive a catalog price for every course from the EXISTING deals.
 *
 * The reps' deal totals vary per cohort (discounts, add-ons, messy rows), but a course
 * FAMILY has one standard price. So we take the most-common deal total across all cohorts
 * of a field (the mode) and set it as the price for every course in that field. Fields with
 * no deal data are left untouched (set them manually in the course form).
 *
 *   node src/scripts/setCoursePrices.js         # dry run (prints, no writes)
 *   node src/scripts/setCoursePrices.js --apply # writes Course.price
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const APPLY = process.argv.includes('--apply');
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');
const { default: Course } = await import('../models/Course.js');
const { buildCourseIndex, matchDealToCourse } = await import('../utils/courseMatch.js');

const norm = (s) => (s || '').replace(/["'׳״\s.]/g, '').toLowerCase();
const mode = (arr) => {
  if (!arr || !arr.length) return null;
  const c = {};
  for (const v of arr) c[v] = (c[v] || 0) + 1;
  // most frequent; tie → higher amount (prefer the list price over a discounted one)
  const [val, count] = Object.entries(c).sort(
    (a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0])
  )[0];
  return { price: Number(val), count, n: arr.length };
};

await connectDB();
const courses = await Course.find({}).lean();
const idx = buildCourseIndex(courses);
const deals = await Registration.find({ recordType: 'registration', totalAmount: { $gt: 0 } })
  .select('course courseField cohortLabel courseRaw dealDate totalAmount')
  .lean();

// Collect deal totals per field (only deals that actually match a course in that field).
const perField = new Map();
for (const d of deals) {
  if (!matchDealToCourse(d, idx)) continue; // ignore old/unmatched cohorts
  const f = norm(d.courseField);
  if (!perField.has(f)) perField.set(f, []);
  perField.get(f).push(d.totalAmount);
}
const fieldPrice = new Map();
for (const [f, arr] of perField) fieldPrice.set(f, mode(arr));

let updated = 0;
const skipped = [];
console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — course prices from field-level deal mode:\n`);
for (const c of courses) {
  const fp = fieldPrice.get(norm(c.field));
  if (!fp) {
    skipped.push(c.name);
    continue;
  }
  console.log(`  ${c.name.padEnd(28)} → ₪${fp.price}  (מתוך ${fp.count}/${fp.n} עסקאות בתחום "${c.field}")`);
  if (APPLY) {
    await Course.updateOne({ _id: c._id }, { $set: { price: fp.price } });
    updated += 1;
  }
}
console.log(`\n${APPLY ? `✅ updated ${updated} courses` : 'ℹ️ dry run — re-run with --apply to write'}`);
if (skipped.length) console.log(`⚠️ no deal data (price left as-is): ${skipped.join(', ')}`);

await disconnectDB();
process.exit(0);
