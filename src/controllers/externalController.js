import crypto from "crypto";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import Registration from "../models/Registration.js";
import Student from "../models/Student.js";
import Course from "../models/Course.js";
import User from "../models/User.js";

/**
 * externalController — הטופס החיצוני (ללא התחברות) + החוזה הדיגיטלי.
 *
 * "חיצוני" = נגיש בלי טוקן: נציגה פותחת קישור, ממלאת עסקה, ובסוף מפיקה קישור
 * חוזה ייחודי שהלקוח חותם בו ביד/עכבר. החתימה מעדכנת אוטומטית את
 * checklist.signedTakanon של העסקה, והטופס רואה את הסטטוס בלייב (polling).
 *
 * המשטח הציבורי מצומצם בכוונה: אפשרויות טופס מינימליות, יצירת עסקה עם ולידציה
 * קשיחה בצד השרת (הסכומים מאומתים מחדש - לא סומכים על הקליינט), וחוזה שנגיש
 * רק דרך token אקראי בן 96 ביט.
 */

const cleanStr = (v) => (typeof v === "string" ? v.trim() : "");
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ------------------------------------------------------------------ */
/* GET /api/public/form-options                                        */
/* ------------------------------------------------------------------ */

/** הנציגות הפעילות + הקורסים הפתוחים (שם ומחיר בלבד) - מה שהטופס צריך ותו לא. */
export const formOptions = asyncHandler(async (req, res) => {
  const [reps, courses] = await Promise.all([
    User.find({ role: "rep", active: true }).select("name").sort({ name: 1 }).lean(),
    Course.find({ status: { $in: ["פעיל", "פתוח להרשמה"] } })
      .select("name field cohortLabel price startDate")
      .sort({ startDate: 1 })
      .lean(),
  ]);
  res.json({
    success: true,
    data: {
      reps: reps.map((r) => ({ _id: String(r._id), name: r.name })),
      courses: courses.map((c) => ({
        _id: String(c._id),
        name: c.name,
        field: c.field || "",
        cohortLabel: c.cohortLabel || "",
        price: Number(c.price) || 0,
        startDate: c.startDate || null,
      })),
    },
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/public/deals                                              */
/* ------------------------------------------------------------------ */

const PAY_METHODS = ["credit", "ern", "cash", "transfer"];
const PAY_TYPES = ["advance", "installment", "one_time"];

/** ולידציית ת.ז. ישראלית (ספרת ביקורת). */
function isValidIsraeliId(id) {
  const s = String(id || "").trim();
  if (!/^\d{5,9}$/.test(s)) return false;
  const p = s.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let d = Number(p[i]) * (i % 2 === 0 ? 1 : 2);
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

export const createDeal = asyncHandler(async (req, res) => {
  const b = req.body || {};

  // --- נציגה ---
  const rep = await User.findById(b.rep).select("name role active");
  if (!rep || rep.role !== "rep" || !rep.active) {
    throw ApiError.badRequest("יש לבחור נציגה מהרשימה");
  }

  // --- פרטים אישיים ---
  const firstNameHe = cleanStr(b.firstNameHe);
  const lastNameHe = cleanStr(b.lastNameHe);
  const firstNameEn = cleanStr(b.firstNameEn);
  const lastNameEn = cleanStr(b.lastNameEn);
  if (!firstNameHe || !lastNameHe)
    throw ApiError.badRequest("שם פרטי ושם משפחה בעברית הם שדות חובה");
  const idNumber = cleanStr(b.idNumber);
  if (!isValidIsraeliId(idNumber))
    throw ApiError.badRequest("מספר תעודת הזהות אינו תקין");
  const gender = b.gender === "male" || b.gender === "female" ? b.gender : null;
  if (!gender) throw ApiError.badRequest("יש לבחור מין");
  const title =
    gender === "male" ? "Mr." : ["Ms.", "Mrs."].includes(b.title) ? b.title : null;
  if (!title) throw ApiError.badRequest("יש לבחור פנייה (Ms./Mrs.)");
  const phone = cleanStr(b.phone).replace(/[^\d+]/g, "");
  if (phone.replace(/\D/g, "").length < 9)
    throw ApiError.badRequest("מספר טלפון אינו תקין");
  const email = cleanStr(b.email).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    throw ApiError.badRequest("כתובת המייל אינה תקינה");
  const city = cleanStr(b.city);
  const street = cleanStr(b.street);
  const houseNumber = cleanStr(b.houseNumber);
  if (!city || !street || !houseNumber)
    throw ApiError.badRequest("כתובת מגורים (עיר, רחוב, מספר) היא שדה חובה");

  // --- קורס ומחיר ---
  const course = await Course.findById(b.course).select(
    "name field cohortLabel price",
  );
  if (!course) throw ApiError.badRequest("יש לבחור קורס");
  const finalPrice = round2(b.finalPrice);
  if (!(finalPrice > 0)) throw ApiError.badRequest("מחיר העסקה אינו תקין");
  const listPrice = Number(course.price) || 0;
  const discountPercent =
    listPrice > 0 ? round2(((listPrice - finalPrice) / listPrice) * 100) : 0;

  // --- תשלומים: אותם חוקים כמו בטופס הפנימי, מאומתים מחדש בצד השרת ---
  const rawPayments = Array.isArray(b.payments) ? b.payments : [];
  if (rawPayments.length === 0)
    throw ApiError.badRequest("יש להזין לפחות תשלום אחד");
  const payments = rawPayments.map((p) => {
    const method = PAY_METHODS.includes(p.method) ? p.method : "credit";
    const paid = Boolean(p.paid);
    const amount = round2(p.amount);
    if (!(amount > 0)) throw ApiError.badRequest("סכום תשלום אינו תקין");
    return {
      type: PAY_TYPES.includes(p.type) ? p.type : "one_time",
      amount,
      method,
      methodCategory: method,
      dueDate: p.dueDate ? new Date(p.dueDate) : new Date(),
      paid,
      installments: p.installments ? Number(p.installments) : undefined,
      note: cleanStr(p.label) || undefined,
      confirmedByName: paid ? `${rep.name} (טופס חיצוני)` : undefined,
      confirmedAt: paid ? new Date() : undefined,
    };
  });
  const paySum = round2(payments.reduce((a, p) => a + p.amount, 0));
  if (Math.abs(paySum - finalPrice) > 1) {
    throw ApiError.badRequest(
      `סך התשלומים (${paySum}) חייב להשתוות למחיר העסקה (${finalPrice})`,
    );
  }

  // --- תלמיד/ה: find-or-create עם כל הפרטים מהטופס ---
  const fullName = `${firstNameHe} ${lastNameHe}`;
  let student = await Student.findOne({
    $or: [{ realIdNumber: idNumber }, { fullName }],
  });
  const englishName = [firstNameEn, lastNameEn].filter(Boolean).join(" ");
  const addressNotes = cleanStr(b.addressNotes);
  const zip = cleanStr(b.zip);
  if (!student) {
    const top = await Student.findOne({ studentNumber: { $ne: null } })
      .sort({ studentNumber: -1 })
      .select("studentNumber")
      .lean();
    student = await Student.create({
      fullName,
      firstName: firstNameHe,
      lastName: lastNameHe,
      hebrewName: fullName,
      englishName: englishName || undefined,
      idNumber: String((top?.studentNumber || 0) + 1), // ת.ז. סינתטית עוקבת (כמו בייבוא)
      realIdNumber: idNumber,
      gender,
      title,
      mobile: phone,
      email,
      city,
      street,
      houseNumber,
      apartment: cleanStr(b.apartment) || undefined,
      notes:
        [
          zip ? `מיקוד: ${zip}` : "",
          addressNotes ? `הערות לכתובת: ${addressNotes}` : "",
        ]
          .filter(Boolean)
          .join(" | ") || undefined,
      studentNumber: (top?.studentNumber || 0) + 1,
    });
  } else {
    // השלמת פרטים שנלמדו מהטופס (בלי לדרוס קיימים).
    // חריג: מין ופנייה נבחרים במפורש בטופס - הבחירה הטרייה דורסת את הקיים,
    // כדי שהחוזה ינוסח לפי מה שסומן בעסקה הזו.
    if (!student.realIdNumber) student.realIdNumber = idNumber;
    student.gender = gender;
    student.title = title;
    if (!student.mobile) student.mobile = phone;
    if (!student.email) student.email = email;
    if (!student.city) student.city = city;
    if (!student.street) student.street = street;
    if (!student.houseNumber) student.houseNumber = houseNumber;
    if (!student.englishName && englishName) student.englishName = englishName;
    await student.save();
  }

  // --- העסקה + החוזה ---
  const dominant = payments
    .map((p) => p.method)
    .sort(
      (a, x) =>
        payments.filter((p) => p.method === x).length -
        payments.filter((p) => p.method === a).length,
    )[0];
  const token = crypto.randomBytes(24).toString("base64url"); // 192 ביט - לא ניתן לניחוש

  const reg = new Registration({
    schemaVersion: 2,
    student: student._id,
    studentName: fullName,
    rep: rep._id,
    repName: rep.name,
    course: course._id,
    courseRaw: course.name,
    courseField: course.field,
    cohortLabel: course.cohortLabel,
    dealDate: new Date(),
    dealPrice: finalPrice,
    discountPercent,
    payments,
    paymentCategory: dominant,
    noteEntries: [
      {
        text: `נוצר מהטופס החיצוני · נציגה: ${rep.name} · ת.ז. ${idNumber} · ${email} · ${phone} · ${city}, ${street} ${houseNumber}${b.apartment ? `/${cleanStr(b.apartment)}` : ""}`,
        date: new Date(),
        byName: `${rep.name} (טופס חיצוני)`,
      },
    ],
    recordType: "registration",
    contract: { token, status: "pending", createdAt: new Date() },
  });
  reg.recompute();
  await reg.save();

  res.status(201).json({
    success: true,
    data: {
      dealId: String(reg._id),
      studentName: fullName,
      courseName: course.name,
      totalAmount: reg.totalAmount,
      contractToken: token,
    },
  });
});

/* ------------------------------------------------------------------ */
/* החוזה הדיגיטלי                                                       */
/* ------------------------------------------------------------------ */

const findByToken = async (token) => {
  const t = cleanStr(token);
  if (!t || t.length < 20) throw ApiError.notFound("החוזה לא נמצא");
  const reg = await Registration.findOne({ "contract.token": t });
  if (!reg || !reg.contract) throw ApiError.notFound("החוזה לא נמצא");
  return reg;
};

/** תיאור אנושי של שיטת התשלום עבור החוזה ("אשראי ב-6 תשלומים", "העברה בנקאית"…). */
function paymentMethodText(payments = []) {
  const HE = {
    credit: "אשראי",
    ern: "הוראת קבע (ERN)",
    cash: "מזומן",
    transfer: "העברה בנקאית",
  };
  const parts = [];
  const seen = new Set();
  for (const p of payments) {
    const m = p.method || "";
    if (seen.has(m)) continue;
    seen.add(m);
    const ofMethod = payments.filter((x) => (x.method || "") === m);
    const spread = ofMethod.find((x) => Number(x.installments) > 1);
    if (m === "credit" && spread) {
      parts.push(`אשראי ב-${spread.installments} תשלומים`);
    } else if (ofMethod.length > 1) {
      parts.push(`${HE[m] || m} - ${ofMethod.length} תשלומים`);
    } else {
      parts.push(HE[m] || m);
    }
  }
  return parts.join(" + ") || "-";
}

/** GET /api/public/contract/:token — תוכן החוזה לצפייה/חתימה. */
export const getContract = asyncHandler(async (req, res) => {
  const reg = await findByToken(req.params.token);
  if (!reg.contract.viewedAt) {
    reg.contract.viewedAt = new Date();
    await reg.save();
  }
  const signed = reg.contract.status === "signed";
  // ת.ז. ומין של הנרשם/ת - הת.ז. שדה חובה בכתב; המין מטה את נוסח ההצהרות
  const student = reg.student
    ? await Student.findById(reg.student)
        .select("realIdNumber idNumber gender")
        .lean()
    : null;
  res.json({
    success: true,
    data: {
      status: reg.contract.status,
      studentName: reg.studentName,
      idNumber: student?.realIdNumber || student?.idNumber || "",
      gender: student?.gender || null,
      paymentMethodText: paymentMethodText(reg.payments),
      courseName: reg.courseRaw || "",
      cohortLabel: reg.cohortLabel || "",
      repName: reg.repName || "",
      dealDate: reg.dealDate,
      totalAmount: reg.totalAmount,
      discountPercent: reg.discountPercent || 0,
      payments: (reg.payments || []).map((p) => ({
        type: p.type,
        amount: p.amount,
        method: p.method,
        dueDate: p.dueDate,
        paid: p.paid,
        installments: p.installments || null,
      })),
      signedAt: signed ? reg.contract.signedAt : null,
      signerName: signed ? reg.contract.signerName : null,
      signatureDataUrl: signed ? reg.contract.signatureDataUrl : null,
    },
  });
});

/** POST /api/public/contract/:token/sign — חתימה דיגיטלית (חד-פעמית). */
export const signContract = asyncHandler(async (req, res) => {
  const reg = await findByToken(req.params.token);
  if (reg.contract.status === "signed") {
    throw ApiError.badRequest("החוזה כבר נחתם - ניתן לצפייה בלבד");
  }
  const signerName = cleanStr(req.body?.signerName);
  const sig = String(req.body?.signatureDataUrl || "");
  if (!signerName) throw ApiError.badRequest("יש להזין שם מלא לאישור החתימה");
  if (!sig.startsWith("data:image/") || sig.length < 200) {
    throw ApiError.badRequest("החתימה ריקה - יש לחתום במסגרת");
  }
  if (sig.length > 300000) throw ApiError.badRequest("החתימה גדולה מדי");

  reg.contract.status = "signed";
  reg.contract.signedAt = new Date();
  reg.contract.signerName = signerName;
  reg.contract.signatureDataUrl = sig;
  // החתימה סוגרת אוטומטית את סעיף "נחתם תקנון" בצ'ק-ליסט של העסקה
  reg.checklist = { ...(reg.checklist?.toObject?.() || reg.checklist || {}), signedTakanon: true };
  reg.noteEntries.push({
    text: `החוזה נחתם דיגיטלית ע"י ${signerName}`,
    date: new Date(),
    byName: "חתימה דיגיטלית",
  });
  reg.recompute();
  await reg.save();

  res.json({
    success: true,
    data: { status: "signed", signedAt: reg.contract.signedAt },
  });
});

/** GET /api/public/contract/:token/status — ל-polling חי מהטופס של הנציגה. */
export const contractStatus = asyncHandler(async (req, res) => {
  const reg = await findByToken(req.params.token);
  res.json({
    success: true,
    data: {
      status: reg.contract.status,
      signedAt: reg.contract.signedAt || null,
      viewedAt: reg.contract.viewedAt || null,
    },
  });
});
