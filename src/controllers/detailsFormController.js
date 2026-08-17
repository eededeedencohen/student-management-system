import { randomBytes } from "crypto";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import CourseCohort from "../models/CourseCohort.js";
import Registration from "../models/Registration.js";
import Student from "../models/Student.js";
import DetailsForm from "../models/DetailsForm.js";
import DetailsSubmission from "../models/DetailsSubmission.js";
import { requiresEnglishDetails } from "./externalController.js";

/**
 * טפסי השלמת פרטים אישיים לנרשמים (עמוד "ניהול טפסים"):
 * לכל מחזור פעיל נוצר טופס עם קישור ציבורי; הסטודנטים ממלאים את אותם שדות
 * כמו שלב "פרטים אישיים" בטופס העסקה (ולפרקטישינר גם שם באנגלית ופנייה),
 * ועמוד הניהול מציג מי מרשימת הנרשמים מילא ומי עדיין לא.
 */

const cleanStr = (v) => (typeof v === "string" ? v.trim().slice(0, 300) : "");

/** בדיקת ספרת ביקורת של ת.ז. ישראלית (עד 9 ספרות, מרופדת באפסים). */
const isValidIsraeliId = (id) => {
  const s = String(id || "").trim();
  if (!/^\d{5,9}$/.test(s)) return false;
  const p = s.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let n = Number(p[i]) * (i % 2 === 0 ? 1 : 2);
    if (n > 9) n -= 9;
    sum += n;
  }
  return sum % 10 === 0;
};

const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || ""));
const phoneDigits = (v) =>
  String(v || "")
    .replace(/\D/g, "")
    .replace(/^972/, "0");
const isValidPhone = (v) => phoneDigits(v).length >= 9;

/** שם הקורס הקנוני של מחזור: שם הקורס הקטלוגי (לא איות חופשי). */
const cohortDisplay = (cohort) => ({
  courseName: cohort.catalogCourse?.name || "",
  label: cohort.label || "",
  requiresEnglish: requiresEnglishDetails(cohort.catalogCourse?.name || ""),
});

/* ------------------------------------------------------------------ */
/* רשימת הנרשמים של מחזור (ההגדרה המאוחדת - זהה לקטלוג/קורסים)          */
/* ------------------------------------------------------------------ */

/** מפה cohortId -> רשימת עסקאות רישום משויכות (כולל דרך coursesAll). */
const enrolledDealsByCohort = async (cohortIds) => {
  const wanted = new Set(cohortIds.map(String));
  const links = await CourseCohort.find({
    _id: { $in: cohortIds },
    sourceCourse: { $ne: null },
  })
    .select("sourceCourse")
    .lean();
  const cohortOfSource = new Map(
    links.map((c) => [String(c.sourceCourse), String(c._id)]),
  );
  const deals = await Registration.find({ recordType: "registration" })
    .select("student studentName cohort cohortsAll coursesAll")
    .lean();
  const byCohort = new Map();
  for (const d of deals) {
    const set = new Set();
    const dealCohorts = d.cohortsAll?.length
      ? d.cohortsAll
      : d.cohort
        ? [d.cohort]
        : [];
    for (const c of dealCohorts) set.add(String(c));
    for (const courseId of d.coursesAll || []) {
      const via = cohortOfSource.get(String(courseId));
      if (via) set.add(via);
    }
    for (const k of set) {
      if (!wanted.has(k)) continue;
      if (!byCohort.has(k)) byCohort.set(k, []);
      byCohort.get(k).push(d);
    }
  }
  return byCohort;
};

/* ------------------------------------------------------------------ */
/* ציבורי - הטופס עצמו                                                 */
/* ------------------------------------------------------------------ */

/** GET /api/public/details-form/:token - פרטי הטופס לעמוד הציבורי. */
export const publicFormInfo = asyncHandler(async (req, res) => {
  const form = await DetailsForm.findOne({ token: req.params.token })
    .populate({
      path: "cohort",
      select: "label catalogCourse",
      populate: { path: "catalogCourse", select: "name" },
    })
    .lean();
  if (!form?.cohort) throw ApiError.notFound("הטופס לא נמצא");
  res.json({ success: true, data: cohortDisplay(form.cohort) });
});

/** POST /api/public/details-form/:token - הגשת הטופס (ציבורי, מוגבל קצב). */
export const publicFormSubmit = asyncHandler(async (req, res) => {
  const form = await DetailsForm.findOne({ token: req.params.token })
    .populate({
      path: "cohort",
      select: "label catalogCourse",
      populate: { path: "catalogCourse", select: "name" },
    })
    .lean();
  if (!form?.cohort) throw ApiError.notFound("הטופס לא נמצא");
  const { requiresEnglish } = cohortDisplay(form.cohort);

  const b = req.body || {};
  const data = {
    firstNameHe: cleanStr(b.firstNameHe),
    lastNameHe: cleanStr(b.lastNameHe),
    firstNameEn: cleanStr(b.firstNameEn),
    lastNameEn: cleanStr(b.lastNameEn),
    idNumber: cleanStr(b.idNumber),
    gender: b.gender === "male" || b.gender === "female" ? b.gender : "",
    title: cleanStr(b.title),
    city: cleanStr(b.city),
    street: cleanStr(b.street),
    houseNumber: cleanStr(b.houseNumber),
    apartment: cleanStr(b.apartment),
    zip: cleanStr(b.zip),
    addressNotes: cleanStr(b.addressNotes),
    email: cleanStr(b.email).toLowerCase(),
    phone: cleanStr(b.phone),
  };

  if (!data.firstNameHe || !data.lastNameHe)
    throw ApiError.badRequest("שם פרטי ושם משפחה בעברית הם שדות חובה");
  if (!isValidIsraeliId(data.idNumber))
    throw ApiError.badRequest("תעודת הזהות אינה תקינה");
  if (!data.gender) throw ApiError.badRequest("יש לבחור מין");
  if (!data.city || !data.street || !data.houseNumber)
    throw ApiError.badRequest("כתובת מלאה (עיר, רחוב ומספר בניין) היא שדה חובה");
  if (!isValidEmail(data.email))
    throw ApiError.badRequest("כתובת המייל אינה תקינה");
  if (!isValidPhone(data.phone))
    throw ApiError.badRequest("מספר הטלפון אינו תקין");

  // לגבר הפנייה תמיד .Mr; לפרקטישינר חובה שם באנגלית ופנייה (התעודה באנגלית)
  if (data.gender === "male") data.title = "Mr.";
  if (data.title && !["Mr.", "Ms.", "Mrs."].includes(data.title))
    throw ApiError.badRequest("הפנייה אינה תקינה");
  if (requiresEnglish && (!data.firstNameEn || !data.lastNameEn || !data.title)) {
    throw ApiError.badRequest(
      "לקורס NLP פרקטישינר חובה למלא שם פרטי ומשפחה באנגלית ופנייה (.Mr/.Ms/.Mrs) - התעודה מונפקת גם בעברית וגם באנגלית",
    );
  }

  await DetailsSubmission.create({
    form: form._id,
    cohort: form.cohort._id,
    ...data,
  });
  res.status(201).json({ success: true, data: { submitted: true } });
});

/* ------------------------------------------------------------------ */
/* ניהול (מנהל בלבד)                                                   */
/* ------------------------------------------------------------------ */

/**
 * מפתח שם ללא תלות בסדר המילים: בייבוא מה-JSON חלק מהשמות נשמרו הפוך
 * ("שימשי עודד"), ולכן "עודד שימשי" מהטופס חייב להתאים לאותו נרשם.
 */
const nameKey = (s) =>
  String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

/**
 * התאמת הגשה לסטודנט מרשימת הנרשמים: לפי ת.ז. אמיתית, טלפון, או שם מלא
 * (ללא תלות בסדר המילים). ההתאמה דינמית - לא נשמרת - כדי שתתעדכן כשהרשימה
 * או ההגשות משתנות.
 */
const matchSubmission = (sub, roster) => {
  const subPhone = phoneDigits(sub.phone);
  const subName = nameKey(`${sub.firstNameHe} ${sub.lastNameHe}`);
  for (const r of roster) {
    if (sub.idNumber && r.realIdNumber && sub.idNumber === r.realIdNumber)
      return r;
  }
  for (const r of roster) {
    if (subPhone && r.phoneKey && subPhone === r.phoneKey) return r;
  }
  for (const r of roster) {
    if (subName && r.nameKey && subName === r.nameKey) return r;
  }
  return null;
};

/**
 * GET /api/details-forms
 * כל המחזורים הפעילים + כל מחזור שכבר יש לו טופס: פרטי הטופס, רשימת הנרשמים
 * עם מי מילא ומי לא, וכל ההגשות (כולל כאלה שלא זוהו ברשימה).
 */
export const adminList = asyncHandler(async (req, res) => {
  const forms = await DetailsForm.find({}).lean();
  const formByCohort = new Map(forms.map((f) => [String(f.cohort), f]));
  const cohorts = await CourseCohort.find({
    $or: [
      { status: "active" },
      { _id: { $in: forms.map((f) => f.cohort) } },
    ],
  })
    .populate("catalogCourse", "name")
    .lean();

  const cohortIds = cohorts.map((c) => c._id);
  const dealsByCohort = await enrolledDealsByCohort(cohortIds);
  const studentIds = [
    ...new Set(
      [...dealsByCohort.values()]
        .flat()
        .map((d) => (d.student ? String(d.student) : null))
        .filter(Boolean),
    ),
  ];
  const students = await Student.find({ _id: { $in: studentIds } })
    .select("fullName mobile realIdNumber")
    .lean();
  const studentById = new Map(students.map((s) => [String(s._id), s]));

  const submissions = await DetailsSubmission.find({
    form: { $in: forms.map((f) => f._id) },
  })
    .sort({ createdAt: -1 })
    .lean();
  const subsByForm = new Map();
  for (const s of submissions) {
    const k = String(s.form);
    if (!subsByForm.has(k)) subsByForm.set(k, []);
    subsByForm.get(k).push(s);
  }

  const data = cohorts
    .map((c) => {
      const disp = cohortDisplay(c);
      const form = formByCohort.get(String(c._id)) || null;

      // רשימת הנרשמים: סטודנט ייחודי לכל עסקה משויכת
      const roster = [];
      const seen = new Set();
      for (const d of dealsByCohort.get(String(c._id)) || []) {
        const sid = d.student ? String(d.student) : null;
        if (!sid || seen.has(sid)) continue;
        seen.add(sid);
        const st = studentById.get(sid);
        const name = st?.fullName || d.studentName || "";
        roster.push({
          studentId: sid,
          name,
          nameKey: nameKey(name),
          phone: st?.mobile || "",
          phoneKey: phoneDigits(st?.mobile),
          realIdNumber: st?.realIdNumber || "",
        });
      }

      const subs = (form && subsByForm.get(String(form._id))) || [];
      const filledStudentIds = new Map(); // studentId -> submissionId
      const subRows = subs.map((s) => {
        const m = matchSubmission(s, roster);
        if (m && !filledStudentIds.has(m.studentId))
          filledStudentIds.set(m.studentId, String(s._id));
        return {
          id: String(s._id),
          createdAt: s.createdAt,
          matchedStudentId: m ? m.studentId : null,
          matchedName: m ? m.name : "",
          firstNameHe: s.firstNameHe,
          lastNameHe: s.lastNameHe,
          firstNameEn: s.firstNameEn,
          lastNameEn: s.lastNameEn,
          idNumber: s.idNumber,
          gender: s.gender,
          title: s.title,
          city: s.city,
          street: s.street,
          houseNumber: s.houseNumber,
          apartment: s.apartment,
          zip: s.zip,
          addressNotes: s.addressNotes,
          email: s.email,
          phone: s.phone,
        };
      });

      return {
        cohortId: String(c._id),
        ...disp,
        status: c.status,
        form: form
          ? {
              id: String(form._id),
              token: form.token,
              createdAt: form.createdAt,
            }
          : null,
        roster: roster.map((r) => ({
          studentId: r.studentId,
          name: r.name,
          phone: r.phone,
          filled: filledStudentIds.has(r.studentId),
          submissionId: filledStudentIds.get(r.studentId) || null,
        })),
        submissions: subRows,
        rosterCount: roster.length,
        filledCount: filledStudentIds.size,
      };
    })
    .sort(
      (a, b) =>
        a.courseName.localeCompare(b.courseName, "he") ||
        a.label.localeCompare(b.label, "he"),
    );

  res.json({ success: true, data });
});

/** POST /api/details-forms {cohort} - יצירת טופס למחזור (אידמפוטנטי). */
export const createForm = asyncHandler(async (req, res) => {
  const cohortId = String(req.body?.cohort || "");
  const cohort = await CourseCohort.findById(cohortId).lean();
  if (!cohort) throw ApiError.notFound("המחזור לא נמצא");
  let form = await DetailsForm.findOne({ cohort: cohort._id });
  if (!form) {
    form = await DetailsForm.create({
      cohort: cohort._id,
      token: randomBytes(18).toString("base64url"),
      createdByName: req.user?.name || "",
    });
  }
  res
    .status(201)
    .json({ success: true, data: { id: String(form._id), token: form.token } });
});

/** DELETE /api/details-forms/:id - מחיקת טופס עם כל ההגשות שלו (לטסטים). */
export const deleteForm = asyncHandler(async (req, res) => {
  const form = await DetailsForm.findById(req.params.id);
  if (!form) throw ApiError.notFound("הטופס לא נמצא");
  const { deletedCount } = await DetailsSubmission.deleteMany({
    form: form._id,
  });
  await form.deleteOne();
  res.json({ success: true, data: { deleted: true, submissions: deletedCount } });
});

/** DELETE /api/details-forms/submissions/:id - מחיקת הגשה בודדת. */
export const deleteSubmission = asyncHandler(async (req, res) => {
  const sub = await DetailsSubmission.findById(req.params.id);
  if (!sub) throw ApiError.notFound("ההגשה לא נמצאה");
  await sub.deleteOne();
  res.json({ success: true, data: { deleted: true } });
});
