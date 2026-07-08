/** Detect running-ledger "snapshot" duplicates: same student+course+total repeated. */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Registration } = await import('../models/Registration.js');
const { cleanStr } = await import('../utils/normalize.js');

await connectDB();
const regs = await Registration.find({ recordType: 'registration' }).lean();
const norm = (s) => cleanStr(s).replace(/\s+/g, ' ');
const groups = new Map();
for (const r of regs) {
  if (!(r.totalAmount > 0)) continue;
  const key = `${norm(r.studentName)}||${r.courseField || r.courseRaw}||${Math.round(r.totalAmount)}`;
  const g = groups.get(key) || [];
  g.push(r);
  groups.set(key, g);
}
let dupGroups = 0, droppedRows = 0, inflatedRevenue = 0, inflatedOut = 0;
const examples = [];
for (const [key, g] of groups) {
  if (g.length < 2) continue;
  dupGroups += 1;
  droppedRows += g.length - 1;
  inflatedRevenue += (g.length - 1) * g[0].totalAmount;
  // keeper = max paid; the rest are dropped
  g.sort((a, b) => (b.totalPaid || 0) - (a.totalPaid || 0));
  inflatedOut += g.slice(1).reduce((s, r) => s + (r.outstanding || 0), 0);
  if (examples.length < 12) examples.push(`${g[0].studentName} · ${g[0].courseField} · ₪${g[0].totalAmount} ×${g.length} (keep paid ${g[0].totalPaid})`);
}
const totalRev = regs.reduce((s, r) => s + (r.totalAmount || 0), 0);
const totalOut = regs.reduce((s, r) => s + (r.outstanding || 0), 0);
console.log('\n========= SNAPSHOT DETECTION =========');
console.log('registration rows:', regs.length);
console.log('duplicate groups (same student+course+total):', dupGroups);
console.log('snapshot rows that would be dropped:', droppedRows);
console.log('current total revenue:', Math.round(totalRev).toLocaleString(), '→ after dedup ~', Math.round(totalRev - inflatedRevenue).toLocaleString());
console.log('current total outstanding:', Math.round(totalOut).toLocaleString(), '→ would drop ~', Math.round(inflatedOut).toLocaleString());
console.log('\nexamples:');
examples.forEach((e) => console.log('  • ' + e));
await disconnectDB();
process.exit(0);
