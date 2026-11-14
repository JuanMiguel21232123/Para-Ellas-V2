const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);

async function api(path, opts = {}) {
  const isBinary = opts.body instanceof ArrayBuffer || opts.body instanceof Blob;
  const res = await fetch("/api/" + path, {
    ...opts,
    headers: isBinary ? (opts.headers || {}) : { "Content-Type": "application/json", ...(opts.headers || {}) },
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) return { data: null, error: { message: data?.error || "error" } };
  return { data, error: null };
}

let CATS = {}; // slug → nombre; se llena desde /api/admin/categories
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_IMAGE = 50 * 1024 * 1024;
const TZ = { timeZone: "America/Bogota" };
// SQLite guarda las fechas en UTC sin zona ("2026-11-30 20:30:00"); sin esto el navegador las lee como hora local (+5 h).
const dbDate = (s) => new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(" ", "T") + "Z");
let me = null, categories = [], editingCat = null, products = [], subs = [], orders = [], expenses = [], settings = {}, editing = null;

function toast(t) {
  const el = $("toast");
  el.textContent = t; el.hidden = false;
  clearTimeout(toast.id);
  toast.id = setTimeout(() => (el.hidden = true), 3000);
}
const setMsg = (el, t, state = "info") => { el.textContent = t; el.dataset.state = state; };
const ACCENT_NAMES = { rose: "Rosa", champagne: "Champagne", plum: "Ciruela" };
const accentOf = (slug) => (categories.find((c) => c.slug === slug) || {}).accent || "rose";
const isUrl = (u) => /^https?:\/\//.test(u || "");

// ---------- Pestañas ----------
const lastTab = {};
function showTab(name) {
  document.querySelectorAll(".sub-tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== "tab-" + name));
  const btn = document.querySelector(`.sub-tab[data-tab="${name}"]`);
  const section = btn && btn.closest(".subtabs").dataset.section;
  if (section) lastTab[section] = name;
  document.querySelectorAll(".main-tab").forEach((b) => b.setAttribute("aria-selected", b.dataset.section === section));
  document.querySelectorAll(".subtabs").forEach((n) => (n.hidden = n.dataset.section !== section));
}
$("panel-nav").addEventListener("click", (e) => {
  const main = e.target.closest(".main-tab");
  if (main) {
    const s = main.dataset.section;
    return showTab(lastTab[s] || document.querySelector(`.subtabs[data-section="${s}"] .sub-tab`).dataset.tab);
  }
  const sub = e.target.closest(".sub-tab");
  if (sub) showTab(sub.dataset.tab);
});
showTab("pedidos");

// ---------- Fotos (R2 vía /api/admin/upload) ----------
// Antes de subir, la foto se reduce (máx. 640 px por lado) y se convierte a WebP.
// 1000px alcanza para las tarjetas y para el visor "ver en grande" de la tienda.
const MAX_SIDE = 1000, QUALITY = 0.82;

async function compressImage(file) {
  let bmp;
  try {
    try { bmp = await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch (e) { bmp = await createImageBitmap(file); }
  } catch (e) {
    throw new Error("No se pudo leer la foto. Prueba con otra imagen.");
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const toBlob = (type) => new Promise((res) => canvas.toBlob(res, type, QUALITY));
  let blob = await toBlob("image/webp");
  if (!blob || blob.type !== "image/webp") {
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    blob = await toBlob("image/jpeg");
  }
  if (!blob) throw new Error("No se pudo optimizar la foto.");
  return scale === 1 && blob.size >= file.size ? file : blob;
}

async function uploadImage(file) {
  if (!EXT[file.type]) throw new Error("La foto debe ser JPG, PNG o WebP.");
  if (file.size > MAX_IMAGE) throw new Error(`La foto pesa más de ${MAX_IMAGE / 1024 / 1024} MB.`);
  const img = await compressImage(file);
  const res = await fetch("/api/admin/upload", {
    method: "POST",
    headers: { "Content-Type": img.type || file.type },
    credentials: "same-origin",
    body: img,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.url) throw new Error(data?.error || "No se pudo subir la foto.");
  return { url: data.url };
}

// ---------- Sesión ----------
async function enter(name) {
  me = { name };
  $("login-view").hidden = true;
  $("dashboard-view").hidden = false;
  $("welcome-name").innerHTML = `Hola, ${esc(me.name)}<span>.</span>`;
  await loadAll();
}

async function loadAll() {
  await loadCategories();
  await Promise.all([loadOrders(), loadProducts(), loadSubs(), loadExpenses(), loadSettings()]);
  $("last-updated").textContent = "Actualizado " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
}

// =====================================================================
// PEDIDOS
// =====================================================================
const ORDER_LABELS = { pending: "Pendiente", confirmed: "Confirmado", delivered: "Entregado", cancelled: "Cancelado" };
const ORDER_ACTIONS = {
  pending: [["confirmed", "Confirmar"], ["cancelled", "Cancelar"]],
  confirmed: [["delivered", "Marcar entregado"], ["cancelled", "Cancelar"]],
  delivered: [["cancelled", "Anular venta"]],
};

async function loadOrders() {
  $("orders-loading").hidden = false;
  const { data, error } = await api("admin/orders");
  $("orders-loading").hidden = true;
  if (error) return setMsg($("orders-message"), "No se pudieron cargar los pedidos.", "error");
  setMsg($("orders-message"), "");
  orders = data;
  renderOrders();
  renderEarnings();
}

const waPhone = (p) => { const d = String(p).replace(/\D/g, ""); return d.length === 10 ? "57" + d : d; };

const STORE_NAME = "Venta en tienda", STORE_PHONE = "0000000";
const isStoreSale = (o) => o.delivery_type === "tienda" && o.customer_name === STORE_NAME && o.customer_phone === STORE_PHONE;

function orderCard(o) {
  const when = dbDate(o.created_at).toLocaleString("es-CO", { ...TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const items = (o.order_items || []).map((i) => `<li><span>${i.quantity} × ${esc(i.name)}${i.variant_name ? ` <em>· ${esc(i.variant_name)}</em>` : ""}</span><span>${money(i.price * i.quantity)}</span></li>`).join("");
  const actions = (ORDER_ACTIONS[o.status] || []).map(([s, l]) => `<button type="button" class="${s === "cancelled" ? "danger" : "ok"}" data-id="${o.id}" data-status="${s}">${l}</button>`).join("")
    + `<button type="button" class="danger" data-id="${o.id}" data-del="1">Eliminar</button>`;
  const PAY = { efectivo: "Efectivo", nequi: "Nequi" };
  const place = [o.address, o.neighborhood].filter(Boolean).join(", ");
  const delivery = [
    o.delivery_type === "tienda"
      ? "Recoge en tienda"
      : `Domicilio: ${esc(place || "sin dirección")}${place ? ` <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place + ", " + CITY)}" target="_blank" rel="noopener noreferrer">ver mapa ↗</a>` : ""}`,
    o.payment_method ? `Pago: ${esc(PAY[o.payment_method] || o.payment_method)}` : "",
    o.preferred_time ? `Hora preferida: ${esc(o.preferred_time)}` : "",
  ].filter(Boolean).join(" · ");
  return `<article class="order-card">
    <div class="order-top">
      <div><strong class="order-code">${esc(o.code)}</strong><span class="muted small"> · ${when}</span></div>
      <span class="badge st-${o.status}">${ORDER_LABELS[o.status]}</span>
    </div>
    <div class="order-customer">
      <strong>${esc(o.customer_name)}</strong>
      ${isStoreSale(o) ? "" : `<a href="https://wa.me/${waPhone(o.customer_phone)}" target="_blank" rel="noopener noreferrer">${esc(o.customer_phone)} ↗</a>`}
    </div>
    <p class="order-delivery">${delivery}</p>
    <ul class="order-items">${items}</ul>
    ${o.notes ? `<p class="order-notes">“${esc(o.notes)}”</p>` : ""}
    <div class="order-bottom">
      <strong class="order-total">${money(o.total)}</strong>
      <div class="row-actions">${actions}</div>
    </div>
  </article>`;
}

function renderOrders() {
  const pending = orders.filter((o) => o.status === "pending").length;
  $("orders-badge").textContent = pending;
  $("orders-badge").hidden = !pending;
  $("orders-badge-main").textContent = pending;
  $("orders-badge-main").hidden = !pending;
  const q = $("order-search").value.trim().toLowerCase(), st = $("order-filter").value;
  const rows = orders.filter((o) => (st === "all" || o.status === st) &&
    (!q || [o.code, o.customer_name, o.customer_phone, o.address, o.neighborhood].join(" ").toLowerCase().includes(q)));
  $("orders-empty").hidden = rows.length > 0;
  $("orders-list").innerHTML = rows.map(orderCard).join("");
}

async function deleteOrder(btn) {
  const o = orders.find((x) => String(x.id) === btn.dataset.id);
  if (!o) return;
  const stockNote = o.status === "confirmed" || o.status === "delivered" ? " Sus existencias se devuelven al inventario." : "";
  if (!confirm(`¿Eliminar el pedido ${o.code} por ${money(o.total)}? Se borra por completo y deja de contar en Ganancias.${stockNote} No se puede deshacer.`)) return;
  btn.disabled = true;
  const { error } = await api("admin/orders/" + o.id, { method: "DELETE" });
  if (error) {
    toast("No se pudo eliminar el pedido.");
    btn.disabled = false;
    return;
  }
  toast("Pedido eliminado.");
  loadOrders();
  loadProducts();
}

$("orders-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  if (btn.dataset.del) return deleteOrder(btn);
  if (btn.dataset.status === "cancelled" && !confirm("¿Cancelar o anular este pedido? Si ya estaba confirmado o entregado, deja de contar en Ganancias y se devuelven las existencias.")) return;
  btn.disabled = true;
  const { error } = await api("admin/orders/" + btn.dataset.id, { method: "PATCH", body: JSON.stringify({ status: btn.dataset.status }) });
  if (error) {
    const m = /^stock:(.+)$/.exec((error.message || "").trim());
    toast(m ? `No hay existencias suficientes de "${m[1]}" para confirmar este pedido.` : "No se pudo actualizar el pedido.");
    btn.disabled = false;
    return;
  }
  toast("Pedido actualizado.");
  loadOrders();
  loadProducts();
});
$("order-search").addEventListener("input", renderOrders);
$("order-filter").addEventListener("change", renderOrders);

// =====================================================================
// GANANCIAS
// =====================================================================
function periodStart(p) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth(), d = n.getDate();
  return p === "week" ? new Date(y, m, d - ((n.getDay() + 6) % 7)) :
    p === "biweekly" ? new Date(y, m, d <= 15 ? 1 : 16) :
    p === "month" ? new Date(y, m, 1) : new Date(y, 0, 1);
}
const expenseDate = (e) => new Date(e.spent_at + "T00:00:00");

function renderEarnings() {
  const from = periodStart($("earn-period").value);
  const done = orders.filter((o) => o.status === "delivered" && dbDate(o.status_at) >= from);
  const total = done.reduce((t, o) => t + o.total, 0);
  $("earn-total").textContent = money(total);
  $("earn-count").textContent = done.length;
  $("earn-avg").textContent = money(done.length ? Math.round(total / done.length) : 0);
  const spent = expenses.filter((e) => expenseDate(e) >= from).reduce((t, e) => t + e.amount, 0);
  const balance = total - spent;
  $("earn-expenses").textContent = money(spent);
  $("earn-balance").textContent = money(balance);
  $("earn-balance").style.color = balance < 0 ? "var(--red)" : "";

  const by = {};
  done.forEach((o) => (o.order_items || []).forEach((i) => { const k = i.category || "otros"; by[k] = (by[k] || 0) + i.price * i.quantity; }));
  const entries = Object.entries(by).sort((a, b) => b[1] - a[1]);
  $("earn-cats").innerHTML = entries.length ? entries.map(([k, v]) => `
    <div class="bar-row">
      <span>${esc(CATS[k] || "Otros")}</span>
      <div class="bar"><i class="bar-${accentOf(k)}" style="width:${total ? Math.max(3, Math.round((v / total) * 100)) : 0}%"></i></div>
      <strong>${money(v)}</strong>
    </div>`).join("") : `<p class="empty">Todavía no hay pedidos entregados en este periodo.</p>`;
}
$("earn-period").addEventListener("change", renderEarnings);

// =====================================================================
// CATEGORÍAS (menú principal)
// =====================================================================
async function loadCategories(rerender = false) {
  const { data, error } = await api("admin/categories");
  if (error) return setMsg($("cat-message"), "No se pudieron cargar las categorías.", "error");
  categories = data;
  CATS = Object.fromEntries(categories.map((c) => [c.slug, c.name]));
  fillCategorySelects();
  renderCategories();
  if (rerender) { renderProducts(); renderSubs(); renderOrders(); renderEarnings(); renderExpenses(); refreshSale(); }
}

function fillCategorySelects() {
  const opts = categories.map((c) => `<option value="${esc(c.slug)}">${esc(c.name)}${c.active ? "" : " (oculta)"}</option>`).join("");
  const fill = (id, first) => {
    const el = $(id), cur = el.value;
    el.innerHTML = first + opts;
    if ([...el.options].some((o) => o.value === cur)) el.value = cur;
  };
  fill("p-category", "");
  fill("sub-category", "");
  fill("filter-category", `<option value="all">Todas</option>`);
  fill("e-category", `<option value="">General</option>`);
  fillSubSelect();
}

function renderCategories() {
  const n = (slug) => products.filter((p) => p.category === slug).length;
  $("cats-list").innerHTML = categories.length ? categories.map((c, i) => `
    <div class="sub-row${c.active ? "" : " is-hidden"}">
      <div>
        <strong class="cat-${esc(c.accent)}">${esc(c.name)}</strong>
        <span class="sub-meta">${n(c.slug)} producto${n(c.slug) === 1 ? "" : "s"} · ${ACCENT_NAMES[c.accent] || "Rosa"} · ${c.active ? "Visible en el menú principal" : "Oculta"}</span>
      </div>
      <div class="row-actions">
        <button type="button" data-act="up" data-slug="${esc(c.slug)}"${i === 0 ? " disabled" : ""} aria-label="Subir">↑</button>
        <button type="button" data-act="down" data-slug="${esc(c.slug)}"${i === categories.length - 1 ? " disabled" : ""} aria-label="Bajar">↓</button>
        <button type="button" data-act="edit" data-slug="${esc(c.slug)}">Editar</button>
        <button type="button" data-act="toggle" data-slug="${esc(c.slug)}">${c.active ? "Ocultar" : "Mostrar"}</button>
        <button type="button" class="danger" data-act="delete" data-slug="${esc(c.slug)}">Eliminar</button>
      </div>
    </div>`).join("") : `<p class="muted small">Todavía no hay categorías. Crea la primera arriba.</p>`;
}

function resetCatForm() {
  $("cat-form").reset();
  editingCat = null;
  $("cat-form-title").textContent = "Categorías";
  $("cat-save").textContent = "Crear categoría";
  $("cat-cancel").hidden = true;
}

$("cat-cancel").addEventListener("click", () => { resetCatForm(); setMsg($("cat-message"), ""); });

$("cat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("cat-message"), btn = $("cat-save");
  const name = $("c-name").value.trim();
  if (name.length < 2) return setMsg(m, "El nombre debe tener al menos 2 caracteres.", "error");
  if (categories.some((c) => (!editingCat || c.slug !== editingCat.slug) && c.name.toLowerCase() === name.toLowerCase()))
    return setMsg(m, `Ya existe una categoría llamada "${name}".`, "error");
  const body = JSON.stringify({
    name, description: $("c-description").value.trim(),
    accent: $("c-accent").value, variant_label: $("c-variant").value.trim() || "Opción",
  });
  btn.disabled = true;
  setMsg(m, "Guardando...");
  const { error } = editingCat
    ? await api("admin/categories/" + editingCat.slug, { method: "PATCH", body })
    : await api("admin/categories", { method: "POST", body });
  btn.disabled = false;
  if (error) return setMsg(m, "No se pudo guardar la categoría.", "error");
  const wasEditing = !!editingCat;
  resetCatForm();
  setMsg(m, wasEditing ? "Categoría actualizada." : `Categoría "${name}" creada. Ya aparece en la portada.`, "success");
  toast(wasEditing ? "Categoría actualizada." : "Categoría creada.");
  loadCategories(true);
});

async function moveCategory(c, dir) {
  const i = categories.findIndex((x) => x.slug === c.slug), j = i + dir;
  if (j < 0 || j >= categories.length) return;
  const list = [...categories];
  [list[i], list[j]] = [list[j], list[i]];
  const changes = list.map((x, idx) => ({ slug: x.slug, sort_order: idx + 1 }))
    .filter((ch) => categories.find((x) => x.slug === ch.slug).sort_order !== ch.sort_order);
  const results = await Promise.all(changes.map((ch) => api("admin/categories/" + ch.slug, { method: "PATCH", body: JSON.stringify({ sort_order: ch.sort_order }) })));
  if (results.some((r) => r.error)) toast("No se pudo cambiar el orden.");
  loadCategories();
}

$("cats-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const c = categories.find((x) => x.slug === btn.dataset.slug);
  if (!c) return;
  const act = btn.dataset.act;
  if (act === "up" || act === "down") { btn.disabled = true; return moveCategory(c, act === "up" ? -1 : 1); }
  if (act === "edit") {
    editingCat = c;
    $("c-name").value = c.name;
    $("c-description").value = c.description || "";
    $("c-accent").value = c.accent;
    $("c-variant").value = c.variant_label || "Opción";
    $("cat-form-title").textContent = `Editando: ${c.name}`;
    $("cat-save").textContent = "Guardar cambios";
    $("cat-cancel").hidden = false;
    setMsg($("cat-message"), "");
    $("c-name").focus();
    return window.scrollTo({ top: 0, behavior: "smooth" });
  }
  btn.disabled = true;
  if (act === "toggle") {
    const { error } = await api("admin/categories/" + c.slug, { method: "PATCH", body: JSON.stringify({ active: !c.active }) });
    if (error) { toast("No se pudo actualizar."); btn.disabled = false; return; }
    toast(c.active ? "Categoría oculta de la portada." : "Categoría visible en la portada.");
    return loadCategories(true);
  }
  const n = products.filter((p) => p.category === c.slug).length;
  if (n) {
    toast(`"${c.name}" tiene ${n} producto${n === 1 ? "" : "s"}. Muévelos a otra categoría o elimínalos primero, o usa Ocultar.`);
    btn.disabled = false;
    return;
  }
  if (!confirm(`¿Eliminar la categoría "${c.name}"? También se borran sus subsecciones. No se puede deshacer.`)) { btn.disabled = false; return; }
  const { error } = await api("admin/categories/" + c.slug, { method: "DELETE" });
  if (error) { toast(error.message === "has_products" ? "Esa categoría todavía tiene productos." : "No se pudo eliminar."); btn.disabled = false; return; }
  toast("Categoría eliminada.");
  if (editingCat && editingCat.slug === c.slug) resetCatForm();
  loadCategories(true);
  loadSubs();
});

// =====================================================================
// SUBSECCIONES
// =====================================================================
async function loadSubs() {
  const { data, error } = await api("admin/subcategories");
  if (error) return setMsg($("sub-message"), "No se pudieron cargar las subsecciones.", "error");
  setMsg($("sub-message"), "");
  subs = data;
  renderSubs();
  renderProducts();
}

const subName = (id) => { const s = subs.find((x) => x.id === id); return s ? s.name : ""; };
const subsOf = (cat) => subs.filter((s) => s.category === cat);

function fillSubSelect(selected) {
  const sel = $("p-subcategory");
  const cur = selected !== undefined ? selected : sel.value;
  const list = subsOf($("p-category").value);
  sel.innerHTML = `<option value="">Sin subsección</option>` + list.map((s) =>
    `<option value="${s.id}">${esc(s.name)}${s.active ? "" : " (oculta)"}</option>`).join("");
  sel.value = list.some((s) => String(s.id) === String(cur)) ? String(cur) : "";
}
$("p-category").addEventListener("change", () => fillSubSelect());

function renderSubs() {
  fillSubSelect();
  $("subs-groups").innerHTML = Object.entries(CATS).map(([k, label]) => {
    const list = subsOf(k);
    const rows = list.map((s, i) => {
      const n = products.filter((p) => p.subcategory_id === s.id).length;
      return `<div class="sub-row${s.active ? "" : " is-hidden"}">
        <div>
          <strong>${esc(s.name)}</strong>
          <span class="sub-meta">${n} producto${n === 1 ? "" : "s"} · ${s.active ? "Visible en la tienda" : "Oculta"}</span>
        </div>
        <div class="row-actions">
          <button type="button" data-act="up" data-id="${s.id}"${i === 0 ? " disabled" : ""} aria-label="Subir">↑</button>
          <button type="button" data-act="down" data-id="${s.id}"${i === list.length - 1 ? " disabled" : ""} aria-label="Bajar">↓</button>
          <button type="button" data-act="rename" data-id="${s.id}">Renombrar</button>
          <button type="button" data-act="toggle" data-id="${s.id}">${s.active ? "Ocultar" : "Mostrar"}</button>
          <button type="button" class="danger" data-act="delete" data-id="${s.id}">Eliminar</button>
        </div>
      </div>`;
    }).join("");
    return `<div class="sub-group">
      <h3 class="sub cat-${accentOf(k)}">${esc(label)}</h3>
      ${rows || `<p class="muted small">Todavía no hay subsecciones en ${esc(label)}.</p>`}
    </div>`;
  }).join("");
}

$("sub-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("sub-message"), btn = $("sub-save");
  const category = $("sub-category").value, name = $("sub-name").value.trim();
  if (!name) return setMsg(m, "Escribe el nombre de la subsección.", "error");
  if (subsOf(category).some((s) => s.name.toLowerCase() === name.toLowerCase()))
    return setMsg(m, `Ya existe "${name}" en ${CATS[category]}.`, "error");
  btn.disabled = true;
  setMsg(m, "Guardando...");
  const { error } = await api("admin/subcategories", { method: "POST", body: JSON.stringify({ category, name }) });
  btn.disabled = false;
  if (error) return setMsg(m, error.message || "No se pudo crear la subsección.", "error");
  $("sub-name").value = "";
  setMsg(m, `Subsección "${name}" creada en ${CATS[category]}.`, "success");
  toast("Subsección creada.");
  loadSubs();
});

async function moveSub(s, dir) {
  const list = subsOf(s.category), i = list.findIndex((x) => x.id === s.id), j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const changes = list.map((x, idx) => ({ id: x.id, sort_order: idx + 1 })).filter((c) => subs.find((x) => x.id === c.id).sort_order !== c.sort_order);
  const results = await Promise.all(changes.map((c) => api("admin/subcategories/" + c.id, { method: "PATCH", body: JSON.stringify({ sort_order: c.sort_order }) })));
  if (results.some((r) => r.error)) toast("No se pudo cambiar el orden.");
  loadSubs();
}

$("subs-groups").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const s = subs.find((x) => String(x.id) === btn.dataset.id);
  if (!s) return;
  const act = btn.dataset.act;
  if (act === "up" || act === "down") { btn.disabled = true; return moveSub(s, act === "up" ? -1 : 1); }

  if (act === "rename") {
    const raw = prompt("Nuevo nombre de la subsección:", s.name);
    if (raw === null) return;
    const name = raw.trim();
    if (!name || name === s.name) return;
    if (name.length > 60) return toast("El nombre es demasiado largo (máximo 60 caracteres).");
    if (subsOf(s.category).some((x) => x.id !== s.id && x.name.toLowerCase() === name.toLowerCase())) return toast(`Ya existe "${name}" en ${CATS[s.category]}.`);
    const { error } = await api("admin/subcategories/" + s.id, { method: "PATCH", body: JSON.stringify({ name }) });
    if (error) return toast("No se pudo renombrar.");
    toast("Subsección renombrada.");
    return loadSubs();
  }

  btn.disabled = true;
  if (act === "toggle") {
    const { error } = await api("admin/subcategories/" + s.id, { method: "PATCH", body: JSON.stringify({ active: !s.active }) });
    if (error) { toast("No se pudo actualizar."); btn.disabled = false; return; }
    toast(s.active ? "Subsección oculta." : "Subsección visible.");
    return loadSubs();
  }
  const n = products.filter((p) => p.subcategory_id === s.id).length;
  const extra = n ? ` Sus ${n} producto${n === 1 ? "" : "s"} no se borran: quedan sin subsección.` : "";
  if (!confirm(`¿Eliminar la subsección "${s.name}" de ${CATS[s.category]}?${extra}`)) { btn.disabled = false; return; }
  const { error } = await api("admin/subcategories/" + s.id, { method: "DELETE" });
  if (error) { toast("No se pudo eliminar."); btn.disabled = false; return; }
  toast("Subsección eliminada.");
  loadSubs();
  loadProducts();
});

// =====================================================================
// PRODUCTOS (inventario)
// =====================================================================
async function loadProducts() {
  $("loading-state").hidden = false;
  $("table-wrap").hidden = true;
  $("empty-state").hidden = true;
  const { data, error } = await api("admin/products");
  if (error) {
    $("loading-state").hidden = true;
    return setMsg($("list-message"), "No se pudieron cargar los productos. " + (error.message || ""), "error");
  }
  setMsg($("list-message"), "");
  products = data;
  products.forEach((p) => p.product_variants.sort((a, b) => a.id - b.id));
  renderProducts();
  renderSubs();
  renderCategories();
  refreshSale();
}

function variantsLine(p) {
  const vs = p.product_variants || [];
  if (!vs.length) return "";
  const hidden = vs.filter((v) => !v.active).length;
  return `<span class="variants-count">${vs.length} variante${vs.length === 1 ? "" : "s"}${hidden ? ` · ${hidden} oculta${hidden === 1 ? "" : "s"}` : ""}</span>`;
}

const LOW_STOCK = 3;

function stockCell(p) {
  const all = p.product_variants || [];
  if (all.length) {
    const vs = all.filter((v) => v.active && v.stock != null);
    if (!vs.length) return `<span class="muted small">Sin control</span>`;
    const total = vs.reduce((t, v) => t + v.stock, 0);
    const out = vs.filter((v) => v.stock === 0).map((v) => esc(v.name));
    const low = vs.filter((v) => v.stock > 0 && v.stock <= LOW_STOCK).map((v) => `${esc(v.name)} (${v.stock})`);
    return `<strong>${total} uds</strong>`
      + (out.length ? `<span class="stock-note out">Agotado: ${out.join(", ")}</span>` : "")
      + (low.length ? `<span class="stock-note low">Quedan pocas: ${low.join(", ")}</span>` : "");
  }
  if (p.stock == null) return `<span class="muted small">Sin control</span>`;
  if (p.stock === 0) return `<span class="badge out">Agotado</span>`;
  return `<strong class="${p.stock <= LOW_STOCK ? "low" : ""}">${p.stock} uds</strong>`;
}

function row(p) {
  const img = isUrl(p.image_url)
    ? `<img class="thumb" src="${esc(p.image_url)}" alt="" loading="lazy">`
    : `<span class="thumb">${INITIALS}</span>`;
  return `<tr>
    <td><div class="product-cell">${img}<div><strong>${esc(p.name)}</strong><span>${esc(p.description)}</span>${variantsLine(p)}</div></div></td>
    <td><span class="badge cat-${accentOf(p.category)}">${esc(CATS[p.category] || p.category)}</span>${subName(p.subcategory_id) ? `<span class="stock-note muted">${esc(subName(p.subcategory_id))}</span>` : ""}</td>
    <td>${money(p.price)}</td>
    <td>${stockCell(p)}</td>
    <td><span class="badge ${p.active ? "on" : "off"}">${p.active ? "Visible" : "Oculto"}</span></td>
    <td><div class="row-actions">
      <button type="button" data-act="edit" data-id="${p.id}">Editar</button>
      <button type="button" data-act="toggle" data-id="${p.id}">${p.active ? "Ocultar" : "Mostrar"}</button>
      <button type="button" class="danger" data-act="delete" data-id="${p.id}">Eliminar</button>
    </div></td>
  </tr>`;
}

function renderProducts() {
  const soldout = products.reduce((t, p) => {
    const vs = (p.product_variants || []).filter((v) => v.active);
    return t + (vs.length ? vs.filter((v) => v.stock === 0).length : (p.stock === 0 ? 1 : 0));
  }, 0);
  const tone = { rose: "s-rose", champagne: "s-champagne", plum: "s-plum" };
  $("inv-stats").innerHTML = [
    ["", "Total", products.length],
    ...categories.map((c) => [tone[c.accent] || "", c.name, products.filter((p) => p.category === c.slug).length]),
    ["", "Ocultos", products.filter((p) => !p.active).length],
    ["", "Agotados", soldout],
  ].map(([cls, label, n]) => `<article class="stat ${cls}"><span>${esc(label)}</span><strong>${n}</strong></article>`).join("");

  const q = $("search").value.trim().toLowerCase(), c = $("filter-category").value;
  const rows = products.filter((p) => (c === "all" || p.category === c) && (!q || p.name.toLowerCase().includes(q)));
  $("loading-state").hidden = true;
  $("empty-state").hidden = rows.length > 0;
  $("table-wrap").hidden = !rows.length;
  $("products-body").innerHTML = rows.map(row).join("");
}

// ---------- Editor de variantes ----------
function addVariantRow(v = {}) {
  const div = document.createElement("div");
  div.className = "variant-row";
  if (v.id) div.dataset.id = v.id;
  div.innerHTML = `
    <input type="text" class="v-name" maxlength="80" placeholder="Nombre (ej. Rosa nude)" aria-label="Nombre del sabor o variante" value="${esc(v.name || "")}">
    <input type="number" class="v-price" min="0" step="1" inputmode="numeric" placeholder="Precio propio" aria-label="Precio propio (opcional)" value="${v.price != null ? Number(v.price) : ""}">
    <input type="number" class="v-stock" min="0" step="1" inputmode="numeric" placeholder="Existencias" aria-label="Existencias (vacío = sin control)" value="${v.stock != null ? Number(v.stock) : ""}">
    <label class="check"><input type="checkbox" class="v-active"${v.active === false ? "" : " checked"}> Visible</label>
    <button type="button" class="v-remove" aria-label="Quitar esta variante">✕</button>`;
  $("variants-list").appendChild(div);
  return div;
}

function fillVariants(list) {
  $("variants-list").innerHTML = "";
  list.forEach(addVariantRow);
}

function parseStock(raw, label) {
  raw = String(raw).trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Las existencias de ${label} deben ser un número entero (0 o más).`);
  return n;
}

function readVariants() {
  const out = [], seen = new Set();
  for (const r of document.querySelectorAll("#variants-list .variant-row")) {
    const name = r.querySelector(".v-name").value.trim();
    const raw = r.querySelector(".v-price").value.trim();
    const rawStock = r.querySelector(".v-stock").value.trim();
    if (!name && !raw && !rawStock && !r.dataset.id) continue;
    if (!name) throw new Error("Todas las variantes necesitan un nombre.");
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`"${name}" está repetido en la lista.`);
    seen.add(key);
    let price = null;
    if (raw !== "") {
      price = Number(raw);
      if (!Number.isInteger(price) || price < 0) throw new Error(`El precio de "${name}" debe ser un número entero.`);
    }
    const stock = parseStock(rawStock, `"${name}"`);
    out.push({ id: r.dataset.id ? Number(r.dataset.id) : null, name, price, stock, active: r.querySelector(".v-active").checked });
  }
  return out;
}

$("variant-add").addEventListener("click", () => addVariantRow().querySelector(".v-name").focus());

$("variants-bulk-add").addEventListener("click", () => {
  const have = new Set([...document.querySelectorAll("#variants-list .v-name")].map((i) => i.value.trim().toLowerCase()));
  let added = 0;
  $("variants-bulk").value.split("\n").map((l) => l.trim().slice(0, 80)).filter(Boolean).forEach((name) => {
    if (have.has(name.toLowerCase())) return;
    have.add(name.toLowerCase());
    addVariantRow({ name });
    added++;
  });
  $("variants-bulk").value = "";
  toast(added ? `${added} variante${added === 1 ? "" : "s"} agregada${added === 1 ? "" : "s"} a la lista. Recuerda guardar el producto.` : "No había nombres nuevos para agregar.");
});

$("variants-list").addEventListener("click", (e) => {
  const b = e.target.closest(".v-remove");
  if (b) b.closest(".variant-row").remove();
});

$("variants-list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.target.matches(".v-name, .v-price")) return;
  e.preventDefault();
  addVariantRow().querySelector(".v-name").focus();
});

function resetForm() {
  $("product-form").reset();
  editing = null;
  $("form-eyebrow").textContent = "NUEVO";
  $("form-title").textContent = "Agregar producto";
  $("tab-btn-agregar").textContent = "Agregar producto";
  $("cancel-edit").hidden = true;
  $("image-current").hidden = true;
  $("variants-list").innerHTML = "";
  fillSubSelect("");
  setMsg($("form-message"), "");
}

function startEdit(p) {
  editing = p;
  $("p-category").value = p.category;
  fillSubSelect(p.subcategory_id ?? "");
  $("p-price").value = p.price;
  $("p-name").value = p.name;
  $("p-description").value = p.description || "";
  $("p-active").checked = p.active;
  $("p-stock").value = p.stock ?? "";
  $("p-variant-label").value = p.variant_label || "";
  $("p-image").value = "";
  $("p-remove-image").checked = false;
  fillVariants(p.product_variants || []);
  $("image-current").hidden = !isUrl(p.image_url);
  if (isUrl(p.image_url)) $("image-preview").src = p.image_url;
  $("form-eyebrow").textContent = "EDITANDO";
  $("form-title").textContent = "Editar producto";
  $("tab-btn-agregar").textContent = "Editar producto";
  $("cancel-edit").hidden = false;
  setMsg($("form-message"), "");
  showTab("agregar");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("product-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fm = $("form-message"), btn = $("save-button");
  const name = $("p-name").value.trim(), desc = $("p-description").value.trim(), price = Number($("p-price").value);
  if (!$("p-category").value) return setMsg(fm, "Primero crea una categoría en Productos › Categorías.", "error");
  if (name.length < 2) return setMsg(fm, "El nombre debe tener al menos 2 caracteres.", "error");
  if ($("p-price").value === "" || !Number.isInteger(price) || price < 0) return setMsg(fm, "El precio debe ser un número entero, sin decimales.", "error");
  let variants;
  try { variants = readVariants(); } catch (err) { return setMsg(fm, err.message, "error"); }
  let stock;
  try { stock = parseStock($("p-stock").value, "este producto"); } catch (err) { return setMsg(fm, err.message, "error"); }

  btn.disabled = true;
  setMsg(fm, "Guardando...");
  try {
    let image_url = editing ? editing.image_url : null;
    const file = $("p-image").files[0];
    if (file) { const up = await uploadImage(file); image_url = up.url; }
    else if (editing && $("p-remove-image").checked) image_url = null;

    const body = {
      category: $("p-category").value,
      subcategory_id: $("p-subcategory").value || null,
      name, description: desc || null, price, image_url,
      active: $("p-active").checked, stock, variants,
      variant_label: $("p-variant-label").value.trim() || null,
    };
    const { error } = editing
      ? await api("admin/products/" + editing.id, { method: "PATCH", body: JSON.stringify(body) })
      : await api("admin/products", { method: "POST", body: JSON.stringify(body) });
    if (error) throw new Error(error.message || "No se pudo guardar el producto.");

    const wasEditing = !!editing;
    toast(wasEditing ? "Producto actualizado." : "Producto creado.");
    resetForm();
    await loadProducts();
    if (wasEditing) showTab("inventario");
  } catch (err) {
    setMsg(fm, err.message, "error");
  }
  btn.disabled = false;
});

$("cancel-edit").addEventListener("click", () => { resetForm(); showTab("inventario"); });

$("products-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const p = products.find((x) => String(x.id) === btn.dataset.id);
  if (!p) return;

  if (btn.dataset.act === "edit") return startEdit(p);

  btn.disabled = true;
  if (btn.dataset.act === "toggle") {
    const { error } = await api("admin/products/" + p.id, { method: "PATCH", body: JSON.stringify({ ...stripForUpdate(p), active: !p.active }) });
    if (error) { toast("No se pudo actualizar el producto."); btn.disabled = false; return; }
    toast(p.active ? "Producto oculto." : "Producto visible.");
  } else {
    if (!confirm(`¿Eliminar "${p.name}"? Esta acción no se puede deshacer. Los pedidos anteriores conservan su nombre y precio.`)) { btn.disabled = false; return; }
    const { error } = await api("admin/products/" + p.id, { method: "DELETE" });
    if (error) { toast("No se pudo eliminar el producto."); btn.disabled = false; return; }
    if (editing && editing.id === p.id) resetForm();
    toast("Producto eliminado.");
  }
  loadProducts();
});

// El backend espera el objeto completo en cada PATCH (no hace falta pisar todo, solo mandamos lo mismo que ya tiene)
function stripForUpdate(p) {
  return {
    category: p.category, subcategory_id: p.subcategory_id, name: p.name, description: p.description,
    price: p.price, image_url: p.image_url, stock: p.stock, variant_label: p.variant_label,
    variants: (p.product_variants || []).map((v) => ({ id: v.id, name: v.name, price: v.price, stock: v.stock, active: !!v.active })),
  };
}

$("search").addEventListener("input", renderProducts);
$("filter-category").addEventListener("change", renderProducts);

// =====================================================================
// VENTA EN TIENDA
// =====================================================================
const activeVariants = (p) => (p.product_variants || []).filter((v) => v.active);
const unitOf = (p, v) => (v && v.price != null ? v.price : p.price);

// Buscador de producto: escribes unas letras y filtra entre todos (sirve igual con 50 o 5000).
const normTxt = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function matchProducts(q) {
  const n = normTxt(q).trim();
  if (!n) return [];
  return products.filter((p) => normTxt(p.name).includes(n)).sort((a, b) => a.name.localeCompare(b.name, "es")).slice(0, 50);
}

function comboListHtml(list, hasQuery) {
  if (!list.length) return `<div class="combo-empty">${hasQuery ? "Sin resultados" : "Escribe el nombre del producto…"}</div>`;
  return list.map((p) => `<div class="combo-item" data-id="${p.id}" role="option">
    <span>${esc(p.name)}${p.active ? "" : " (oculto)"}</span><small>${esc(CATS[p.category] || "")}</small></div>`).join("");
}

function openCombo(row, q) {
  row.querySelector(".combo-list").innerHTML = comboListHtml(matchProducts(q), q.trim().length > 0);
  row.querySelector(".combo-list").hidden = false;
}
const closeCombo = (row) => (row.querySelector(".combo-list").hidden = true);

function chooseProduct(row, id) {
  const p = products.find((x) => String(x.id) === String(id));
  row.querySelector(".s-product").value = id;
  row.querySelector(".s-product-q").value = p ? p.name : "";
  closeCombo(row);
  const vs = row.querySelector(".s-variant"), price = row.querySelector(".s-price");
  if (p && activeVariants(p).length) { vs.innerHTML = variantOptionsHtml(p); vs.hidden = false; price.value = ""; }
  else { vs.hidden = true; vs.innerHTML = ""; price.value = p ? p.price : ""; }
  updateSaleTotal();
  (vs.hidden ? row.querySelector(".s-qty") : vs).focus();
}

function variantOptionsHtml(p) {
  return `<option value="">Selecciona opción</option>` + activeVariants(p).map((v) =>
    `<option value="${v.id}"${v.sold_out ? " disabled" : ""}>${esc(v.name)}${v.stock != null ? ` · ${v.stock} uds` : ""}${v.stock === 0 ? " · Agotado" : ""}</option>`).join("");
}

function addSaleRow() {
  const div = document.createElement("div");
  div.className = "sale-row";
  div.innerHTML = `
    <div class="combo">
      <input type="text" class="s-product-q" placeholder="Busca un producto…" autocomplete="off" aria-label="Producto">
      <input type="hidden" class="s-product">
      <div class="combo-list" hidden></div>
    </div>
    <select class="s-variant" aria-label="Sabor o variante" hidden></select>
    <input type="number" class="s-qty" min="1" max="20" step="1" value="1" inputmode="numeric" aria-label="Cantidad">
    <input type="number" class="s-price" min="0" step="1" inputmode="numeric" placeholder="Precio c/u" aria-label="Precio cobrado por unidad">
    <button type="button" class="v-remove" aria-label="Quitar esta línea">✕</button>`;
  $("sale-lines").appendChild(div);
  return div;
}

function refreshSale() {
  const rows = document.querySelectorAll("#sale-lines .sale-row");
  if (!rows.length) { addSaleRow(); return; }
  rows.forEach((r) => {
    const p = products.find((x) => String(x.id) === r.querySelector(".s-product").value);
    if (!p) { r.querySelector(".s-variant").hidden = true; return; }
    r.querySelector(".s-product-q").value = p.name + (p.active ? "" : " (oculto)");
    const vs = r.querySelector(".s-variant"), cur = vs.value;
    if (activeVariants(p).length) { vs.innerHTML = variantOptionsHtml(p); vs.value = cur; }
  });
}

function updateSaleTotal() {
  let total = 0;
  document.querySelectorAll("#sale-lines .sale-row").forEach((r) => {
    const qty = Number(r.querySelector(".s-qty").value), price = Number(r.querySelector(".s-price").value);
    if (qty > 0 && price > 0) total += qty * price;
  });
  $("sale-total").textContent = money(total);
}

$("sale-add").addEventListener("click", () => addSaleRow().querySelector(".s-product-q").focus());

$("sale-lines").addEventListener("click", (e) => {
  const item = e.target.closest(".combo-item");
  if (item) return chooseProduct(item.closest(".sale-row"), item.dataset.id);
  const b = e.target.closest(".v-remove");
  if (!b) return;
  b.closest(".sale-row").remove();
  if (!document.querySelector("#sale-lines .sale-row")) addSaleRow();
  updateSaleTotal();
});

$("sale-lines").addEventListener("focusin", (e) => {
  if (e.target.matches(".s-product-q")) openCombo(e.target.closest(".sale-row"), e.target.value);
});
document.addEventListener("click", (e) => {
  document.querySelectorAll("#sale-lines .combo").forEach((c) => { if (!c.contains(e.target)) c.querySelector(".combo-list").hidden = true; });
});

$("sale-lines").addEventListener("keydown", (e) => {
  if (!e.target.matches(".s-product-q")) return;
  const row = e.target.closest(".sale-row"), list = row.querySelector(".combo-list");
  const items = [...list.querySelectorAll(".combo-item")];
  let idx = items.findIndex((i) => i.classList.contains("active"));
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (idx >= 0) items[idx].classList.remove("active");
    idx = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
    if (items[idx]) { items[idx].classList.add("active"); items[idx].scrollIntoView({ block: "nearest" }); }
  } else if (e.key === "Enter" && idx >= 0) {
    e.preventDefault();
    chooseProduct(row, items[idx].dataset.id);
  } else if (e.key === "Escape") closeCombo(row);
});

$("sale-lines").addEventListener("change", (e) => {
  const row = e.target.closest(".sale-row");
  if (!row || !e.target.matches(".s-variant")) return;
  const p = products.find((x) => String(x.id) === row.querySelector(".s-product").value);
  const v = p && activeVariants(p).find((x) => String(x.id) === e.target.value);
  row.querySelector(".s-price").value = v ? unitOf(p, v) : "";
  e.target.classList.remove("invalid");
  updateSaleTotal();
});
$("sale-lines").addEventListener("input", (e) => {
  e.target.classList.remove("invalid");
  if (e.target.matches(".s-product-q")) {
    const row = e.target.closest(".sale-row");
    row.querySelector(".s-product").value = "";
    row.querySelector(".s-price").value = "";
    row.querySelector(".s-variant").hidden = true;
    openCombo(row, e.target.value);
  }
  if (e.target.matches(".s-qty, .s-price")) updateSaleTotal();
});

function readSale() {
  const items = [];
  for (const r of document.querySelectorAll("#sale-lines .sale-row")) {
    const sp = r.querySelector(".s-product"), spq = r.querySelector(".s-product-q"), sv = r.querySelector(".s-variant");
    const sq = r.querySelector(".s-qty"), sprice = r.querySelector(".s-price");
    if (!sp.value && !sprice.value.trim()) continue;
    const fail = (el, msg) => { el.classList.add("invalid"); el.focus(); throw new Error(msg); };
    const p = products.find((x) => String(x.id) === sp.value);
    if (!p) fail(spq, "Elige el producto en cada línea.");
    const needsVariant = activeVariants(p).length > 0;
    if (needsVariant && !sv.value) fail(sv, `Elige la opción de "${p.name}".`);
    const qty = Number(sq.value);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) fail(sq, "La cantidad debe ser un entero entre 1 y 20.");
    const price = Number(sprice.value);
    if (sprice.value.trim() === "" || !Number.isInteger(price) || price < 0) fail(sprice, `El precio de "${p.name}" debe ser un número entero.`);
    items.push({ id: p.id, variant_id: needsVariant ? Number(sv.value) : null, qty, price });
  }
  if (!items.length) throw new Error("Agrega al menos un producto.");
  return items;
}

$("sale-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("sale-message"), btn = $("sale-save");
  let items;
  try { items = readSale(); } catch (err) { return setMsg(m, err.message, "error"); }
  btn.disabled = true;
  setMsg(m, "Registrando...");
  const { data, error } = await api("admin/sales", {
    method: "POST",
    body: JSON.stringify({ items, payment: $("sale-payment").value, notes: $("sale-notes").value.trim() || null }),
  });
  btn.disabled = false;
  if (error) {
    const msg = (error.message || "").trim(), st = /^stock:(.+)$/.exec(msg);
    return setMsg(m, st ? `No hay existencias suficientes de "${st[1]}".` : msg || "No se pudo registrar la venta.", "error");
  }
  setMsg(m, `Venta ${data.code} registrada por ${money(data.total)}.`, "success");
  toast("Venta registrada.");
  $("sale-lines").innerHTML = "";
  $("sale-notes").value = "";
  updateSaleTotal();
  loadOrders();
  loadProducts();
});

// =====================================================================
// GASTOS
// =====================================================================
$("e-date").value = new Date().toLocaleDateString("en-CA", TZ);

async function loadExpenses() {
  const { data, error } = await api("admin/expenses");
  if (error) return setMsg($("expense-message"), "No se pudieron cargar los gastos.", "error");
  expenses = data;
  renderExpenses();
  renderEarnings();
}

function renderExpenses() {
  const from = periodStart($("exp-period").value);
  const rows = expenses.filter((e) => expenseDate(e) >= from);
  const total = rows.reduce((t, e) => t + e.amount, 0);
  $("exp-total").textContent = money(total);
  $("exp-count").textContent = rows.length;
  $("exp-avg").textContent = money(rows.length ? Math.round(total / rows.length) : 0);
  $("expenses-empty").hidden = rows.length > 0;
  $("expenses-table").hidden = !rows.length;
  $("expenses-body").innerHTML = rows.map((e) => `<tr>
    <td>${expenseDate(e).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" })}</td>
    <td>${esc(e.description)}</td>
    <td>${e.category ? `<span class="badge cat-${accentOf(e.category)}">${esc(CATS[e.category] || e.category)}</span>` : `<span class="muted small">General</span>`}</td>
    <td>${money(e.amount)}</td>
    <td><div class="row-actions"><button type="button" class="danger" data-id="${e.id}">Eliminar</button></div></td>
  </tr>`).join("");
}

$("expense-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("expense-message"), btn = $("expense-save");
  const spent_at = $("e-date").value, description = $("e-description").value.trim();
  const raw = $("e-amount").value, amount = Number(raw);
  if (!spent_at) return setMsg(m, "Elige la fecha del gasto.", "error");
  if (description.length < 2) return setMsg(m, "Escribe en qué se gastó (mínimo 2 caracteres).", "error");
  if (raw === "" || !Number.isInteger(amount) || amount <= 0) return setMsg(m, "El monto debe ser un número entero mayor que 0.", "error");
  btn.disabled = true;
  setMsg(m, "Guardando...");
  const { error } = await api("admin/expenses", { method: "POST", body: JSON.stringify({ spent_at, description, amount, category: $("e-category").value || null }) });
  btn.disabled = false;
  if (error) return setMsg(m, "No se pudo guardar el gasto.", "error");
  $("e-description").value = "";
  $("e-amount").value = "";
  setMsg(m, "Gasto guardado.", "success");
  toast("Gasto registrado.");
  loadExpenses();
});

$("expenses-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  if (!confirm("¿Eliminar este gasto? Esta acción no se puede deshacer.")) return;
  btn.disabled = true;
  const { error } = await api("admin/expenses/" + btn.dataset.id, { method: "DELETE" });
  if (error) { toast("No se pudo eliminar el gasto."); btn.disabled = false; return; }
  toast("Gasto eliminado.");
  loadExpenses();
});

$("exp-period").addEventListener("change", renderExpenses);

// =====================================================================
// PERSONALIZACIÓN
// =====================================================================
const DEFAULTS = {"hero_title_1": "Pensado para ellas,", "hero_title_2": "hecho para brillar.", "hero_text": "Maquillaje y joyas seleccionados con cariño para realzar tu belleza y tu estilo, todos los días.", "visit_text": "Escríbenos por WhatsApp para consultar disponibilidad, precios y envíos."};
DEFAULTS.whatsapp = WHATSAPP;
DEFAULTS.color_rose = "#b44a6e";
DEFAULTS.color_champagne = "#96692b";
DEFAULTS.color_plum = "#6d2f5a";
const KEYS = Object.keys(DEFAULTS);

async function loadSettings() {
  const { data, error } = await api("public/settings", { cache: "no-store" }); // el admin siempre ve lo último, sin caché del navegador
  if (error) return setMsg($("settings-message"), "No se pudo cargar la personalización.", "error");
  settings = data || {};
  fillSettings();
}

function fillSettings() {
  KEYS.forEach((k) => { const el = $("s-" + k); if (el) el.value = settings[k] ?? DEFAULTS[k]; });
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const m = $("settings-message"), btn = $("settings-save");
  const set = {}, del = [];
  for (const k of KEYS) {
    const inp = $("s-" + k);
    if (!inp) continue;
    let v = inp.value.trim();
    if (k === "whatsapp") {
      v = v.replace(/\D/g, "");
      if (v && !/^[0-9]{10,15}$/.test(v)) return setMsg(m, "El WhatsApp debe tener entre 10 y 15 números, con el indicativo (ej. 573001234567).", "error");
    }
    if (!v || v.toLowerCase() === String(DEFAULTS[k]).toLowerCase()) del.push(k);
    else set[k] = v;
  }
  btn.disabled = true;
  setMsg(m, "Guardando...");
  const { error } = await api("admin/settings", { method: "PATCH", body: JSON.stringify({ set, delete: del }) });
  btn.disabled = false;
  if (error) return setMsg(m, "No se pudieron guardar los cambios.", "error");
  settings = { ...settings, ...set };
  del.forEach((k) => delete settings[k]);
  fillSettings();
  setMsg(m, "Cambios guardados. Ya se ven en la tienda.", "success");
  toast("Personalización guardada.");
});

$("settings-reset").addEventListener("click", async () => {
  if (!confirm("¿Restaurar todos los textos y colores originales de la tienda?")) return;
  const { error } = await api("admin/settings", { method: "PATCH", body: JSON.stringify({ set: {}, delete: KEYS }) });
  if (error) return setMsg($("settings-message"), "No se pudo restaurar.", "error");
  settings = {};
  fillSettings();
  setMsg($("settings-message"), "Se restauró la página original.", "success");
});

// =====================================================================
// INICIO DE SESIÓN
// =====================================================================
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-button"), m = $("login-message");
  btn.disabled = true;
  setMsg(m, "Verificando...");
  const { data, error } = await api("login", {
    method: "POST",
    body: JSON.stringify({ email: $("email").value.trim().toLowerCase(), password: $("password").value }),
  });
  if (error) {
    setMsg(m, error.message || "No se pudo iniciar sesión.", "error");
    btn.disabled = false;
    return;
  }
  await enter(data.name);
  $("password").value = "";
  setMsg(m, "");
  btn.disabled = false;
});

$("logout-button").addEventListener("click", async () => { await api("session", { method: "DELETE" }); location.reload(); });
$("refresh-button").addEventListener("click", loadAll);

api("session").then(({ data }) => { if (data?.name) enter(data.name).catch(() => {}); });