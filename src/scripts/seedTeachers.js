import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { connectDB, disconnectDB } = await import("../config/db.js");
const { default: Teacher } = await import("../models/Teacher.js");

/**
 * seedTeachers - creates the מרצים that appear in יקיר's קורסים.xlsx.
 *
 * The names are taken from the workbook's own data-validation list (the dropdown
 * he picks from in the "מרצה" row), which is the authoritative spelling - it also
 * contains lecturers not yet assigned to any course.
 *
 * Idempotent and additive: matches on fullName and NEVER updates or deletes an
 * existing teacher, so entries created by hand in the UI are left untouched.
 *
 *   node src/scripts/seedTeachers.js          # create what's missing
 *   node src/scripts/seedTeachers.js --dry    # only report
 */

/**
 * The dropdown list verbatim, with each entry's English handle for the email.
 * "יש לשבץ??" from the same list is deliberately absent - it is a to-do marker
 * ("needs assigning"), not a person.
 * "עמר לוין + אביטל דניאל" is one cell in the Excel but two lecturers, so it is
 * split here; a cohort can hold both (see CourseCohort.teachers).
 */
const TEACHERS = [
  { fullName: "אורטל כהן", handle: "ortal.cohen" },
  { fullName: "דורית חרמון", handle: "dorit.harmon" },
  { fullName: 'ד"ר ליזי שמעוני', handle: "lizi.shimoni" },
  { fullName: "יהונתן יפרח", handle: "yehonatan.yifrach" },
  { fullName: "עמר לוין", handle: "omer.levin" },
  { fullName: "אביטל דניאל", handle: "avital.daniel" },
  { fullName: "הילה לייזרוביץ' סעד", handle: "hila.leizerovich.saad" },
  { fullName: "רעות חמדני", handle: "reut.hamdani" },
  { fullName: "יקיר זקן", handle: "yakir.zaken" },
  { fullName: "לנה שיר דיאמנת", handle: "lena.shir.diamant" },
  { fullName: 'ד"ר דן הרמן', handle: "dan.herman" },
  { fullName: "אורלי סוהר", handle: "orly.sohar" },
];

const EMAIL_DOMAIN = "safra.org.il";
const PREFIXES = ["050", "052", "053", "054", "055", "058"];

/** טלפון אקראי בפורמט נייד ישראלי. הטלפון הוא המפתח העסקי, ולכן חייב להיות ייחודי. */
const randomPhone = (taken) => {
  for (let i = 0; i < 500; i += 1) {
    const prefix = PREFIXES[Math.floor(Math.random() * PREFIXES.length)];
    const rest = String(Math.floor(Math.random() * 10_000_000)).padStart(
      7,
      "0",
    );
    const phone = `${prefix}${rest}`;
    if (!taken.has(phone)) return phone;
  }
  throw new Error("לא הצלחתי להגריל טלפון פנוי");
};

const run = async () => {
  const dry = process.argv.includes("--dry");
  await connectDB();

  const existing = await Teacher.find({}).select("fullName phone email").lean();
  const byName = new Map(existing.map((t) => [t.fullName.trim(), t]));
  const takenPhones = new Set(existing.map((t) => t.phone));
  const takenEmails = new Set(
    existing.map((t) => (t.email || "").toLowerCase()),
  );

  const created = [];
  const skipped = [];

  for (const { fullName, handle } of TEACHERS) {
    const found = byName.get(fullName.trim());
    if (found) {
      skipped.push(`${fullName} - קיים כבר (${found.phone})`);
      continue;
    }
    let email = `${handle}@${EMAIL_DOMAIN}`;
    // התנגשות מייל תיאורטית (שני שמות שמתועתקים אותו הדבר) - מוסיפים סיפרה
    for (let n = 2; takenEmails.has(email); n += 1)
      email = `${handle}${n}@${EMAIL_DOMAIN}`;
    const phone = randomPhone(takenPhones);
    takenPhones.add(phone);
    takenEmails.add(email);

    const doc = {
      fullName,
      phone,
      email,
      notes:
        "נוצר אוטומטית מרשימת המרצים בקובץ קורסים.xlsx. טלפון אקראי - יש להחליף.",
    };
    if (!dry) await Teacher.create(doc);
    created.push(`${fullName} → ${phone} · ${email}`);
  }

  console.log(
    `\n${dry ? "[dry-run] היו נוצרים" : "נוצרו"} ${created.length} מרצים:`,
  );
  created.forEach((l) => console.log(`  + ${l}`));
  console.log(`\nדולגו ${skipped.length}:`);
  skipped.forEach((l) => console.log(`  = ${l}`));
  console.log(`\nסה"כ מרצים במערכת: ${await Teacher.countDocuments({})}`);

  await disconnectDB();
};

run().catch(async (err) => {
  console.error("❌", err.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
