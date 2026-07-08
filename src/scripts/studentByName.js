/** Print one student's fully-assembled picture (all rows, payments, plans). */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Student } = await import('../models/Student.js');
const { default: Registration } = await import('../models/Registration.js');
await import('../models/User.js');
await import('../models/Course.js');

const name = (process.argv[2] || '').trim();
const d = (x) => (x ? new Date(x).toISOString().slice(0, 10) : '?');

await connectDB();
const rx = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
const students = await Student.find({ fullName: rx }).lean();
if (!students.length) console.log('(no student matched: ' + name + ')');
for (const s of students) {
  console.log(`\n==== STUDENT: ${s.fullName} | id ${s._id} | ת.ז. ${s.idNumber || '-'} ====`);
  const regs = await Registration.find({ student: s._id }).sort({ dealDate: 1 }).lean();
  console.log(`records: ${regs.length}`);
  for (const r of regs) {
    console.log(
      ` - [${r.recordType}] "${r.courseRaw || r.courseField}" | total ${r.totalAmount} paid ${r.totalPaid} out ${r.outstanding} | ${r.paymentCategory || ''} x${r.installments || ''} | ${r.sourceFile}#${r.sourceRow}`
    );
    if ((r.payments || []).length) {
      console.log('     payments: ' + r.payments.map((p) => `${p.amount}@${p.dateRaw || d(p.date)}/${p.kind}`).join(' ; '));
    }
    if ((r.installmentPlan || []).length) {
      console.log('     plan: ' + r.installmentPlan.map((p) => `${p.label}=${p.status}:${p.amount}@${d(p.dueDate)}`).join(' ; '));
    }
    if (r.notes) console.log('     notes: ' + r.notes);
  }
}
await disconnectDB();
process.exit(0);
