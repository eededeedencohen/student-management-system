/**
 * extractCertAssets.mjs - one-off extraction of the certificate generator assets.
 *
 * Reads the standalone generator HTML files (the originals under
 * "C:\2026\S\NLP Practitioner Certificate") and pulls every embedded base64
 * asset out into a staging folder, with a manifest that says which role each
 * file plays in which generator (background, seal, original signature, font).
 *
 * The staging folder is NOT committed: the repo is public and these are the
 * blank certificate templates plus the real signature images. seedCertAssets.mjs
 * loads the staging folder into Mongo, which is where the app reads them from.
 *
 *   node src/scripts/extractCertAssets.mjs            # extract + write manifest
 *   node src/scripts/extractCertAssets.mjs --list     # report only, write nothing
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../.cert-assets");
const LIST_ONLY = process.argv.includes("--list");

const SRC_ROOT = "C:/2026/S/NLP Practitioner Certificate";

/** The four generators the system exposes. "clinic" exists too but is not wired up. */
const GENERATORS = {
  horim: {
    file: `${SRC_ROOT}/מחולל תעודות.html`,
    title: "הדרכת הורים",
  },
  nlp: {
    file: `${SRC_ROOT}/NLP PRACTITIONER/מחולל תעודות NLP.html`,
    title: "NLP פרקטישינר",
  },
  trauma: {
    file: `${SRC_ROOT}/מחולל תעודת קורס טראומה וחרדה.html`,
    title: "טראומה וחרדה",
  },
  master: {
    file: `${SRC_ROOT}/מחולל תעודות NLP מאסטר.html`,
    title: "NLP מאסטר",
  },
  clinic: {
    file: `${SRC_ROOT}/תעודת מקימים קליניקה/מחולל תעודות מקימים קליניקה.html`,
    title: "מקימים קליניקה",
  },
};

const EXT = {
  "font/ttf": "ttf",
  "font/woff2": "woff2",
  "image/png": "png",
  "image/jpeg": "jpg",
};

const B64 = /data:([a-z/+-]+);base64,([A-Za-z0-9+/=]{200,})/g;

/**
 * Work out what a payload IS from the markup immediately before it.
 * Fonts carry a font-family; images carry an id/class on their <img>, or the
 * name of the const they are assigned to.
 *
 * `sheetId` is the id of the enclosing <div class="sheet">, tracked by the
 * caller: the payloads are megabytes long, so the sheet's opening tag is far
 * outside any window we can afford to re-scan per match.
 */
function roleOf(before, sheetId) {
  const fam = [...before.matchAll(/font-family:'([\w-]+)'/g)].pop();
  if (fam) return { kind: "font", role: fam[1] };

  const cnst = before.match(/const\s+([A-Z][A-Z_0-9]*)\s*=\s*"?$/);
  if (cnst) return { kind: "image", role: cnst[1] };

  // nearest <img ...> that this src belongs to
  const img = [...before.matchAll(/<img\b([^>]*)$/g)].pop();
  if (img) {
    const attrs = img[1];
    const id = attrs.match(/id="([\w-]+)"/);
    if (id) return { kind: "image", role: id[1] };
    const cls = attrs.match(/class="([\w .-]+)"/);
    if (cls) {
      const variant = cls[1].replace(/\bbg\b/, "").trim().replace(/\s+/g, "_");
      const base = sheetId || "sheet";
      return { kind: "image", role: variant ? `${base}_${variant}` : base };
    }
  }
  return { kind: "image", role: "asset" };
}

const files = new Map(); // sha -> {name, mime, bytes}
const manifest = {};
let totalBytes = 0;

for (const [key, gen] of Object.entries(GENERATORS)) {
  if (!fs.existsSync(gen.file)) {
    console.warn(`  !! missing generator source: ${gen.file}`);
    continue;
  }
  const src = fs.readFileSync(gen.file, "utf8");
  const entry = { title: gen.title, source: path.basename(gen.file), fonts: {}, images: {} };
  const seenRole = new Set();

  B64.lastIndex = 0;
  let m;
  let scanned = 0; // how much of src we have already swept for sheet ids
  let sheetId = null;
  while ((m = B64.exec(src))) {
    const [, mime, b64] = m;
    // sweep the gap since the previous payload for the enclosing sheet's id
    const gap = src.slice(scanned, m.index);
    const sheetHit = [...gap.matchAll(/id="(sheet\w+)"/g)].pop();
    if (sheetHit) sheetId = sheetHit[1];
    scanned = m.index + m[0].length;

    const raw = Buffer.from(b64, "base64");
    const sha = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
    const { kind, role } = roleOf(src.slice(Math.max(0, m.index - 300), m.index), sheetId);

    // a role can legitimately appear once per generator; if it repeats, suffix it
    let uniq = role;
    let n = 2;
    while (seenRole.has(`${kind}:${uniq}`)) uniq = `${role}${n++}`;
    seenRole.add(`${kind}:${uniq}`);

    const ext = EXT[mime] || "bin";
    const name = `${sha}.${ext}`;
    if (!files.has(sha)) {
      files.set(sha, { name, mime, bytes: raw.length, raw });
      totalBytes += raw.length;
    }
    (kind === "font" ? entry.fonts : entry.images)[uniq] = { sha, mime, bytes: raw.length };
  }
  manifest[key] = entry;
  const nF = Object.keys(entry.fonts).length;
  const nI = Object.keys(entry.images).length;
  console.log(`${key.padEnd(8)} ${gen.title.padEnd(18)} fonts=${nF} images=${nI}`);
  for (const [r, v] of Object.entries(entry.images)) {
    console.log(`           image ${r.padEnd(18)} ${String(Math.round(v.bytes / 1024)).padStart(6)} KB  ${v.sha}`);
  }
  for (const [r, v] of Object.entries(entry.fonts)) {
    console.log(`           font  ${r.padEnd(18)} ${String(Math.round(v.bytes / 1024)).padStart(6)} KB  ${v.sha}`);
  }
}

console.log(`\nunique files: ${files.size}, total ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

if (LIST_ONLY) {
  console.log("(--list: nothing written)");
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
for (const { name, raw } of files.values()) {
  fs.writeFileSync(path.join(OUT, name), raw);
}
fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), generators: manifest }, null, 1),
  "utf8"
);
console.log(`\nwrote ${files.size} files + manifest.json to ${OUT}`);
console.log("this folder is gitignored on purpose - next step: node src/scripts/seedCertAssets.mjs");
