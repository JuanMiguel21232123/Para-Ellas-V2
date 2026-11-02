// ---------- Turso: ejecuta SQL por su API HTTP (fetch), sin librerías que instalar ----------
// Necesita TURSO_URL y TURSO_TOKEN (Cloudflare Pages > Settings > Environment variables).
export async function turso(env, sql, args = []) {
  const url = env.TURSO_URL.replace(/^libsql:\/\//, "https://") + "/v2/pipeline";
  const toArg = (v) =>
    v === null || v === undefined ? { type: "null" }
    : typeof v === "boolean" ? { type: "integer", value: v ? "1" : "0" }
    : typeof v === "number" ? { type: Number.isInteger(v) ? "integer" : "float", value: String(v) }
    : { type: "text", value: String(v) };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TURSO_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args: args.map(toArg) } }, { type: "close" }] }),
  });
  const data = await res.json();
  const r = data.results?.[0];
  if (!r || r.type === "error") throw new Error(r?.error?.message || "Error de Turso");
  const { cols, rows, last_insert_rowid, affected_row_count } = r.response.result;
  const value = (c) => (c.type === "null" ? null : c.type === "integer" || c.type === "float" ? Number(c.value) : c.value);
  return {
    rows: rows.map((row) => Object.fromEntries(row.map((c, i) => [cols[i].name, value(c)]))),
    lastInsertRowid: last_insert_rowid,
    changes: affected_row_count,
  };
}

// ---------- Contraseñas: PBKDF2 con Web Crypto, sin librerías externas ----------
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));

async function derive(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return toHex(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return toHex(salt) + ":" + (await derive(password, salt));
}

export async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  return (await derive(password, fromHex(saltHex))) === hashHex;
}

// ---------- Sesión: cookie firmada con HMAC (Web Crypto) ----------
// Necesita SESSION_SECRET (cualquier texto largo e inventado).
const WEEK = 1000 * 60 * 60 * 24 * 7;
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmacKey(env) {
  return crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function makeSessionCookie(env, adminId) {
  const payload = `${adminId}.${Date.now() + WEEK}`;
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(payload)));
  return `session=${encodeURIComponent(payload + "." + sig)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${WEEK / 1000}`;
}

export const clearSessionCookie = () => "session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

export async function readSession(env, cookieHeader) {
  const m = (cookieHeader || "").match(/session=([^;]+)/);
  if (!m) return null;
  const [adminId, expires, sig] = decodeURIComponent(m[1]).split(".");
  if (!adminId || !expires || !sig || Date.now() > Number(expires)) return null;
  const expected = b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(`${adminId}.${expires}`)));
  return sig === expected ? adminId : null;
}

// ---------- Fotos en R2: borra un objeto a partir de su URL pública ----------
export async function deleteImageByUrl(env, url) {
  if (!url || !env.PRODUCT_IMAGES || !env.R2_PUBLIC_BASE) return;
  const base = String(env.R2_PUBLIC_BASE).replace(/\/+$/, "");
  if (!String(url).startsWith(base + "/")) return;
  const key = decodeURIComponent(url.slice(base.length + 1));
  try { await env.PRODUCT_IMAGES.delete(key); } catch (e) {}
}
