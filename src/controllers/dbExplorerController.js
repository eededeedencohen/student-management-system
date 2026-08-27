import mongoose from "mongoose";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import {
  DOMAINS,
  COLLECTIONS,
  FIELD_HE,
  FIELD_HE_BY_PATH,
  EXTRA_FKS,
  REDACTED_FIELDS,
  LONG_BINARY_FIELDS,
  DISPLAY_FIELDS,
} from "../utils/dbExplorerMeta.js";
// כל המודלים נרשמים כאן במפורש, כדי שהמבוא יראה את כולם גם אם קונטרולר אחר עוד לא נטען
import "../models/CatalogCourse.js";
import "../models/ContractPdf.js";
import "../models/Course.js";
import "../models/CourseCohort.js";
import "../models/DetailsForm.js";
import "../models/DetailsSubmission.js";
import "../models/EmailAccount.js";
import "../models/Expense.js";
import "../models/Goal.js";
import "../models/LoginEvent.js";
import "../models/PaymentReceipt.js";
import "../models/Quote.js";
import "../models/QuotePdf.js";
import "../models/QuoteTemplate.js";
import "../models/Registration.js";
import "../models/SourceCourseBlock.js";
import "../models/SourceRef.js";
import "../models/SourceRow.js";
import "../models/Student.js";
import "../models/Teacher.js";
import "../models/User.js";

/**
 * עמוד "מסד הנתונים" (מנהל-העל, קריאה בלבד): מבוא אוטומטי של כל מודלי Mongoose -
 * שדות, סוגים, מפתחות (PK/FK ולאן), אינדקסים, קשרים נכנסים/יוצאים, ספירות ונפח -
 * ודפדוף ברשומות עם פענוח שמות של מזהי FK. סודות (סיסמאות/טוקנים) לעולם לא נשלחים,
 * ומחרוזות base64 נשלחות מקוצרות.
 */

const { ObjectId } = mongoose.Types;

const modelsByCollection = () => {
  const map = {};
  for (const m of Object.values(mongoose.models)) map[m.collection.name] = m;
  return map;
};

const refToCollection = (ref) => {
  if (!ref || typeof ref !== "string") return null;
  const m = mongoose.models[ref];
  return m ? m.collection.name : null;
};

const describeDefault = (d) => {
  if (d === undefined) return undefined;
  if (typeof d === "function") return "(פונקציה)";
  if (d instanceof Date) return d.toISOString();
  try {
    return JSON.stringify(d);
  } catch {
    return String(d);
  }
};

const heFor = (collection, path, name) =>
  FIELD_HE_BY_PATH[`${collection}.${path}`] ||
  FIELD_HE_BY_PATH[`${collection}.${path.replace(/\[\]/g, "")}`] ||
  FIELD_HE[name] ||
  "";

/** הליכה רקורסיבית על סכימה: מחזירה רשימת שדות שטוחה עם נתיב מלא (a.b[].c). */
function walkSchema(schema, prefix, collection, out) {
  for (const [path, st] of Object.entries(schema.paths)) {
    if (path === "__v") continue;
    const full = prefix ? `${prefix}.${path}` : path;
    const name = path.split(".").pop();
    const opts = st.options || {};
    const entry = {
      path: full,
      name,
      he: heFor(collection, full, name),
      depth: (prefix.match(/\./g) || []).length + (prefix ? 1 : 0),
      type: st.instance || "Mixed",
      required: Boolean(opts.required),
      hidden: opts.select === false,
      index: Boolean(opts.index),
      unique: Boolean(opts.unique),
      sparse: Boolean(opts.sparse),
      enum: undefined,
      default: describeDefault(opts.default),
      ref: undefined,
      refCollection: undefined,
      lowercase: Boolean(opts.lowercase),
    };
    if (Array.isArray(opts.enum)) entry.enum = opts.enum;
    else if (opts.enum?.values) entry.enum = opts.enum.values;
    if (st.instance === "Array") {
      if (st.schema) {
        entry.type = "Array<Subdoc>";
        out.push(entry);
        walkSchema(st.schema, `${full}[]`, collection, out);
        continue;
      }
      const caster = st.caster || {};
      const cOpts = caster.options || {};
      entry.type = `Array<${caster.instance || "Mixed"}>`;
      if (cOpts.ref) {
        entry.ref = cOpts.ref;
        entry.refCollection = refToCollection(cOpts.ref);
      }
      if (Array.isArray(cOpts.enum)) entry.enum = cOpts.enum;
      out.push(entry);
      continue;
    }
    if (st.instance === "Embedded" || (st.schema && st.instance !== "Array")) {
      entry.type = "Subdoc";
      out.push(entry);
      walkSchema(st.schema, full, collection, out);
      continue;
    }
    if (st.instance === "ObjectId" && opts.ref) {
      entry.ref = opts.ref;
      entry.refCollection = refToCollection(opts.ref);
    }
    out.push(entry);
  }
}

// ---- בניית תיאור הסכימה (עם מטמון קצר - החישוב סורק מסמכים לאחוזי אכלוס) ----
let schemaCache = { at: 0, data: null };

async function buildSchema() {
  const db = mongoose.connection.db;
  const models = modelsByCollection();
  const collections = [];

  for (const [collName, model] of Object.entries(models)) {
    const fields = [];
    walkSchema(model.schema, "", collName, fields);
    // מפתחות: PK = _id; FK = ref בסכימה או EXTRA_FKS
    for (const f of fields) {
      f.pk = f.path === "_id";
      const extra = EXTRA_FKS[`${collName}.${f.path}`];
      if (extra) {
        f.fk = true;
        f.refCollection = extra.target;
        f.refPath = extra.targetPath;
        f.refNote = extra.note;
      } else if (f.refCollection) {
        f.fk = true;
        f.refPath = "_id";
      } else f.fk = false;
      if (f.pk) f.he = f.he || "מזהה";
    }
    // _id של תת-מסמכים במערכים (payments[]._id וכו') - Mongoose לא מציג אותם ב-paths של ההורה
    // אבל הם קיימים ב-schema.paths של תת-הסכימה, אז הם כבר נכללו.

    // אינדקסים חיים מ-Atlas
    let indexes = [];
    try {
      indexes = (await db.collection(collName).indexes()).map((i) => ({
        name: i.name,
        key: i.key,
        unique: Boolean(i.unique),
        sparse: Boolean(i.sparse),
        expireAfterSeconds: i.expireAfterSeconds,
      }));
    } catch {
      indexes = [];
    }

    // סטטיסטיקה
    let stats = { count: 0, size: 0, storageSize: 0, avgObjSize: 0, totalIndexSize: 0 };
    try {
      const s = await db.command({ collStats: collName });
      stats = {
        count: s.count,
        size: s.size,
        storageSize: s.storageSize,
        avgObjSize: s.avgObjSize || 0,
        totalIndexSize: s.totalIndexSize,
      };
    } catch {
      stats.count = await db.collection(collName).countDocuments();
    }

    // אחוז אכלוס לשדות ברמה העליונה (בלי לטעון base64)
    const projection = {};
    for (const f of fields) if (f.depth === 0 && LONG_BINARY_FIELDS.has(f.name)) projection[f.path] = 0;
    const sample = await db.collection(collName).find({}, { projection }).limit(2000).toArray();
    const presence = {};
    for (const d of sample) for (const k of Object.keys(d)) presence[k] = (presence[k] || 0) + 1;
    const extraKeys = [];
    for (const f of fields) {
      if (f.depth !== 0) continue;
      f.fillPct = sample.length ? Math.round(((presence[f.name] || 0) / sample.length) * 100) : 0;
    }
    const known = new Set(fields.filter((f) => f.depth === 0).map((f) => f.name));
    for (const k of Object.keys(presence)) {
      if (!known.has(k) && k !== "__v") {
        extraKeys.push({ name: k, fillPct: Math.round((presence[k] / sample.length) * 100) });
      }
    }

    await countBrokenFks(db, collName, fields);

    const meta = COLLECTIONS[collName] || { he: collName, domain: "tools", desc: "" };
    collections.push({
      collection: collName,
      model: model.modelName,
      file: `server/src/models/${model.modelName}.js`,
      he: meta.he,
      domain: meta.domain,
      desc: meta.desc,
      timestamps: Boolean(model.schema.options?.timestamps),
      stats,
      indexes,
      fields,
      // שדות שקיימים במסמכים אבל לא בסכימה (שאריות)
      orphanKeys: extraKeys,
      outgoing: fields
        .filter((f) => f.fk)
        .map((f) => ({ field: f.path, he: f.he, target: f.refCollection, targetPath: f.refPath, note: f.refNote, brokenCount: f.brokenCount })),
      incoming: [],
    });
  }

  // קשרים נכנסים
  const byName = Object.fromEntries(collections.map((c) => [c.collection, c]));
  for (const c of collections) {
    for (const o of c.outgoing) {
      const t = byName[o.target];
      if (!t) continue;
      t.incoming.push({ from: c.collection, fromHe: c.he, field: o.field, he: o.he, targetPath: o.targetPath, note: o.note });
    }
  }
  const order = DOMAINS.map((d) => d.key);
  collections.sort((a, b) => order.indexOf(a.domain) - order.indexOf(b.domain) || b.stats.count - a.stats.count);
  return { domains: DOMAINS, collections, generatedAt: new Date() };
}

export const schema = asyncHandler(async (req, res) => {
  const fresh = req.query.refresh === "1";
  if (!fresh && schemaCache.data && Date.now() - schemaCache.at < 60_000) {
    return res.json({ success: true, data: schemaCache.data });
  }
  const data = await buildSchema();
  schemaCache = { at: Date.now(), data };
  res.json({ success: true, data });
});

// ---- רשומות ----

const getCollectionInfo = async (collName) => {
  if (!schemaCache.data || Date.now() - schemaCache.at > 60_000) {
    schemaCache = { at: Date.now(), data: await buildSchema() };
  }
  const info = schemaCache.data.collections.find((c) => c.collection === collName);
  if (!info) throw ApiError.notFound(`אוסף לא מוכר: ${collName}`);
  return info;
};

/** שלבי אגרגציה שמסתירים סודות ומקצרים base64 - לפי שדות הסכימה של האוסף. */
const safetyStages = (info) => {
  const addFields = {};
  for (const f of info.fields) {
    const p = f.path.replace(/\[\]/g, "");
    if (f.path.includes("[]")) continue; // בתוך מערכים - מטופל אחרי השליפה ב-JS
    // הורה שכבר הוחלף (למשל passwordReset) - צאצאיו לא יכולים להופיע גם כן ב-$addFields
    if (Object.keys(addFields).some((k) => p.startsWith(`${k}.`))) continue;
    if (REDACTED_FIELDS.has(f.name) || f.hidden) {
      addFields[p] = { $cond: [{ $eq: [{ $type: `$${p}` }, "missing"] }, "$$REMOVE", "••• (מוסתר)"] };
    } else if (LONG_BINARY_FIELDS.has(f.name)) {
      addFields[p] = {
        $cond: [
          { $eq: [{ $type: `$${p}` }, "string"] },
          {
            $concat: [
              { $substrCP: [`$${p}`, 0, 48] },
              "… (",
              { $toString: { $strLenCP: `$${p}` } },
              " תווים)",
            ],
          },
          `$${p}`,
        ],
      };
    }
  }
  return Object.keys(addFields).length ? [{ $addFields: addFields }] : [];
};

/** ניקוי בטיחות ב-JS לערכים בתוך מערכים/עומק (למקרה שלא כוסה באגרגציה). */
const scrub = (v, key = "") => {
  if (v == null) return v;
  if (REDACTED_FIELDS.has(key)) return "••• (מוסתר)";
  if (typeof v === "string") {
    if (LONG_BINARY_FIELDS.has(key) && v.length > 60) return `${v.slice(0, 48)}… (${v.length} תווים)`;
    if (v.length > 4000) return `${v.slice(0, 4000)}… (${v.length} תווים)`;
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x));
  if (v instanceof Date || v instanceof ObjectId) return v;
  if (typeof v === "object" && v._bsontype) return v;
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
  return v;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ערכים בנתיב עם תמיכה במערכים: "payments[].confirmedBy" */
const valuesAtPath = (doc, path) => {
  const parts = path.split(".");
  let cur = [doc];
  for (const raw of parts) {
    const isArr = raw.endsWith("[]");
    const key = isArr ? raw.slice(0, -2) : raw;
    const next = [];
    for (const c of cur) {
      if (c == null || typeof c !== "object") continue;
      const v = c[key];
      if (v == null) continue;
      if (isArr || Array.isArray(v)) next.push(...(Array.isArray(v) ? v : [v]));
      else next.push(v);
    }
    cur = next;
  }
  return cur;
};

/** מפענח שמות תצוגה למזהי FK: { אוסף: { id: "שם" } } */
async function resolveFkNames(info, docs) {
  const db = mongoose.connection.db;
  const wanted = {}; // collection -> Set(ids)
  for (const f of info.fields) {
    if (!f.fk || f.refPath !== "_id") continue;
    for (const d of docs) {
      for (const v of valuesAtPath(d, f.path)) {
        const id = v instanceof ObjectId ? v : ObjectId.isValid(String(v)) && String(v).length === 24 ? new ObjectId(String(v)) : null;
        if (!id) continue;
        (wanted[f.refCollection] ||= new Set()).add(String(id));
      }
    }
  }
  const out = {};
  for (const [coll, ids] of Object.entries(wanted)) {
    const fieldsToShow = DISPLAY_FIELDS[coll] || ["name", "fullName", "label", "title"];
    const projection = Object.fromEntries(fieldsToShow.map((x) => [x, 1]));
    const rows = await db
      .collection(coll)
      .find({ _id: { $in: [...ids].map((x) => new ObjectId(x)) } }, { projection })
      .toArray();
    out[coll] = {};
    // מזהה שלא נמצא ביעד = הפניה שבורה (FK יתום) - מסומן כ-null כדי שהלקוח יציג "לא קיים"
    for (const id of ids) out[coll][id] = null;
    for (const r of rows) {
      const label = fieldsToShow.map((x) => r[x]).filter(Boolean).join(" · ");
      out[coll][String(r._id)] = label || String(r._id);
    }
  }
  return out;
}

/** לכל FK ברמה העליונה: כמה מסמכים מצביעים על רשומה שלא קיימת ביעד (הפניות שבורות). */
async function countBrokenFks(db, collName, fields) {
  for (const f of fields) {
    if (!f.fk || f.depth !== 0 || f.refPath !== "_id" || f.type !== "ObjectId") continue;
    try {
      const ids = (await db.collection(collName).distinct(f.path, { [f.path]: { $ne: null } })).filter((x) => x instanceof ObjectId);
      if (!ids.length) { f.brokenCount = 0; continue; }
      const found = new Set((await db.collection(f.refCollection).find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
      const missing = ids.filter((id) => !found.has(String(id)));
      f.brokenCount = missing.length ? await db.collection(collName).countDocuments({ [f.path]: { $in: missing } }) : 0;
    } catch {
      f.brokenCount = undefined;
    }
  }
}

export const records = asyncHandler(async (req, res) => {
  const info = await getCollectionInfo(req.params.collection);
  const db = mongoose.connection.db;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  const q = String(req.query.q || "").trim();
  const sortField = String(req.query.sort || "_id");
  const dir = req.query.dir === "asc" ? 1 : -1;
  const refField = req.query.refField ? String(req.query.refField) : null;
  const refId = req.query.refId ? String(req.query.refId) : null;

  const and = [];
  if (refField && refId) {
    const p = refField.replace(/\[\]/g, "");
    const or = [{ [p]: refId }];
    if (ObjectId.isValid(refId) && refId.length === 24) or.push({ [p]: new ObjectId(refId) });
    and.push({ $or: or });
  }
  if (q) {
    const or = [];
    if (ObjectId.isValid(q) && q.length === 24) {
      const oid = new ObjectId(q);
      or.push({ _id: oid });
      for (const f of info.fields) if (f.fk && f.depth === 0) or.push({ [f.path]: oid });
      or.push({ "payments._id": oid });
    }
    const rx = new RegExp(escapeRegex(q), "i");
    for (const f of info.fields) {
      if (f.hidden || LONG_BINARY_FIELDS.has(f.name)) continue;
      if (f.type === "String" || f.type === "Array<String>") or.push({ [f.path.replace(/\[\]/g, "")]: rx });
    }
    if (/^-?\d+(\.\d+)?$/.test(q)) {
      const n = Number(q);
      for (const f of info.fields) if (f.type === "Number" && f.depth === 0) or.push({ [f.path]: n });
    }
    if (or.length) and.push({ $or: or });
  }
  const filter = and.length ? { $and: and } : {};
  const validSort = info.fields.some((f) => f.path === sortField) || sortField === "_id";
  const sort = { [validSort ? sortField : "_id"]: dir, _id: dir };

  const total = await db.collection(info.collection).countDocuments(filter);
  const pipeline = [{ $match: filter }, { $sort: sort }, { $skip: page * limit }, { $limit: limit }, ...safetyStages(info)];
  const raw = await db.collection(info.collection).aggregate(pipeline).toArray();
  const rows = raw.map((d) => scrub(d));
  const fkNames = await resolveFkNames(info, rows);

  // עמודות מומלצות לטבלה: _id + שדות סקלריים ברמה העליונה (עד 9)
  const columns = ["_id"];
  for (const f of info.fields) {
    if (f.depth !== 0 || f.pk || f.hidden) continue;
    if (["String", "Number", "Date", "Boolean", "ObjectId"].includes(f.type) && !LONG_BINARY_FIELDS.has(f.name)) {
      if ((f.fillPct ?? 100) < 5) continue;
      columns.push(f.path);
    }
    if (columns.length >= 9) break;
  }
  res.json({ success: true, data: { rows, total, page, limit, columns, fkNames } });
});

export const record = asyncHandler(async (req, res) => {
  const info = await getCollectionInfo(req.params.collection);
  const db = mongoose.connection.db;
  const { id } = req.params;
  if (!ObjectId.isValid(id) || id.length !== 24) throw ApiError.badRequest("מזהה לא תקין");
  const oid = new ObjectId(id);
  const raw = await db.collection(info.collection).aggregate([{ $match: { _id: oid } }, ...safetyStages(info)]).toArray();
  if (!raw.length) throw ApiError.notFound("הרשומה לא נמצאה");
  const doc = scrub(raw[0]);
  const fkNames = await resolveFkNames(info, [doc]);

  // רשומות מקושרות (קשרים נכנסים): כמה מסמכים באוסף אחר מצביעים על הרשומה הזאת
  const related = [];
  for (const inc of info.incoming) {
    const p = inc.field.replace(/\[\]/g, "");
    let ids = [oid, id];
    if (inc.targetPath && inc.targetPath.startsWith("payments[]._id")) {
      ids = (raw[0].payments || []).map((x) => x._id).filter(Boolean);
      ids = [...ids, ...ids.map(String)];
    } else if (inc.targetPath && inc.targetPath.startsWith("row")) {
      continue; // קשר לוגי לפי file+row - לא נספר
    }
    if (!ids.length) {
      related.push({ collection: inc.from, he: inc.fromHe, field: inc.field, fieldHe: inc.he, count: 0, refId: id });
      continue;
    }
    const count = await db.collection(inc.from).countDocuments({ [p]: { $in: ids } });
    related.push({ collection: inc.from, he: inc.fromHe, field: inc.field, fieldHe: inc.he, count, refId: id, refIds: ids.length > 2 ? ids.filter((x) => typeof x === "string") : undefined });
  }
  res.json({ success: true, data: { doc, fkNames, related } });
});
