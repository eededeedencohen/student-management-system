/** Coherence audit over EVERY student: money invariant, plan coverage, orphan markers. */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');
const { parseInstallmentMarker } = await import('../utils/normalize.js');

await connectDB();
const regs = await Registration.find({}).lean();
const byStudent = new Map();
for (const r of regs) {
  const k = r.student ? String(r.student) : `name:${r.studentName}`;
  const g = byStudent.get(k) || { name: r.studentName, recs: [] };
  g.recs.push(r);
  byStudent.set(k, g);
}

const flags = { money: [], planMiss: [], orphanMarker: [], nonFixed: [] };
let adhoc = 0, coherent = 0;

for (const [, g] of byStudent) {
  const deals = g.recs.filter((r) => r.recordType === 'registration');
  const markers = g.recs.filter((r) => parseInstallmentMarker(r.courseRaw));
  let studentOk = true;

  for (const d of deals) {
    const t = d.totalAmount || 0;
    const paid = d.totalPaid || 0;
    const out = d.outstanding || 0;
    if (t > 0 && Math.abs(paid + out - t) > 1) {
      flags.money.push(`${g.name} · ${d.courseRaw} · total ${t} paid ${paid} out ${out}`);
      studentOk = false;
    }
    const plan = d.installmentPlan || [];
    if (out > 0.5) {
      const isInstallmentMethod = d.paymentCategory === 'credit' || d.paymentCategory === 'ern';
      if (!plan.length && isInstallmentMethod && (d.installments || 0) > 1) {
        flags.planMiss.push(`${g.name} · ${d.courseRaw} · ${d.paymentCategory} ×${d.installments} · out ${Math.round(out)}`);
        studentOk = false;
      } else if (!plan.length) {
        adhoc += 1; // genuine ad-hoc (transfer/cash/no count) — handled by the page
      }
      if (plan.length) {
        const pend = plan.filter((p) => p.status !== 'paid').reduce((s, p) => s + (p.amount || 0), 0);
        if (Math.abs(pend - out) > 50) {
          flags.nonFixed.push(`${g.name} · ${d.courseRaw} · pending ${Math.round(pend)} vs out ${Math.round(out)}`);
        }
      }
    }
  }

  // orphan marker: an "N/M" collection row whose installment isn't reflected paid in any deal plan
  for (const m of markers) {
    const mk = parseInstallmentMarker(m.courseRaw);
    const covered = mk.indices.every((ix) =>
      deals.some((d) =>
        (d.installmentPlan || []).some((p) => p.index === ix && p.count === mk.count && p.status === 'paid')
      )
    );
    if (!covered) {
      flags.orphanMarker.push(`${g.name} · ${m.courseRaw} (row ${m.sourceRow}) not reflected in a plan`);
      studentOk = false;
    }
  }
  if (studentOk) coherent += 1;
}

const show = (arr) => arr.slice(0, 15).forEach((x) => console.log('     • ' + x));
console.log('\n================ STUDENT COHERENCE AUDIT ================');
console.log('students:', byStudent.size, '| fully coherent:', coherent);
console.log('genuine ad-hoc balances (transfer/cash/no-plan, page-handled):', adhoc);
console.log(`\n⚑ MONEY invariant breaks: ${flags.money.length}`);
show(flags.money);
console.log(`\n⚑ PLAN MISSING (credit/ERN installment deal, owing, no plan): ${flags.planMiss.length}`);
show(flags.planMiss);
console.log(`\n⚑ ORPHAN MARKERS (collected installment not linked to a plan): ${flags.orphanMarker.length}`);
show(flags.orphanMarker);
console.log(`\nℹ NON-FIXED remainders (plan pending != outstanding ±50): ${flags.nonFixed.length}`);
show(flags.nonFixed);

await disconnectDB();
process.exit(0);
