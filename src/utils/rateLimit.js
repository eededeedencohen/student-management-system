/**
 * Minimal in-memory per-IP rate limiter (dependency-free). Best-effort: resets on
 * restart and is per-process, but it caps abuse of the PUBLIC (unauthenticated)
 * contract routes - e.g. someone driving the connected Gmail to send mail in bulk.
 */
const buckets = new Map();

const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim() ||
  req.socket?.remoteAddress ||
  req.connection?.remoteAddress ||
  "unknown";

export function rateLimit({ windowMs = 60_000, max = 30, key = "rl" } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const k = `${key}:${clientIp(req)}`;
    let b = buckets.get(k);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(k, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.set("Retry-After", String(Math.ceil((b.reset - now) / 1000)));
      return res
        .status(429)
        .json({
          success: false,
          message: "יותר מדי בקשות. נסו שוב מאוחר יותר.",
        });
    }
    // prune expired entries occasionally so the map can't grow unbounded
    if (buckets.size > 5000) {
      for (const [key2, v] of buckets) if (now > v.reset) buckets.delete(key2);
    }
    next();
  };
}
