// Lógica compartida por la portada y las páginas de categoría:
// llamadas a /api/..., verificación de edad, personalización, productos con sabores y "Mi pedido".
const API_OK = true; // antes dependía de si Supabase estaba configurado; ahora siempre lo está
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);

// Ajusta el recuadro de una foto a su propia forma (vertical, horizontal o cuadrada) en vez de forzar siempre 4:5.
// Se limita entre 3:4 y 4:3 para que las tarjetas del catálogo no queden demasiado altas ni demasiado anchas.
function fitPhoto(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h || !img.parentElement) return;
  const ratio = Math.min(4 / 3, Math.max(3 / 4, w / h));
  img.parentElement.style.aspectRatio = ratio;
}

async function api(path, opts = {}) {
  const res = await fetch("/api/" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) return { data: null, error: { message: data?.error || "error" } };
  return { data, error: null };
}

// Categorías: las crea el admin (Productos › Categorías) y llegan de /api/public/categories
let CATEGORIES = {};
async function loadCategories() {
  const { data, error } = await api("public/categories");
  if (error || !Array.isArray(data)) return false;
  CATEGORIES = Object.fromEntries(data.map((c, i) => [c.slug, {
    num: String(i + 1).padStart(2, "0"), accent: c.accent, variant: c.variant_label || "Opción",
    title: c.name, text: c.description || "",
  }]));
  return true;
}

const PAY_LABELS = { efectivo: "Efectivo", nequi: "Nequi" };

let whatsapp = WHATSAPP;
const waLink = (text) => `https://wa.me/${whatsapp}${text ? "?text=" + encodeURIComponent(text) : ""}`;
const HELLO = `Hola, quiero información de ${BUSINESS}.`;

function updateLinks() {
  const link = $("#wa-link"), hero = $("#wa-hero");
  if (link) link.href = waLink(HELLO);
  if (hero) { hero.href = waLink(HELLO); hero.target = "_blank"; hero.rel = "noopener noreferrer"; }
}

const year = $("#year");
if (year) year.textContent = new Date().getFullYear();
updateLinks();

// ---------- Verificación de edad: una sola vez por visita ----------
document.body.style.overflow = document.documentElement.classList.contains("need-age") ? "hidden" : "";
if ($("#age-yes")) $("#age-yes").addEventListener("click", () => {
  try { sessionStorage.setItem("urs-18", "1"); } catch (e) {}
  document.documentElement.classList.remove("need-age");
  document.body.style.overflow = "";
});

// ---------- Personalización (textos y colores que cambia el admin) ----------
const darken = (hex) => {
  const n = parseInt(hex.slice(1), 16), mix = (c) => Math.round(c * 0.8);
  return "#" + [mix(n >> 16), mix((n >> 8) & 255), mix(n & 255)].map((v) => v.toString(16).padStart(2, "0")).join("");
};

function applySettings(s) {
  document.querySelectorAll("[data-s]").forEach((el) => { if (s[el.dataset.s]) el.textContent = s[el.dataset.s]; });
  const root = document.documentElement.style;
  ["rose", "champagne", "plum"].forEach((c) => {
    const v = s["color_" + c];
    if (!/^#[0-9a-f]{6}$/i.test(v || "")) return;
    root.setProperty("--" + c, v);
    if (c === "rose") root.setProperty("--rose-2", darken(v));
  });
  if (/^[0-9]{10,15}$/.test(s.whatsapp || "")) whatsapp = s.whatsapp;
  updateLinks();
}

async function loadSettings() {
  const { data, error } = await api("public/settings");
  if (error || !data) return;
  applySettings(data);
}

// ---------- Productos y sabores ----------
let products = []; // cada producto trae product_variants (solo las activas)
const variantsOf = (p) => (p.product_variants || []).filter((v) => v.active);
const unitPrice = (p, v) => (v && v.price != null ? v.price : p.price);
const soldOut = (p) => { const o = variantsOf(p); return o.length ? o.every((v) => v.sold_out) : !!p.sold_out; };

// ---------- Mi pedido (carrito) ----------
const MAX_QTY = 20;
let cart = {};
try { cart = JSON.parse(localStorage.getItem("nt-cart") || "{}") || {}; } catch (e) { cart = {}; }
const saveCart = () => { try { localStorage.setItem("nt-cart", JSON.stringify(cart)); } catch (e) {} };
const keyOf = (pid, vid) => pid + ":" + (vid || 0);

// Existencias disponibles para una línea del carrito (null = sin control de inventario → sin límite salvo MAX_QTY).
function stockFor(pid, vid) {
  const p = products.find((x) => String(x.id) === String(pid));
  if (!p) return 0;
  if (vid && vid !== "0") {
    const v = (p.product_variants || []).find((x) => String(x.id) === String(vid));
    return v ? v.stock : 0;
  }
  return p.stock;
}
function maxQtyFor(key) {
  const [pid, vid] = key.split(":");
  const limit = stockFor(pid, vid === "0" ? null : vid);
  return limit == null ? MAX_QTY : Math.min(MAX_QTY, Math.max(0, limit));
}

function resolveLine(key) {
  const [pid, vid] = key.split(":");
  const p = products.find((x) => String(x.id) === pid);
  if (!p) return null;
  const options = variantsOf(p);
  const v = vid === "0" ? null : options.find((x) => String(x.id) === vid) || null;
  if (vid !== "0" && !v) return null;
  if (vid === "0" && options.length) return null;
  if (v ? v.sold_out : p.sold_out) return null;
  return { key, p, v, qty: cart[key], price: unitPrice(p, v) };
}
const lines = () => Object.keys(cart).map(resolveLine).filter(Boolean);
const countItems = () => lines().reduce((t, l) => t + l.qty, 0);

document.body.insertAdjacentHTML("beforeend", `
  <button id="cart-open" class="cart-fab" type="button" hidden>Mi pedido <span id="cart-count">0</span></button>
  <div id="cart-backdrop" class="backdrop" hidden></div>
  <aside id="cart" class="cart" aria-label="Mi pedido" hidden>
    <div class="cart-head">
      <h3>Mi pedido</h3>
      <button id="cart-close" class="icon-btn" type="button" aria-label="Cerrar">✕</button>
    </div>
    <div id="cart-form-view">
      <div id="cart-items" class="cart-items"></div>
      <form id="order-form" class="order-form">
        <div class="field">
          <label for="o-name">Tu nombre</label>
          <input id="o-name" type="text" autocomplete="name" minlength="2" maxlength="100" required>
        </div>
        <div class="field">
          <label for="o-phone">Teléfono</label>
          <input id="o-phone" type="tel" autocomplete="tel" minlength="7" maxlength="25" pattern="[+0-9 \\(\\)\\.\\-]{7,25}" required>
        </div>
        <div id="delivery-fields" class="delivery-fields">
          <div class="field">
            <label for="o-address">Dirección de entrega</label>
            <input id="o-address" type="text" autocomplete="street-address" minlength="5" maxlength="200" placeholder="Calle, carrera, número, apto o casa" required>
          </div>
          <div class="field">
            <label for="o-hood">Barrio o sector</label>
            <input id="o-hood" type="text" autocomplete="address-level3" minlength="2" maxlength="100" required>
          </div>
        </div>
        <div class="field">
          <label for="o-payment">Método de pago</label>
          <select id="o-payment" required>
            <option value="">Selecciona cómo vas a pagar</option>
            <option value="efectivo">Efectivo</option>
            <option value="nequi">Nequi</option>
          </select>
          <p class="pay-note">El pago se coordina por WhatsApp al confirmar el pedido.</p>
        </div>
        <div class="field">
          <label for="o-time">Día u hora preferida (opcional)</label>
          <input id="o-time" type="text" maxlength="100" placeholder="Ej. hoy después de las 5 pm">
        </div>
        <div class="field">
          <label for="o-notes">Notas (opcional)</label>
          <textarea id="o-notes" rows="2" maxlength="300" placeholder="Forma de entrega, indicaciones…"></textarea>
        </div>
        <p class="cart-total"><span>Total</span><strong id="cart-total">$ 0</strong></p>
        <button id="order-submit" class="btn solid full" type="submit">Enviar pedido</button>
        <p id="order-msg" class="form-msg" role="status" aria-live="polite"></p>
        <p class="cart-note">El pedido queda registrado y lo confirmamos por WhatsApp. Precio y disponibilidad se verifican al confirmar.</p>
      </form>
    </div>
    <div id="order-done" class="order-done" hidden>
      <p class="eyebrow">PEDIDO REGISTRADO</p>
      <h3 id="done-code"></h3>
      <p>Toca el botón para enviárnoslo por WhatsApp y confirmarlo.</p>
      <a id="done-wa" class="btn solid full" target="_blank" rel="noopener noreferrer" href="#">Enviar por WhatsApp ↗</a>
      <button id="done-close" class="btn full" type="button">Seguir comprando</button>
    </div>
  </aside>`);

function renderCart() {
  const ls = lines();
  $("#cart-count").textContent = countItems();
  $("#cart-open").hidden = !ls.length && $("#cart").hidden;
  $("#cart-total").textContent = money(ls.reduce((t, l) => t + l.price * l.qty, 0));
  $("#order-submit").disabled = !ls.length;
  $("#cart-items").innerHTML = ls.length ? ls.map(({ key, p, v, qty, price }) => {
    const atMax = qty >= maxQtyFor(key);
    return `
    <div class="cart-line">
      <div>
        <strong>${esc(p.name)}</strong>
        ${v ? `<small class="line-variant">${esc(v.name)}</small>` : ""}
        ${atMax ? `<small class="line-limit">No hay más existencias</small>` : ""}
      </div>
      <span class="line-price">${money(price * qty)}</span>
      <div class="qty">
        <button type="button" data-act="minus" data-key="${key}" aria-label="Quitar uno">−</button>
        <span>${qty}</span>
        <button type="button" data-act="plus" data-key="${key}" aria-label="Agregar uno"${atMax ? " disabled" : ""}>+</button>
        <button type="button" class="remove" data-act="remove" data-key="${key}">Quitar</button>
      </div>
    </div>`;
  }).join("") : `<p class="cart-empty">Tu pedido está vacío.</p>`;
}

function addToCart(pid, vid) {
  const k = keyOf(pid, vid);
  cart[k] = Math.min((cart[k] || 0) + 1, maxQtyFor(k));
  saveCart();
  renderCart();
}

function openCart(open) {
  $("#cart").hidden = !open;
  $("#cart-backdrop").hidden = !open;
  if (open) { $("#cart-form-view").hidden = false; $("#order-done").hidden = true; }
  renderCart();
}

$("#cart-items").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const k = btn.dataset.key;
  if (btn.dataset.act === "plus") cart[k] = Math.min((cart[k] || 0) + 1, maxQtyFor(k));
  if (btn.dataset.act === "minus") cart[k] = (cart[k] || 0) - 1;
  if (btn.dataset.act === "remove" || cart[k] <= 0) delete cart[k];
  saveCart();
  renderCart();
});

$("#cart-open").addEventListener("click", () => openCart(true));
$("#cart-close").addEventListener("click", () => openCart(false));
$("#cart-backdrop").addEventListener("click", () => openCart(false));
$("#done-close").addEventListener("click", () => openCart(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#cart").hidden) openCart(false); });

const ORDER_ERRORS = {
  data: "Revisa tu nombre y tu teléfono.",
  address: "Escribe tu dirección y tu barrio para el domicilio.",
  payment: "Elige un método de pago.",
  items: "Revisa los productos de tu pedido.",
  invalid: "Algún producto ya no está disponible. Actualiza la página e inténtalo de nuevo.",
  variant: "Algún sabor u opción ya no está disponible. Actualiza la página e inténtalo de nuevo.",
  limit: "Ya tienes varios pedidos pendientes. Espera a que los confirmemos o escríbenos por WhatsApp.",
  busy: "Estamos recibiendo muchos pedidos en este momento. Escríbenos por WhatsApp para atenderte.",
};

// ---------- Datos del cliente: se recuerdan en este dispositivo ----------
const CUST_KEY = "nt-cust";
const CUST_FIELDS = { name: "o-name", phone: "o-phone", address: "o-address", hood: "o-hood", payment: "o-payment" };

function loadCustomer() {
  try {
    const c = JSON.parse(localStorage.getItem(CUST_KEY) || "{}") || {};
    for (const [k, id] of Object.entries(CUST_FIELDS)) if (typeof c[k] === "string" && c[k]) $("#" + id).value = c[k];
  } catch (e) {}
}
function saveCustomer() {
  try {
    const c = {};
    for (const [k, id] of Object.entries(CUST_FIELDS)) c[k] = $("#" + id).value.trim();
    localStorage.setItem(CUST_KEY, JSON.stringify(c));
  } catch (e) {}
}
loadCustomer();

$("#order-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ls = lines(), msg = $("#order-msg"), btn = $("#order-submit");
  if (!ls.length) return;
  btn.disabled = true;
  msg.dataset.state = "info";
  msg.textContent = "Enviando pedido...";
  const name = $("#o-name").value.trim(), notes = $("#o-notes").value.trim();
  const payment = $("#o-payment").value;
  const address = $("#o-address").value.trim(), hood = $("#o-hood").value.trim();
  const when = $("#o-time").value.trim();
  const { data, error } = await api("orders", {
    method: "POST",
    body: JSON.stringify({
      name, phone: $("#o-phone").value, notes,
      items: ls.map((l) => ({ id: l.p.id, variant_id: l.v ? l.v.id : null, qty: l.qty })),
      address, neighborhood: hood, payment, time: when || null, instore: false,
    }),
  });
  if (error) {
    msg.dataset.state = "error";
    msg.textContent = ORDER_ERRORS[(error.message || "").trim()] || "No se pudo enviar el pedido. Intenta de nuevo.";
    btn.disabled = false;
    return;
  }
  const text = [
    `Hola, acabo de hacer el pedido ${data.code} en ${BUSINESS}:`,
    ...ls.map((l) => `- ${l.qty} x ${l.p.name}${l.v ? " – " + l.v.name : ""} (${money(l.price * l.qty)})`),
    `Total: ${money(data.total)}`,
    `Nombre: ${name}`,
    `Domicilio: ${address}, ${hood}`,
    `Pago: ${PAY_LABELS[payment] || payment}`,
    when ? `Hora preferida: ${when}` : "",
    notes ? `Notas: ${notes}` : "",
  ].filter(Boolean).join("\n");
  cart = {};
  saveCart();
  saveCustomer();
  $("#order-form").reset();
  loadCustomer();
  msg.textContent = "";
  $("#done-code").textContent = data.code;
  $("#done-wa").href = waLink(text);
  $("#cart-form-view").hidden = true;
  $("#order-done").hidden = false;
  renderCart();
});

// ---------- Visor de foto: tocar una foto de producto la muestra en grande ----------
document.body.insertAdjacentHTML("beforeend", `
  <div id="lightbox" class="lightbox" hidden>
    <button id="lightbox-close" class="icon-btn lightbox-close" type="button" aria-label="Cerrar foto">✕</button>
    <img id="lightbox-img" src="" alt="">
  </div>`);

function openLightbox(src, alt) {
  if (!src) return;
  $("#lightbox-img").src = src;
  $("#lightbox-img").alt = alt || "";
  $("#lightbox").hidden = false;
}
function closeLightbox() {
  $("#lightbox").hidden = true;
  $("#lightbox-img").src = "";
}
$("#lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
$("#lightbox-close").addEventListener("click", closeLightbox);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#lightbox").hidden) closeLightbox(); });

// ---------- Inicio: cada página llama a startShop() cuando está lista ----------
async function startShop() {
  renderCart();
  loadSettings();
  const [, { data, error }] = await Promise.all([loadCategories(), api("public/products")]);
  if (error || !data) return false;
  products = data;
  products.forEach((p) => p.product_variants.sort((a, b) => a.id - b.id));
  Object.keys(cart).forEach((k) => {
    if (!resolveLine(k)) { delete cart[k]; return; }
    cart[k] = Math.min(cart[k], maxQtyFor(k));
    if (cart[k] <= 0) delete cart[k];
  });
  saveCart();
  renderCart();
  return true;
}