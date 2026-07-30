import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: CatalogCourse } = await import('../models/CatalogCourse.js');

/**
 * seedCatalogCourses — creates the קורסים קטלוגיים from יקיר's summary table
 * (course name / price / default session count).
 *
 * Idempotent and additive: matches on name and NEVER updates or deletes an existing
 * course, so prices edited by hand in the UI are left untouched.
 *
 *   node src/scripts/seedCatalogCourses.js          # create what's missing
 *   node src/scripts/seedCatalogCourses.js --dry    # only report
 */

/** [שם הקורס, מחיר, כמות מפגשים ברירת מחדל] — כפי שנרשם בטבלת הסיכום. */
const COURSES = [
  ['NLP פרקטישינר', 5900, 18],
  ['טראומה וחרדה', 5900, 12],
  ['הדרכת הורים', 5900, 22],
  ['ייעוץ זוגי', 5900, 23],
  ['מאסטר תרפי', 2480, 8],
  ['טראנס וסוגסטיה', 4900, 8],
  ['מאסטר NLP', 4900, 16],
  ['אורח חיים בריא', 0, 20], // המחיר נרשם 0 בטבלה — יש לעדכן אם אינו נכון
  ['מרצים בכירים', 5900, 9],
  ['טוני רובינס', 4900, 8],
];

const run = async () => {
  const dry = process.argv.includes('--dry');
  await connectDB();

  const existing = await CatalogCourse.find({}).select('name price defaultSessionCount').lean();
  const byName = new Map(existing.map((c) => [c.name.trim(), c]));

  const created = [];
  const skipped = [];

  for (const [name, price, sessions] of COURSES) {
    const found = byName.get(name.trim());
    if (found) {
      const same = found.price === price && found.defaultSessionCount === sessions;
      skipped.push(
        `${name} — קיים כבר (${found.price} ₪ / ${found.defaultSessionCount} מפגשים)` +
          (same ? '' : ` ⚠ שונה מהטבלה (${price} ₪ / ${sessions}) — לא עודכן`),
      );
      continue;
    }
    if (!dry) await CatalogCourse.create({ name, price, defaultSessionCount: sessions });
    created.push(`${name} → ${price} ₪ · ${sessions} מפגשים`);
  }

  console.log(`\n${dry ? '[dry-run] היו נוצרים' : 'נוצרו'} ${created.length} קורסים:`);
  created.forEach((l) => console.log(`  + ${l}`));
  console.log(`\nדולגו ${skipped.length}:`);
  skipped.forEach((l) => console.log(`  = ${l}`));
  console.log(`\nסה"כ קורסים במערכת: ${await CatalogCourse.countDocuments({})}`);

  await disconnectDB();
};

run().catch(async (err) => {
  console.error('❌', err.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
