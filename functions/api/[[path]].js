import { turso, tursoBatch, verifyPassword, makeSessionCookie, clearSessionCookie, readSession, deleteImageByUrl } from "../_lib/db.js";

const json = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
const err = (message, status = 400) => json({ error: message }, { status });
const ACCENTS = ["rose", "champagne", "plum"];
const catExists = async (env, slug) =>
  !!slug && (await turso(env, "SELECT 1 FROM categories WHERE slug = ?", [String(slug)])).rows.length > 0;
const slugify = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");

// ---------- Caché de las lecturas públicas (60 s) ----------
// Se guarda el resultado en la caché de Cloudflare: las visitas siguientes no tocan Turso.
// Cada cambio hecho desde el panel admin la borra (purgePublic), así lo nuevo se ve de inmediato.
const CACHE_TTL = 60;
const PUBLIC_CACHE = ["products", "categories", "settings", "subs"];
const cacheKey = (request, name) => new Request(new URL("/__cache/" + name, request.url).href);

async function cachedData(request, ctx, name, produce) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = cacheKey(request, name);
  if (cache) {
    try { const hit = await cache.match(key); if (hit) return await hit.json(); } catch (e) {}
  }
  const data = await produce();
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL}` },
    })).catch(() => {});
    if (ctx.waitUntil) ctx.waitUntil(put);
  }
  return data;
}

async function purgePublic(request) {
  if (typeof caches === "undefined") return;
  await Promise.all(PUBLIC_CACHE.map((n) => caches.default.delete(cacheKey(request, n)).catch(() => {})));
}

// Respuesta pública cacheable también en el navegador del visitante
const publicJson = (data) => json(data, { headers: { "Cache-Control": `public, max-age=${CACHE_TTL}` } });

// Un solo archivo decide la ruta leyendo params.path (todo lo que viene después de /api/).
export async function onRequest(ctx) {
  const { request, params } = ctx;
  let res;
  try { res = await route(ctx); } catch (e) { res = err("server", 500); } // await: así sí se atrapan los errores de las funciones async
  // Cualquier cambio exitoso del admin invalida la caché pública
  if (request.method !== "GET" && (params.path || [])[0] === "admin" && res.status < 400) await purgePublic(request);
  return res;
}

async function route(ctx) {
  const { request, env, params } = ctx;
  const path = (params.path || []).join("/");
  const method = request.method;
  try {
    // ---------- Público ----------
    if (path === "public/products" && method === "GET") return getProducts(request, env, ctx);
    if (path === "public/subs" && method === "GET") return getSubs(request, env, ctx);
    if (path === "public/categories" && method === "GET") return getCategories(request, env, ctx);
    if (path === "public/settings" && method === "GET") return getSettings(request, env, ctx);
    if (path === "login" && method === "POST") return login(request, env);
    if (path === "session" && method === "GET") return getSession(request, env);
    if (path === "session" && method === "DELETE") return json(null, { headers: { "Set-Cookie": clearSessionCookie() } });
    if (path === "orders" && method === "POST") return createOrder(request, env);

    // ---------- Admin: pedidos ----------
    if (path === "admin/orders" && method === "GET") return getAdminOrders(request, env);
    let m = /^admin\/orders\/(\d+)$/.exec(path);
    if (m && method === "PATCH") return updateOrderStatus(request, env, Number(m[1]));
    if (m && method === "DELETE") return deleteOrder(request, env, Number(m[1]));

    // ---------- Admin: subsecciones ----------
    if (path === "admin/subcategories" && method === "GET") return getAdminSubs(request, env);
    if (path === "admin/subcategories" && method === "POST") return createSub(request, env);
    m = /^admin\/subcategories\/(\d+)$/.exec(path);
    if (m && method === "PATCH") return updateSub(request, env, Number(m[1]));
    if (m && method === "DELETE") return deleteSub(request, env, Number(m[1]));

    // ---------- Admin: categorías (menú principal) ----------
    if (path === "admin/categories" && method === "GET") return getAdminCategories(request, env);
    if (path === "admin/categories" && method === "POST") return createCategory(request, env);
    m = /^admin\/categories\/([a-z0-9-]+)$/.exec(path);
    if (m && method === "PATCH") return updateCategory(request, env, m[1]);
    if (m && method === "DELETE") return deleteCategory(request, env, m[1]);

    // ---------- Admin: productos ----------
    if (path === "admin/products" && method === "GET") return getAdminProducts(request, env);
    if (path === "admin/products" && method === "POST") return createProduct(request, env);
    m = /^admin\/products\/(\d+)$/.exec(path);
    if (m && method === "PATCH") return updateProduct(request, env, Number(m[1]));
    if (m && method === "DELETE") return deleteProduct(request, env, Number(m[1]));

    // ---------- Admin: venta en tienda ----------
    if (path === "admin/sales" && method === "POST") return createSale(request, env);

    // ---------- Admin: gastos ----------
    if (path === "admin/expenses" && method === "GET") return getExpenses(request, env);
    if (path === "admin/expenses" && method === "POST") return createExpense(request, env);
    m = /^admin\/expenses\/(\d+)$/.exec(path);
    if (m && method === "DELETE") return deleteExpense(request, env, Number(m[1]));

    // ---------- Admin: personalización ----------
    if (path === "admin/settings" && method === "PATCH") return updateSettings(request, env);

    // ---------- Admin: fotos (R2) ----------
    if (path === "admin/upload" && method === "POST") return uploadPhoto(request, env);
  } catch (e) {
    return err("server", 500);
  }
  return err("not_found", 404);
}

// ---------- Sesión admin ----------
async function requireAdmin(request, env) {
  return await readSession(env, request.headers.get("Cookie"));
}

// =====================================================================
// PÚBLICO
// =====================================================================
async function getProducts(request, env, ctx) {
  const data = await cachedData(request, ctx, "products", async () => {
    const [{ rows: products }, { rows: variants }] = await tursoBatch(env, [
      ["SELECT id, category, subcategory_id, name, description, price, image_url, stock, variant_label FROM products WHERE active = 1 ORDER BY created_at DESC"],
      ["SELECT id, product_id, name, price, stock FROM product_variants WHERE active = 1 ORDER BY id"],
    ]);
    const byProduct = {};
    variants.forEach((v) => (byProduct[v.product_id] ||= []).push({
      id: v.id, name: v.name, price: v.price, active: true, stock: v.stock, sold_out: v.stock != null && v.stock <= 0,
    }));
    return products.map((p) => ({
      id: p.id, category: p.category, subcategory_id: p.subcategory_id, name: p.name, description: p.description,
      price: p.price, image_url: p.image_url, stock: p.stock, sold_out: p.stock != null && p.stock <= 0, variant_label: p.variant_label || null,
      product_variants: byProduct[p.id] || [],
    }));
  });
  return publicJson(data);
}

async function getSubs(request, env, ctx) {
  const cat = new URL(request.url).searchParams.get("c") || "";
  // Se cachean todas las subsecciones juntas y aquí se filtra la colección pedida
  const all = await cachedData(request, ctx, "subs", async () =>
    (await turso(env, "SELECT id, name, sort_order, category FROM subcategories WHERE active = 1 ORDER BY sort_order, id")).rows);
  return publicJson(all.filter((s) => s.category === cat).map(({ id, name, sort_order }) => ({ id, name, sort_order })));
}

async function getSettings(request, env, ctx) {
  const data = await cachedData(request, ctx, "settings", async () => {
    const { rows } = await turso(env, "SELECT key, value FROM site_settings");
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
  return publicJson(data);
}

// Bloqueo del login: 5 claves incorrectas desde la misma IP → 15 minutos de espera.
// La tabla login_attempts se crea sola la primera vez (no hay que hacer nada en Turso).
const LOGIN_MAX_FAILS = 5, LOGIN_WINDOW = "-15 minutes";

async function login(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "desconocida";
  const res = await tursoBatch(env, [
    ["CREATE TABLE IF NOT EXISTS login_attempts (ip TEXT NOT NULL, at TEXT NOT NULL DEFAULT (datetime('now')))"],
    ["DELETE FROM login_attempts WHERE at < datetime('now', ?)", [LOGIN_WINDOW]],
    ["SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?", [ip]],
  ]);
  if ((res[2].rows[0]?.n || 0) >= LOGIN_MAX_FAILS) return err("Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.", 429);

  const { email, password } = await request.json().catch(() => ({}));
  const { rows } = await turso(env, "SELECT id, name, password_hash FROM admins WHERE email = ?", [String(email || "").trim().toLowerCase()]);
  const admin = rows[0];
  if (!admin || !(await verifyPassword(password || "", admin.password_hash))) {
    await turso(env, "INSERT INTO login_attempts (ip) VALUES (?)", [ip]);
    return err("Correo o contraseña incorrectos.", 401);
  }
  await turso(env, "DELETE FROM login_attempts WHERE ip = ?", [ip]);
  return json({ name: admin.name }, { headers: { "Set-Cookie": await makeSessionCookie(env, admin.id) } });
}

async function getSession(request, env) {
  const adminId = await readSession(env, request.headers.get("Cookie"));
  if (!adminId) return json({ name: null });
  const { rows } = await turso(env, "SELECT name FROM admins WHERE id = ?", [adminId]);
  return json({ name: rows[0]?.name || null });
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin O/0/I/1
const genCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
const PENDING_LIMIT = 3; // pedidos "pending" simultáneos permitidos por teléfono
const PENDING_TOTAL_LIMIT = 30; // pedidos "pending" simultáneos en toda la tienda (sube este número si algún día se queda corto)

async function uniqueCode(env) {
  let code = genCode();
  for (let i = 0; i < 5; i++) {
    const { rows } = await turso(env, "SELECT 1 FROM orders WHERE code = ?", [code]);
    if (!rows.length) break;
    code = genCode();
  }
  return code;
}

const MAX_LINES = 60; // líneas máximas por pedido o venta
const toId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const placeholders = (a) => a.map(() => "?").join(",");

// Busca de una vez (2 consultas en 1 llamada) todos los productos y variantes de un pedido.
// Devuelve { lines } o { error }. `price` queda con el precio de la tienda (variante o producto).
async function resolveLines(env, items, { requireActive }) {
  const pids = [...new Set(items.map((it) => toId(it?.id)))];
  if (pids.includes(null)) return { error: "invalid" };
  const vids = [...new Set(items.filter((it) => it.variant_id).map((it) => toId(it.variant_id)))];
  if (vids.includes(null)) return { error: "variant" };
  const [pr, vr] = await tursoBatch(env, [
    [`SELECT id, name, category, price, active FROM products WHERE id IN (${placeholders(pids)})`, pids],
    [`SELECT id, product_id, name, price, active FROM product_variants WHERE id IN (${vids.length ? placeholders(vids) : "NULL"})`, vids],
  ]);
  const prods = new Map(pr.rows.map((r) => [r.id, r]));
  const vars = new Map(vr.rows.map((r) => [r.id, r]));
  const lines = [];
  for (const it of items) {
    const p = prods.get(toId(it.id));
    if (!p || (requireActive && !p.active)) return { error: "invalid" };
    let v = null;
    if (it.variant_id) {
      v = vars.get(toId(it.variant_id));
      if (!v || v.product_id !== p.id || (requireActive && !v.active)) return { error: "variant" };
    }
    const qty = Math.max(1, Math.min(20, Number(it.qty) || 1));
    lines.push({
      product_id: p.id, variant_id: v ? v.id : null, name: p.name, category: p.category,
      variant_name: v ? v.name : null, price: v && v.price != null ? v.price : p.price, qty,
    });
  }
  return { lines };
}

// Consultas que crean el pedido y sus líneas (se ejecutan juntas, en una transacción).
function orderStatements(o, lines) {
  const stmts = [[
    `INSERT INTO orders (code, customer_name, customer_phone, delivery_type, address, neighborhood, payment_method, preferred_time, notes, total, status, status_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [o.code, o.name, o.phone, o.type, o.address ?? null, o.hood ?? null, o.payment ?? null, o.time ?? null, o.notes ?? null, o.total, o.status],
  ]];
  for (const l of lines) {
    stmts.push([
      "INSERT INTO order_items (order_id, product_id, variant_id, name, variant_name, price, quantity, category) VALUES ((SELECT id FROM orders WHERE code = ? ORDER BY id DESC LIMIT 1), ?, ?, ?, ?, ?, ?, ?)",
      [o.code, l.product_id, l.variant_id, l.name, l.variant_name, l.price, l.qty, l.category],
    ]);
  }
  return stmts;
}

async function createOrder(request, env) {
  const b = await request.json().catch(() => null);
  if (!b) return err("data");

  const name = String(b.name || "").trim(), phone = String(b.phone || "").trim();
  if (name.length < 2 || phone.length < 7) return err("data");

  const instore = !!b.instore;
  const address = String(b.address || "").trim(), hood = String(b.neighborhood || "").trim();
  if (!instore && (address.length < 5 || hood.length < 2)) return err("address");

  const payment = String(b.payment || "");
  if (!instore && !["efectivo", "nequi"].includes(payment)) return err("payment");

  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > MAX_LINES) return err("items");

  const { lines, error } = await resolveLines(env, items, { requireActive: true });
  if (error) return err(error);

  const { rows: pending } = await turso(env,
    "SELECT COUNT(*) AS total, COALESCE(SUM(customer_phone = ?), 0) AS mine FROM orders WHERE status = 'pending'", [phone]);
  if ((pending[0]?.mine || 0) >= PENDING_LIMIT) return err("limit");
  if ((pending[0]?.total || 0) >= PENDING_TOTAL_LIMIT) return err("busy"); // freno general contra pedidos en masa

  const total = lines.reduce((t, l) => t + l.price * l.qty, 0);
  const code = await uniqueCode(env);

  await tursoBatch(env, orderStatements({
    code, name, phone, type: instore ? "tienda" : "domicilio",
    address: instore ? null : address, hood: instore ? null : hood, payment: instore ? null : payment,
    time: b.time || null, notes: b.notes || null, total, status: "pending",
  }, lines), { write: true });

  return json({ code, total });
}

// =====================================================================
// EXISTENCIAS: una sola columna `stock` (NULL = sin control) en
// products y product_variants. Se descuenta al confirmar un pedido o
// al registrar una venta en tienda, y se devuelve al cancelar/eliminar
// un pedido que ya estaba confirmado o entregado.
// =====================================================================
class StockError extends Error {
  constructor(itemName) { super("stock"); this.itemName = itemName; }
}

// items: [{ product_id, variant_id, name, variant_name, quantity }]
// sign: -1 descuenta, +1 devuelve
// Devuelve las consultas UPDATE para ejecutar (junto a otras) en una sola transacción.
// Al descontar, primero revisa (todo en 1 llamada) que alcance; si algo no alcanza, lanza StockError y no se toca nada.
async function stockStatements(env, items, sign) {
  const groups = new Map(); // se suman las líneas repetidas del mismo producto/variante
  for (const it of items) {
    const key = it.variant_id ? "v" + it.variant_id : it.product_id ? "p" + it.product_id : null;
    if (!key) continue;
    const g = groups.get(key) || { ...it, quantity: 0 };
    g.quantity += it.quantity;
    groups.set(key, g);
  }
  const list = [...groups.values()];
  if (!list.length) return [];
  if (sign < 0) {
    const current = await tursoBatch(env, list.map((g) => g.variant_id
      ? ["SELECT stock FROM product_variants WHERE id = ?", [g.variant_id]]
      : ["SELECT stock FROM products WHERE id = ?", [g.product_id]]));
    list.forEach((g, i) => {
      const cur = current[i].rows[0] ? current[i].rows[0].stock : null; // null = sin control de existencias
      if (cur != null && cur - g.quantity < 0) throw new StockError(g.variant_name || g.name);
    });
  }
  return list.map((g) => [
    g.variant_id
      ? "UPDATE product_variants SET stock = MAX(0, stock + ?) WHERE id = ? AND stock IS NOT NULL"
      : "UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ? AND stock IS NOT NULL",
    [sign * g.quantity, g.variant_id || g.product_id],
  ]);
}

// =====================================================================
// ADMIN: PEDIDOS
// =====================================================================
async function getAdminOrders(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows: orders } = await turso(env, "SELECT * FROM orders ORDER BY created_at DESC");
  const { rows: items } = await turso(env, "SELECT * FROM order_items");
  const byOrder = {};
  items.forEach((i) => (byOrder[i.order_id] ||= []).push(i));
  return json(orders.map((o) => ({ ...o, order_items: byOrder[o.id] || [] })));
}

const ORDER_STATUSES = ["pending", "confirmed", "delivered", "cancelled"];

async function updateOrderStatus(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { status } = await request.json().catch(() => ({}));
  if (!ORDER_STATUSES.includes(status)) return err("data");

  const { rows } = await turso(env, "SELECT status FROM orders WHERE id = ?", [id]);
  const o = rows[0];
  if (!o) return err("not_found", 404);

  const wasCommitted = o.status === "confirmed" || o.status === "delivered";
  const willBeCommitted = status === "confirmed" || status === "delivered";

  const stmts = [];
  if (wasCommitted !== willBeCommitted) {
    const { rows: items } = await turso(env, "SELECT product_id, variant_id, name, variant_name, quantity FROM order_items WHERE order_id = ?", [id]);
    try {
      stmts.push(...(await stockStatements(env, items, willBeCommitted ? -1 : 1)));
    } catch (e) {
      if (e instanceof StockError) return err(`stock:${e.itemName}`);
      throw e;
    }
  }
  stmts.push(["UPDATE orders SET status = ?, status_at = datetime('now') WHERE id = ?", [status, id]]);
  await tursoBatch(env, stmts, { write: true }); // existencias + estado: o se aplican las dos o ninguna
  return json({ ok: true });
}

async function deleteOrder(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows } = await turso(env, "SELECT status FROM orders WHERE id = ?", [id]);
  const o = rows[0];
  if (!o) return err("not_found", 404);
  const stmts = [];
  if (o.status === "confirmed" || o.status === "delivered") {
    const { rows: items } = await turso(env, "SELECT product_id, variant_id, name, variant_name, quantity FROM order_items WHERE order_id = ?", [id]);
    stmts.push(...(await stockStatements(env, items, 1)));
  }
  stmts.push(["DELETE FROM orders WHERE id = ?", [id]]); // order_items se borra en cascada
  await tursoBatch(env, stmts, { write: true });
  return json({ ok: true });
}

// =====================================================================
// ADMIN: SUBSECCIONES
// =====================================================================
async function getAdminSubs(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows } = await turso(env, "SELECT * FROM subcategories ORDER BY category, sort_order, id");
  return json(rows);
}

async function createSub(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { category, name } = await request.json().catch(() => ({}));
  if (!(await catExists(env, category))) return err("data");
  const n = String(name || "").trim();
  if (!n || n.length > 60) return err("data");
  const { rows } = await turso(env, "SELECT COALESCE(MAX(sort_order), 0) AS m FROM subcategories WHERE category = ?", [category]);
  const { lastInsertRowid: id } = await turso(env,
    "INSERT INTO subcategories (category, name, sort_order, active) VALUES (?, ?, ?, 1)", [category, n, (rows[0]?.m || 0) + 1]);
  return json({ id });
}

async function updateSub(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const b = await request.json().catch(() => ({}));
  const sets = [], args = [];
  if (typeof b.name === "string") { sets.push("name = ?"); args.push(b.name.trim()); }
  if (typeof b.active === "boolean") { sets.push("active = ?"); args.push(b.active ? 1 : 0); }
  if (typeof b.sort_order === "number") { sets.push("sort_order = ?"); args.push(b.sort_order); }
  if (!sets.length) return err("data");
  args.push(id);
  await turso(env, `UPDATE subcategories SET ${sets.join(", ")} WHERE id = ?`, args);
  return json({ ok: true });
}

async function deleteSub(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  await turso(env, "UPDATE products SET subcategory_id = NULL WHERE subcategory_id = ?", [id]);
  await turso(env, "DELETE FROM subcategories WHERE id = ?", [id]);
  return json({ ok: true });
}

// =====================================================================
// CATEGORÍAS (colecciones del menú principal)
// El slug (maquillaje, joyas, ropa…) se genera solo a partir del nombre y
// no cambia después: es lo que guardan products.category y subcategories.category.
// =====================================================================
async function getCategories(request, env, ctx) {
  const data = await cachedData(request, ctx, "categories", async () =>
    (await turso(env,
      "SELECT slug, name, description, accent, variant_label FROM categories WHERE active = 1 ORDER BY sort_order, rowid")).rows);
  return publicJson(data);
}

async function getAdminCategories(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows } = await turso(env, "SELECT * FROM categories ORDER BY sort_order, rowid");
  return json(rows.map((c) => ({ ...c, active: !!c.active })));
}

function cleanCategory(b) {
  const name = String(b.name || "").trim();
  const description = String(b.description || "").trim();
  const variant_label = String(b.variant_label || "").trim() || "Opción";
  if (name.length < 2 || name.length > 40 || description.length > 400 || variant_label.length > 30) return null;
  return { name, description, variant_label, accent: ACCENTS.includes(b.accent) ? b.accent : "rose" };
}

async function createCategory(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const b = await request.json().catch(() => null);
  const c = b && cleanCategory(b);
  if (!c) return err("data");
  const base = slugify(c.name);
  if (!base) return err("data");
  let slug = base;
  for (let i = 2; await catExists(env, slug); i++) slug = `${base.slice(0, 26)}-${i}`;
  const { rows } = await turso(env, "SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories");
  await turso(env,
    "INSERT INTO categories (slug, name, description, accent, variant_label, sort_order, active) VALUES (?, ?, ?, ?, ?, ?, 1)",
    [slug, c.name, c.description, c.accent, c.variant_label, (rows[0]?.m || 0) + 1]);
  return json({ slug });
}

async function updateCategory(request, env, slug) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  if (!(await catExists(env, slug))) return err("not_found", 404);
  const b = await request.json().catch(() => ({}));
  const sets = [], args = [];
  if (typeof b.name === "string") {
    const v = b.name.trim();
    if (v.length < 2 || v.length > 40) return err("data");
    sets.push("name = ?"); args.push(v);
  }
  if (typeof b.description === "string") {
    const v = b.description.trim();
    if (v.length > 400) return err("data");
    sets.push("description = ?"); args.push(v);
  }
  if (typeof b.variant_label === "string") {
    const v = b.variant_label.trim() || "Opción";
    if (v.length > 30) return err("data");
    sets.push("variant_label = ?"); args.push(v);
  }
  if (ACCENTS.includes(b.accent)) { sets.push("accent = ?"); args.push(b.accent); }
  if (typeof b.active === "boolean") { sets.push("active = ?"); args.push(b.active ? 1 : 0); }
  if (typeof b.sort_order === "number") { sets.push("sort_order = ?"); args.push(b.sort_order); }
  if (!sets.length) return err("data");
  args.push(slug);
  await turso(env, `UPDATE categories SET ${sets.join(", ")} WHERE slug = ?`, args);
  return json({ ok: true });
}

async function deleteCategory(request, env, slug) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows } = await turso(env, "SELECT COUNT(*) AS n FROM products WHERE category = ?", [slug]);
  if ((rows[0]?.n || 0) > 0) return err("has_products"); // no se borra una categoría con productos
  await turso(env, "DELETE FROM subcategories WHERE category = ?", [slug]);
  await turso(env, "DELETE FROM categories WHERE slug = ?", [slug]);
  return json({ ok: true });
}

// =====================================================================
// ADMIN: PRODUCTOS
// =====================================================================
async function getAdminProducts(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows: products } = await turso(env,
    "SELECT id, category, subcategory_id, name, description, price, image_url, stock, active, variant_label FROM products ORDER BY created_at DESC");
  const { rows: variants } = await turso(env,
    "SELECT id, product_id, name, price, stock, active FROM product_variants ORDER BY id");
  const byProduct = {};
  variants.forEach((v) => (byProduct[v.product_id] ||= []).push({
    id: v.id, name: v.name, price: v.price, stock: v.stock, active: !!v.active, sold_out: v.stock === 0,
  }));
  return json(products.map((p) => ({ ...p, active: !!p.active, product_variants: byProduct[p.id] || [] })));
}

const MAX_VARIANTS = 300;

async function validProductBody(env, b) {
  if (!(await catExists(env, b.category))) return "data";
  const name = String(b.name || "").trim();
  if (name.length < 2) return "data";
  const price = Number(b.price);
  if (!Number.isInteger(price) || price < 0) return "data";
  if (String(b.variant_label || "").trim().length > 30) return "data";
  if (b.variants != null) {
    if (!Array.isArray(b.variants) || b.variants.length > MAX_VARIANTS) return "data";
    for (const v of b.variants) {
      const n = typeof v?.name === "string" ? v.name.trim() : "";
      if (!n || n.length > 80) return "data";
      if (v.price != null && (!Number.isInteger(Number(v.price)) || Number(v.price) < 0)) return "data";
      if (v.stock != null && (!Number.isInteger(Number(v.stock)) || Number(v.stock) < 0)) return "data";
    }
  }
  return null;
}

const numOrNull = (x) => (x == null ? null : Number(x));
const variantArgs = (v) => [v.name.trim(), numOrNull(v.price), numOrNull(v.stock), v.active === false ? 0 : 1];

async function createProduct(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const b = await request.json().catch(() => null);
  if (!b) return err("data");
  const bad = await validProductBody(env, b);
  if (bad) return err(bad);

  const { lastInsertRowid } = await turso(env,
    `INSERT INTO products (category, subcategory_id, name, description, price, image_url, active, stock, variant_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [b.category, b.subcategory_id || null, b.name.trim(), b.description || "", Number(b.price), b.image_url || null,
      b.active === false ? 0 : 1, numOrNull(b.stock), String(b.variant_label || "").trim() || null]);
  const id = Number(lastInsertRowid);

  const variants = Array.isArray(b.variants) ? b.variants : [];
  if (variants.length) {
    try {
      // Todas las variantes en una sola llamada y una sola transacción
      await tursoBatch(env, variants.map((v) => [
        "INSERT INTO product_variants (product_id, name, price, stock, active) VALUES (?, ?, ?, ?, ?)", [id, ...variantArgs(v)],
      ]), { write: true });
    } catch (e) {
      await turso(env, "DELETE FROM products WHERE id = ?", [id]).catch(() => {}); // no dejar el producto a medias
      throw e;
    }
  }
  return json({ id });
}

async function updateProduct(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const b = await request.json().catch(() => null);
  if (!b) return err("data");
  const bad = await validProductBody(env, b);
  if (bad) return err(bad);

  const [{ rows: cur }, { rows: existing }] = await tursoBatch(env, [
    ["SELECT image_url FROM products WHERE id = ?", [id]],
    ["SELECT id FROM product_variants WHERE product_id = ?", [id]],
  ]);
  if (!cur.length) return err("not_found", 404);
  const oldImage = cur[0].image_url;

  const incoming = Array.isArray(b.variants) ? b.variants : [];
  const existingIds = new Set(existing.map((r) => r.id));
  const keep = new Set(incoming.filter((v) => v.id && existingIds.has(Number(v.id))).map((v) => Number(v.id)));
  const remove = [...existingIds].filter((x) => !keep.has(x));

  // Producto + todas sus variantes se guardan juntos: o queda todo o no cambia nada.
  const stmts = [[
    `UPDATE products SET category = ?, subcategory_id = ?, name = ?, description = ?, price = ?, image_url = ?, active = ?, stock = ?, variant_label = ? WHERE id = ?`,
    [b.category, b.subcategory_id || null, b.name.trim(), b.description || "", Number(b.price), b.image_url || null,
      b.active === false ? 0 : 1, numOrNull(b.stock), String(b.variant_label || "").trim() || null, id],
  ]];
  if (remove.length) stmts.push([`DELETE FROM product_variants WHERE product_id = ? AND id IN (${placeholders(remove)})`, [id, ...remove]]);
  for (const v of incoming) {
    if (v.id && keep.has(Number(v.id))) {
      stmts.push(["UPDATE product_variants SET name = ?, price = ?, stock = ?, active = ? WHERE id = ? AND product_id = ?", [...variantArgs(v), Number(v.id), id]]);
    } else {
      stmts.push(["INSERT INTO product_variants (product_id, name, price, stock, active) VALUES (?, ?, ?, ?, ?)", [id, ...variantArgs(v)]]);
    }
  }
  await tursoBatch(env, stmts, { write: true });

  if (oldImage && oldImage !== (b.image_url || null)) await deleteImageByUrl(env, oldImage);
  return json({ ok: true });
}

async function deleteProduct(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows } = await turso(env, "SELECT image_url FROM products WHERE id = ?", [id]);
  if (rows[0]?.image_url) await deleteImageByUrl(env, rows[0].image_url);
  await turso(env, "DELETE FROM products WHERE id = ?", [id]); // variantes en cascada; pedidos conservan nombre/precio (SET NULL)
  return json({ ok: true });
}

// =====================================================================
// ADMIN: VENTA EN TIENDA
// (se registra como un pedido ya "delivered" y descuenta existencias de una vez)
// =====================================================================
const STORE_NAME = "Venta en tienda", STORE_PHONE = "0000000";

async function createSale(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const b = await request.json().catch(() => null);
  if (!b) return err("data");
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length || items.length > MAX_LINES) return err("items");

  const prices = items.map((it) => Number(it?.price));
  const { lines, error } = await resolveLines(env, items, { requireActive: false });
  if (error) return err(error);
  if (prices.some((x) => !Number.isInteger(x) || x < 0)) return err("data");
  lines.forEach((l, i) => { l.price = prices[i]; }); // en tienda se cobra el precio que escribió el admin

  let stock;
  try {
    stock = await stockStatements(env, lines.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, name: l.name, variant_name: l.variant_name, quantity: l.qty })), -1);
  } catch (e) {
    if (e instanceof StockError) return err(`stock:${e.itemName}`);
    throw e;
  }

  const total = lines.reduce((t, l) => t + l.price * l.qty, 0);
  const code = await uniqueCode(env);
  const payment = String(b.payment || "");

  // Descontar existencias + crear la venta y sus líneas: todo en una llamada y una transacción
  await tursoBatch(env, [
    ...stock,
    ...orderStatements({
      code, name: STORE_NAME, phone: STORE_PHONE, type: "tienda",
      payment: ["efectivo", "nequi"].includes(payment) ? payment : null, notes: b.notes || null, total, status: "delivered",
    }, lines),
  ], { write: true });
  return json({ code, total });
}

// =====================================================================
// ADMIN: GASTOS
// =====================================================================
async function getExpenses(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows } = await turso(env, "SELECT * FROM expenses ORDER BY spent_at DESC, id DESC");
  return json(rows);
}

async function createExpense(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const b = await request.json().catch(() => ({}));
  const spent_at = String(b.spent_at || "").trim(), description = String(b.description || "").trim();
  const amount = Number(b.amount);
  if (!spent_at || description.length < 2 || !Number.isInteger(amount) || amount <= 0) return err("data");
  const { lastInsertRowid: id } = await turso(env,
    "INSERT INTO expenses (spent_at, description, amount, category) VALUES (?, ?, ?, ?)",
    [spent_at, description, amount, b.category || null]);
  return json({ id });
}

async function deleteExpense(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  await turso(env, "DELETE FROM expenses WHERE id = ?", [id]);
  return json({ ok: true });
}

// =====================================================================
// ADMIN: PERSONALIZACIÓN
// =====================================================================
async function updateSettings(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { set, delete: del } = await request.json().catch(() => ({}));
  const stmts = [];
  for (const [key, value] of Object.entries(set || {})) {
    stmts.push(["INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]]);
  }
  for (const key of Array.isArray(del) ? del : []) {
    stmts.push(["DELETE FROM site_settings WHERE key = ?", [key]]);
  }
  if (stmts.length) await tursoBatch(env, stmts, { write: true });
  return json({ ok: true });
}

// =====================================================================
// ADMIN: FOTOS (R2)
// =====================================================================
const UPLOAD_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_UPLOAD = 50 * 1024 * 1024;

async function uploadPhoto(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  if (!env.PRODUCT_IMAGES || !env.R2_PUBLIC_BASE) return err("not_configured", 500);
  const ct = (request.headers.get("Content-Type") || "").split(";")[0].trim();
  const ext = UPLOAD_EXT[ct];
  if (!ext) return err("type");
  const buf = await request.arrayBuffer();
  if (!buf.byteLength || buf.byteLength > MAX_UPLOAD) return err("size");
  const key = `products/${crypto.randomUUID()}.${ext}`;
  await env.PRODUCT_IMAGES.put(key, buf, { httpMetadata: { contentType: ct } });
  const base = String(env.R2_PUBLIC_BASE).replace(/\/+$/, "");
  return json({ url: `${base}/${key}` });
}