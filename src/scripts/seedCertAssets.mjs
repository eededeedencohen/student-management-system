/**
 * seedCertAssets.mjs - מזין ל-Mongo את נכסי מחוללי התעודות שחולצו ל-.cert-assets.
 *
 * הנכסים (רקעים, חותמות, לוגואים, פונטים) לא נמצאים בגיט כי הריפו ציבורי,
 * ולכן Mongo הוא מקור האמת היחיד - וכך גם Render מקבל אותם בלי צעד נוסף.
 * הסקריפט אידמפוטנטי: נכס שכבר קיים באותו sha לא נכתב מחדש.
 *
 *   node src/scripts/extractCertAssets.mjs     # קודם - מחלץ מקובצי ה-HTML
 *   node src/scripts/seedCertAssets.mjs        # דוח בלבד (dry run)
 *   node src/scripts/seedCertAssets.mjs --apply
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import CertificateAsset from "../models/CertificateAsset.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGING = path.resolve(HERE, "../../.cert-assets");
const apply = process.argv.includes("--apply");

const manifestPath = path.join(STAGING, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error(`לא נמצא ${manifestPath}`);
  console.error("הריצו קודם: node src/scripts/extractCertAssets.mjs");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// sha -> {mime, kind, usedBy[]}
const wanted = new Map();
for (const [generator, gen] of Object.entries(manifest.generators)) {
  for (const [kind, group] of [
    ["font", gen.fonts],
    ["image", gen.images],
  ]) {
    for (const [role, info] of Object.entries(group)) {
      const cur = wanted.get(info.sha) || { mime: info.mime, kind, bytes: info.bytes, usedBy: [] };
      cur.usedBy.push({ generator, role });
      wanted.set(info.sha, cur);
    }
  }
}

const uri =
  process.env.MONGODB_URI ||
  process.env.DATABASE?.replace("<PASSWORD>", process.env.DATABASE_PASSWORD || "");
await mongoose.connect(uri);

const existing = new Map(
  (await CertificateAsset.find({}, { sha: 1, bytes: 1 }).lean()).map((d) => [d.sha, d]),
);

let toInsert = 0;
let toUpdate = 0;
let insertBytes = 0;
for (const [sha, info] of wanted) {
  if (!existing.has(sha)) {
    toInsert++;
    insertBytes += info.bytes;
  } else {
    toUpdate++; // usedBy may have grown
  }
}
console.log(`מניפסט: ${wanted.size} נכסים ייחודיים`);
console.log(`  כבר במסד: ${toUpdate}`);
console.log(`  חדשים: ${toInsert} (${(insertBytes / 1024 / 1024).toFixed(2)} MB)`);

const stale = [...existing.keys()].filter((sha) => !wanted.has(sha));
if (stale.length) console.log(`  במסד ולא במניפסט: ${stale.length} (לא נוגעים בהם)`);

if (!apply) {
  console.log("\ndry run - להרצה בפועל: --apply");
  await mongoose.disconnect();
  process.exit(0);
}

const staged = fs.readdirSync(STAGING);
let written = 0;
for (const [sha, info] of wanted) {
  // הקובץ נכתב עם סיומת לפי ה-mime; מוצאים אותו לפי ה-sha
  const match = staged.find((f) => f.startsWith(`${sha}.`));
  if (!match) {
    console.warn(`  !! חסר קובץ עבור ${sha}`);
    continue;
  }
  const data = fs.readFileSync(path.join(STAGING, match));
  await CertificateAsset.updateOne(
    { sha },
    {
      $set: {
        sha,
        kind: info.kind,
        mime: info.mime,
        bytes: data.length,
        data,
        usedBy: info.usedBy,
      },
    },
    { upsert: true },
  );
  written++;
}

const after = await CertificateAsset.aggregate([
  { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: "$bytes" } } },
]);
console.log(`\nנכתבו ${written} נכסים.`);
console.log(
  `באוסף certificateassets: ${after[0]?.n || 0} מסמכים, ${((after[0]?.bytes || 0) / 1024 / 1024).toFixed(2)} MB`,
);
await mongoose.disconnect();
