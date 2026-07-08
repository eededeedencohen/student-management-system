/**
 * reconcile.js — self-check over EVERY deal. The core invariant the owner defined:
 *   collected + future-scheduled  ==  deal total      (or collected == total when done)
 * Flags every deal that does not reconcile, is over-collected, or owes money with no plan
 * and no collection note (i.e. time passed but nothing recorded).
 *   node src/scripts/reconcile.js
 */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');

const TOL = 50;
await connectDB();
const deals = await Registration.find({ recordType: 'registration' }).lean();

const flags = { over: [], unreconciled: [], uncovered: [], zeroTotal: [] };
let reconciled = 0;
let totalRevenue = 0, totalCollected = 0, totalFuture = 0;

for (const d of deals) {
  const total = d.totalAmount || 0;
  const paid = d.totalPaid || 0;
  const out = d.outstanding || 0;
  const plan = d.installmentPlan || [];
  const pending = plan.filter((p) => p.status !== 'paid').reduce((s, p) => s + (p.amount || 0), 0);
  const tag = `${d.studentName} · ${d.courseRaw || d.courseField} · ₪${Math.round(total)} (paid ${Math.round(paid)}, out ${Math.round(out)}, future ${Math.round(pending)})`;

  totalRevenue += total;
  totalCollected += paid;
  totalFuture += pending;

  if (!(total > 0)) {
    flags.zeroTotal.push(tag);
    continue;
  }
  if (paid > total + 1) {
    flags.over.push(tag);
    continue;
  }
  if (plan.length) {
    // a plan must CLOSE the deal: collected + future ≈ total
    if (Math.abs(paid + pending - total) > TOL) flags.unreconciled.push(tag);
    else reconciled += 1;
  } else if (out > 1) {
    // owing with no plan — acceptable only if a collection note documents it
    if (!d.nextPaymentNote && !d.notes) flags.uncovered.push(tag);
    else reconciled += 1; // documented ad-hoc
  } else {
    reconciled += 1; // fully paid, nothing pending
  }
}

const show = (arr) => arr.slice(0, 20).forEach((x) => console.log('   • ' + x));
console.log('\n================ RECONCILIATION SELF-CHECK ================');
console.log(`deals checked: ${deals.length} | reconciled: ${reconciled}`);
console.log(`Σ total ₪${Math.round(totalRevenue).toLocaleString()} | Σ collected ₪${Math.round(totalCollected).toLocaleString()} | Σ future ₪${Math.round(totalFuture).toLocaleString()}`);
console.log(`collected + future = ₪${Math.round(totalCollected + totalFuture).toLocaleString()}  (vs total ₪${Math.round(totalRevenue).toLocaleString()})`);
console.log(`\n⚑ OVER-COLLECTED (paid > total): ${flags.over.length}`);
show(flags.over);
console.log(`\n⚑ PLAN DOESN'T CLOSE (paid+future ≠ total ±${TOL}): ${flags.unreconciled.length}`);
show(flags.unreconciled);
console.log(`\n⚑ OWING, NO PLAN & NO NOTE (time passed, nothing recorded): ${flags.uncovered.length}`);
show(flags.uncovered);
console.log(`\n⚑ ZERO-TOTAL DEALS (should be 0): ${flags.zeroTotal.length}`);
show(flags.zeroTotal);

await disconnectDB();
process.exit(0);
