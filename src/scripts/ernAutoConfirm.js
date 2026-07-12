/** הרצה ידנית של אישור ה-ERN האוטומטי:  node src/scripts/ernAutoConfirm.js */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const { connectDB, disconnectDB } = await import('../config/db.js');
const { autoConfirmDueErn } = await import('../utils/ernAutoConfirm.js');

await connectDB();
const { flipped, deals } = await autoConfirmDueErn();
console.log(flipped
  ? `✅ ${flipped} תשלומי ERN אושרו אוטומטית:\n   ${deals.join('\n   ')}`
  : 'אין תשלומי ERN שממתינים לאישור.');
await disconnectDB();
process.exit(0);
