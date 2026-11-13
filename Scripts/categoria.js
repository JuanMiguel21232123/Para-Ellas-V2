// Página de una colección: categoria.html?c=maquillaje | joyas | ropa
const CAT = new URLSearchParams(location.search).get("c");
let INFO = null; // se llena cuando startShop() trae las categorías

function setupHeader() {
  document.body.dataset.accent = INFO.accent;
  document.title = `${INFO.title} | ${BUSINESS}`;
  $("#cat-eyebrow").textContent = `${INFO.num} · COLECCIÓN`;
  $("#cat-title").textContent = INFO.title;
  $("#cat-text").textContent = INFO.text;
  $("#cat-switch").innerHTML = Object.entries(CATEGORIES).map(([key, c]) =>
    `<a class="tab" href="categoria.html?c=${encodeURIComponent(key)}" aria-current="${key === CAT}">${esc(c.title)}</a>`).join("");
}

const variantLabel = (p) => p.variant_label || INFO.variant;
const optionsWord = (p, n) => variantLabel(p) === "Tono" ? (n === 1 ? "tono" : "tonos") : (n === 1 ? "opción" : "opciones");
const stockWord = (n) => n === 1 ? "Queda 1" : `Quedan ${n}`;

function priceLabel(p, vid) {
  const opts = variantsOf(p);
  if (!opts.length) return money(p.price);
  const chosen = opts.find((o) => String(o.id) === String(vid));
  if (chosen) return money(unitPrice(p, chosen));
  const prices = opts.map((o) => unitPrice(p, o));
  const min = Math.min(...prices);
  return min === Math.max(...prices) ? money(min) : "Desde " + money(min);
}

function card(p) {
  const opts = variantsOf(p);
  const out = soldOut(p);
  const hasPhoto = /^https?:\/\//.test(p.image_url || "");
  const img = hasPhoto
    ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" width="480" height="600" loading="lazy" decoding="async" onload="fitPhoto(this)">` : INITIALS;
  const select = opts.length ? `
    <p class="meta">${opts.length} ${optionsWord(p, opts.length)}</p>
    <div class="variant-field">
      <label for="v-${p.id}">${esc(variantLabel(p))}</label>
      <select id="v-${p.id}" class="variant">
        <option value="">Selecciona ${esc(variantLabel(p).toLowerCase())}</option>
        ${opts.map((o) => `<option value="${o.id}"${o.sold_out ? " disabled" : ""}>${esc(o.name)}${o.price != null && o.price !== p.price ? " · " + money(o.price) : ""}${o.sold_out ? " · Agotado" : (o.stock != null ? " · " + stockWord(o.stock) : "")}</option>`).join("")}
      </select>
    </div>` : (!out && p.stock != null && p.stock > 0 ? `<p class="meta">${stockWord(p.stock)}</p>` : "");
  return `
    <article class="card${out ? " soldout" : ""}" data-id="${p.id}">
      <div class="img${hasPhoto ? " zoomable" : ""}"${hasPhoto ? ` tabindex="0" role="button" aria-label="Ver foto de ${esc(p.name)} en grande"` : ""}>${img}</div>
      <div class="body">
        <h4>${esc(p.name)}</h4>
        <p class="desc">${esc(p.description)}</p>
        ${select}
        <span class="price">${priceLabel(p, null)}</span>
        ${out ? `<button class="add" type="button" disabled>Agotado</button>` : `<button class="add" type="button">Agregar al pedido</button>`}
      </div>
    </article>`;
}

let loaded = false;

// ---------- Subsecciones (las crea el admin; categoria.html?c=joyas&s=ID abre una directo) ----------
let subs = [];
let activeSub = new URLSearchParams(location.search).get("s") || "all";

async function loadSubs() {
  const { data } = await api("public/subs?c=" + encodeURIComponent(CAT));
  subs = data || [];
}

const visibleSubs = () => {
  const inCat = products.filter((p) => p.category === CAT);
  return subs.filter((s) => inCat.some((p) => String(p.subcategory_id) === String(s.id)));
};

function renderSubs() {
  const vis = visibleSubs(), box = $("#sub-switch");
  if (activeSub !== "all" && !vis.some((s) => String(s.id) === activeSub)) activeSub = "all";
  box.hidden = !vis.length;
  box.innerHTML = vis.length
    ? [["all", "Todo"], ...vis.map((s) => [String(s.id), s.name])].map(([id, label]) =>
        `<button class="sub-chip" type="button" data-sub="${id}" aria-pressed="${id === activeSub}">${esc(label)}</button>`).join("")
    : "";
}

function render() {
  const q = $("#search").value.trim().toLowerCase();
  const inCat = products.filter((p) => p.category === CAT);
  const list = inCat.filter((p) => (activeSub === "all" || String(p.subcategory_id) === activeSub) && (!q ||
    [p.name, p.description, ...variantsOf(p).map((v) => v.name)].join(" ").toLowerCase().includes(q)));
  if (!list.length) {
    $("#products").innerHTML = `<p class="empty">${inCat.length ? "No encontramos nada con esa búsqueda." : "Estamos preparando esta colección. Muy pronto verás aquí nuestros productos."}</p>`;
    return;
  }
  const vis = visibleSubs();
  if (activeSub !== "all" || !vis.length) { $("#products").innerHTML = list.map(card).join(""); return; }
  const groups = vis.map((s) => [s.name, list.filter((p) => String(p.subcategory_id) === String(s.id))]);
  groups.push(["Más productos", list.filter((p) => !vis.some((s) => String(s.id) === String(p.subcategory_id)))]);
  $("#products").innerHTML = groups.filter(([, ps]) => ps.length)
    .map(([title, ps]) => `<h3 class="group-title">${esc(title)}</h3>${ps.map(card).join("")}`).join("");
}

$("#sub-switch").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sub]");
  if (!b) return;
  activeSub = b.dataset.sub;
  const url = new URL(location.href);
  if (activeSub === "all") url.searchParams.delete("s"); else url.searchParams.set("s", activeSub);
  history.replaceState(null, "", url);
  renderSubs();
  render();
});

$("#search").addEventListener("input", () => { if (loaded) render(); });

$("#products").addEventListener("change", (e) => {
  const sel = e.target.closest("select.variant");
  if (!sel) return;
  sel.classList.remove("invalid");
  const c = sel.closest(".card"), p = products.find((x) => String(x.id) === c.dataset.id);
  c.querySelector(".price").textContent = priceLabel(p, sel.value);
});

$("#products").addEventListener("click", (e) => {
  const box = e.target.closest(".img.zoomable");
  if (box) { const img = box.querySelector("img"); if (img) openLightbox(img.src, img.alt); return; }
  const btn = e.target.closest("button.add");
  if (!btn) return;
  const c = btn.closest(".card"), p = products.find((x) => String(x.id) === c.dataset.id);
  if (!p || soldOut(p)) return;
  const sel = c.querySelector("select.variant");
  if (sel && !sel.value) { sel.classList.add("invalid"); sel.focus(); return; }
  const key = keyOf(p.id, sel ? sel.value : null);
  if ((cart[key] || 0) >= maxQtyFor(key)) {
    btn.textContent = "No hay más existencias";
  } else {
    addToCart(p.id, sel ? sel.value : null);
    btn.textContent = "Agregado ✓";
  }
  setTimeout(() => (btn.textContent = "Agregar al pedido"), 1200);
});

$("#products").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const box = e.target.closest(".img.zoomable");
  if (!box) return;
  e.preventDefault();
  const img = box.querySelector("img");
  if (img) openLightbox(img.src, img.alt);
});

startShop().then(async (ok) => {
  INFO = CATEGORIES[CAT];
  if (!INFO) { location.replace("index.html#colecciones"); return; }
  setupHeader();
  if (!ok) {
    $("#products").innerHTML = `<p class="empty">No se pudo cargar el catálogo. Intenta más tarde.</p>`;
    return;
  }
  await loadSubs();
  loaded = true;
  renderSubs();
  render();
});