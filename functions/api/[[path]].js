import { turso, verifyPassword, makeSessionCookie, clearSessionCookie, readSession, deleteImageByUrl } from "./_lib/db.js";

const json = (data, init = {}) => new Response(JSON.stringify(data), { ...init, headers: { "Content-Type": "application/json", ...(init.headers || {}) } });
const err = (message, status = 400) => json({ error: message }, { status });
const CATS = ["maquillaje", "joyas", "ropa"];

// Un solo archivo decide la ruta leyendo params.path (todo lo que viene después de /api/).
export async function onRequest({ request, env, params }) {
  const parts = params.path || [];
  const path = parts.join("/");
  const method = request.method;

  try {
    // ---------- públicas ----------
    if (path === "public/products" && method === "GET") return getProducts(env);
    if (path === "public/subs" && method === "GET") return getSubs(request, env);
    if (path === "public/settings" && method === "GET") return getSettings(env);
    if (path === "login" && method === "POST") return login(request, env);
    if (path === "session" && method === "GET") return getSession(request, env);
    if (path === "session" && method === "DELETE") return json(null, { headers: { "Set-Cookie": clearSessionCookie() } });
    if (path === "orders" && method === "POST") return createOrder(request, env);

    // ---------- admin: todo lo de aquí abajo exige sesión ----------
    if (parts[0] === "admin") {
      const adminId = await readSession(env, request.headers.get("Cookie"));
      if (!adminId) return err("No autenticado.", 401);
      const sub = parts.slice(1); // p.ej. ["products", "5"]

      if (sub[0] === "products" && sub.length === 1 && method === "GET") return adminProducts(env);
      if (sub[0] === "products" && sub.length === 1 && method === "POST") return createProduct(request, env);
      if (sub[0] === "products" && sub.length === 2 && method === "PATCH") return updateProduct(request, env, sub[1]);
      if (sub[0] === "products" && sub.length === 2 && method === "DELETE") return deleteProduct(env, sub[1]);

      if (sub[0] === "subcategories" && sub.length === 1 && method === "GET") return adminSubs(env);
      if (sub[0] === "subcategories" && sub.length === 1 && method === "POST") return createSub(request, env);
      if (sub[0] === "subcategories" && sub.length === 2 && method === "PATCH") return updateSub(request, env, sub[1]);
      if (sub[0] === "subcategories" && sub.length === 2 && method === "DELETE") return deleteSub(env, sub[1]);

      if (sub[0] === "orders" && sub.length === 1 && method === "GET") return adminOrders(env);
      if (sub[0] === "orders" && sub.length === 2 && method === "PATCH") return updateOrderStatus(request, env, sub[1]);
      if (sub[0] === "orders" && sub.length === 2 && method === "DELETE") return deleteOrderAdmin(env, sub[1]);

      if (sub[0] === "sales" && sub.length === 1 && method === "POST") return createStoreSale(request, env);

      if (sub[0] === "expenses" && sub.length === 1 && method === "GET") return adminExpenses(env);
      if (sub[0] === "expenses" && sub.length === 1 && method === "POST") return createExpense(request, env);
      if (sub[0] === "expenses" && sub.length === 2 && method === "DELETE") return deleteExpense(env, sub[1]);

      if (sub[0] === "settings" && sub.length === 1 && method === "PATCH") return patchSettings(request, env);

      if (sub[0] === "upload" && sub.length === 1 && method === "POST") return uploadImage(request, env);
    }
  } catch (e) {
    return err(e.message === "stock" || /^stock:/.test(e.message || "") ? e.message : "server", 500);
  }
  return err("not_found", 404);
}

// =====================================================================
// PÚBLICAS
// =====================================================================
async function getProducts(env) {
  const { rows: products } = await turso(env,
    "SELECT id, category, subcategory_id, name, description, price, image_url, stock, active FROM products WHERE active = 1 ORDER BY created_at DESC");
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
const PENDING_LIMIT = 3;

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
  let code = genCode();
  for (let i = 0; i < 5; i++) {
    const { rows } = await turso(env, "SELECT 1 FROM orders WHERE code = ?", [code]);
    if (!rows.length) break;
    code = genCode();
  }

  const { lastInsertRowid: orderId } = await turso(env,
    `INSERT INTO orders (code, customer_name, customer_phone, delivery_type, address, neighborhood, payment_method, preferred_time, notes, total, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
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
// ADMIN · PRODUCTOS
// =====================================================================
async function adminProducts(env) {
  const { rows: products } = await turso(env, "SELECT * FROM products ORDER BY created_at DESC");
  const { rows: variants } = await turso(env, "SELECT * FROM product_variants ORDER BY id");
  const byProduct = {};
  variants.forEach((v) => (byProduct[v.product_id] ||= []).push(v));
  return json(products.map((p) => ({ ...p, product_variants: byProduct[p.id] || [] })));
}

function readProductBody(d) {
  const name = String(d.name || "").trim();
  const category = String(d.category || "");
  const price = Number(d.price);
  if (name.length < 2) throw new Error("El nombre debe tener al menos 2 caracteres.");
  if (!CATS.includes(category)) throw new Error("Categoría inválida.");
  if (!Number.isInteger(price) || price < 0) throw new Error("El precio debe ser un número entero.");
  const stockRaw = d.stock === "" || d.stock == null ? null : Number(d.stock);
  if (stockRaw !== null && (!Number.isInteger(stockRaw) || stockRaw < 0)) throw new Error("El stock debe ser un número entero (o vacío).");
  return {
    name, category,
    subcategory_id: d.subcategory_id ? Number(d.subcategory_id) : null,
    description: d.description ? String(d.description).trim() : null,
    price,
    image_url: d.image_url || null,
    stock: stockRaw,
    active: d.active === false ? 0 : 1,
  };
}

function readVariants(list) {
  const out = [], seen = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    const name = String(v.name || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`"${name}" está repetido en la lista.`);
    seen.add(key);
    const price = v.price === "" || v.price == null ? null : Number(v.price);
    if (price !== null && (!Number.isInteger(price) || price < 0)) throw new Error(`El precio de "${name}" debe ser un número entero.`);
    const stock = v.stock === "" || v.stock == null ? null : Number(v.stock);
    if (stock !== null && (!Number.isInteger(stock) || stock < 0)) throw new Error(`Las existencias de "${name}" deben ser un número entero.`);
    out.push({ id: v.id || null, name, price, stock, active: v.active !== false });
  }
  return out;
}

async function syncVariants(env, productId, variants, existingIds) {
  const keep = new Set(variants.filter((v) => v.id).map((v) => v.id));
  for (const id of existingIds) if (!keep.has(id)) await turso(env, "DELETE FROM product_variants WHERE id = ?", [id]);
  for (const v of variants) {
    if (v.id) await turso(env, "UPDATE product_variants SET name=?, price=?, stock=?, active=? WHERE id=?", [v.name, v.price, v.stock, v.active ? 1 : 0, v.id]);
    else await turso(env, "INSERT INTO product_variants (product_id, name, price, stock, active) VALUES (?, ?, ?, ?, ?)", [productId, v.name, v.price, v.stock, v.active ? 1 : 0]);
  }
}

async function createProduct(request, env) {
  const d = await request.json().catch(() => null);
  if (!d) return err("data");
  let p, variants;
  try { p = readProductBody(d); variants = readVariants(d.variants); } catch (e) { return err(e.message); }
  const { lastInsertRowid } = await turso(env,
    "INSERT INTO products (category, subcategory_id, name, description, price, image_url, stock, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [p.category, p.subcategory_id, p.name, p.description, p.price, p.image_url, variants.length ? null : p.stock, p.active]);
  await syncVariants(env, lastInsertRowid, variants, []);
  return json({ id: lastInsertRowid });
}

async function updateProduct(request, env, id) {
  const d = await request.json().catch(() => null);
  if (!d) return err("data");
  let p, variants;
  try { p = readProductBody(d); variants = readVariants(d.variants); } catch (e) { return err(e.message); }

  const { rows: before } = await turso(env, "SELECT image_url FROM products WHERE id = ?", [id]);
  if (!before[0]) return err("No encontrado.", 404);

  await turso(env, "UPDATE products SET category=?, subcategory_id=?, name=?, description=?, price=?, image_url=?, stock=?, active=? WHERE id=?",
    [p.category, p.subcategory_id, p.name, p.description, p.price, p.image_url, variants.length ? null : p.stock, p.active, id]);

  const { rows: existing } = await turso(env, "SELECT id FROM product_variants WHERE product_id = ?", [id]);
  await syncVariants(env, id, variants, existing.map((r) => r.id));

  if (before[0].image_url && before[0].image_url !== p.image_url) await deleteImageByUrl(env, before[0].image_url);
  return json({ ok: true });
}

async function deleteProduct(env, id) {
  const { rows } = await turso(env, "SELECT image_url FROM products WHERE id = ?", [id]);
  if (!rows[0]) return err("No encontrado.", 404);
  await turso(env, "DELETE FROM product_variants WHERE product_id = ?", [id]);
  await turso(env, "DELETE FROM products WHERE id = ?", [id]);
  await deleteImageByUrl(env, rows[0].image_url);
  return json({ ok: true });
}

// =====================================================================
// ADMIN · SUBSECCIONES
// =====================================================================
async function adminSubs(env) {
  const { rows } = await turso(env, "SELECT * FROM subcategories ORDER BY category, sort_order, id");
  return json(rows);
}

async function createSub(request, env) {
  const d = await request.json().catch(() => null);
  const category = String(d?.category || ""), name = String(d?.name || "").trim();
  if (!CATS.includes(category)) return err("Categoría inválida.");
  if (!name) return err("Escribe el nombre de la subsección.");
  const { rows: dup } = await turso(env, "SELECT 1 FROM subcategories WHERE category=? AND lower(name)=lower(?)", [category, name]);
  if (dup.length) return err(`Ya existe "${name}" en esa colección.`);
  const { rows: mx } = await turso(env, "SELECT COALESCE(MAX(sort_order),0) AS m FROM subcategories WHERE category=?", [category]);
  const { lastInsertRowid } = await turso(env, "INSERT INTO subcategories (category, name, sort_order) VALUES (?, ?, ?)", [category, name, (mx[0]?.m || 0) + 1]);
  return json({ id: lastInsertRowid });
}

async function updateSub(request, env, id) {
  const d = await request.json().catch(() => null) || {};
  const sets = [], args = [];
  if (d.name !== undefined) { const n = String(d.name).trim(); if (!n) return err("El nombre no puede quedar vacío."); sets.push("name=?"); args.push(n); }
  if (d.active !== undefined) { sets.push("active=?"); args.push(d.active ? 1 : 0); }
  if (d.sort_order !== undefined) { sets.push("sort_order=?"); args.push(Number(d.sort_order)); }
  if (!sets.length) return err("Nada que actualizar.");
  args.push(id);
  await turso(env, `UPDATE subcategories SET ${sets.join(", ")} WHERE id=?`, args);
  return json({ ok: true });
}

async function deleteSub(env, id) {
  await turso(env, "UPDATE products SET subcategory_id = NULL WHERE subcategory_id = ?", [id]);
  await turso(env, "DELETE FROM subcategories WHERE id = ?", [id]);
  return json({ ok: true });
}

// =====================================================================
// ADMIN · PEDIDOS (confirmar / entregar / cancelar / eliminar, maneja stock)
// =====================================================================
const NEXT_STATUS = { pending: ["confirmed", "cancelled"], confirmed: ["delivered", "cancelled"], delivered: ["cancelled"], cancelled: [] };

// Descuenta stock (al confirmar) o lo devuelve (al cancelar desde confirmado/entregado)
async function adjustStockForOrder(env, orderId, sign) {
  const { rows: items } = await turso(env, "SELECT product_id, variant_id, name, quantity FROM order_items WHERE order_id = ?", [orderId]);
  if (sign < 0) {
    // vamos a descontar: primero validar que alcance
    for (const it of items) {
      const table = it.variant_id ? "product_variants" : "products";
      const { rows } = await turso(env, `SELECT stock FROM ${table} WHERE id = ?`, [it.variant_id || it.product_id]);
      const stock = rows[0]?.stock;
      if (stock != null && stock + 0 < it.quantity) throw new Error(`stock:${it.name}`);
    }
  }
  for (const it of items) {
    const table = it.variant_id ? "product_variants" : "products";
    await turso(env, `UPDATE ${table} SET stock = CASE WHEN stock IS NULL THEN NULL ELSE MAX(0, stock + ?) END WHERE id = ?`,
      [sign * it.quantity, it.variant_id || it.product_id]);
  }
}

async function updateOrderStatus(request, env, id) {
  const d = await request.json().catch(() => null);
  const status = String(d?.status || "");
  const { rows } = await turso(env, "SELECT status FROM orders WHERE id = ?", [id]);
  const order = rows[0];
  if (!order) return err("No encontrado.", 404);
  if (!NEXT_STATUS[order.status]?.includes(status)) return err("Transición de estado inválida.");

  if (status === "confirmed") await adjustStockForOrder(env, id, -1);
  if (status === "cancelled" && (order.status === "confirmed" || order.status === "delivered")) await adjustStockForOrder(env, id, +1);

  await turso(env, "UPDATE orders SET status = ?, status_at = datetime('now') WHERE id = ?", [status, id]);
  return json({ ok: true });
}

async function deleteOrderAdmin(env, id) {
  const { rows } = await turso(env, "SELECT status FROM orders WHERE id = ?", [id]);
  const order = rows[0];
  if (!order) return err("No encontrado.", 404);
  if (order.status === "confirmed" || order.status === "delivered") await adjustStockForOrder(env, id, +1);
  await turso(env, "DELETE FROM order_items WHERE order_id = ?", [id]);
  await turso(env, "DELETE FROM orders WHERE id = ?", [id]);
  return json({ ok: true });
}

async function adminOrders(env) {
  const { rows: orders } = await turso(env, "SELECT * FROM orders ORDER BY created_at DESC LIMIT 500");
  const { rows: items } = await turso(env, "SELECT * FROM order_items WHERE order_id IN (" + (orders.map(() => "?").join(",") || "0") + ")", orders.map((o) => o.id));
  const byOrder = {};
  items.forEach((i) => (byOrder[i.order_id] ||= []).push(i));
  return json(orders.map((o) => ({ ...o, order_items: byOrder[o.id] || [] })));
}

// =====================================================================
// ADMIN · VENTA EN TIENDA (mostrador: ya pagada, descuenta stock de inmediato)
// =====================================================================
const STORE_NAME = "Venta en tienda", STORE_PHONE = "0000000";

async function createStoreSale(request, env) {
  const d = await request.json().catch(() => null);
  if (!d) return err("data");
  const items = Array.isArray(d.items) ? d.items : [];
  if (!items.length) return err("items");
  const payment = String(d.payment || "");
  if (!["efectivo", "nequi"].includes(payment)) return err("payment");

  const lines = [];
  for (const it of items) {
    const { rows } = await turso(env, "SELECT id, name, category, price FROM products WHERE id = ?", [it.id]);
    const p = rows[0];
    if (!p) return err("invalid");
    let variantName = null;
    if (it.variant_id) {
      const { rows: vr } = await turso(env, "SELECT id, name FROM product_variants WHERE id = ? AND product_id = ?", [it.variant_id, it.id]);
      if (!vr[0]) return err("variant");
      variantName = vr[0].name;
    }
    const qty = Math.max(1, Math.min(20, Number(it.qty) || 1));
    const price = Number(it.price);
    if (!Number.isInteger(price) || price < 0) return err("items");
    lines.push({ product_id: p.id, variant_id: it.variant_id || null, name: p.name, category: p.category, variant_name: variantName, price, qty });
  }

  const total = lines.reduce((t, l) => t + l.price * l.qty, 0);
  let code = genCode();
  for (let i = 0; i < 5; i++) {
    const { rows } = await turso(env, "SELECT 1 FROM orders WHERE code = ?", [code]);
    if (!rows.length) break;
    code = genCode();
  }

  const { lastInsertRowid: orderId } = await turso(env,
    `INSERT INTO orders (code, customer_name, customer_phone, delivery_type, payment_method, notes, total, status, status_at)
     VALUES (?, ?, ?, 'tienda', ?, ?, ?, 'delivered', datetime('now'))`,
    [code, STORE_NAME, STORE_PHONE, payment, d.notes || null, total]);

  for (const l of lines) {
    await turso(env,
      "INSERT INTO order_items (order_id, product_id, variant_id, name, variant_name, price, quantity, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [orderId, l.product_id, l.variant_id, l.name, l.variant_name, l.price, l.qty, l.category]);
  }
  await adjustStockForOrder(env, orderId, -1);

  return json({ code, total });
}

// =====================================================================
// ADMIN · GASTOS
// =====================================================================
async function adminExpenses(env) {
  const { rows } = await turso(env, "SELECT * FROM expenses ORDER BY spent_at DESC, id DESC LIMIT 1000");
  return json(rows);
}

async function createExpense(request, env) {
  const d = await request.json().catch(() => null);
  const spent_at = String(d?.spent_at || ""), description = String(d?.description || "").trim();
  const amount = Number(d?.amount);
  if (!spent_at) return err("Elige la fecha del gasto.");
  if (description.length < 2) return err("Escribe en qué se gastó.");
  if (!Number.isInteger(amount) || amount <= 0) return err("El monto debe ser un número entero mayor que 0.");
  const { lastInsertRowid } = await turso(env, "INSERT INTO expenses (spent_at, description, amount, category) VALUES (?, ?, ?, ?)",
    [spent_at, description, amount, d.category || null]);
  return json({ id: lastInsertRowid });
}

async function deleteExpense(env, id) {
  await turso(env, "DELETE FROM expenses WHERE id = ?", [id]);
  return json({ ok: true });
}

// =====================================================================
// ADMIN · PERSONALIZACIÓN
// =====================================================================
async function patchSettings(request, env) {
  const d = await request.json().catch(() => null) || {};
  const upserts = Object.entries(d.set || {});
  const deletes = Array.isArray(d.delete) ? d.delete : [];
  for (const [key, value] of upserts) {
    await turso(env, "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
  }
  for (const key of deletes) await turso(env, "DELETE FROM site_settings WHERE key = ?", [key]);
  return json({ ok: true });
}

// =====================================================================
// ADMIN · SUBIR FOTO A R2
// =====================================================================
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_IMAGE = 8 * 1024 * 1024; // ya viene comprimida desde el navegador

async function uploadImage(request, env) {
  if (!env.PRODUCT_IMAGES) return err("El bucket de fotos no está configurado.", 500);
  if (!env.R2_PUBLIC_BASE) return err("Falta configurar la URL pública de las fotos.", 500);
  const type = request.headers.get("Content-Type") || "";
  const ext = EXT[type];
  if (!ext) return err("La foto debe ser JPG, PNG o WebP.");
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return err("La foto llegó vacía.");
  if (buf.byteLength > MAX_IMAGE) return err("La foto pesa demasiado.");
  const key = `${crypto.randomUUID()}.${ext}`;
  await env.PRODUCT_IMAGES.put(key, buf, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  const base = String(env.R2_PUBLIC_BASE).replace(/\/+$/, "");
  return json({ url: `${base}/${key}` });
}
