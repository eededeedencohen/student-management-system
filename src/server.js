// שעון ישראל לכל חישובי הזמן המקומיים (setHours/getDate/toLocaleDateString) - גם
// כשהשרת רץ ב-UTC (Render). חייב להיקבע לפני כל שימוש ב-Date.
process.env.TZ = 'Asia/Jerusalem';

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { connectDB } = await import('./config/db.js');
const { default: app } = await import('./app.js');
const { autoConfirmDueErn } = await import('./utils/ernAutoConfirm.js');

const PORT = process.env.PORT || 5000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * הוראות קבע שמועדן עבר נגבות אוטומטית (הכסף יורד ביום החיוב גם בלי ✓ ידני; רק הו"ק -
 * owner rule 2026-08-27). עסקה שנשמרת עם הו"ק שמועדה כבר עבר מסומנת מיד ב-pre-save של
 * המודל; הריצה כאן סוגרת את מה שהגיע מועדו מאז - כל שעה, כדי שחיוב של היום ייסגר
 * בבוקר ולא "מתי שהשרת עלה + 24 שעות".
 */
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
    // In production, refuse to boot without a real JWT_SECRET. Both auth tokens and the
    // OAuth "state" that guards the public /api/emails/oauth/callback are signed with it;
    // silently falling back to the published dev constant would make them forgeable.
    if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
      console.error('❌  JWT_SECRET חייב להיות מוגדר בפרודקשן (אחרת טוקני התחברות ו-OAuth ניתנים לזיוף)');
      process.exit(1);
    }
    await connectDB();
    await runErnAutoConfirm(); // בעליית השרת
    setInterval(runErnAutoConfirm, HOUR_MS).unref(); // וכל שעה כל עוד השרת רץ
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
