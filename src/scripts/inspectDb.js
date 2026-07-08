import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');

await connectDB();
const db = mongoose.connection.db;
const cols = await db.listCollections().toArray();
console.log('\nCOLLECTIONS in DB:', mongoose.connection.name);
for (const c of cols) {
  const coll = db.collection(c.name);
  const count = await coll.countDocuments();
  const idx = await coll.indexes();
  console.log(`\n• ${c.name}  (docs: ${count})`);
  idx.forEach((i) => console.log(`    index: ${i.name}  keys=${JSON.stringify(i.key)}  ${i.unique ? 'UNIQUE' : ''}`));
  if (count > 0) {
    const sample = await coll.find({}).limit(1).toArray();
    console.log('    sample keys:', Object.keys(sample[0] || {}).join(', '));
  }
}
await disconnectDB();
process.exit(0);
