/**
 * מטא-דאטה בעברית לעמוד "מסד הנתונים" (מנהל-העל): שמות עבריים לאוספים ולשדות,
 * חלוקה לתחומים, וקשרי FK שאינם מוגדרים כ-`ref` בסכימה (למשל מזהה תת-מסמך).
 * הסכימה עצמה נקראת אוטומטית ממודלי Mongoose - כאן רק מה שהקוד לא יודע לבד.
 */

export const DOMAINS = [
  { key: "core", label: "ליבת המכירות" },
  { key: "catalog", label: "קטלוג ולוח זמנים" },
  { key: "users", label: "משתמשים ואבטחה" },
  { key: "tools", label: "כלי מכירה וניהול" },
  { key: "forms", label: "טפסים ציבוריים" },
  { key: "legacy", label: "שאריות ייבוא (legacy)" },
];

// לפי שם האוסף ב-Mongo
export const COLLECTIONS = {
  registrations: { he: "עסקאות / רישומים", domain: "core", desc: "עסקה אחת = מסמך אחד: תלמיד/ה, נציגה, מחזור, מחיר, התשלומים (מוטמעים), חוזה דיגיטלי, ביטול, צ'קליסט והערות. השדות הכספיים המסוכמים מחושבים ב-recompute() מתוך payments." },
  students: { he: "תלמידים", domain: "core", desc: "אדם אחד = מסמך אחד. פרטים אישיים בלבד; כל רכישה היא עסקה שמצביעה לכאן." },
  paymentreceipts: { he: "אסמכתאות העברה", domain: "core", desc: "תמונת אסמכתת העברה בנקאית של תשלום ספציפי (base64), באוסף נפרד כדי לא להכביד על העסקה." },
  contractpdfs: { he: "קבצי חוזה (PDF)", domain: "core", desc: "עותק ה-PDF של החוזה החתום, לשליחה חוזרת במייל. מסמך אחד לעסקה. האוסף הכבד ביותר במסד." },
  catalogcourses: { he: "קורסים קטלוגיים", domain: "catalog", desc: "הגדרת הקורס הקבועה (שם, מחיר מחירון, מספר מפגשים). המחזורים מצביעים לכאן." },
  coursecohorts: { he: "מחזורים", domain: "catalog", desc: "מחזור קונקרטי של קורס קטלוגי: מרצים, מיקום, מפגשים, סטטוס, הרשמה פתוחה." },
  teachers: { he: "מרצים", domain: "catalog", desc: "מרצים שמשויכים למחזורים. הטלפון הוא המפתח העסקי (ייחודי)." },
  courses: { he: "קורסים (מערכת ישנה)", domain: "legacy", desc: "רשומות קורס/מחזור מהאקסלים. כל עסקה עדיין מצביעה לכאן (course) לצד המחזור החדש (cohort)." },
  users: { he: "משתמשים", domain: "users", desc: "נציגות ומנהלים: התחברות, תפקיד, הרשאות, הגדרות עמלה." },
  loginevents: { he: "כניסות למערכת", domain: "users", desc: "רשומה לכל התחברות / חזרה עם טוקן. למסך פעילות התחברות." },
  emailaccounts: { he: "חשבון Gmail", domain: "users", desc: "חשבון Google היחיד שמחובר לשליחת מייל (מסמך יחיד, key=primary)." },
  quotes: { he: "הצעות מחיר", domain: "tools", desc: "הצעת מחיר שמורה ממחולל ההצעות, עם סטטוס ידני." },
  quotepdfs: { he: "קבצי הצעה (PDF)", domain: "tools", desc: "PDF של הצעת מחיר לקישור ציבורי (token). מסמך אחד להצעה." },
  quotetemplates: { he: "טמפלטים להצעות", domain: "tools", desc: "טמפלטים משותפים להצעות מחיר; fields מכיל רק שדות שנבחרו." },
  goals: { he: "יעדים", domain: "tools", desc: "יעד לנציגה או לצוות לתקופה (סכום מכירות / כמות עסקאות / גבייה / אחוז סגירה)." },
  expenses: { he: "הוצאות", domain: "tools", desc: "הוצאות קבועות/משתנות לתחזית התזרים." },
  detailsforms: { he: "טפסי השלמת פרטים", domain: "forms", desc: "טופס אחד למחזור עם קישור ציבורי (token)." },
  detailssubmissions: { he: "הגשות טופס פרטים", domain: "forms", desc: "הגשה אחת של טופס השלמת פרטים. ההתאמה לתלמיד/ה מחושבת בזמן אמת ולא נשמרת." },
  sourcerows: { he: "שורות אקסל מקוריות", domain: "legacy", desc: "העתק של שורות האקסלים המקוריים עם העיצוב. שימש את עמוד עריכת הנתונים שנמחק." },
  sourcerefs: { he: "עקיבות לאקסל", domain: "legacy", desc: "גשר: עסקה או תשלום → שורת האקסל שממנה יובאו. מוגדר כזמני." },
  sourcecourseblocks: { he: "בלוקי קורסים מהאקסל", domain: "legacy", desc: "עמודות הקורסים מ-קורסים.xlsx של יקיר, עם העיצוב." },
};

// שם עברי לשדה - לפי שם השדה בלבד (ללא הנתיב); מקרים מיוחדים לפי "אוסף.נתיב"
export const FIELD_HE = {
  _id: "מזהה", __v: "גרסת מסמך", createdAt: "נוצר ב", updatedAt: "עודכן ב",
  student: "תלמיד/ה", studentName: "שם התלמיד/ה", idNumber: "ת.ז.", rep: "נציגה", repName: "שם הנציגה",
  cohort: "מחזור", cohortsAll: "כל המחזורים", course: "קורס (ישן)", coursesAll: "כל הקורסים (ישן)", courseRaw: "שם קורס גולמי",
  courseField: "משפחת קורס", cohortLabel: "תווית מחזור", coursesInfo: "פרטי קורסים לחוזה", deliveryMode: "אופן השתתפות",
  externalId: "מזהה חיצוני", dealDate: "תאריך עסקה", dealDateRaw: "תאריך עסקה גולמי", dateAssumed: "תאריך משוער",
  schemaVersion: "גרסת סכימה", recordType: "סוג רשומה", needsReview: "דורש בדיקה",
  dealPrice: "מחיר העסקה", discountPercent: "אחוז הנחה", writeOff: "מחילה", totalAmount: "סה\"כ עסקה", totalPaid: "נגבה",
  outstanding: "יתרה", paymentStatus: "סטטוס תשלום", nextPaymentDate: "תאריך גבייה הבא", nextPaymentNote: "הערת גבייה",
  reconciled: "מאוזן", reconcileNote: "הערת איזון", paymentCategory: "קטגוריית תשלום", installments: "מספר תשלומים",
  advancePaid: "מקדמה ששולמה", balanceDue: "יתרה לתשלום", finalBalance: "יתרה סופית", amountExVat: "סכום ללא מע\"מ", vatAmount: "מע\"מ",
  primaryPaymentMethod: "אופן תשלום ראשי", installmentPlan: "לוח תשלומים (ישן)", payments: "תשלומים",
  type: "סוג", amount: "סכום", method: "אופן תשלום", methodCategory: "קטגוריית אופן תשלום", dueDate: "מועד", paid: "שולם",
  canceled: "בוטל", addedOnCancel: "נוסף בביטול", confirmedBy: "אושר ע\"י", confirmedByName: "שם המאשר/ת", confirmedAt: "אושר ב", noAutoConfirm: "ללא אישור אוטומטי (בוטל ידנית)",
  receiptReference: "מספר אסמכתא", receiptImage: "יש תמונת אסמכתא", receiptUploadedAt: "אסמכתא הועלתה ב", receiptUploadedByName: "מי העלה אסמכתא",
  note: "הערה", date: "תאריך", dateRaw: "תאריך גולמי", kind: "סוג", source: "מקור", index: "אינדקס", count: "כמות", label: "תווית",
  paidAt: "שולם ב", sourceRow: "שורת מקור", sourceFile: "קובץ מקור", sourceSheet: "גיליון מקור",
  contract: "חוזה", token: "טוקן (מזהה קישור)", status: "סטטוס", viewedAt: "נצפה ב", signedAt: "נחתם ב", signerName: "שם החותם/ת",
  signatureDataUrl: "תמונת חתימה", signedVia: "דרך חתימה", emailedAt: "נשלח במייל ב", emailedTo: "נשלח למייל",
  cancellation: "ביטול", canceledAt: "בוטל ב", by: "ע\"י", byName: "שם המבצע/ת", refunds: "החזרים", sourcePaymentId: "תשלום מקור",
  refunded: "הוחזר", refundedAt: "הוחזר ב", refundedByName: "הוחזר ע\"י",
  checklist: "צ'קליסט", signedTakanon: "נחתם תקנון", addedToCourseWhatsapp: "נכנס/ה לקבוצת הקורס", addedToAlumniWhatsapp: "נכנס/ה לקבוצת בוגרים",
  invoiceIssued: "הוצאה חשבונית", courseGroups: "קבוצות קורס", key: "מפתח", name: "שם", added: "נוסף/ה",
  checklistComplete: "צ'קליסט הושלם", noteEntries: "יומן הערות", text: "טקסט", notes: "הערות", registeredByRaw: "נרשם/ה ע\"י (גולמי)",
  studentNumber: "מספר תלמיד/ה", fullName: "שם מלא", firstName: "שם פרטי", lastName: "שם משפחה", hebrewName: "שם בעברית", englishName: "שם באנגלית",
  realIdNumber: "ת.ז. אמיתית", gender: "מין", title: "פנייה / כותרת", mobile: "נייד", email: "מייל", city: "עיר", street: "רחוב", houseNumber: "מספר בית",
  apartment: "דירה", zip: "מיקוד", addressNotes: "הערות לכתובת",
  registration: "עסקה", paymentId: "מזהה תשלום", imageDataUrl: "תמונה (base64)", byteLength: "גודל (תווים)", uploadedAt: "הועלה ב", uploadedByName: "מי העלה",
  filename: "שם קובץ", pdfBase64: "קובץ PDF (base64)",
  price: "מחיר", defaultSessionCount: "מספר מפגשים ברירת מחדל", active: "פעיל",
  catalogCourse: "קורס קטלוגי", sourceCourse: "קורס מקור (ישן)", teachers: "מרצים", teacher: "מרצה", defaultLocation: "מיקום ברירת מחדל",
  sessions: "מפגשים", startTime: "שעת התחלה", endTime: "שעת סיום", location: "מיקום", registrationOpen: "הרשמה פתוחה",
  phone: "טלפון", field: "משפחת קורס", rawNames: "שמות גולמיים", startDate: "תאריך התחלה", endDate: "תאריך סיום", startDateRaw: "התחלה גולמי",
  endDateRaw: "סיום גולמי", sessionsCount: "מספר מפגשים", lecturer: "מרצה (טקסט)", weekday: "יום בשבוע",
  username: "שם משתמש", passwordHash: "סיסמה (hash)", passwordReset: "איפוס סיסמה", tokenHash: "hash של הטוקן", expiresAt: "תוקף",
  createdByName: "שם היוצר/ת", role: "תפקיד", superAdmin: "מנהל-על", formsAccess: "גישה לטפסים",
  quickDealAccess: "גישה לעסקה מהירה", testOnly: "לטסטים בלבד", aliases: "כינויים", commission: "עמלה", baseSalary: "שכר בסיס",
  commissionRate: "אחוז עמלה", tiers: "מדרגות", fromSales: "ממכירות של", rate: "אחוז",
  user: "משתמש/ת", at: "בזמן", ip: "כתובת IP", userAgent: "דפדפן",
  accessToken: "טוקן גישה", refreshToken: "טוקן רענון", expiryDate: "תפוגה", scope: "הרשאות / היקף", connectedById: "חובר ע\"י (מזהה)",
  connectedByName: "חובר ע\"י", connectedAt: "חובר ב",
  quoteNo: "מספר הצעה", statusAt: "סטטוס עודכן ב", statusByName: "סטטוס עודכן ע\"י", courseName: "שם קורס", description: "תיאור",
  sessionLength: "אורך מפגש", schedule: "לוח זמנים", place: "מקום", recordedLine: "שורת הקלטה", createdBy: "נוצר ע\"י",
  quote: "הצעת מחיר", fields: "שדות",
  metric: "מדד", targetValue: "ערך יעד", periodType: "סוג תקופה", workingDays: "ימי עבודה",
  category: "קטגוריה", vatIncluded: "כולל מע\"מ", recurrence: "חזרתיות", dayOfMonth: "יום בחודש",
  form: "טופס", firstNameHe: "שם פרטי בעברית", lastNameHe: "שם משפחה בעברית", firstNameEn: "שם פרטי באנגלית", lastNameEn: "שם משפחה באנגלית",
  file: "קובץ", sheet: "גיליון", row: "שורה", isHeader: "שורת כותרת", cells: "תאים", deal: "עסקה", payment: "תשלום",
  column: "עמודה", startRow: "שורת התחלה", entries: "רשומות", value: "ערך", v: "טקסט התא", bg: "צבע רקע", color: "צבע טקסט",
  bold: "מודגש", italic: "נטוי", strike: "קו חוצה",
};

// שם עברי מיוחד לפי "אוסף.נתיב" (עוקף את FIELD_HE)
export const FIELD_HE_BY_PATH = {
  "students.idNumber": "ת.ז. סינתטית (מהייבוא)",
  "goals.scope": "היקף (נציגה/צוות)",
  "emailaccounts.scope": "הרשאות OAuth",
  "goals.rep": "נציגה (ריק = צוות)",
};

/**
 * קשרי FK שאינם `ref` בסכימה (מזהה של תת-מסמך או מחרוזת). key = "אוסף.נתיב".
 * target = אוסף היעד; targetPath = לאן בדיוק בתוך המסמך.
 */
export const EXTRA_FKS = {
  "paymentreceipts.paymentId": { target: "registrations", targetPath: "payments[]._id", note: "מזהה תשלום בתוך מערך payments של העסקה" },
  "sourcerefs.payment": { target: "registrations", targetPath: "payments[]._id", note: "null = הפניה ברמת העסקה" },
  "registrations.cancellation.refunds[].sourcePaymentId": { target: "registrations", targetPath: "payments[]._id", note: "נשמר כמחרוזת" },
  "emailaccounts.connectedById": { target: "users", targetPath: "_id", note: "נשמר כמחרוזת, לא ObjectId" },
  "registrations.sourceRow": { target: "sourcerows", targetPath: "row (יחד עם sourceFile = file)", note: "קשר לוגי, לא מזהה" },
  "sourcerefs.sourceRow": { target: "sourcerows", targetPath: "row (יחד עם sourceFile = file)", note: "קשר לוגי, לא מזהה" },
};

// שדות שלעולם לא נשלחים ללקוח כערך מלא
export const REDACTED_FIELDS = new Set([
  "passwordHash", "accessToken", "refreshToken", "tokenHash", "passwordReset",
]);
// שדות שמכילים base64 ארוך - נשלחים מקוצרים
export const LONG_BINARY_FIELDS = new Set(["pdfBase64", "imageDataUrl", "signatureDataUrl"]);

// השדה שמייצג "שם" לתצוגת FK לכל אוסף (הראשון שקיים)
export const DISPLAY_FIELDS = {
  students: ["fullName"], users: ["name"], registrations: ["studentName", "courseRaw"], coursecohorts: ["label"],
  catalogcourses: ["name"], teachers: ["fullName"], courses: ["name"], quotes: ["quoteNo", "fullName"],
  detailsforms: ["token"], goals: ["title"], expenses: ["name"], quotetemplates: ["name"],
};
