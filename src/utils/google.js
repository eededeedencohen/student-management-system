import jwt from 'jsonwebtoken';

/**
 * Google OAuth2 + Gmail API helpers (dependency-free — uses Node 18+ global fetch).
 *
 * Flow: the super-admin (עדן) connects a Google account once. We request offline
 * access with the `gmail.send` scope and keep the refresh token, so the server can
 * send mail on that account's behalf ("automatic" sending) without the user present.
 *
 * Nothing here is Safra-specific; it only knows how to talk to Google.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// openid+email → we learn WHICH account was connected (from the id_token);
// gmail.send   → permission to send mail as that account (send-only, cannot read).
export const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
];

const clientId = () => process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || '';

/** True only when both OAuth credentials are configured in the environment. */
export const isGoogleConfigured = () => Boolean(clientId() && clientSecret());

/**
 * The redirect URI Google will send the user back to. Must EXACTLY match one of the
 * "Authorized redirect URIs" registered on the OAuth client in Google Cloud Console.
 * Prefer an explicit env var; otherwise derive it from the incoming request's host.
 */
export const redirectUri = (req) => {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .toString()
    .split(',')[0]
    .trim();
  // Host must be forwarded-aware too (consistent with proto) — behind a proxy the raw
  // Host header can be an internal name, which would produce a redirect_uri_mismatch.
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '')
    .toString()
    .split(',')[0]
    .trim();
  return `${proto}://${host}/api/emails/oauth/callback`;
};

// --- CSRF state (a short-lived signed token proving the flow began authenticated) ---
const STATE_SECRET = () => process.env.JWT_SECRET || 'dev-secret-change-me';

export const signOAuthState = (payload) =>
  jwt.sign({ ...payload, purpose: 'gmail-oauth' }, STATE_SECRET(), { expiresIn: '15m' });

export const verifyOAuthState = (token) => {
  const decoded = jwt.verify(token, STATE_SECRET());
  if (decoded.purpose !== 'gmail-oauth') throw new Error('bad state purpose');
  return decoded;
};

/** Build the Google consent-screen URL the user is redirected to. */
export const buildConsentUrl = ({ redirect, state, loginHint }) => {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirect,
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline', // → issue a refresh token
    prompt: 'consent', // force the consent screen so a refresh token is always returned
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_URL}?${params.toString()}`;
};

/** Decode the `email` claim out of a Google id_token (no verification — it came
 *  straight from Google's token endpoint over TLS). */
const emailFromIdToken = (idToken) => {
  try {
    const payload = idToken.split('.')[1];
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(json).email || '';
  } catch {
    return '';
  }
};

/** Exchange an authorization code for tokens. Returns { accessToken, refreshToken,
 *  expiryDate, scope, email }. */
export const exchangeCodeForTokens = async ({ code, redirect }) => {
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirect,
    grant_type: 'authorization_code',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'החלפת קוד ההרשאה נכשלה');
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiryDate: new Date(Date.now() + (data.expires_in || 3600) * 1000),
    scope: data.scope || '',
    email: emailFromIdToken(data.id_token || ''),
  };
};

/** Use a refresh token to obtain a fresh access token. Returns { accessToken, expiryDate }. */
export const refreshAccessToken = async (refreshToken) => {
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant → the user revoked access or the token expired; caller re-connects.
    const err = new Error(data.error_description || data.error || 'רענון ההרשאה נכשל');
    err.code = data.error;
    throw err;
  }
  return {
    accessToken: data.access_token,
    expiryDate: new Date(Date.now() + (data.expires_in || 3600) * 1000),
  };
};

// --- RFC 5322 / MIME message building ---------------------------------------

/** Encode a header value as RFC 2047 encoded-words (UTF-8, Base64), folding so no
 *  single encoded-word exceeds the 75-char limit and no multi-byte char is split. */
const encodeHeaderWord = (str) => {
  if (/^[\x20-\x7E]*$/.test(str)) return str; // pure ASCII → leave as-is
  const words = [];
  let bytes = [];
  const flush = () => {
    if (!bytes.length) return;
    const b64 = Buffer.from(bytes).toString('base64');
    words.push(`=?UTF-8?B?${b64}?=`);
    bytes = [];
  };
  for (const ch of str) {
    const chBytes = [...Buffer.from(ch, 'utf8')];
    if (bytes.length + chBytes.length > 45) flush(); // ≤45 bytes → encoded-word ≤ ~72 chars
    bytes.push(...chBytes);
  }
  flush();
  return words.join('\r\n '); // fold with CRLF + space between encoded-words
};

/** Format an address as `Display Name <email>` (name encoded if non-ASCII, or
 *  quoted if it is pure-ASCII but contains an RFC 5322 special like a comma —
 *  otherwise the comma would be parsed as an address-list separator). */
const formatAddress = (email, name) => {
  if (!name) return email;
  const encoded = encodeHeaderWord(name);
  if (encoded === name && /[()<>@,;:\\".[\]]/.test(name)) {
    // encoded-words must NOT be quoted, so quote only on the untouched pure-ASCII path
    return `"${name.replace(/([\\"])/g, '\\$1')}" <${email}>`;
  }
  return `${encoded} <${email}>`;
};

/** Wrap a long base64 string to 76-char lines (RFC 2045). */
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n').trimEnd();

/**
 * Encode an attachment filename parameter. RFC 2047 encoded-words are NOT allowed
 * inside a quoted MIME parameter, so for non-ASCII names use RFC 2231 (`name*=` /
 * `filename*=UTF-8''<pct-encoded>`) with an ASCII fallback that strict clients read.
 */
const filenameParam = (param, name) => {
  const s = String(name || 'attachment');
  if (/^[\x20-\x7E]*$/.test(s)) return `${param}="${s.replace(/(["\\])/g, '\\$1')}"`;
  const pct = encodeURIComponent(s).replace(/['()*!~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${param}="attachment.pdf"; ${param}*=UTF-8''${pct}`;
};

/**
 * Build a base64url-encoded RFC 5322 message ready for gmail.users.messages.send.
 * Body is sent as UTF-8 HTML. When `attachments` are given the message becomes
 * multipart/mixed (HTML part + each file). `from` is informational — Gmail sends
 * as the authenticated account regardless.
 *
 * @param {Array<{filename:string, mimeType:string, base64:string}>} [attachments]
 */
export const buildRawMessage = ({ from, fromName, to, toName, subject, html, replyTo, attachments }) => {
  const headers = [];
  // Omit From when the address is unknown — Gmail fills it with the authenticated
  // account. Setting a malformed/empty From would be rejected.
  if (from) headers.push(`From: ${formatAddress(from, fromName)}`);
  headers.push(`To: ${formatAddress(to, toName)}`);
  if (replyTo) headers.push(`Reply-To: ${replyTo}`);
  headers.push(`Subject: ${encodeHeaderWord(subject || '')}`, 'MIME-Version: 1.0');

  const htmlPart =
    'Content-Type: text/html; charset="UTF-8"\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    wrap76(Buffer.from(html || '', 'utf8').toString('base64'));

  let mime;
  const files = Array.isArray(attachments) ? attachments.filter((a) => a && a.base64) : [];
  if (files.length === 0) {
    mime = `${headers.join('\r\n')}\r\nContent-Type: text/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(
      Buffer.from(html || '', 'utf8').toString('base64'),
    )}`;
  } else {
    const boundary = `=_safra_${Buffer.from(String(files.length) + subject).toString('base64url').slice(0, 24)}`;
    const parts = [`--${boundary}\r\n${htmlPart}`];
    for (const f of files) {
      const b64 = wrap76(String(f.base64).replace(/\s+/g, ''));
      parts.push(
        `--${boundary}\r\n` +
          `Content-Type: ${f.mimeType || 'application/octet-stream'}; ${filenameParam('name', f.filename)}\r\n` +
          `Content-Transfer-Encoding: base64\r\n` +
          `Content-Disposition: attachment; ${filenameParam('filename', f.filename)}\r\n\r\n` +
          b64,
      );
    }
    const bodyMultipart = `${parts.join('\r\n')}\r\n--${boundary}--`;
    mime = `${headers.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${bodyMultipart}`;
  }
  return Buffer.from(mime, 'utf8').toString('base64url');
};

/** Send one message via the Gmail API using a valid access token. Returns the
 *  Gmail message id on success; throws with a Hebrew-friendly message otherwise. */
export const sendGmailMessage = async ({ accessToken, raw }) => {
  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || data.error_description || 'שליחת המייל נכשלה';
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data.id;
};
