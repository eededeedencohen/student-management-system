/** Emit a compact JSON list of students that need verification (multi-record or owing). */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');

await connectDB();
const regs = await Registration.find({}).select('student studentName recordType totalAmount totalPaid outstanding installmentPlan').lean();
const byStudent = new Map();
for (const r of regs) {
  if (!r.student) continue;
  const k = String(r.student);
  const g = byStudent.get(k) || { id: k, name: r.studentName, recs: 0, deals: 0, out: 0, plan: false };
  g.recs += 1;
  if (r.recordType === 'registration' || r.recordType === 'refund') g.deals += 1;
  if (r.recordType === 'registration') g.out += r.outstanding || 0;
  if ((r.installmentPlan || []).length) g.plan = true;
  byStudent.set(k, g);
}
const list = [...byStudent.values()]
  .filter((g) => g.recs > 1 || g.out > 0.5)
  .map((g) => ({ id: g.id, name: g.name, recs: g.recs, deals: g.deals, out: Math.round(g.out), plan: g.plan }));
console.log('COUNT=' + list.length);
console.log(JSON.stringify(list));
await disconnectDB();
process.exit(0);
