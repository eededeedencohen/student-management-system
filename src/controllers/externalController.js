import crypto from "crypto";
import asyncHandler from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import Registration from "../models/Registration.js";
import Student from "../models/Student.js";
import Course from "../models/Course.js";
import CourseCohort from "../models/CourseCohort.js";
import User from "../models/User.js";
import ContractPdf from "../models/ContractPdf.js";
import { attachCreationReceipts } from "./registrationController.js";
import { sendOneEmail } from "../utils/mailer.js";
import { contractEmailHtml } from "../utils/contractEmailHtml.js";

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

/**
 * קורס NLP פרקטישינר — התעודה הבינלאומית מונפקת באנגלית, ולכן ההרשמה אליו
 * מחייבת שם פרטי ומשפחה באנגלית ופנייה (.Mr/.Ms/.Mrs). הזיהוי לפי שם הקורס,
 * עמיד לכתיב מלא/חסר (פרקטישינר/פרקטישינייר) ולשם באנגלית.
 */
const requiresEnglishDetails = (courseName = "") =>
  String(courseName).replace(/י/g, "").includes("פרקטשנר") ||
  /practitioner/i.test(String(courseName));

/**
 * הנציגות הפעילות + המחזורים שבהרשמה פתוחה - מה שהטופס צריך ותו לא.
 * הרשימה מגיעה ממערכת המחזורים (CourseCohort), לא מרשומות האקסל הישנות:
 * רק מחזור שהוגדר/נערך בעמוד הקטלוג וסומן "הרשמה פתוחה" מוצע בטופס.
 */
export const formOptions = asyncHandler(async (req, res) => {
  const [reps, cohorts] = await Promise.all([
    User.find({ role: "rep", active: true }).select("name").sort({ name: 1 }).lean(),
    CourseCohort.find({ registrationOpen: true })
      .populate("catalogCourse", "name price")
      .lean(),
  ]);
  const courses = cohorts
    .filter((c) => c.catalogCourse) // מחזור יתום ללא קורס קטלוגי — אין מה להציג
    .map((c) => {
      const sessions = [...(c.sessions || [])].sort(
        (a, b) => new Date(a.date) - new Date(b.date),
      );
      return {
        _id: String(c._id), // מזהה המחזור — הטופס שולח אותו כ-course ביצירת העסקה
        name: c.catalogCourse.name,
        cohortLabel: c.label || "",
        price: Number(c.catalogCourse.price) || 0,
        startDate: sessions[0]?.date || null,
        deliveryMode: c.deliveryMode || "", // zoom / frontal / hybrid ("" = לא הוגדר)
        requiresEnglish: requiresEnglishDetails(c.catalogCourse.name),
      };
    })
    .sort((a, b) => {
      // מתחילים בקרוב — קודם; מחזורים בלי מפגשים — בסוף, לפי שם
      if (a.startDate && b.startDate) return new Date(a.startDate) - new Date(b.startDate);
      if (a.startDate) return -1;
      if (b.startDate) return 1;
      return a.name.localeCompare(b.name, "he");
    });
  res.json({
    success: true,
    data: {
      reps: reps.map((r) => ({ _id: String(r._id), name: r.name })),
      courses,
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
  // פנייה: גבר תמיד .Mr; אישה בוחרת .Ms/.Mrs. לא חובה — אלא בקורס פרקטישינר
  // (נבדק בהמשך מול הקורס שנבחר), כי שם התעודה באנגלית מחייבת אותה.
  const title =
    gender === "male" ? "Mr." : ["Ms.", "Mrs."].includes(b.title) ? b.title : null;
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

  // --- קורס: מחזור מהמערכת החדשה, חייב להיות בהרשמה פתוחה ---
  const cohort = await CourseCohort.findById(b.course)
    .populate("catalogCourse", "name price")
    .lean();
  if (!cohort || !cohort.catalogCourse) throw ApiError.badRequest("יש לבחור קורס מהרשימה");
  if (!cohort.registrationOpen) {
    throw ApiError.badRequest("ההרשמה למחזור הזה סגורה - יש לבחור מחזור אחר");
  }

  // NLP פרקטישינר: התעודה מונפקת באנגלית — שם באנגלית ופנייה הם חובה
  if (requiresEnglishDetails(cohort.catalogCourse.name) && (!firstNameEn || !lastNameEn || !title)) {
    throw ApiError.badRequest(
      "לקורס NLP פרקטישינר חובה למלא שם פרטי ומשפחה באנגלית ופנייה (.Mr/.Ms/.Mrs) - התעודה מונפקת באנגלית",
    );
  }

  // אופן השתתפות: מחזור "לפי בחירה" (hybrid) מחייב את בחירת הנרשם/ת בין
  // זום לפרונטלי; מחזור עם אופן קבוע יורש אותו אוטומטית.
  let deliveryMode = ["zoom", "frontal"].includes(cohort.deliveryMode)
    ? cohort.deliveryMode
    : null;
  if (cohort.deliveryMode === "hybrid") {
    const pick = cleanStr(b.deliveryChoice);
    if (!["zoom", "frontal"].includes(pick)) {
      throw ApiError.badRequest("יש לבחור אופן השתתפות - זום או פרונטלי");
    }
    deliveryMode = pick;
  }

  // רשומת ה-Course הישנה המקושרת (mirror/רשומת אקסל) — הדוחות והעמוד הראשי רצים עליה
  const legacyCourse = cohort.sourceCourse
    ? await Course.findById(cohort.sourceCourse).select("name field cohortLabel").lean()
    : null;
  const courseName =
    legacyCourse?.name ||
    `${cohort.catalogCourse.name}${cohort.label ? ` ${cohort.label}` : ""}`;

  const finalPrice = round2(b.finalPrice);
  if (!(finalPrice > 0)) throw ApiError.badRequest("מחיר העסקה אינו תקין");
  const listPrice = Number(cohort.catalogCourse.price) || 0;
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
      title: title || undefined,
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
    if (title) student.title = title;
    else if (gender === "female" && student.title === "Mr.") student.title = undefined; // אישה לא נשארת .Mr
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

  const DELIVERY_HE = { zoom: "זום", frontal: "פרונטלי" };
  const reg = new Registration({
    schemaVersion: 2,
    student: student._id,
    studentName: fullName,
    rep: rep._id,
    repName: rep.name,
    course: legacyCourse?._id,
    courseRaw: courseName,
    courseField: legacyCourse?.field || cohort.catalogCourse.name,
    cohortLabel: legacyCourse?.cohortLabel || cohort.label || "",
    cohort: cohort._id, // שיוך רשמי למחזור — נספר ב"נרשמים" וחוסם מחיקת מחזור בשוגג
    deliveryMode: deliveryMode || undefined,
    dealDate: new Date(),
    dealPrice: finalPrice,
    discountPercent,
    payments,
    paymentCategory: dominant,
    noteEntries: [
      {
        text: `נוצר מהטופס החיצוני · נציגה: ${rep.name} · ת.ז. ${idNumber} · ${email} · ${phone} · ${city}, ${street} ${houseNumber}${b.apartment ? `/${cleanStr(b.apartment)}` : ""}${deliveryMode ? ` · אופן השתתפות: ${DELIVERY_HE[deliveryMode]}${cohort.deliveryMode === "hybrid" ? " (לפי בחירת הנרשם/ת)" : ""}` : ""}`,
        date: new Date(),
        byName: `${rep.name} (טופס חיצוני)`,
      },
    ],
    recordType: "registration",
    contract: { token, status: "pending", createdAt: new Date() },
  });
  reg.recompute();
  await reg.save();

  // אסמכתאות העברה בנקאית שצורפו כבר בטופס (אופציונלי)
  if (await attachCreationReceipts(reg, rawPayments, `${rep.name} (טופס חיצוני)`)) {
    await reg.save();
  }

  res.status(201).json({
    success: true,
    data: {
      dealId: String(reg._id),
      studentName: fullName,
      courseName,
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
  // האם כבר נשמר עותק PDF? (לשימוש ה"ריפוי-עצמי" בצד הלקוח אם ההפקה נכשלה בעבר)
  const pdfStored = signed ? Boolean(await ContractPdf.exists({ registration: reg._id })) : false;
  res.json({
    success: true,
    data: {
      status: reg.contract.status,
      pdfStored,
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

/**
 * POST /api/public/contract/:token/email
 * body: { pdfBase64, force? }
 * מקבל את ה-PDF החתום, שומר עותק לשליחה חוזרת בעתיד, ושולח ללקוח. "מיטב-מאמץ":
 * אם אין חשבון Google מחובר או אין מייל — לא נכשל, רק מדווח (וה-PDF כבר נשמר, כך
 * שאפשר לשלוח מאוחר יותר מעמוד "מיילים"). חד-פעמי אלא אם force=true (שליחה חוזרת).
 */
export const emailSignedContract = asyncHandler(async (req, res) => {
  const reg = await findByToken(req.params.token);
  if (reg.contract.status !== "signed") {
    throw ApiError.badRequest("החוזה טרם נחתם");
  }
  const force = Boolean(req.body?.force);

  const pdfBase64 = String(req.body?.pdfBase64 || "")
    .replace(/^data:application\/pdf;base64,/, "")
    .replace(/\s+/g, "");
  if (!pdfBase64 || pdfBase64.length < 1000) {
    throw ApiError.badRequest("קובץ ה-PDF חסר או פגום");
  }
  if (pdfBase64.length > 14_000_000) {
    throw ApiError.badRequest("קובץ ה-PDF גדול מדי");
  }
  // חייב להיות PDF אמיתי (הסימן "%PDF" = "JVBER" ב-base64) — לא להעלות בייטים שרירותיים
  if (!pdfBase64.startsWith("JVBER")) {
    throw ApiError.badRequest("הקובץ אינו PDF תקין");
  }

  const filename = `תקנון-מכללת-ספרא-${reg.studentName || "חוזה"}.pdf`;

  // שומרים עותק PDF רק בפעם הראשונה ($setOnInsert) — כדי שאפשר יהיה לשלוח שוב מאוחר
  // יותר, אך בלי לאפשר לדרוס את "העותק החתום שברשומה" בהעלאה חוזרת (מניעת זיוף).
  await ContractPdf.findOneAndUpdate(
    { registration: reg._id },
    {
      $setOnInsert: {
        registration: reg._id,
        token: reg.contract.token,
        filename,
        pdfBase64,
        byteLength: pdfBase64.length,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // חד-פעמי: לא שולחים שוב אם כבר נשלח (אלא אם force)
  if (reg.contract.emailedAt && !force) {
    return res.json({
      success: true,
      data: { emailed: true, already: true, to: reg.contract.emailedTo || null },
    });
  }

  const student = reg.student
    ? await Student.findById(reg.student).select("email firstName fullName").lean()
    : null;
  const to = cleanStr(student?.email).toLowerCase();
  if (!to) {
    return res.json({ success: true, data: { emailed: false, reason: "no_email" } });
  }

  try {
    await sendOneEmail({
      to,
      toName: reg.studentName || "",
      subject: "עותק חתום — תקנון מכללת ספרא",
      html: contractEmailHtml({
        name: student?.firstName || reg.studentName,
        courseName: reg.courseRaw,
      }),
      attachments: [{ filename, mimeType: "application/pdf", base64: pdfBase64 }],
    });
  } catch (err) {
    // לא מחובר / ההרשאה בוטלה — החתימה כבר הצליחה וה-PDF נשמר; לא מפילים את הזרימה.
    if (err.notConnected || err.fatalAuth) {
      return res.json({
        success: true,
        data: { emailed: false, reason: err.notConnected ? "not_connected" : "auth_failed" },
      });
    }
    throw err;
  }

  reg.contract.emailedAt = new Date();
  reg.contract.emailedTo = to;
  reg.markModified("contract");
  reg.noteEntries.push({
    text: `עותק חתום של החוזה נשלח למייל ${to}`,
    date: new Date(),
    byName: "מערכת",
  });
  await reg.save();

  res.json({ success: true, data: { emailed: true, to } });
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

/**
 * GET /api/public/contract/:token/pdf
 * הורדת עותק ה-PDF החתום ע"י החותם עצמו — דרך אותו token סודי שמקנה גישה לחוזה.
 * זמין רק אחרי חתימה; אם אין עותק שמור (חתימות ישנות) הקליינט מפיק אחד מקומית.
 */
export const downloadSignedContractPdf = asyncHandler(async (req, res) => {
  const reg = await findByToken(req.params.token);
  if (reg.contract.status !== "signed") {
    throw ApiError.badRequest("החוזה טרם נחתם");
  }
  const doc = await ContractPdf.findOne({ registration: reg._id }).lean();
  if (!doc?.pdfBase64) {
    throw ApiError.notFound("אין עותק PDF שמור לחוזה זה");
  }
  const filename = doc.filename || `תקנון-מכללת-ספרא-${reg.studentName || "חוזה"}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  return res.send(Buffer.from(doc.pdfBase64, "base64"));
});
