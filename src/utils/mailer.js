import EmailAccount from '../models/EmailAccount.js';
import ApiError from './ApiError.js';
import { refreshAccessToken, buildRawMessage, sendGmailMessage } from './google.js';

/**
 * Server-side mailer over the single connected Google account (see emailController /
 * utils/google.js). Centralizes token loading + refresh so both the "מיילים" page
 * and automatic sends (e.g. the signed-contract email) share one code path.
 */

const ACCOUNT_KEY = 'primary';
const defaultFromName = () => process.env.EMAIL_FROM_NAME || 'מכללת ספרא';

/** Load the stored account WITH its (select:false) tokens, or null if none connected. */
export const loadAccountWithTokens = () =>
  EmailAccount.findOne({ key: ACCOUNT_KEY }).select('+accessToken +refreshToken');

/**
 * Return a valid access token for `acct`, refreshing when the stored one is expired
 * (or when `force` is set — used to recover from a 401 on a not-yet-expired token).
 * Errors are tagged `fatalAuth` so batch callers can stop instead of retrying per item.
 */
export async function ensureAccessToken(acct, { force = false } = {}) {
  const stillValid =
    !force && acct.accessToken && acct.expiryDate && new Date(acct.expiryDate).getTime() > Date.now() + 60_000;
  if (stillValid) return acct.accessToken;
  if (!acct.refreshToken) {
    const e = ApiError.badRequest('החיבור ל-Google פג. יש להתחבר מחדש.');
    e.fatalAuth = true;
    throw e;
  }
  let refreshed;
  try {
    refreshed = await refreshAccessToken(acct.refreshToken);
  } catch (err) {
    if (err.code === 'invalid_grant') {
      await EmailAccount.deleteOne({ key: ACCOUNT_KEY });
      const e = ApiError.badRequest('החיבור ל-Google בוטל. יש להתחבר מחדש.');
      e.fatalAuth = true;
      throw e;
    }
    const e = ApiError.badRequest(err.message || 'רענון ההרשאה מול Google נכשל');
    e.fatalAuth = true;
    throw e;
  }
  acct.accessToken = refreshed.accessToken;
  acct.expiryDate = refreshed.expiryDate;
  await acct.save();
  return acct.accessToken;
}

/**
 * Send ONE email via the connected account (loads + refreshes the token itself).
 * Retries once on a 401 (stale token). Returns the Gmail message id.
 * Throws ApiError.badRequest('EMAIL_NOT_CONNECTED') tagged { notConnected:true }
 * when no account is connected, so callers can treat "not set up" as non-fatal.
 *
 * @param {{to:string,toName?:string,subject:string,html:string,replyTo?:string,
 *          fromName?:string,attachments?:Array}} opts
 */
export async function sendOneEmail(opts) {
  const acct = await loadAccountWithTokens();
  if (!acct || !acct.refreshToken) {
    const e = ApiError.badRequest('לא מחובר חשבון Google לשליחת מיילים');
    e.notConnected = true;
    throw e;
  }
  let forced = false;
  for (;;) {
    try {
      const accessToken = await ensureAccessToken(acct, { force: forced });
      const raw = buildRawMessage({
        from: acct.email || undefined,
        fromName: opts.fromName || defaultFromName(),
        to: opts.to,
        toName: opts.toName,
        subject: opts.subject,
        html: opts.html,
        replyTo: opts.replyTo,
        attachments: opts.attachments,
      });
      return await sendGmailMessage({ accessToken, raw });
    } catch (err) {
      if (err.status === 401 && !forced) {
        forced = true;
        continue;
      }
      throw err;
    }
  }
}
