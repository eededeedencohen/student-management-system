/**
 * ניקוי רשומות-ילד יתומות: קובצי חוזה (contractpdfs), אסמכתאות (paymentreceipts)
 * ועקיבות (sourcerefs) שמצביעים על עסקה שכבר לא קיימת.
 * מאז 2026-08-26 מחיקת עסקה מוחקת אותם אוטומטית (hook ב-Registration); הסקריפט
 * מנקה את מה שנשאר מלפני כן.
 *
 *   node src/scripts/cleanupOrphanFiles.js           -> דוח בלבד (dry run)
 *   node src/scripts/cleanupOrphanFiles.js --apply   -> מחיקה בפועל (לפי _id שנאספו)
 */
import "dotenv/config";
import mongoose from "mongoose";

const apply = process.argv.includes("--apply");
const uri =
  process.env.MONGODB_URI ||
  process.env.DATABASE?.replace("<PASSWORD>", process.env.DATABASE_PASSWORD || "");
await mongoose.connect(uri);
const db = mongoose.connection.db;

const regIds = new Set(
  (await db.collection("registrations").find({}, { projection: { _id: 1 } }).toArray()).map((r) => String(r._id)),
);

const TARGETS = [
  { col: "contractpdfs", field: "registration" },
  { col: "paymentreceipts", field: "registration" },
  { col: "sourcerefs", field: "deal" },
];

let totalBytes = 0;
for (const { col, field } of TARGETS) {
  const docs = await db.collection(col).find({}, { projection: { [field]: 1, byteLength: 1 } }).toArray();
  const orphans = docs.filter((d) => !regIds.has(String(d[field])));
  const bytes = orphans.reduce((s, d) => s + (d.byteLength || 0), 0);
  totalBytes += bytes;
  console.log(`${col}: ${docs.length} סה"כ, ${orphans.length} יתומים (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  if (apply && orphans.length) {
    // מחיקה לפי _id שנאספו בלבד - לעולם לא deleteMany עם מסנן ריק
    const ids = orphans.map((d) => d._id);
    const { deletedCount } = await db.collection(col).deleteMany({ _id: { $in: ids } });
    console.log(`   נמחקו ${deletedCount}`);
  }
}
console.log(apply ? "בוצע." : `dry run - להרצה בפועל: --apply (יפנה ~${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
await mongoose.disconnect();
