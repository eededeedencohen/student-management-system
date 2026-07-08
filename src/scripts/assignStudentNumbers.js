/** Backfill studentNumber (1..N) for existing students that don't have one yet. */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { default: Student } = await import('../models/Student.js');

await connectDB();

// Continue after the current maximum (so re-running is safe / idempotent).
const top = await Student.findOne({ studentNumber: { $ne: null } })
  .sort({ studentNumber: -1 })
  .select('studentNumber')
  .lean();
let n = top?.studentNumber || 0;

// Deterministic order so numbers are stable across runs.
const missing = await Student.find({
  $or: [{ studentNumber: null }, { studentNumber: { $exists: false } }],
}).sort({ createdAt: 1, _id: 1 });

let assigned = 0;
for (const s of missing) {
  n += 1;
  s.studentNumber = n;
  await s.save();
  assigned += 1;
}

console.log(`✅ assigned studentNumber to ${assigned} students; highest number is now ${n}`);
await disconnectDB();
process.exit(0);
