import { turso, verifyPassword, makeSessionCookie, clearSessionCookie, readSession, deleteImageByUrl } from "../_lib/db.js";

const json = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
const err = (message, status = 400) => json({ error: message }, { status });
const ACCENTS = ["rose", "champagne", "plum"];
const catExists = async (env, slug) =>
  !!slug && (await turso(env, "SELECT 1 FROM categories WHERE slug = ?", [String(slug)])).rows.length > 0;
const slugify = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");

// Un solo archivo decide la ruta leyendo params.path (todo lo que viene después de /api/).
export async function onRequest({ request, env, params }) {
  const path = (params.path || []).join("/");
  const method = request.method;
  try {
    // ---------- Público ----------
    if (path === "public/products" && method === "GET") return getProducts(env);
    if (path === "public/subs" && method === "GET") return getSubs(request, env);
    if (path === "public/categories" && method === "GET") return getCategories(env);
    if (path === "public/settings" && method === "GET") return getSettings(env);
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
async function getProducts(env) {
  const { rows: products } = await turso(env,
    "SELECT id, category, subcategory_id, name, description, price, image_url, stock FROM products WHERE active = 1 ORDER BY created_at DESC");
  const { rows: variants } = await turso(env,
    "SELECT id, product_id, name, price, stock FROM product_variants WHERE active = 1 ORDER BY id");
  const byProduct = {};
  variants.forEach((v) => (byProduct[v.product_id] ||= []).push({
    id: v.id, name: v.name, price: v.price, active: true, sold_out: v.stock != null && v.stock <= 0,
  }));
  return json(products.map((p) => ({
    id: p.id, category: p.category, subcategory_id: p.subcategory_id, name: p.name, description: p.description,
    price: p.price, image_url: p.image_url, sold_out: p.stock != null && p.stock <= 0,
    product_variants: byProduct[p.id] || [],
  })));
}

async function getSubs(request, env) {
  const cat = new URL(request.url).searchParams.get("c") || "";
  const { rows } = await turso(env,
    "SELECT id, name, sort_order FROM subcategories WHERE category = ? AND active = 1 ORDER BY sort_order, id", [cat]);
  return json(rows);
}

async function getSettings(env) {
  const { rows } = await turso(env, "SELECT key, value FROM site_settings");
  return json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
}

async function login(request, env) {
  const { email, password } = await request.json().catch(() => ({}));
  const { rows } = await turso(env, "SELECT id, name, password_hash FROM admins WHERE email = ?", [String(email || "").trim().toLowerCase()]);
  const admin = rows[0];
  if (!admin || !(await verifyPassword(password || "", admin.password_hash))) return err("Correo o contraseña incorrectos.", 401);
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

async function uniqueCode(env) {
  let code = genCode();
  for (let i = 0; i < 5; i++) {
    const { rows } = await turso(env, "SELECT 1 FROM orders WHERE code = ?", [code]);
    if (!rows.length) break;
    code = genCode();
  }
  return code;
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
  if (!items.length) return err("items");

  const lines = [];
  for (const it of items) {
    const { rows } = await turso(env, "SELECT id, name, category, price, active FROM products WHERE id = ?", [it.id]);
    const p = rows[0];
    if (!p || !p.active) return err("invalid");
    let variantName = null, price = p.price;
    if (it.variant_id) {
      const { rows: vr } = await turso(env, "SELECT id, name, price, active FROM product_variants WHERE id = ? AND product_id = ?", [it.variant_id, it.id]);
      const v = vr[0];
      if (!v || !v.active) return err("variant");
      variantName = v.name;
      price = v.price != null ? v.price : p.price;
    }
    const qty = Math.max(1, Math.min(20, Number(it.qty) || 1));
    lines.push({ product_id: p.id, variant_id: it.variant_id || null, name: p.name, category: p.category, variant_name: variantName, price, qty });
  }

  const { rows: pending } = await turso(env, "SELECT COUNT(*) AS n FROM orders WHERE customer_phone = ? AND status = 'pending'", [phone]);
  if ((pending[0]?.n || 0) >= PENDING_LIMIT) return err("limit");

  const total = lines.reduce((t, l) => t + l.price * l.qty, 0);
  const code = await uniqueCode(env);

  const { lastInsertRowid: orderId } = await turso(env,
    `INSERT INTO orders (code, customer_name, customer_phone, delivery_type, address, neighborhood, payment_method, preferred_time, notes, total, status, status_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
    [code, name, phone, instore ? "tienda" : "domicilio", instore ? null : address, instore ? null : hood,
      instore ? null : payment, b.time || null, b.notes || null, total]);

  for (const l of lines) {
    await turso(env,
      "INSERT INTO order_items (order_id, product_id, variant_id, name, variant_name, price, quantity, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [orderId, l.product_id, l.variant_id, l.name, l.variant_name, l.price, l.qty, l.category]);
  }

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
async function adjustStock(env, items, sign) {
  // Primero se valida que alcance (solo al descontar); si algo falla, no se toca nada.
  if (sign < 0) {
    for (const it of items) {
      const cur = await currentStock(env, it);
      if (cur != null && cur + sign * it.quantity < 0) throw new StockError(it.variant_name || it.name);
    }
  }
  for (const it of items) {
    const cur = await currentStock(env, it);
    if (cur == null) continue; // sin control de existencias para este producto/variante
    const next = Math.max(0, cur + sign * it.quantity);
    if (it.variant_id) await turso(env, "UPDATE product_variants SET stock = ? WHERE id = ?", [next, it.variant_id]);
    else if (it.product_id) await turso(env, "UPDATE products SET stock = ? WHERE id = ?", [next, it.product_id]);
  }
}

async function currentStock(env, it) {
  if (it.variant_id) {
    const { rows } = await turso(env, "SELECT stock FROM product_variants WHERE id = ?", [it.variant_id]);
    return rows[0] ? rows[0].stock : null;
  }
  if (it.product_id) {
    const { rows } = await turso(env, "SELECT stock FROM products WHERE id = ?", [it.product_id]);
    return rows[0] ? rows[0].stock : null;
  }
  return null;
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

  if (wasCommitted !== willBeCommitted) {
    const { rows: items } = await turso(env, "SELECT product_id, variant_id, name, variant_name, quantity FROM order_items WHERE order_id = ?", [id]);
    try {
      await adjustStock(env, items, willBeCommitted ? -1 : 1);
    } catch (e) {
      if (e instanceof StockError) return err(`stock:${e.itemName}`);
      throw e;
    }
  }

  await turso(env, "UPDATE orders SET status = ?, status_at = datetime('now') WHERE id = ?", [status, id]);
  return json({ ok: true });
}

async function deleteOrder(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const { rows } = await turso(env, "SELECT status FROM orders WHERE id = ?", [id]);
  const o = rows[0];
  if (!o) return err("not_found", 404);
  if (o.status === "confirmed" || o.status === "delivered") {
    const { rows: items } = await turso(env, "SELECT product_id, variant_id, name, variant_name, quantity FROM order_items WHERE order_id = ?", [id]);
    await adjustStock(env, items, 1);
  }
  await turso(env, "DELETE FROM orders WHERE id = ?", [id]); // order_items se borra en cascada
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
async function getCategories(env) {
  const { rows } = await turso(env,
    "SELECT slug, name, description, accent, variant_label FROM categories WHERE active = 1 ORDER BY sort_order, rowid");
  return json(rows);
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
    "SELECT id, category, subcategory_id, name, description, price, image_url, stock, active FROM products ORDER BY created_at DESC");
  const { rows: variants } = await turso(env,
    "SELECT id, product_id, name, price, stock, active FROM product_variants ORDER BY id");
  const byProduct = {};
  variants.forEach((v) => (byProduct[v.product_id] ||= []).push({
    id: v.id, name: v.name, price: v.price, stock: v.stock, active: !!v.active, sold_out: v.stock === 0,
  }));
  return json(products.map((p) => ({ ...p, active: !!p.active, product_variants: byProduct[p.id] || [] })));
}

async function validProductBody(env, b) {
  if (!(await catExists(env, b.category))) return "data";
  const name = String(b.name || "").trim();
  if (name.length < 2) return "data";
  const price = Number(b.price);
  if (!Number.isInteger(price) || price < 0) return "data";
  return null;
}

async function createProduct(request, env) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const b = await request.json().catch(() => null);
  if (!b) return err("data");
  const bad = await validProductBody(env, b);
  if (bad) return err(bad);

  const { lastInsertRowid: id } = await turso(env,
    `INSERT INTO products (category, subcategory_id, name, description, price, image_url, active, stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [b.category, b.subcategory_id || null, b.name.trim(), b.description || "", Number(b.price), b.image_url || null,
      b.active === false ? 0 : 1, b.stock == null ? null : Number(b.stock)]);

  for (const v of Array.isArray(b.variants) ? b.variants : []) {
    await turso(env, "INSERT INTO product_variants (product_id, name, price, stock, active) VALUES (?, ?, ?, ?, ?)",
      [id, v.name, v.price == null ? null : Number(v.price), v.stock == null ? null : Number(v.stock), v.active === false ? 0 : 1]);
  }
  return json({ id });
}

async function updateProduct(request, env, id) {
  if (!(await requireAdmin(request, env))) return err("auth", 401);
  const b = await request.json().catch(() => null);
  if (!b) return err("data");
  const bad = await validProductBody(env, b);
  if (bad) return err(bad);

  const { rows: cur } = await turso(env, "SELECT image_url FROM products WHERE id = ?", [id]);
  if (!cur.length) return err("not_found", 404);
  const oldImage = cur[0].image_url;

  await turso(env,
    `UPDATE products SET category = ?, subcategory_id = ?, name = ?, description = ?, price = ?, image_url = ?, active = ?, stock = ? WHERE id = ?`,
    [b.category, b.subcategory_id || null, b.name.trim(), b.description || "", Number(b.price), b.image_url || null,
      b.active === false ? 0 : 1, b.stock == null ? null : Number(b.stock), id]);

  if (oldImage && oldImage !== (b.image_url || null)) await deleteImageByUrl(env, oldImage);

  const incoming = Array.isArray(b.variants) ? b.variants : [];
  const { rows: existing } = await turso(env, "SELECT id FROM product_variants WHERE product_id = ?", [id]);
  const keep = new Set();
  for (const v of incoming) {
    if (v.id && existing.some((r) => r.id === v.id)) {
      keep.add(v.id);
      await turso(env, "UPDATE product_variants SET name = ?, price = ?, stock = ?, active = ? WHERE id = ?",
        [v.name, v.price == null ? null : Number(v.price), v.stock == null ? null : Number(v.stock), v.active === false ? 0 : 1, v.id]);
    } else {
      const { lastInsertRowid: newId } = await turso(env,
        "INSERT INTO product_variants (product_id, name, price, stock, active) VALUES (?, ?, ?, ?, ?)",
        [id, v.name, v.price == null ? null : Number(v.price), v.stock == null ? null : Number(v.stock), v.active === false ? 0 : 1]);
      keep.add(newId);
    }
  }
  for (const r of existing) if (!keep.has(r.id)) await turso(env, "DELETE FROM product_variants WHERE id = ?", [r.id]);

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
  if (!items.length) return err("items");

  const lines = [];
  for (const it of items) {
    const { rows } = await turso(env, "SELECT id, name, category FROM products WHERE id = ?", [it.id]);
    const p = rows[0];
    if (!p) return err("invalid");
    let variantName = null;
    if (it.variant_id) {
      const { rows: vr } = await turso(env, "SELECT id, name FROM product_variants WHERE id = ? AND product_id = ?", [it.variant_id, it.id]);
      const v = vr[0];
      if (!v) return err("variant");
      variantName = v.name;
    }
    const qty = Math.max(1, Math.min(20, Number(it.qty) || 1));
    const price = Number(it.price);
    if (!Number.isInteger(price) || price < 0) return err("data");
    lines.push({ product_id: p.id, variant_id: it.variant_id || null, name: p.name, category: p.category, variant_name: variantName, price, qty });
  }

  try {
    await adjustStock(env, lines.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, name: l.name, variant_name: l.variant_name, quantity: l.qty })), -1);
  } catch (e) {
    if (e instanceof StockError) return err(`stock:${e.itemName}`);
    throw e;
  }

  const total = lines.reduce((t, l) => t + l.price * l.qty, 0);
  const code = await uniqueCode(env);
  const payment = String(b.payment || "");

  const { lastInsertRowid: orderId } = await turso(env,
    `INSERT INTO orders (code, customer_name, customer_phone, delivery_type, payment_method, notes, total, status, status_at)
     VALUES (?, ?, ?, 'tienda', ?, ?, ?, 'delivered', datetime('now'))`,
    [code, STORE_NAME, STORE_PHONE, ["efectivo", "nequi"].includes(payment) ? payment : null, b.notes || null, total]);

  for (const l of lines) {
    await turso(env, "INSERT INTO order_items (order_id, product_id, variant_id, name, variant_name, price, quantity, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [orderId, l.product_id, l.variant_id, l.name, l.variant_name, l.price, l.qty, l.category]);
  }
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
  for (const [key, value] of Object.entries(set || {})) {
    await turso(env, "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
  }
  for (const key of Array.isArray(del) ? del : []) {
    await turso(env, "DELETE FROM site_settings WHERE key = ?", [key]);
  }
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
