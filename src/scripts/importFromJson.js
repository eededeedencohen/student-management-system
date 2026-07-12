/**
 * importFromJson.js — מאחד את מסד הנתונים עם ה-JSON המתוקן (organize-student-data/output/students.json).
 * ה-JSON הוא מקור האמת: הסקריפט בונה את המסד מחדש ממנו.
 *
 * בטיחות (לקחים מסקירה אדוורסרית):
 *   1. ריצה יבשה קודם — כל 345 העסקאות נבנות ומאומתות בזיכרון מול ה-JSON לפני שנוגעים במסד.
 *      אי-התאמה כלשהי ⇒ יציאה עם קוד 1 בלי למחוק כלום.
 *   2. גיבוי JSON של האוספים הנמחקים נכתב לקובץ לפני המחיקה.
 *   3. עסקת "שולם" עם פער מחיר (הנחה בדיעבד) ⇒ הפער נרשם כ-writeOff, הסטטוס נשמר "שולם"
 *      ואין חוב פתוח מזויף. עסקה מבוטלת ⇒ היתרה נרשמת כ-writeOff (לא חוב).
 *   4. דגלי מקור נשמרים: תאריך/אמצעי משוער בהערת התשלום; needsReview רק לרמת high
 *      (רמת info = הנחה מתועדת ⇒ הערה בלבד).
 *   5. קוד יציאה: 0 רק כשכל האימותים עברו.
 *
 * מיפוי:
 *   student  → Student { studentNumber = json.id, idNumber = realIdNumber }
 *   deal     → Registration schemaVersion=2 עם dealPrice מפורש
 *   payment  → מקדמה→advance, חד פעמי→one_time, פריסה→installment
 *              פריסת אשראי = רשומה אחת (הכרטיס חויב ⇒ הכסף נגבה)
 *              פריסת ERN   = מפוצלת ל-N תשלומים עם דגל paid לפי confirmations
 *   sourceRef "מיכל!488" → SourceRef (kind deal/payment) + sourceFile/Row על העסקה
 *   advertisers → Expenses (קטגוריה פרסום)
 *
 *   node src/scripts/importFromJson.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const ROOT = path.resolve(__dirname, '../../../');
const JSON_PATH = path.join(ROOT, 'organize-student-data', 'output', 'students.json');
const BACKUP_DIR = path.join(ROOT, 'organize-student-data', 'backups');

const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');
const { default: Student } = await import('../models/Student.js');
const { default: Course } = await import('../models/Course.js');
const { default: User } = await import('../models/User.js');
const { default: Lead } = await import('../models/Lead.js');
const { default: Expense } = await import('../models/Expense.js');
const { default: SourceRef } = await import('../models/SourceRef.js');
const { splitName } = await import('../utils/normalize.js');

const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
console.log(`📖 students.json: ${data.students.length} סטודנטים, ${data.courses.length} קורסים, ` +
  `${data.advertisers.length} מפרסמים, ${data.issues.length} בעיות (נוצר ${data.meta.generatedAt})`);

const warns = [];
const warn = (msg) => { warns.push(msg); };

// ---------- helpers ---------------------------------------------------------
const METHOD_MAP = { 'אשראי': 'credit', 'העברה בנקאית': 'transfer', 'ERN': 'ern', 'מזומן': 'cash' };
const STATUS_HE_TO_EN = { 'שולם': 'paid', 'שולם חלקית': 'partial', 'לא שולם': 'unpaid' };
const normName = (s) => String(s || '').replace(/["'׳״\s.()\-]/g, '').toLowerCase();

/** "מיכל!488" → { file:'מיכל.xlsx', sheet:'924', row:488 } */
const SHEET_BY_FILE = { 'מיכל': '924', 'מורן': 'גיליון1' };
const parseSourceRef = (ref) => {
  const m = /^(.+)!(\d+)$/.exec(String(ref || '').trim());
  if (!m) return null;
  return { file: `${m[1]}.xlsx`, sheet: SHEET_BY_FILE[m[1]] || undefined, row: parseInt(m[2], 10) };
};

/** base ISO date + i months, day clamped to the target month's length (UTC-safe). */
const addMonthsClamped = (iso, i) => {
  const b = new Date(iso);
  const y = b.getUTCFullYear();
  const m = b.getUTCMonth() + i;
  const day = b.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, lastDay)));
};

/**
 * Build the unified v2 payment list + derived deal facts for one JSON deal.
 * Pure (no DB) — used identically by the dry-run validation and the real import.
 */
function buildDeal(s, dl) {
  const payments = [];
  for (const p of dl.payments || []) {
    const method = METHOD_MAP[p.method] || 'other';
    if (!METHOD_MAP[p.method]) warn(`אמצעי תשלום לא מוכר בעסקה ${dl.dealId}: "${p.method}"`);
    const src = parseSourceRef(p.sourceRef);
    const srcLabel = src ? `${src.file} שורה ${src.row}` : (p.sourceRef || '');
    // provenance flags from the source — kept on the payment note
    const prov = [
      p.dateApproximate ? 'תאריך משוער' : '',
      p.methodAssumed ? 'אמצעי תשלום משוער' : '',
    ].filter(Boolean);

    if (p.type === 'פריסה לתשלומים' && p.method === 'ERN') {
      // expand the ERN schedule into N dated payments with real paid-flags
      const det = p.details || {};
      const n = det.installmentCount || (det.confirmations || []).length || 1;
      const per = det.installmentAmount || (det.totalAmount || 0) / n;
      const confirmations = det.confirmations || [];
      let scheduled = 0;
      for (let i = 0; i < n; i += 1) {
        const isLast = i === n - 1;
        const amount = isLast && det.totalAmount ? Math.round((det.totalAmount - scheduled) * 100) / 100 : per;
        scheduled += amount;
        payments.push({
          type: 'installment',
          amount,
          method: 'ern',
          methodCategory: 'ern',
          dueDate: det.firstPaymentDateISO ? addMonthsClamped(det.firstPaymentDateISO, i) : undefined,
          paid: confirmations[i] === true,
          installments: n,
          note: [
            `ERN ${i + 1}/${n}`,
            det.stoppedAfter != null && i >= det.stoppedAfter ? `⚠️ ההוראה הופסקה לאחר ${det.stoppedAfter}` : '',
            p.note || '', ...prov,
          ].filter(Boolean).join(' · '),
          source: srcLabel,
        });
      }
      const rcv = payments.filter((x) => x.method === 'ern' && x.paid).reduce((a, x) => a + x.amount, 0);
      if (det.amountReceivedToDate != null && Math.abs(rcv - det.amountReceivedToDate) > 1) {
        warn(`${dl.dealId}: ERN amountReceivedToDate=${det.amountReceivedToDate} אך סכום המאושרים=${rcv}`);
      }
    } else {
      const det = p.details || {};
      const isSpread = p.type === 'פריסה לתשלומים';
      const inst = det.installmentCount || 1;
      payments.push({
        type: p.type === 'מקדמה' ? 'advance' : isSpread ? 'installment' : 'one_time',
        amount: det.amount ?? det.totalAmount ?? 0,
        method,
        methodCategory: method,
        dueDate: det.date ? new Date(det.date) : dl.dealDate ? new Date(dl.dealDate) : undefined,
        paid: true, // כסף שנרשם במקור = נגבה (פריסת אשראי: הכרטיס חויב)
        installments: isSpread && inst > 1 ? inst : undefined, // מטא-פריסה רק על פריסה אמיתית
        note: [isSpread && inst > 1 ? `פריסת אשראי ל-${inst} תשלומים` : '', p.note || '', ...prov]
          .filter(Boolean).join(' · '),
        source: srcLabel,
      });
    }
  }

  const isCancelled = dl.status === 'לא בוצע';
  const balance = dl.balance || 0;
  const collected = payments.reduce((a, x) => a + (x.paid ? x.amount : 0), 0);
  const unpaidScheduled = payments.filter((x) => !x.paid).reduce((a, x) => a + x.amount, 0);

  // writeOff — closes gaps the source declares settled:
  //   * status "שולם" with a price gap = הנחה בדיעבד/עיגול (₪2 עד ₪1,600 במקור)
  //   * cancelled deal's remaining balance is not collectible debt
  let writeOff = 0;
  let writeOffNote = '';
  if (!isCancelled && dl.status === 'שולם' && balance > 0.5) {
    writeOff = balance;
    writeOffNote = `הפרש ₪${balance.toLocaleString()} מהמחיר נסגר כהנחה/עיגול (במקור: שולם)`;
  } else if (isCancelled && balance > 0.5) {
    writeOff = balance;
    writeOffNote = `עסקה בוטלה — היתרה (₪${balance.toLocaleString()}) אינה חוב לגבייה`;
  }

  // expected derived values (must match what recompute() will produce)
  const expectedOut = Math.max((dl.price || 0) - collected - writeOff, 0);
  const expectedStatus = (dl.price || 0) > 0 && expectedOut <= 0.5 ? 'paid' : collected > 0 ? 'partial' : 'unpaid';

  const reconciled = isCancelled || expectedOut <= 0.5 || Math.abs(unpaidScheduled - expectedOut) <= 1;
  return { payments, isCancelled, balance, collected, unpaidScheduled, writeOff, writeOffNote, expectedOut, expectedStatus, reconciled };
}

/** Validate one built deal against the JSON's authoritative numbers. */
function checkDeal(s, dl, built, mismatches) {
  if (Math.abs(built.collected - (dl.totalPaid || 0)) > 1) {
    mismatches.push(`${dl.dealId} (${s.name}): totalPaid=${built.collected} JSON=${dl.totalPaid}`);
  }
  // outstanding: a settled ("שולם") or cancelled deal must end with 0 open debt
  const jsonExpectedOut = dl.status === 'שולם' || built.isCancelled ? 0 : Math.max(built.balance, 0);
  if (Math.abs(built.expectedOut - jsonExpectedOut) > 1) {
    mismatches.push(`${dl.dealId} (${s.name}): outstanding=${built.expectedOut} מצופה=${jsonExpectedOut}`);
  }
  if (!built.isCancelled && STATUS_HE_TO_EN[dl.status] && built.expectedStatus !== STATUS_HE_TO_EN[dl.status]) {
    mismatches.push(`${dl.dealId} (${s.name}): status=${built.expectedStatus} JSON=${dl.status}`);
  }
}

await connectDB();
let exitCode = 0;

try {
  // ======================= שלב 1: ריצה יבשה (ללא כתיבה) =======================
  const dryMismatches = [];
  for (const s of data.students) for (const dl of s.deals) checkDeal(s, dl, buildDeal(s, dl), dryMismatches);
  if (dryMismatches.length) {
    console.error(`\n✗ הריצה היבשה מצאה ${dryMismatches.length} אי-התאמות — המסד לא נגעּ. פירוט:`);
    dryMismatches.slice(0, 30).forEach((m) => console.error('   ' + m));
    process.exitCode = 1;
    await disconnectDB();
    process.exit(1);
  }
  console.log(`✅ ריצה יבשה: כל ${data.students.reduce((a, s) => a + s.deals.length, 0)} העסקאות משוחזרות בדיוק (0 אי-התאמות) — ממשיכים`);

  // ======================= שלב 2: גיבוי לפני מחיקה ============================
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `pre-json-import-${stamp}.json`);
  const backup = {
    registrations: await Registration.find({}).lean(),
    students: await Student.find({}).lean(),
    sourceRefs: await SourceRef.find({}).lean(),
    expensesImported: await Expense.find({ sourceFile: { $exists: true, $ne: null } }).lean(),
  };
  fs.writeFileSync(backupPath, JSON.stringify(backup));
  console.log(`💾 גיבוי נשמר: ${backupPath} (${backup.registrations.length} עסקאות, ${backup.students.length} סטודנטים)`);

  // ======================= שלב 3: נציגות + קורסים =============================
  const users = await User.find({}).lean();
  const repByJsonName = new Map();
  for (const u of users) for (const k of [u.name, ...(u.aliases || [])]) if (k) repByJsonName.set(normName(k), u);
  const resolveRep = (name) => repByJsonName.get(normName(name)) || null;
  for (const rn of new Set(data.students.flatMap((s) => s.deals.map((d) => d.rep)))) {
    if (!resolveRep(rn)) warn(`נציגה לא מזוהה: "${rn}"`);
  }

  const existingCourses = await Course.find({}).lean();
  const courseByNorm = new Map(existingCourses.map((c) => [normName(c.name), c]));
  let coursesCreated = 0;
  let coursesEnriched = 0;
  for (const jc of data.courses) {
    const key = normName(jc.name);
    const found = courseByNorm.get(key);
    if (found) {
      const set = {};
      if (!found.field && jc.type) set.field = jc.type;
      if (!found.cohortLabel && jc.cohort && jc.cohort !== 'לא משובץ') set.cohortLabel = jc.cohort;
      if (!found.location && jc.location) set.location = jc.location;
      if (Object.keys(set).length) {
        await Course.updateOne({ _id: found._id }, { $set: set });
        coursesEnriched += 1;
      }
    } else {
      const isOld = /\/(24|25)\b/.test(jc.cohort || '');
      const doc = await Course.create({
        name: jc.name,
        field: jc.type || undefined,
        cohortLabel: jc.cohort && jc.cohort !== 'לא משובץ' ? jc.cohort : undefined,
        location: jc.location || undefined,
        status: /לא משובץ/.test(jc.name) ? 'לא משובץ' : isOld ? 'הסתיים' : 'פעיל',
        rawNames: [jc.name],
        sourceFile: 'students.json',
      });
      courseByNorm.set(key, doc.toObject());
      coursesCreated += 1;
    }
  }
  const resolveCourse = (name) => courseByNorm.get(normName(name)) || null;

  // ======================= שלב 4: מחיקה ובנייה מחדש ===========================
  const delRegs = await Registration.deleteMany({});
  const delStu = await Student.deleteMany({});
  const delRefs = await SourceRef.deleteMany({});
  const delExp = await Expense.deleteMany({ sourceFile: { $exists: true, $ne: null } });
  await Lead.updateMany({}, { $unset: { convertedRegistration: 1 } });
  console.log(`🧹 נמחקו: ${delRegs.deletedCount} עסקאות, ${delStu.deletedCount} סטודנטים, ` +
    `${delRefs.deletedCount} רפרנסים, ${delExp.deletedCount} הוצאות מיובאות`);

  const studentDocs = data.students.map((s) => {
    const { firstName, lastName } = splitName(s.name);
    return {
      studentNumber: s.id, fullName: s.name, firstName, lastName,
      idNumber: String(s.id), // ת.ז. סינתטית 1001+ — כמו ב-JSON
      realIdNumber: s.realIdNumber || undefined, // ת.ז. אמיתית כשידועה
      sourceFile: 'students.json',
    };
  });
  const insertedStudents = await Student.insertMany(studentDocs);
  const studentByJsonId = new Map();
  data.students.forEach((s, i) => studentByJsonId.set(s.id, insertedStudents[i]));
  console.log(`👤 נוצרו ${insertedStudents.length} סטודנטים (studentNumber = מזהה JSON, כולל ת.ז. אמיתיות)`);

  const mismatches = [];
  const sourceRefDocs = [];
  let dealsCreated = 0;
  let paymentsCreated = 0;
  let writeOffs = 0;

  for (const s of data.students) {
    const stuDoc = studentByJsonId.get(s.id);
    for (const dl of s.deals) {
      const built = buildDeal(s, dl);
      const repUser = resolveRep(dl.rep);
      const courseDocs = (dl.courses || []).map((cn) => {
        const c = resolveCourse(cn);
        if (!c) warn(`קורס לא נמצא לעסקה ${dl.dealId}: "${cn}"`);
        return c;
      }).filter(Boolean);
      const primaryCourse = courseDocs[0] || null;

      const dealDateObj = dl.dealDate ? new Date(dl.dealDate) : new Date();
      const noteEntries = [];
      for (const n of dl.notes || []) noteEntries.push({ text: n, date: dealDateObj, byName: 'ייבוא JSON' });
      if (dl.cancellationNote) noteEntries.push({ text: `ביטול: ${dl.cancellationNote}`, date: dealDateObj, byName: 'ייבוא JSON' });
      if (built.writeOffNote) noteEntries.push({ text: built.writeOffNote, date: dealDateObj, byName: 'ייבוא JSON' });
      const reasons = [...(dl.reviewReasons || [])];
      if (dl.priceInferred) reasons.push('המחיר הוסק (לא נכתב במקור)');
      if (dl.dealDateApproximate) reasons.push('תאריך העסקה משוער');
      const isHigh = dl.reviewLevel === 'high';
      for (const r of reasons) {
        noteEntries.push({ text: `${isHigh ? 'לבדיקה' : 'הנחה מתועדת'}: ${r}`, date: dealDateObj, byName: 'ייבוא JSON' });
      }

      const catCount = {};
      for (const x of built.payments) catCount[x.method] = (catCount[x.method] || 0) + 1;
      const dominant = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0]?.[0];
      const maxInst = Math.max(1, ...built.payments.map((x) => x.installments || 1));
      const firstSrc = parseSourceRef((dl.sourceRows || [])[0]);

      const reg = new Registration({
        schemaVersion: 2,
        externalId: dl.dealId,
        student: stuDoc._id,
        studentName: s.name,
        idNumber: String(s.id),
        rep: repUser?._id,
        repName: repUser?.name || dl.rep,
        course: primaryCourse?._id,
        coursesAll: courseDocs.length > 1 ? courseDocs.map((c) => c._id) : undefined,
        courseRaw: dl.courseRaw || dl.courseName,
        courseField: primaryCourse?.field || undefined,
        cohortLabel: primaryCourse?.cohortLabel || undefined,
        dealDate: dealDateObj,
        dateAssumed: dl.dealDateApproximate === true,
        dealPrice: dl.price,
        writeOff: built.writeOff,
        discountPercent: 0,
        payments: built.payments,
        paymentCategory: dominant,
        installments: maxInst > 1 ? maxInst : undefined,
        recordType: built.isCancelled ? 'cancelled' : 'registration',
        // needsReview רק לבעיות אמיתיות (high); רמת info = הנחה מתועדת (בהערות)
        needsReview: isHigh,
        reconciled: built.reconciled,
        reconcileNote: built.reconciled ? undefined
          : `יתרה של ₪${built.expectedOut.toLocaleString()} ללא פריסה מתועדת${reasons.length ? ' · ' + reasons[0] : ''}`,
        noteEntries,
        notes: (dl.notes || []).join(' | ') || undefined,
        nextPaymentNote: !built.isCancelled && built.expectedOut > 0.5
          ? (dl.notes || []).concat(built.payments.map((x) => x.note).filter(Boolean)).find((t) => /בהמשך|תשלומים|לחודש/.test(t || ''))
          : undefined,
        sourceFile: firstSrc?.file,
        sourceSheet: firstSrc?.sheet,
        sourceRow: firstSrc?.row,
      });
      reg.recompute();

      // אימות סופי מול הריצה היבשה (חייב להיות זהה — אותה פונקציה)
      if (Math.abs((reg.totalPaid || 0) - built.collected) > 0.5 ||
          Math.abs((reg.outstanding || 0) - built.expectedOut) > 0.5 ||
          (!built.isCancelled && reg.paymentStatus !== built.expectedStatus)) {
        mismatches.push(`${dl.dealId}: recompute שונה מהסימולציה (paid ${reg.totalPaid}/${built.collected}, out ${reg.outstanding}/${built.expectedOut}, status ${reg.paymentStatus}/${built.expectedStatus})`);
      }

      await reg.save();
      dealsCreated += 1;
      paymentsCreated += reg.payments.length;
      if (built.writeOff > 0) writeOffs += 1;

      for (const srcRow of dl.sourceRows || []) {
        const pr = parseSourceRef(srcRow);
        if (pr) sourceRefDocs.push({ deal: reg._id, kind: 'deal', sourceFile: pr.file, sourceSheet: pr.sheet, sourceRow: pr.row });
      }
      reg.payments.forEach((pm) => {
        const pr = pm.source ? /^(.+\.xlsx) שורה (\d+)$/.exec(pm.source) : null;
        if (pr) sourceRefDocs.push({ deal: reg._id, payment: pm._id, kind: 'payment', sourceFile: pr[1], sourceSheet: SHEET_BY_FILE[pr[1].replace('.xlsx', '')], sourceRow: parseInt(pr[2], 10) });
      });
    }
  }
  if (sourceRefDocs.length) await SourceRef.insertMany(sourceRefDocs);
  console.log(`📄 נוצרו ${dealsCreated} עסקאות · ${paymentsCreated} תשלומים · ${sourceRefDocs.length} רפרנסים · ${writeOffs} עסקאות עם writeOff (הנחה/ביטול)`);
  console.log(`📚 קורסים: ${coursesCreated} נוצרו, ${coursesEnriched} הועשרו (סה"כ ${courseByNorm.size})`);

  // ---------- advertisers → expenses -------------------------------------------
  let expCreated = 0;
  for (const adv of data.advertisers || []) {
    for (const d of adv.deals || []) {
      await Expense.create({
        name: `${adv.name} — ${d.item}`,
        category: 'פרסום',
        amount: d.amount || 0,
        vatIncluded: true,
        type: 'variable',
        date: d.date ? new Date(d.date) : undefined,
        notes: [(d.notes || []).join(' | '), d.amountPaid != null && d.amountPaid !== d.amount ? `שולם: ₪${d.amountPaid}` : ''].filter(Boolean).join(' · ') || undefined,
        sourceFile: 'students.json',
      });
      expCreated += 1;
    }
  }
  console.log(`💸 נוצרו ${expCreated} הוצאות פרסום ממפרסמים`);

  // ======================= שלב 5: אימות מול ה-JSON ============================
  // "נרכש" ב-JSON (totals.purchased) אינו כולל עסקאות מבוטלות; "נגבה" (totals.paid) כן.
  const [aggActive] = await Registration.aggregate([
    { $match: { recordType: { $ne: 'cancelled' } } },
    { $group: { _id: null, total: { $sum: '$totalAmount' }, n: { $sum: 1 } } },
  ]);
  const [aggAll] = await Registration.aggregate([
    { $group: { _id: null, paid: { $sum: '$totalPaid' }, n: { $sum: 1 } } },
  ]);
  const [aggCancelled] = await Registration.aggregate([
    { $match: { recordType: 'cancelled' } },
    { $group: { _id: null, total: { $sum: '$totalAmount' }, paid: { $sum: '$totalPaid' }, out: { $sum: '$outstanding' }, n: { $sum: 1 } } },
  ]);
  const jsonPurchased = data.students.reduce((a, s) => a + s.totals.purchased, 0);
  const jsonPaid = data.students.reduce((a, s) => a + s.totals.paid, 0);
  const jsonDeals = data.students.reduce((a, s) => a + s.deals.length, 0);

  console.log('\n================ אימות מול ה-JSON ================');
  const ok1 = aggAll.n === jsonDeals;
  const ok2 = Math.abs(aggActive.total - jsonPurchased) <= 2;
  const ok3 = Math.abs(aggAll.paid - jsonPaid) <= 2;
  console.log(`עסקאות: DB=${aggAll.n} JSON=${jsonDeals} ${ok1 ? '✓' : '✗'}`);
  console.log(`סה"כ נרכש (ללא מבוטלות): DB=₪${aggActive.total.toLocaleString()}  JSON=₪${jsonPurchased.toLocaleString()}  ${ok2 ? '✓' : '✗ הפרש ' + (aggActive.total - jsonPurchased)}`);
  console.log(`סה"כ נגבה (כולל מבוטלות): DB=₪${aggAll.paid.toLocaleString()}  JSON=₪${jsonPaid.toLocaleString()}  ${ok3 ? '✓' : '✗ הפרש ' + (aggAll.paid - jsonPaid)}`);
  if (aggCancelled) {
    console.log(`מבוטלות: ${aggCancelled.n} עסקאות · מחיר ₪${aggCancelled.total.toLocaleString()} · נגבה ₪${aggCancelled.paid.toLocaleString()} · חוב פתוח ₪${aggCancelled.out.toLocaleString()} (חייב 0)`);
    if (aggCancelled.out > 0.5) mismatches.push(`עסקאות מבוטלות עם חוב פתוח: ₪${aggCancelled.out}`);
  }
  const stDist = await Registration.aggregate([{ $group: { _id: { t: '$recordType', s: '$paymentStatus' }, n: { $sum: 1 } } }]);
  console.log('התפלגות:', stDist.map((x) => `${x._id.t}/${x._id.s}=${x.n}`).sort().join('  '));

  if (!ok1 || !ok2 || !ok3) mismatches.push('אי-התאמה במספרים המצרפיים (ראו למעלה)');
  if (mismatches.length) {
    console.log(`\n✗ אי-התאמות (${mismatches.length}):`);
    mismatches.slice(0, 20).forEach((m) => console.log('   ' + m));
    exitCode = 1;
  } else {
    console.log('\n✓ כל האימותים עברו: המסד תואם 1:1 ל-JSON');
  }
  if (warns.length) {
    console.log(`\n⚠️ אזהרות (${warns.length}):`);
    [...new Set(warns)].slice(0, 20).forEach((w) => console.log('   ' + w));
  }
  console.log(`\n💾 שחזור למצב הקודם במקרה הצורך: הגיבוי ב-${backupPath}`);
} catch (err) {
  console.error('\n💥 שגיאה באמצע הריצה — ייתכן שהמסד במצב חלקי! יש להריץ שוב (הסקריפט אידמפוטנטי) או לשחזר מהגיבוי.');
  console.error(err);
  exitCode = 1;
}

await disconnectDB();
process.exit(exitCode);
