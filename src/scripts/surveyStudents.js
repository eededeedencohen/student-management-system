/** Survey students with multiple linked records ("puzzles") + coherence flags. */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');
const { default: Student } = await import('../models/Student.js');

await connectDB();
const regs = await Registration.find({}).lean();

// group by student id (fallback to name)
const byStudent = new Map();
for (const r of regs) {
  const key = r.student ? String(r.student) : `name:${r.studentName}`;
  const g = byStudent.get(key) || { name: r.studentName, recs: [] };
  g.recs.push(r);
  byStudent.set(key, g);
}

let multi = 0, withPlan = 0, withFollowups = 0, outNoPlan = 0, planNotFullyExplained = 0;
const examples = [];
for (const [, g] of byStudent) {
  const deals = g.recs.filter((r) => r.recordType === 'registration');
  const followups = g.recs.filter((r) => r.recordType === 'collection_followup');
  const refunds = g.recs.filter((r) => r.recordType === 'refund');
  const plans = g.recs.filter((r) => (r.installmentPlan || []).length);
  if (g.recs.length > 1) multi += 1;
  if (plans.length) withPlan += 1;
  if (followups.length) withFollowups += 1;
  const outstanding = deals.reduce((s, r) => s + (r.outstanding || 0), 0);
  if (outstanding > 0.5 && !plans.length) outNoPlan += 1;
  // a deal with outstanding>0, a plan, but pending installments sum far from outstanding => non-fixed remainder
  for (const d of deals) {
    const plan = d.installmentPlan || [];
    if (plan.length) {
      const pending = plan.filter((p) => p.status !== 'paid').reduce((s, p) => s + (p.amount || 0), 0);
      if (Math.abs(pending - (d.outstanding || 0)) > 50) planNotFullyExplained += 1;
    }
  }
  // collect interesting multi-record examples
  if (g.recs.length >= 3 || (deals.length && followups.length)) {
    examples.push({
      name: g.name,
      total: g.recs.length,
      deals: deals.length,
      followups: followups.length,
      refunds: refunds.length,
      outstanding: Math.round(outstanding),
      planLens: plans.map((p) => p.installmentPlan.length),
    });
  }
}

console.log('\n================ STUDENT SURVEY ================');
console.log('students (groups):', byStudent.size);
console.log('  with >1 record:', multi);
console.log('  with an installment plan:', withPlan);
console.log('  with collection-followup rows:', withFollowups);
console.log('  outstanding>0 but NO plan:', outNoPlan, '  (candidates for ad-hoc / non-fixed remainder)');
console.log('  deals whose pending installments != outstanding (±50):', planNotFullyExplained);
console.log('\n--- multi-record "puzzle" examples (top 25 by record count) ---');
examples.sort((a, b) => b.total - a.total).slice(0, 25).forEach((e) =>
  console.log(
    `  ${e.name}: ${e.total} rec (deals ${e.deals}, followups ${e.followups}, refunds ${e.refunds}) | out ₪${e.outstanding} | plans [${e.planLens.join(',')}]`
  )
);

await disconnectDB();
process.exit(0);
