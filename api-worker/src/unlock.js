// Uncensored-mode unlock: one shared access code, checked here, never in the
// frontend. A correct code is traded for a signed token (expiry + HMAC keyed by
// the code itself), so rotating UNCENSORED_CODE revokes every token at once and
// no second secret is needed.

const TTL_MS = 30 * 24 * 3600_000;
const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time string compare (equal-length hashes, so no early exit).
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const unlockEnabled = (env) => typeof env.UNCENSORED_CODE === "string" && env.UNCENSORED_CODE.length > 0;

// Compares hashes of both codes, so length differences leak nothing either.
export async function codeMatches(env, code) {
  if (!unlockEnabled(env) || typeof code !== "string" || !code) return false;
  const [a, b] = await Promise.all([hmac(env.UNCENSORED_CODE, `code:${code}`), hmac(env.UNCENSORED_CODE, `code:${env.UNCENSORED_CODE}`)]);
  return same(a, b);
}

export async function issueToken(env) {
  const expires = Date.now() + TTL_MS;
  return { token: `${expires}.${await hmac(env.UNCENSORED_CODE, `unlock:${expires}`)}`, expires };
}

export async function verifyToken(env, token) {
  if (!unlockEnabled(env) || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const expires = Number(token.slice(0, dot));
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  return same(await hmac(env.UNCENSORED_CODE, `unlock:${expires}`), token.slice(dot + 1));
}
