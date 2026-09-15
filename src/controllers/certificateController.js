import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import CertificateAsset from "../models/CertificateAsset.js";
import CertificateSignature from "../models/CertificateSignature.js";
import CertificateBatch from "../models/CertificateBatch.js";
import CourseCohort from "../models/CourseCohort.js";
import Registration from "../models/Registration.js";
import Student from "../models/Student.js";
import DetailsSubmission from "../models/DetailsSubmission.js";
import Teacher from "../models/Teacher.js";
import { teacherNamesOf } from "../utils/cohortTeachers.js";

/**
 * מחוללי התעודות.
 *
 * מנוע הציור עצמו יושב בלקוח (client/src/lib/certs) והוא העתק מדויק של
 * המחוללים העצמאיים - אותם קבועי פריסה, אותו ציור על קנבס ב-300dpi ואותו
 * כותב PDF - כדי שה-PDF יֵצא זהה. השרת מספק לו שלושה דברים:
 *   1. הנכסים (רקעים, חותמות, פונטים) שאסור שיישבו בגיט הציבורי
 *   2. רשימת מקבלי התעודה של המחזור, עם השדות שהתעודה צריכה
 *   3. מצב העבודה: הגדרות משותפות + דריסות ידניות פר אדם
 */

/** המחוללים שהמערכת חושפת, לפי הסדר שבו הם מוצגים. */
export const GENERATORS = {
  nlp: {
    title: "NLP פרקטישינר",
    subtitle: "עברית, אנגלית ותעודת מגמה מקצועית",
    pages: ["he", "en", "track"],
  },
  master: {
    title: "NLP מאסטר",
    subtitle: "עברית ואנגלית",
    pages: ["he", "en"],
  },
  trauma: {
    title: "טראומה וחרדה",
    subtitle: "עברית, אנגלית או שתיהן",
    pages: ["he", "en"],
  },
  horim: {
    title: "הדרכת הורים",
    subtitle: "תעודה אחת בעברית",
    pages: ["he"],
  },
};

/* ------------------------------------------------------------------ */
/* נכסים                                                               */
/* ------------------------------------------------------------------ */

/**
 * GET /api/certificates/manifest
 * לכל מחולל: אילו נכסים הוא צריך ובאיזה תפקיד. הלקוח מושך לפי זה רק את מה
 * שהמחולל הנבחר צריך (6MB ל-NLP, 0.6MB להורים) ולא את כל 12MB.
 */
export const manifest = asyncHandler(async (req, res) => {
  const assets = await CertificateAsset.find({}, { data: 0 }).lean();
  const byGenerator = {};
  for (const a of assets) {
    for (const u of a.usedBy || []) {
      if (!byGenerator[u.generator]) byGenerator[u.generator] = { fonts: {}, images: {} };
      const group = a.kind === "font" ? "fonts" : "images";
      byGenerator[u.generator][group][u.role] = { sha: a.sha, mime: a.mime, bytes: a.bytes };
    }
  }
  const generators = Object.entries(GENERATORS).map(([key, meta]) => {
    const g = byGenerator[key] || { fonts: {}, images: {} };
    const bytes =
      Object.values(g.fonts).reduce((s, x) => s + x.bytes, 0) +
      Object.values(g.images).reduce((s, x) => s + x.bytes, 0);
    return {
      key,
      ...meta,
      ready: Object.keys(g.images).length > 0,
      bytes,
      fonts: g.fonts,
      images: g.images,
    };
  });
  res.json({ success: true, data: { generators } });
});

/**
 * GET /api/certificates/assets/:sha
 * בייטים גולמיים של נכס. ה-sha הוא תוכן הקובץ, ולכן התשובה אף פעם לא משתנה
 * ואפשר לתת לדפדפן לשמור אותה לנצח. הלקוח מושך דרך axios (עם הטוקן) ולא
 * ב-<img src>, ולכן אין בעיה שהנתיב מוגן.
 */
export const asset = asyncHandler(async (req, res) => {
  const doc = await CertificateAsset.findOne({ sha: req.params.sha }).lean();
  if (!doc) throw ApiError.notFound("הנכס לא נמצא");
  // עם lean() שדה Buffer חוזר כ-Binary של הדרייבר (ה-length שלו הוא פונקציה),
  // ולכן מנרמלים ל-Buffer אמיתי. את Content-Length אקספרס קובע לבד.
  const data = Buffer.isBuffer(doc.data) ? doc.data : Buffer.from(doc.data?.buffer || doc.data);
  res.set("Content-Type", doc.mime);
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.set("ETag", `"${doc.sha}"`);
  res.send(data);
});

/* ------------------------------------------------------------------ */
/* רשימת מקבלי התעודה                                                  */
/* ------------------------------------------------------------------ */

const digits = (s) => String(s || "").replace(/\D/g, "");

/** מפתח שם ללא תלות בסדר המילים - שמות מיובאים נשמרו לפעמים הפוך. */
const nameKey = (s) =>
  String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

/**
 * ת.ז. אמיתית בלבד. ל-Student.idNumber יש ערכים סינתטיים (1001 ומעלה) שנוצרו
 * בייבוא - הם מזהה פנימי ולא ת.ז., ואסור שיודפסו על תעודה.
 */
const realId = (...candidates) => {
  for (const c of candidates) {
    const d = digits(c);
    if (d.length >= 7) return d;
  }
  return "";
};

/** מר/גב׳ מתוך gender/title, עם ברירת מחדל נקבה כמו במחוללים. */
const titlesOf = (gender, title) => {
  const male = gender === "male" || title === "Mr.";
  return {
    titleHe: male ? "מר" : "גב׳",
    titleEn: male ? "MR." : title === "Mrs." ? "MRS." : "MS.",
    male,
  };
};

/**
 * GET /api/certificates/roster/:cohortId
 * מקבלי התעודה של המחזור, עם השדות שהתעודה צריכה: שם עברי, שם אנגלי, ת.ז.,
 * ופנייה. השם האנגלי והת.ז. מגיעים בעדיפות ראשונה מטופס השלמת הפרטים, שהוא
 * המקום היחיד שבו הסטודנט/ית הקלידו אותם בעצמם.
 */
export const roster = asyncHandler(async (req, res) => {
  const cohort = await CourseCohort.findById(req.params.cohortId)
    .populate("catalogCourse", "name")
    .populate("teachers", "fullName")
    .populate("teacher", "fullName")
    .lean();
  if (!cohort) throw ApiError.notFound("המחזור לא נמצא");

  // שיוך מפורש בלבד: cohort או cohortsAll. זה מה שקובע מי בקורס.
  const deals = await Registration.find({
    recordType: "registration",
    $or: [{ cohort: cohort._id }, { cohortsAll: cohort._id }],
  })
    .select("student studentName idNumber dealDate rep repName")
    .sort({ studentName: 1 })
    .lean();

  const studentIds = deals.map((d) => d.student).filter(Boolean);
  const students = await Student.find({ _id: { $in: studentIds } })
    .select(
      "fullName firstName lastName hebrewName englishName idNumber realIdNumber gender title mobile",
    )
    .lean();
  const studentById = new Map(students.map((s) => [String(s._id), s]));

  const subs = await DetailsSubmission.find({ cohort: cohort._id }).lean();

  const people = deals.map((d) => {
    const st = d.student ? studentById.get(String(d.student)) : null;
    const heName = st?.hebrewName || st?.fullName || d.studentName || "";
    const idKey = realId(st?.realIdNumber, d.idNumber);
    const phoneKey = digits(st?.mobile);
    const nKey = nameKey(heName);

    // התאמת הגשת טופס: ת.ז. → טלפון → שם (ללא תלות בסדר המילים)
    const sub =
      subs.find((s) => idKey && digits(s.idNumber) === idKey) ||
      subs.find((s) => phoneKey && digits(s.phone) === phoneKey) ||
      subs.find((s) => nKey && nameKey(`${s.firstNameHe} ${s.lastNameHe}`) === nKey) ||
      null;

    const nameHe =
      (sub && `${sub.firstNameHe || ""} ${sub.lastNameHe || ""}`.trim()) || heName;
    const nameEn =
      (sub && `${sub.firstNameEn || ""} ${sub.lastNameEn || ""}`.trim()) ||
      st?.englishName ||
      "";
    const gender = st?.gender || sub?.gender || "";
    const title = st?.title || sub?.title || "";

    return {
      key: String(d._id),
      registration: String(d._id),
      student: d.student ? String(d.student) : null,
      nameHe,
      nameEn,
      id: realId(st?.realIdNumber, sub?.idNumber, d.idNumber),
      ...titlesOf(gender, title),
      repName: d.repName || "",
      dealDate: d.dealDate || null,
      // מה חסר כדי להפיק תעודה תקינה - מוצג כאזהרה בעמוד
      missing: [
        !nameHe && "שם",
        !realId(st?.realIdNumber, sub?.idNumber, d.idNumber) && "ת.ז.",
      ].filter(Boolean),
      hasSubmission: Boolean(sub),
    };
  });

  res.json({
    success: true,
    data: {
      cohort: {
        id: String(cohort._id),
        courseName: cohort.catalogCourse?.name || "(קורס נמחק)",
        label: cohort.label || "",
        teacherName: teacherNamesOf(cohort),
        status: cohort.status,
      },
      people,
    },
  });
});

/* ------------------------------------------------------------------ */
/* מצב העבודה של הקבוצה                                                */
/* ------------------------------------------------------------------ */

const assertGenerator = (key) => {
  if (!GENERATORS[key]) throw ApiError.badRequest("מחולל לא מוכר");
};

/** GET /api/certificates/batch/:cohortId/:generator */
export const getBatch = asyncHandler(async (req, res) => {
  const { cohortId, generator } = req.params;
  assertGenerator(generator);
  const doc = await CertificateBatch.findOne({ cohort: cohortId, generator }).lean();
  res.json({
    success: true,
    data: doc
      ? { settings: doc.settings || {}, people: doc.people || [], updatedAt: doc.updatedAt }
      : { settings: {}, people: [], updatedAt: null },
  });
});

/**
 * PUT /api/certificates/batch/:cohortId/:generator
 * שמירת ההגדרות והדריסות. הדריסות הן "זמניות" במובן שהבעלים ביקש: הן חיות
 * כאן בלבד ולא נוגעות ב-Student או ב-Registration.
 */
export const saveBatch = asyncHandler(async (req, res) => {
  const { cohortId, generator } = req.params;
  assertGenerator(generator);
  const { settings, people } = req.body || {};
  if (settings && typeof settings !== "object") throw ApiError.badRequest("settings לא תקין");
  if (people && !Array.isArray(people)) throw ApiError.badRequest("people לא תקין");

  const clean = (people || []).map((p, i) => ({
    registration: p.registration || undefined,
    student: p.student || undefined,
    key: String(p.key || p.registration || i),
    overrides: p.overrides && typeof p.overrides === "object" ? p.overrides : {},
    include: p.include && typeof p.include === "object" ? p.include : {},
    excluded: Boolean(p.excluded),
    order: Number.isFinite(p.order) ? p.order : i,
  }));

  const doc = await CertificateBatch.findOneAndUpdate(
    { cohort: cohortId, generator },
    {
      $set: {
        settings: settings || {},
        people: clean,
        updatedByName: req.user?.fullName || req.user?.username || "",
      },
    },
    { upsert: true, new: true },
  ).lean();

  res.json({
    success: true,
    data: { settings: doc.settings || {}, people: doc.people || [], updatedAt: doc.updatedAt },
  });
});

/* ------------------------------------------------------------------ */
/* חתימות                                                              */
/* ------------------------------------------------------------------ */

/**
 * GET /api/certificates/signatures
 * כל המרצים עם החתימות שלהם (עברית/אנגלית) + חתימות חופשיות. התמונות עצמן
 * לא נשלחות כאן - רק מזהים - כדי שהרשימה תישאר קלה; כל תמונה נמשכת בנפרד
 * ונשמרת במטמון הדפדפן.
 */
export const listSignatures = asyncHandler(async (req, res) => {
  const [teachers, sigs] = await Promise.all([
    Teacher.find({}).select("fullName phone email active").sort({ fullName: 1 }).lean(),
    CertificateSignature.find({}, { imageDataUrl: 0 }).sort({ createdAt: 1 }).lean(),
  ]);

  const byTeacher = new Map();
  const loose = [];
  for (const s of sigs) {
    const row = {
      id: String(s._id),
      name: s.name,
      lang: s.lang,
      byteLength: s.byteLength || 0,
      uploadedAt: s.uploadedAt,
      uploadedByName: s.uploadedByName || "",
    };
    if (s.teacher) {
      const k = String(s.teacher);
      if (!byTeacher.has(k)) byTeacher.set(k, {});
      byTeacher.get(k)[s.lang] = row;
    } else {
      loose.push(row);
    }
  }

  res.json({
    success: true,
    data: {
      teachers: teachers.map((t) => ({
        id: String(t._id),
        fullName: t.fullName,
        phone: t.phone,
        email: t.email,
        active: t.active !== false,
        he: byTeacher.get(String(t._id))?.he || null,
        en: byTeacher.get(String(t._id))?.en || null,
      })),
      loose,
    },
  });
});

/** GET /api/certificates/signatures/:id/image - בייטים של חתימה אחת. */
export const signatureImage = asyncHandler(async (req, res) => {
  const sig = await CertificateSignature.findById(req.params.id)
    .select("imageDataUrl updatedAt")
    .lean();
  if (!sig) throw ApiError.notFound("החתימה לא נמצאה");
  const m = /^data:(image\/[\w+.-]+);base64,(.+)$/s.exec(sig.imageDataUrl || "");
  if (!m) throw ApiError.badRequest("תמונת החתימה פגומה");
  const buf = Buffer.from(m[2], "base64");
  res.set("Content-Type", m[1]);
  // התמונה יכולה להתחלף באותו מזהה, ולכן ETag ולא immutable
  res.set("Cache-Control", "private, max-age=60");
  res.set("ETag", `"${String(sig.updatedAt?.getTime() || 0)}"`);
  res.send(buf);
});

const MAX_SIG_CHARS = 4 * 1024 * 1024; // ~3MB תמונה

/**
 * POST /api/certificates/signatures
 * יצירה או החלפה. למרצה יש חתימה אחת לכל שפה, ולכן שליחה חוזרת לאותו
 * (teacher, lang) דורסת את הקיימת.
 */
export const saveSignature = asyncHandler(async (req, res) => {
  const { name, teacher, lang, imageDataUrl } = req.body || {};
  if (!["he", "en"].includes(lang)) throw ApiError.badRequest("שפה לא תקינה");
  if (!imageDataUrl || !/^data:image\/[\w+.-]+;base64,/.test(imageDataUrl))
    throw ApiError.badRequest("נדרשת תמונת חתימה");
  if (imageDataUrl.length > MAX_SIG_CHARS) throw ApiError.badRequest("תמונת החתימה גדולה מדי");

  let label = String(name || "").trim();
  if (teacher) {
    const t = await Teacher.findById(teacher).select("fullName").lean();
    if (!t) throw ApiError.notFound("המרצה לא נמצא");
    if (!label) label = `${t.fullName} - ${lang === "he" ? "עברית" : "אנגלית"}`;
  }
  if (!label) throw ApiError.badRequest("נדרש שם לחתימה");

  const payload = {
    name: label,
    lang,
    imageDataUrl,
    byteLength: imageDataUrl.length,
    uploadedAt: new Date(),
    uploadedByName: req.user?.fullName || req.user?.username || "",
  };

  const doc = teacher
    ? await CertificateSignature.findOneAndUpdate(
        { teacher, lang },
        { $set: { ...payload, teacher } },
        { upsert: true, new: true },
      )
    : await CertificateSignature.create(payload);

  res.status(201).json({
    success: true,
    data: { id: String(doc._id), name: doc.name, lang: doc.lang, byteLength: doc.byteLength },
  });
});

/** DELETE /api/certificates/signatures/:id */
export const deleteSignature = asyncHandler(async (req, res) => {
  const doc = await CertificateSignature.findByIdAndDelete(req.params.id);
  if (!doc) throw ApiError.notFound("החתימה לא נמצאה");
  res.json({ success: true, data: { deleted: true } });
});
