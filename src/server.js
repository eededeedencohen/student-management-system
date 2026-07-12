import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { connectDB } = await import('./config/db.js');
const { default: app } = await import('./app.js');
const { autoConfirmDueErn } = await import('./utils/ernAutoConfirm.js');

const PORT = process.env.PORT || 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** תשלומי ERN שמועדם עבר נגבים אוטומטית (הכסף נכנס ביום החיוב גם בלי ✓ ידני). */
const runErnAutoConfirm = async () => {
  try {
    const { flipped, deals } = await autoConfirmDueErn();
    if (flipped) console.log(`💳 ERN: ${flipped} תשלומים אושרו אוטומטית (${deals.join(', ')})`);
  } catch (err) {
    console.error('ERN auto-confirm failed:', err.message);
  }
};

const start = async () => {
  try {
    await connectDB();
    await runErnAutoConfirm(); // בעליית השרת
    setInterval(runErnAutoConfirm, DAY_MS).unref(); // ואחת ליום כל עוד השרת רץ
    app.listen(PORT, () => {
      console.log(`🚀  Safra API listening on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌  Failed to start server:', err.message);
    process.exit(1);
  }
};

start();

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
