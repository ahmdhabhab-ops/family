import crypto from "crypto";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET is required (any long random string — used to sign session tokens).");
}
const JWT_EXPIRES_IN = "180d"; // family app on trusted personal devices — long-lived on purpose

// Same digest the old client-side sha256Hex() used, so existing PINs
// (migrated pin_hash values) keep working without anyone re-entering a PIN.
export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function issueToken(memberId) {
  return jwt.sign({ sub: memberId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  try {
    req.memberId = jwt.verify(token, JWT_SECRET).sub;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
