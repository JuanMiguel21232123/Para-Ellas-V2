// La portada necesita lo común (personalización, edad, "Mi pedido") y pintar las colecciones (ver shop.js)
function renderBlocks() {
  const list = Object.entries(CATEGORIES);
  $("#blocks").innerHTML = list.length
    ? list.map(([slug, c]) => `
      <a class="block b-${esc(c.accent)}" href="categoria.html?c=${encodeURIComponent(slug)}">
        <span class="num">${esc(c.num)}</span>
        <h3>${esc(c.title)}</h3>
        <p>${esc(c.text)}</p>
        <span class="more">Explorar →</span>
      </a>`).join("")
    : `<p class="empty">Muy pronto verás aquí nuestras colecciones.</p>`;
}

startShop().then(renderBlocks);
