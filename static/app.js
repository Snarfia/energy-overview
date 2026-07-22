const urlParams = new URLSearchParams(window.location.search);
const BUILD_TAG = "2026-07-22-08";
const isLandscapeMode = urlParams.get("landscape") === "1";
const isWidgetMode = urlParams.get("widget") === "1";
const initialPageParamRaw = urlParams.get("page");
const pathLower = window.location.pathname.toLowerCase();

function normalizePage(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "gas" || v === "aardgas") return "gas";
  if (v === "electricity" || v === "elektriciteit" || v === "power") return "electricity";
  return null;
}
const initialPageParam = normalizePage(initialPageParamRaw);

if (isLandscapeMode) document.documentElement.classList.add("mode-landscape");
if (isWidgetMode) document.documentElement.classList.add("mode-widget");
document.documentElement.setAttribute("data-build", BUILD_TAG);
document.title = `Energy Dashboard (${BUILD_TAG})`;

const electricityDemandCardsEl = document.getElementById("electricityDemandCards");
const electricityWholesaleCardsEl = document.getElementById("electricityWholesaleCards");
const electricityRetailCardsEl = document.getElementById("electricityRetailCards");
const gasDemandCardsEl = document.getElementById("gasDemandCards");
const gasWholesaleCardsEl = document.getElementById("gasWholesaleCards");
const gasRetailCardsEl = document.getElementById("gasRetailCards");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refreshBtn");
const cardTemplate = document.getElementById("cardTemplate");
const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const pagePanels = {
  electricity: document.getElementById("page-electricity"),
  gas: document.getElementById("page-gas"),
};

const ELECTRICITY_DEMAND_IDS = new Set(["nlCrossBorderFlows", "dayAheadPower24h"]);
const ELECTRICITY_WHOLESALE_IDS = new Set(["ets", "gaslichtElectricity"]);
const ELECTRICITY_RETAIL_IDS = new Set([]);

const GAS_DEMAND_IDS = new Set(["nlGasImport"]);
const GAS_WHOLESALE_IDS = new Set(["ttfGas", "ets", "gaslichtGas"]);
const GAS_RETAIL_IDS = new Set([]);

const CARD_EXPLANATIONS = {
  nlCrossBorderFlows: "Fysieke uitwisseling via Nederlandse stroomverbindingen. Positief is netto import; negatief is netto export.",
  dayAheadPower24h: "Alle leveringsuren van vandaag. Deze prijzen zijn gisteren in de day-aheadveiling vastgesteld; exclusief belasting en netkosten.",
  nlGenerationMixShare: "Aandeel van de actuele Nederlandse productie per bron. De percentages tellen op tot 100% van de getoonde productiecategorieën.",
  nlElectricityOverview: "Het actuele totale elektriciteitsverbruik dat door ENTSO-E voor Nederland wordt gemeten.",
  nlGridFrequency: "De netfrequentie hoort rond 50 Hz te blijven; kleine afwijkingen tonen de directe balans tussen productie en verbruik.",
  tennetRegulation: "Onbalanssignaal van TenneT. Het toont hoeveel regelvermogen op dit moment wordt ingezet.",
  ets: "Prijs van een Europees emissierecht voor één ton CO₂; dit is een termijnmarktprijs.",
  gaslichtElectricity: "Consumentenreferentie inclusief belastingen; niet rechtstreeks vergelijkbaar met de EPEX-groothandelsprijs.",
  nlGasImport: "Alle getoonde aanvoer minus opslagvulling en binnenlands verbruik. De kleine restbalans hoort rond nul te liggen.",
  nlGasConsumptionBreakdown: "Geschat Nederlands dagverbruik uit distributie, industrie en gascentrales op dezelfde volledige gasdag.",
  nlGasStorage: "Vullingsgraad van de Nederlandse gasopslagen. De stroom naar of uit opslag staat apart op de stromenkaart.",
  nlGasProduction: "Binnenlandse gasproductie op exact dezelfde volledige gasdag als de balanskaart, inclusief groen gas waar beschikbaar.",
  ttfGas: "Europese groothandelsreferentie voor aardgas in EUR/MWh; exclusief belasting, transport en leveranciersmarge.",
  gaslichtGas: "Consumentenreferentie per m³ inclusief belastingen; niet rechtstreeks vergelijkbaar met TTF in EUR/MWh.",
};

let activePage = "electricity";

function setActivePage(page, syncUrl = true) {
  activePage = page;
  for (const b of tabButtons) b.classList.toggle("active", b.dataset.page === page);
  for (const [name, panel] of Object.entries(pagePanels)) panel.classList.toggle("active", name === page);
  if (syncUrl) {
    const next = new URL(window.location.href);
    next.pathname = "/";
    next.searchParams.set("page", page === "gas" ? "gas" : "electricity");
    window.history.replaceState({}, "", `${next.pathname}${next.search}`);
  }
}

for (const b of tabButtons) {
  b.addEventListener("click", (event) => {
    event.preventDefault();
    setActivePage(b.dataset.page, true);
  });
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "n/a";
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatNumberFixed2(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "n/a";
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTime(value) {
  if (!value) return "Update time unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
}

function extractHourLabel(rowHour) {
  if (!rowHour) return "";
  const m = String(rowHour).match(/(\d{2}:\d{2})/);
  return m ? m[1] : String(rowHour);
}

function orderDayAheadRowsForDisplay(rows) {
  if ((rows || []).some((row) => row?.timestamp)) {
    return [...rows].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
  const byHour = new Map();
  for (const row of rows || []) {
    const h = extractHourLabel(row?.hour);
    if (h) byHour.set(h, row);
  }
  const orderedHours = [];
  for (let h = 5; h <= 23; h += 1) orderedHours.push(`${String(h).padStart(2, "0")}:00`);
  for (let h = 0; h <= 4; h += 1) orderedHours.push(`${String(h).padStart(2, "0")}:00`);
  return orderedHours.map((h) => byHour.get(h) || { hour: h, value: null, unit: "EUR/MWh" });
}

function createDayAheadChart(rows) {
  const valid = rows.map((r, i) => ({ i, value: Number(r.value) })).filter((p) => Number.isFinite(p.value));
  if (valid.length < 2) return null;

  const width = 1500;
  const height = 180;
  const m = { top: 14, right: 14, bottom: 36, left: 52 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  const rawMin = Math.min(0, ...valid.map((point) => point.value));
  const rawMax = Math.max(0, ...valid.map((point) => point.value));
  const span = Math.max(20, rawMax - rawMin);
  const yMin = Math.floor((rawMin - span * 0.12) / 10) * 10;
  const yMax = Math.ceil((rawMax + span * 0.12) / 10) * 10;

  const xOf = (idx) => m.left + (idx / Math.max(1, rows.length - 1)) * innerW;
  const yOf = (v) => m.top + ((yMax - v) / (yMax - yMin)) * innerH;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "dayahead-chart");

  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", String(m.left));
  bg.setAttribute("y", String(m.top));
  bg.setAttribute("width", String(innerW));
  bg.setAttribute("height", String(innerH));
  bg.setAttribute("class", "dayahead-plot-bg");
  svg.appendChild(bg);

  for (let t = 0; t <= 4; t += 1) {
    const v = yMin + ((yMax - yMin) * t) / 4;
    const y = yOf(v);
    const grid = document.createElementNS("http://www.w3.org/2000/svg", "line");
    grid.setAttribute("x1", String(m.left));
    grid.setAttribute("x2", String(m.left + innerW));
    grid.setAttribute("y1", String(y));
    grid.setAttribute("y2", String(y));
    grid.setAttribute("class", "dayahead-grid");
    svg.appendChild(grid);

    const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    lbl.setAttribute("x", String(m.left - 8));
    lbl.setAttribute("y", String(y + 4));
    lbl.setAttribute("text-anchor", "end");
    lbl.setAttribute("class", "dayahead-axis-label");
    lbl.textContent = Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
    svg.appendChild(lbl);
  }

  const xTicks = [...new Set(Array.from({ length: Math.min(7, rows.length) }, (_, i) => Math.round((i * (rows.length - 1)) / Math.max(1, Math.min(6, rows.length - 1)))) )];
  for (const idx of xTicks) {
    if (idx < 0 || idx >= rows.length) continue;
    const x = xOf(idx);
    const tick = document.createElementNS("http://www.w3.org/2000/svg", "line");
    tick.setAttribute("x1", String(x));
    tick.setAttribute("x2", String(x));
    tick.setAttribute("y1", String(m.top + innerH));
    tick.setAttribute("y2", String(m.top + innerH + 5));
    tick.setAttribute("class", "dayahead-axis");
    svg.appendChild(tick);

    const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    lbl.setAttribute("x", String(x));
    lbl.setAttribute("y", String(m.top + innerH + 18));
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute("class", "dayahead-axis-label");
    lbl.textContent = extractHourLabel(rows[idx]?.hour);
    svg.appendChild(lbl);
  }

  const nowHour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Amsterdam" }).format(new Date())
  );
  const nowLabel = `${String(nowHour).padStart(2, "0")}:00`;
  const now = new Date();
  const nowIdxByTimestamp = rows.findIndex((row) => {
    if (!row?.timestamp) return false;
    const timestamp = new Date(row.timestamp);
    return timestamp <= now && now < new Date(timestamp.getTime() + 3_600_000);
  });
  const nowIdx = nowIdxByTimestamp >= 0 ? nowIdxByTimestamp : rows.findIndex((r) => extractHourLabel(r.hour) === nowLabel);
  if (nowIdx >= 0) {
    const xNow = xOf(nowIdx);
    const nowLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    nowLine.setAttribute("x1", String(xNow));
    nowLine.setAttribute("x2", String(xNow));
    nowLine.setAttribute("y1", String(m.top));
    nowLine.setAttribute("y2", String(m.top + innerH));
    nowLine.setAttribute("class", "dayahead-now-line");
    svg.appendChild(nowLine);

    const nowText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    nowText.setAttribute("x", String(xNow + 4));
    nowText.setAttribute("y", String(m.top + 12));
    nowText.setAttribute("class", "dayahead-now-label");
    nowText.textContent = "Nu";
    svg.appendChild(nowText);
  }

  const points = valid.map((p) => `${xOf(p.i)},${yOf(p.value)}`).join(" ");
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", points);
  poly.setAttribute("class", "dayahead-line");
  svg.appendChild(poly);

  return svg;
}

function createElectricityCountryMap(rows, quality = {}) {
  const width = 1080;
  const height = 620;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "flow-map gas-network-map electricity-country-map");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Geografische kaart van fysieke Nederlandse elektriciteitsstromen en de actuele netstatus");

  const rowByName = new Map((rows || []).map((row) => [String(row.hour || ""), row]));
  const maxAbs = Math.max(1, ...(rows || []).map((row) => Math.abs(Number(row.value))).filter(Number.isFinite));
  const mapFrame = { x: 20, y: 44, width: 768, height: 550, originTileX: 7, originTileY: 4, zoom: 4 };
  const worldSize = 256 * (2 ** mapFrame.zoom);
  const mercator = (lon, lat) => {
    const safeLat = Math.max(-85, Math.min(85, lat));
    const x = ((lon + 180) / 360) * worldSize;
    const sinLat = Math.sin((safeLat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;
    return { x, y };
  };
  const project = (lon, lat) => {
    const point = mercator(lon, lat);
    return {
      x: mapFrame.x + point.x - mapFrame.originTileX * 256,
      y: mapFrame.y + point.y - mapFrame.originTileY * 256,
    };
  };
  const NL = project(5.3, 52.2);
  const countryAt = (key, code, name, lon, lat, labelDx, labelDy) => {
    const point = project(lon, lat);
    return { key, code, name, ...point, labelX: point.x + labelDx, labelY: point.y + labelDy };
  };
  const countries = [
    countryAt("Verenigd Koninkrijk", "GB", "Verenigd Koninkrijk", -2.0, 54.0, -72, -12),
    countryAt("Belgie", "BE", "België", 4.5, 50.8, -82, 56),
    countryAt("Duitsland", "DE", "Duitsland", 10.0, 51.2, 80, 24),
    countryAt("Denemarken", "DK", "Denemarken", 9.5, 56.0, 88, -6),
    countryAt("Noorwegen", "NO", "Noorwegen", 7.5, 60.5, 70, -25),
  ];
  const add = (tag, attrs = {}, content = "") => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (content) element.textContent = content;
    svg.appendChild(element);
    return element;
  };

  for (let tileY = mapFrame.originTileY; tileY <= mapFrame.originTileY + 2; tileY += 1) {
    for (let tileX = mapFrame.originTileX; tileX <= mapFrame.originTileX + 2; tileX += 1) {
      add("image", {
        x: mapFrame.x + (tileX - mapFrame.originTileX) * 256,
        y: mapFrame.y + (tileY - mapFrame.originTileY) * 256,
        width: 256,
        height: 256,
        href: `https://tile.openstreetmap.org/${mapFrame.zoom}/${tileX}/${tileY}.png`,
        class: "gas-map-background",
      });
    }
  }
  add("rect", { x: mapFrame.x, y: mapFrame.y, width: mapFrame.width, height: mapFrame.height, rx: 18, class: "gas-map-background-wash" });
  add("text", { x: 26, y: 30, class: "gas-map-kicker" }, "FYSIEKE ELEKTRICITEITSSTROMEN · ACTUEEL");
  add("circle", { cx: 565, cy: 25, r: 5, class: "gas-legend-import" });
  add("text", { x: 577, y: 30, class: "gas-map-legend" }, "import naar NL");
  add("circle", { cx: 684, cy: 25, r: 5, class: "gas-legend-export" });
  add("text", { x: 696, y: 30, class: "gas-map-legend" }, "export uit NL");

  for (const country of countries) {
    const row = rowByName.get(country.key);
    const value = Number(row?.value);
    if (row?.value === null || row?.value === undefined || !Number.isFinite(value)) continue;
    const isImport = value >= 0;
    const start = isImport ? country : NL;
    const end = isImport ? NL : country;
    const widthPx = Math.max(2.5, Math.min(12, 2.5 + (Math.abs(value) / maxAbs) * 9.5));
    add("path", {
      d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
      class: `gas-flow-connector ${isImport ? "is-import" : "is-export"}`,
      "stroke-width": widthPx,
    });
  }

  for (const country of countries) {
    const row = rowByName.get(country.key);
    const value = Number(row?.value);
    const finite = row?.value !== null && row?.value !== undefined && Number.isFinite(value);
    const isExport = finite && value < 0;
    const magnitudeText = finite && Math.abs(value) < 50 ? "<0.1 GW" : `${(Math.abs(value) / 1000).toFixed(1)} GW`;
    const flowText = finite ? `${magnitudeText} · ${isExport ? "export" : "import"}` : "geen actuele meting";
    add("rect", { x: country.labelX - 73, y: country.labelY - 31, width: 146, height: 70, rx: 14, class: "gas-country-chip" });
    add("text", { x: country.labelX, y: country.labelY - 9, "text-anchor": "middle", class: "gas-country-code" }, country.code);
    add("text", { x: country.labelX, y: country.labelY + 7, "text-anchor": "middle", class: "gas-country-name" }, country.name);
    add("text", { x: country.labelX, y: country.labelY + 28, "text-anchor": "middle", class: `gas-country-flow${isExport ? " is-export" : ""}` }, flowText);
  }

  add("circle", { cx: NL.x, cy: NL.y, r: 31, class: "gas-map-hub-ring" });
  add("circle", { cx: NL.x, cy: NL.y, r: 23, class: "gas-map-hub" });
  add("text", { x: NL.x, y: NL.y + 5, "text-anchor": "middle", class: "gas-map-hub-title" }, "NL");
  add("text", { x: NL.x, y: NL.y + 48, "text-anchor": "middle", class: "gas-map-nl-label" }, "Nederlands elektriciteitsnet");

  const loadMw = Number(quality?.loadMw);
  const borderNetMw = Number(quality?.borderNetMw);
  const frequencyHz = Number(quality?.frequencyHz);
  const regulationMw = Number(quality?.regulationMw);
  const borderIsImport = Number.isFinite(borderNetMw) && borderNetMw >= 0;
  const regulationIsUp = Number.isFinite(regulationMw) && regulationMw >= 0;
  const deviationMhz = Number.isFinite(frequencyHz) ? Math.round((frequencyHz - 50) * 1000) : null;
  const frequencyOkay = Number.isFinite(deviationMhz) && Math.abs(deviationMhz) <= 100;
  const signedMhz = deviationMhz === null ? "n/a" : `${deviationMhz > 0 ? "+" : ""}${deviationMhz} mHz`;

  add("rect", { x: 825, y: 54, width: 230, height: 500, rx: 22, class: "gas-balance-panel" });
  add("text", { x: 850, y: 87, class: "gas-balance-kicker" }, "NETSTATUS");
  add("text", { x: 850, y: 116, class: "gas-balance-heading" }, "Nederland");

  const metric = (label, primary, secondary, y, tone = "is-import") => {
    add("text", { x: 850, y, class: "electricity-status-label" }, label);
    add("text", { x: 1030, y: y + 25, "text-anchor": "end", class: `electricity-status-value ${tone}` }, primary);
    add("text", { x: 1030, y: y + 43, "text-anchor": "end", class: "electricity-status-detail" }, secondary);
  };
  metric("Systeembelasting", Number.isFinite(loadMw) ? `${(loadMw / 1000).toFixed(1)} GW` : "n/a", "actueel verbruik", 151);
  metric("Grenssaldo", Number.isFinite(borderNetMw) ? `${(Math.abs(borderNetMw) / 1000).toFixed(1)} GW` : "n/a", borderIsImport ? "netto import" : "netto export", 222, borderIsImport ? "is-import" : "is-export");
  metric("Netfrequentie", Number.isFinite(frequencyHz) ? `${frequencyHz.toFixed(3)} Hz` : "n/a", signedMhz, 293, frequencyOkay ? "is-import" : "is-export");
  metric("Regelvermogen", Number.isFinite(regulationMw) ? `${Math.abs(regulationMw).toFixed(0)} MW` : "n/a", regulationIsUp ? "opregelen" : "afregelen", 364, regulationIsUp ? "is-import" : "is-export");
  add("rect", { x: 850, y: 458, width: 180, height: 42, rx: 11, class: frequencyOkay ? "gas-balance-ok" : "gas-balance-warning" });
  add("text", { x: 940, y: 484, "text-anchor": "middle", class: "gas-balance-status" }, frequencyOkay ? "frequentie normaal" : "frequentie controleren");
  add("text", { x: 26, y: 611, class: "gas-map-footnote" }, "Lijndikte = omvang; kleur = richting. Meetmomenten kunnen per verbinding verschillen.");
  add("text", { x: 790, y: 611, "text-anchor": "end", class: "gas-map-attribution" }, "Kaart © OpenStreetMap-bijdragers");
  return svg;
}

function createCrossBorderFlowMap(rows, unitLabel = "MW", mode = "electricity", context = {}) {
  if (mode === "gas") return createGasCountryBalanceMap(rows, context);
  if (mode === "electricity") return createElectricityCountryMap(rows, context);

  const width = 980;
  const height = 420;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "flow-map");

  const isGas = mode === "gas";
  const NL = isGas ? { x: 500, y: 220, label: "NL" } : { x: 505, y: 220, label: "NL" };
  const anchors = isGas
    ? {
        "Verenigd Koninkrijk": { x: 180, y: 220, label: "GB" },
        Belgie: { x: 320, y: 335, label: "BE" },
        Duitsland: { x: 820, y: 220, label: "DE" },
        Denemarken: { x: 770, y: 88, label: "DK" },
        Noorwegen: { x: 620, y: 40, label: "NO" },
        "LNG (Gate+EET)": { x: 420, y: 100, label: "LNG" },
        "Gasopslag (4 sites)": { x: 500, y: 340, label: "OPS" },
        "Nationale productie": { x: 620, y: 320, label: "PROD" },
      }
    : {
        "Verenigd Koninkrijk": { x: 260, y: 220, label: "GB" },
        Belgie: { x: 430, y: 270, label: "BE" },
        Duitsland: { x: 670, y: 220, label: "DE" },
        Denemarken: { x: 625, y: 130, label: "DK" },
        Noorwegen: { x: 535, y: 70, label: "NO" },
      };

  if (isGas) {
    const rowByName = new Map((rows || []).map((r) => [String(r.hour || ""), r]));
    const maxAbs = Math.max(
      1,
      ...(rows || [])
        .map((r) => Number(r.value))
        .filter((v) => Number.isFinite(v))
        .map((v) => Math.abs(v))
    );
    const ribbonPath = (x1, y1, x2, y2, w) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.max(1, Math.hypot(dx, dy));
      const nx = -dy / len;
      const ny = dx / len;
      const hw = w / 2;
      const c = 0.34;
      const c1x = x1 + dx * c;
      const c1y = y1 + dy * c;
      const c2x = x2 - dx * c;
      const c2y = y2 - dy * c;
      const p1x = x1 + nx * hw;
      const p1y = y1 + ny * hw;
      const p2x = x2 + nx * hw;
      const p2y = y2 + ny * hw;
      const p3x = x2 - nx * hw;
      const p3y = y2 - ny * hw;
      const p4x = x1 - nx * hw;
      const p4y = y1 - ny * hw;
      return `M ${p1x} ${p1y} C ${c1x + nx * hw} ${c1y + ny * hw}, ${c2x + nx * hw} ${c2y + ny * hw}, ${p2x} ${p2y} L ${p3x} ${p3y} C ${c2x - nx * hw} ${c2y - ny * hw}, ${c1x - nx * hw} ${c1y - ny * hw}, ${p4x} ${p4y} Z`;
    };

    const nlNode = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    nlNode.setAttribute("cx", String(NL.x));
    nlNode.setAttribute("cy", String(NL.y));
    nlNode.setAttribute("r", "18");
    nlNode.setAttribute("class", "flow-map-node-nl");
    svg.appendChild(nlNode);
    const nlText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    nlText.setAttribute("x", String(NL.x));
    nlText.setAttribute("y", String(NL.y + 4));
    nlText.setAttribute("text-anchor", "middle");
    nlText.setAttribute("class", "flow-map-label-nl");
    nlText.textContent = "NL";
    svg.appendChild(nlText);

    for (const [name, anchor] of Object.entries(anchors)) {
      const row = rowByName.get(name);
      const value = Number(row?.value);
      const finite = Number.isFinite(value);
      if (finite) {
        const bandWidth = Math.max(4, Math.min(22, (Math.abs(value) / maxAbs) * 22));
        const band = document.createElementNS("http://www.w3.org/2000/svg", "path");
        band.setAttribute("d", ribbonPath(anchor.x, anchor.y, NL.x, NL.y, bandWidth));
        band.setAttribute("class", `flow-sankey-band ${value < 0 ? "flow-sankey-band-export" : "flow-sankey-band-import"}`);
        svg.appendChild(band);

        const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
        lbl.setAttribute("x", String((anchor.x + NL.x) / 2));
        lbl.setAttribute("y", String((anchor.y + NL.y) / 2 - 4));
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("class", `flow-map-value ${value < 0 ? "flow-map-value-export" : "flow-map-value-import"}`);
        lbl.textContent = `${Math.round(value)}`;
        svg.appendChild(lbl);
      }

      const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      node.setAttribute("cx", String(anchor.x));
      node.setAttribute("cy", String(anchor.y));
      node.setAttribute("r", "11");
      const rowName = String(name || "").toLowerCase();
      const isLng = rowName.startsWith("lng");
      const isStorage = rowName.startsWith("gasopslag");
      node.setAttribute("class", isLng ? "flow-map-node flow-map-node-lng" : "flow-map-node");
      if (isStorage) node.setAttribute("class", "flow-map-node flow-map-node-storage");
      svg.appendChild(node);

      const code = document.createElementNS("http://www.w3.org/2000/svg", "text");
      code.setAttribute("x", String(anchor.x));
      code.setAttribute("y", String(anchor.y - 16));
      code.setAttribute("text-anchor", "middle");
      code.setAttribute("class", "flow-map-label");
      code.textContent = anchor.label;
      svg.appendChild(code);

      const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      lbl.setAttribute("x", String(anchor.x));
      lbl.setAttribute("y", String(anchor.y + 24));
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("class", "flow-map-country-name");
      lbl.textContent = name;
      svg.appendChild(lbl);
    }

    const foot = document.createElementNS("http://www.w3.org/2000/svg", "text");
    foot.setAttribute("x", String(width - 18));
    foot.setAttribute("y", String(height - 12));
    foot.setAttribute("text-anchor", "end");
    foot.setAttribute("class", "flow-map-country-name");
    foot.textContent = "Getallen in GWh/dag";
    svg.appendChild(foot);
    return svg;
  }

  const countries = isGas
    ? [
        { code: "GB", name: "Verenigd Koninkrijk", d: "M150 170 L198 158 L238 168 L250 202 L236 245 L188 264 L150 252 L132 212 Z", cx: 192, cy: 216 },
        { code: "BE", name: "Belgie", d: "M330 278 L368 266 L402 274 L414 300 L402 326 L366 336 L336 322 L324 302 Z", cx: 369, cy: 302 },
        { code: "NL", name: "Nederland", d: "M456 184 L486 170 L522 172 L546 194 L550 230 L536 264 L508 282 L474 278 L452 254 L446 220 Z", cx: 500, cy: 228 },
        { code: "DE", name: "Duitsland", d: "M650 150 L760 146 L808 182 L824 234 L808 292 L760 322 L684 316 L646 282 L638 228 Z", cx: 736, cy: 232 },
        { code: "DK", name: "Denemarken", d: "M708 84 L752 78 L790 94 L800 120 L782 144 L742 152 L712 136 L700 112 Z", cx: 752, cy: 116 },
        { code: "NO", name: "Noorwegen", d: "M462 24 L500 14 L538 20 L560 42 L562 74 L544 98 L508 108 L470 102 L448 80 L448 50 Z", cx: 506, cy: 63 },
      ]
    : [
        { code: "GB", name: "Verenigd Koninkrijk", d: "M208 170 L226 155 L252 148 L276 156 L292 176 L301 201 L298 230 L286 254 L262 272 L235 278 L214 266 L202 244 L196 218 L198 192 Z", cx: 248, cy: 220 },
        { code: "BE", name: "Belgie", d: "M386 248 L402 238 L424 238 L444 248 L454 266 L448 286 L430 298 L404 298 L390 284 L384 266 Z", cx: 420, cy: 270 },
        { code: "NL", name: "Nederland", d: "M470 186 L488 176 L510 176 L529 184 L540 201 L542 224 L536 246 L520 262 L500 268 L482 262 L472 244 L468 220 L468 198 Z", cx: 505, cy: 220 },
        { code: "DE", name: "Duitsland", d: "M576 162 L612 150 L656 149 L704 158 L736 178 L748 206 L748 236 L734 264 L706 286 L668 298 L628 299 L596 286 L578 262 L570 230 L568 198 Z", cx: 662, cy: 224 },
        { code: "DK", name: "Denemarken", d: "M590 112 L610 102 L634 100 L656 108 L668 122 L666 138 L650 150 L628 154 L606 150 L592 138 L586 124 Z", cx: 626, cy: 129 },
        { code: "NO", name: "Noorwegen", d: "M496 40 L518 30 L542 30 L560 42 L568 58 L566 78 L554 96 L536 108 L514 112 L496 106 L486 90 L484 70 L490 52 Z", cx: 528, cy: 72 },
      ];

  for (const c of countries) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", c.d);
    path.setAttribute("class", `flow-map-country-shape ${c.code === "NL" ? "flow-map-country-shape-nl" : ""}`);
    svg.appendChild(path);

    const code = document.createElementNS("http://www.w3.org/2000/svg", "text");
    code.setAttribute("x", String(c.cx));
    code.setAttribute("y", String(c.cy - 2));
    code.setAttribute("text-anchor", "middle");
    code.setAttribute("class", "flow-map-country-code");
    code.textContent = c.code;
    svg.appendChild(code);

    const name = document.createElementNS("http://www.w3.org/2000/svg", "text");
    name.setAttribute("x", String(c.cx));
    name.setAttribute("y", String(c.cy + 14));
    name.setAttribute("text-anchor", "middle");
    name.setAttribute("class", "flow-map-country-name");
    name.textContent = c.name;
    svg.appendChild(name);
  }

  const maxAbs = Math.max(1, ...rows.map((r) => Number(r.value)).filter((v) => Number.isFinite(v)).map((v) => Math.abs(v)));
  const formatFlowLabel = (value) => {
    if (!Number.isFinite(value)) return "n/a";
    if (mode === "electricity") return `${(value / 1000).toFixed(1)} GW`;
    return `${Math.round(value)}`;
  };
  const ribbonPath = (x1, y1, x2, y2, w) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / len;
    const ny = dx / len;
    const hw = w / 2;
    const c = 0.35;
    const c1x = x1 + dx * c;
    const c1y = y1 + dy * c;
    const c2x = x2 - dx * c;
    const c2y = y2 - dy * c;
    const p1x = x1 + nx * hw;
    const p1y = y1 + ny * hw;
    const p2x = x2 + nx * hw;
    const p2y = y2 + ny * hw;
    const p3x = x2 - nx * hw;
    const p3y = y2 - ny * hw;
    const p4x = x1 - nx * hw;
    const p4y = y1 - ny * hw;
    return `M ${p1x} ${p1y} C ${c1x + nx * hw} ${c1y + ny * hw}, ${c2x + nx * hw} ${c2y + ny * hw}, ${p2x} ${p2y} L ${p3x} ${p3y} C ${c2x - nx * hw} ${c2y - ny * hw}, ${c1x - nx * hw} ${c1y - ny * hw}, ${p4x} ${p4y} Z`;
  };

  const nlNode = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  nlNode.setAttribute("cx", String(NL.x));
  nlNode.setAttribute("cy", String(NL.y));
  nlNode.setAttribute("r", "16");
  nlNode.setAttribute("class", "flow-map-node-nl");
  svg.appendChild(nlNode);
  const nlText = document.createElementNS("http://www.w3.org/2000/svg", "text");
  nlText.setAttribute("x", String(NL.x));
  nlText.setAttribute("y", String(NL.y + 4));
  nlText.setAttribute("text-anchor", "middle");
  nlText.setAttribute("class", "flow-map-label-nl");
  nlText.textContent = "NL";
  svg.appendChild(nlText);

  for (const row of rows) {
    const anchor = anchors[row.hour];
    if (!anchor) continue;
    const value = Number(row.value);
    const finite = Number.isFinite(value);

    const bandWidth = finite ? Math.max(5, Math.min(28, (Math.abs(value) / maxAbs) * 28)) : 4;
    const band = document.createElementNS("http://www.w3.org/2000/svg", "path");
    band.setAttribute("d", ribbonPath(anchor.x, anchor.y, NL.x, NL.y, bandWidth));
    band.setAttribute("class", `flow-sankey-band ${finite && value < 0 ? "flow-sankey-band-export" : "flow-sankey-band-import"}`);
    svg.appendChild(band);

    const lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    lbl.setAttribute("x", String((anchor.x + NL.x) / 2));
    lbl.setAttribute("y", String((anchor.y + NL.y) / 2 - 4));
    lbl.setAttribute("text-anchor", "middle");
    lbl.setAttribute("class", `flow-map-value ${finite && value < 0 ? "flow-map-value-export" : "flow-map-value-import"}`);
    lbl.textContent = formatFlowLabel(value);
    svg.appendChild(lbl);

    const node = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    node.setAttribute("cx", String(anchor.x));
    node.setAttribute("cy", String(anchor.y));
    node.setAttribute("r", "10");
    const rowName = String(row.hour || "").toLowerCase();
    const isLng = rowName.startsWith("lng");
    const isStorage = rowName.startsWith("gasopslag");
    node.setAttribute("class", isLng ? "flow-map-node flow-map-node-lng" : "flow-map-node");
    if (isStorage) node.setAttribute("class", "flow-map-node flow-map-node-storage");
    svg.appendChild(node);

    const code = document.createElementNS("http://www.w3.org/2000/svg", "text");
    code.setAttribute("x", String(anchor.x));
    code.setAttribute("y", String(anchor.y - 14));
    code.setAttribute("text-anchor", "middle");
    code.setAttribute("class", "flow-map-label");
    code.textContent = anchor.label;
    svg.appendChild(code);

    if (isLng || isStorage) {
      const name = document.createElementNS("http://www.w3.org/2000/svg", "text");
      name.setAttribute("x", String(anchor.x));
      name.setAttribute("y", String(anchor.y + 23));
      name.setAttribute("text-anchor", "middle");
      name.setAttribute("class", "flow-map-country-name");
      name.textContent = isLng ? "Gate+EET" : "Norg+Grijpskerk+Bergermeer+Zuidwending";
      svg.appendChild(name);
    }
  }

  return svg;
}

function createGasCountryBalanceMap(rows, quality = {}) {
  const width = 1080;
  const height = 700;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "flow-map gas-network-map gas-country-map");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Geografische kaart van de Nederlandse gasstromen en de sluitende dagbalans");

  const rowByName = new Map((rows || []).map((row) => [String(row.hour || ""), row]));
  const magnitudes = (rows || [])
    .filter((row) => row?.value !== null && row?.value !== undefined)
    .map((row) => Math.abs(Number(row.value)))
    .filter(Number.isFinite);
  const maxAbs = Math.max(1, ...magnitudes);
  const mapFrame = { x: 20, y: 44, width: 768, height: 630, originTileX: 7, originTileY: 4, zoom: 4 };
  const worldSize = 256 * (2 ** mapFrame.zoom);
  const mercator = (lon, lat) => {
    const safeLat = Math.max(-85, Math.min(85, lat));
    const x = ((lon + 180) / 360) * worldSize;
    const sinLat = Math.sin((safeLat * Math.PI) / 180);
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize;
    return { x, y };
  };
  const project = (lon, lat) => {
    const point = mercator(lon, lat);
    return {
      x: mapFrame.x + point.x - mapFrame.originTileX * 256,
      y: mapFrame.y + point.y - mapFrame.originTileY * 256,
    };
  };
  const NL = project(5.3, 52.2);
  const countryAt = (key, code, name, lon, lat, labelDx, labelDy) => {
    const point = project(lon, lat);
    return { key, code, name, ...point, labelX: point.x + labelDx, labelY: point.y + labelDy };
  };

  const countries = [
    countryAt("Verenigd Koninkrijk", "GB", "Verenigd Koninkrijk", -2.0, 54.0, -70, -10),
    countryAt("Belgie", "BE", "België", 4.5, 50.8, -80, 52),
    countryAt("Duitsland", "DE", "Duitsland", 10.0, 51.2, 75, 20),
    countryAt("Noorwegen", "NO", "Noorwegen", 7.5, 60.5, 65, -28),
  ];

  const lngNode = { key: "LNG-terminals", x: 142, y: 151 };
  const internalNodes = [
    { key: "Nationale productie", label: "Productie", detail: "Nederlandse productie", x: 150, y: 574, type: "supply" },
    { key: "Gasopslag (4 sites)", label: "Opslag", detail: "naar vier opslaglocaties", x: 404, y: 574, type: "storage" },
    { key: "Binnenlands verbruik", label: "Verbruik", detail: "huishoudens + industrie", x: 658, y: 574, type: "consumption" },
  ];

  const add = (tag, attrs = {}, text = "") => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
    if (text) element.textContent = text;
    svg.appendChild(element);
    return element;
  };

  for (let tileY = mapFrame.originTileY; tileY <= mapFrame.originTileY + 2; tileY += 1) {
    for (let tileX = mapFrame.originTileX; tileX <= mapFrame.originTileX + 2; tileX += 1) {
      add("image", {
        x: mapFrame.x + (tileX - mapFrame.originTileX) * 256,
        y: mapFrame.y + (tileY - mapFrame.originTileY) * 256,
        width: 256,
        height: 256,
        href: `https://tile.openstreetmap.org/${mapFrame.zoom}/${tileX}/${tileY}.png`,
        class: "gas-map-background",
      });
    }
  }
  add("rect", { x: mapFrame.x, y: mapFrame.y, width: mapFrame.width, height: mapFrame.height, rx: 18, class: "gas-map-background-wash" });
  add("rect", { x: mapFrame.x, y: 496, width: mapFrame.width, height: 178, class: "gas-map-metric-wash" });

  add("text", { x: 26, y: 30, class: "gas-map-kicker" }, "GASSTROMEN · LAATSTE VOLLEDIGE GASDAG");
  add("circle", { cx: 572, cy: 25, r: 5, class: "gas-legend-import" });
  add("text", { x: 584, y: 30, class: "gas-map-legend" }, "naar het gasnet");
  add("circle", { cx: 696, cy: 25, r: 5, class: "gas-legend-export" });
  add("text", { x: 708, y: 30, class: "gas-map-legend" }, "uit het gasnet");

  const drawFlow = (key, anchor) => {
    const row = rowByName.get(key);
    const value = Number(row?.value);
    const finite = row?.value !== null && row?.value !== undefined && Number.isFinite(value);
    if (!finite) return;
    const towardGrid = value >= 0;
    const start = towardGrid ? anchor : NL;
    const end = towardGrid ? NL : anchor;
    const widthPx = Math.max(2.5, Math.min(12, 2.5 + (Math.abs(value) / maxAbs) * 9.5));
    add("path", {
      d: `M ${start.x} ${start.y} L ${end.x} ${end.y}`,
      class: `gas-flow-connector ${towardGrid ? "is-import" : "is-export"}`,
      "stroke-width": widthPx,
    });
  };

  for (const country of countries) drawFlow(country.key, country);
  drawFlow(lngNode.key, lngNode);

  const flowLabel = (row, type) => {
    const value = Number(row?.value);
    if (row?.value === null || row?.value === undefined || !Number.isFinite(value)) return "geen actuele meting";
    const direction = type === "border"
      ? (value >= 0 ? "import" : "export")
      : type === "storage"
        ? (value >= 0 ? "uit opslag" : "naar opslag")
        : type === "consumption"
          ? "verbruik"
          : "aanvoer";
    return `${Math.abs(value).toFixed(0)} GWh/d · ${direction}`;
  };

  for (const country of countries) {
    const row = rowByName.get(country.key);
    const value = Number(row?.value);
    const isOut = row?.value !== null && row?.value !== undefined && Number.isFinite(value) && value < 0;
    add("rect", { x: country.labelX - 76, y: country.labelY - 31, width: 152, height: 70, rx: 14, class: "gas-country-chip" });
    add("text", { x: country.labelX, y: country.labelY - 9, "text-anchor": "middle", class: "gas-country-code" }, country.code);
    add("text", { x: country.labelX, y: country.labelY + 7, "text-anchor": "middle", class: "gas-country-name" }, country.name);
    add("text", { x: country.labelX, y: country.labelY + 28, "text-anchor": "middle", class: `gas-country-flow${isOut ? " is-export" : ""}` }, flowLabel(row, "border"));
  }

  const lngRow = rowByName.get(lngNode.key);
  const lngValue = Number(lngRow?.value);
  add("rect", { x: lngNode.x - 83, y: lngNode.y - 58, width: 166, height: 116, rx: 18, class: "gas-lng-ship-card" });
  add("text", { x: lngNode.x, y: lngNode.y - 24, "text-anchor": "middle", class: "gas-lng-ship-icon" }, "⛴");
  add("text", { x: lngNode.x, y: lngNode.y + 2, "text-anchor": "middle", class: "gas-lng-ship-label" }, "LNG-aanvoer");
  add("text", { x: lngNode.x, y: lngNode.y + 26, "text-anchor": "middle", class: "gas-lng-ship-value" }, Number.isFinite(lngValue) ? `+${lngValue.toFixed(1)} GWh/d` : "geen actuele meting");
  add("text", { x: lngNode.x, y: lngNode.y + 46, "text-anchor": "middle", class: "gas-lng-ship-detail" }, "Gate + EET");

  add("circle", { cx: NL.x, cy: NL.y, r: 31, class: "gas-map-hub-ring" });
  add("circle", { cx: NL.x, cy: NL.y, r: 23, class: "gas-map-hub" });
  add("text", { x: NL.x, y: NL.y + 5, "text-anchor": "middle", class: "gas-map-hub-title" }, "NL");
  add("text", { x: NL.x, y: NL.y + 48, "text-anchor": "middle", class: "gas-map-nl-label" }, "Nederlands gasnet");

  const metricSigned = (value) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}`;
  for (const node of internalNodes) {
    const row = rowByName.get(node.key);
    const value = Number(row?.value);
    const isOut = row?.value !== null && row?.value !== undefined && Number.isFinite(value) && value < 0;
    add("rect", { x: node.x - 105, y: node.y - 62, width: 210, height: 124, rx: 18, class: `gas-map-node gas-map-node-${node.type}` });
    add("text", { x: node.x, y: node.y - 34, "text-anchor": "middle", class: "gas-map-metric-label" }, node.label);
    add("text", { x: node.x, y: node.y + 2, "text-anchor": "middle", class: `gas-map-metric-value${isOut ? " is-export" : ""}` }, Number.isFinite(value) ? `${metricSigned(value)} GWh/d` : "n/a");
    add("text", { x: node.x, y: node.y + 26, "text-anchor": "middle", class: "gas-map-metric-detail" }, node.detail);
    if (node.type === "storage") {
      const storageFillPct = Number(quality?.storageFillPct);
      add("text", { x: node.x, y: node.y + 48, "text-anchor": "middle", class: "gas-map-storage-fill" }, Number.isFinite(storageFillPct) ? `${storageFillPct.toFixed(1)}% gevuld` : "vulling onbekend");
    }
  }

  const supply = Number(quality?.supplyGwhDay);
  const consumption = Number(quality?.consumptionGwhDay);
  const difference = Number(quality?.differenceGwhDay);
  const differencePct = Number(quality?.differencePct);
  const balanceFinite = [supply, consumption, difference, differencePct].every(Number.isFinite);
  const explainedPct = balanceFinite ? Math.max(0, 100 - Math.abs(differencePct)) : null;
  const signed = (value) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}`;

  add("rect", { x: 825, y: 54, width: 230, height: 500, rx: 22, class: "gas-balance-panel" });
  add("text", { x: 850, y: 87, class: "gas-balance-kicker" }, "DAGBALANS");
  add("text", { x: 850, y: 116, class: "gas-balance-heading" }, "Nederland");
  add("text", { x: 850, y: 154, class: "gas-balance-label" }, "Netto aanvoer");
  add("text", { x: 1030, y: 154, "text-anchor": "end", class: "gas-balance-value is-import" }, balanceFinite ? `+${supply.toFixed(1)}` : "n/a");
  add("text", { x: 850, y: 190, class: "gas-balance-label" }, "Binnenlands verbruik");
  add("text", { x: 1030, y: 190, "text-anchor": "end", class: "gas-balance-value is-export" }, balanceFinite ? `−${consumption.toFixed(1)}` : "n/a");
  add("line", { x1: 850, y1: 215, x2: 1030, y2: 215, class: "gas-balance-rule" });
  add("text", { x: 850, y: 252, class: "gas-balance-label strong" }, "Restcheck");
  add("text", { x: 1030, y: 252, "text-anchor": "end", class: "gas-balance-total" }, balanceFinite ? signed(difference) : "n/a");
  add("text", { x: 1030, y: 276, "text-anchor": "end", class: "gas-balance-unit" }, "GWh/d");
  add("rect", { x: 850, y: 301, width: 180, height: 54, rx: 13, class: balanceFinite && Math.abs(differencePct) <= 15 ? "gas-balance-ok" : "gas-balance-warning" });
  add("text", { x: 940, y: 324, "text-anchor": "middle", class: "gas-balance-status" }, explainedPct === null ? "controle nodig" : `${explainedPct.toFixed(1)}% verklaard`);
  add("text", { x: 940, y: 344, "text-anchor": "middle", class: "gas-balance-percent" }, balanceFinite && Math.abs(differencePct) <= 15 ? "balans vrijwel compleet" : "extra controle nodig");
  add("text", { x: 850, y: 386, class: "gas-balance-breakdown-title" }, "OPBOUW NETTO AANVOER");
  const breakdown = [
    ["Grenssaldo", Number(quality?.borderNetGwhDay)],
    ["LNG", Number(rowByName.get("LNG-terminals")?.value)],
    ["Productie", Number(rowByName.get("Nationale productie")?.value)],
    ["Opslag", Number(rowByName.get("Gasopslag (4 sites)")?.value)],
  ];
  breakdown.forEach(([label, value], index) => {
    const y = 410 + index * 23;
    add("text", { x: 850, y, class: "gas-balance-breakdown-label" }, label);
    add("text", { x: 1030, y, "text-anchor": "end", class: `gas-balance-breakdown-value${value < 0 ? " is-export" : ""}` }, Number.isFinite(value) ? signed(value) : "n/a");
  });
  add("text", { x: 850, y: 520, class: "gas-balance-note" }, "Restverschil: linepack + meetmomenten.");

  add("text", { x: 26, y: 689, class: "gas-map-footnote" }, "Lijndikte = grootte van de stroom; kleur = richting. Interne stromen staan in de drie blokken.");
  add("text", { x: 790, y: 689, "text-anchor": "end", class: "gas-map-attribution" }, "Kaart © OpenStreetMap-bijdragers");
  return svg;
}

function createGasNetHubMap(rows) {
  const width = 980;
  const height = 450;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "flow-map gas-network-map");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Gasstromen van en naar het Nederlandse gasnet");

  const anchors = {
    "Verenigd Koninkrijk": { x: 135, y: 150, code: "GB", type: "border" },
    Belgie: { x: 165, y: 320, code: "BE", type: "border", displayName: "België" },
    Duitsland: { x: 835, y: 315, code: "DE", type: "border" },
    Noorwegen: { x: 710, y: 95, code: "NO", type: "border" },
    "LNG-terminals": { x: 365, y: 80, code: "LNG", type: "supply" },
    "Gasopslag (4 sites)": { x: 455, y: 375, code: "OPSLAG", type: "storage" },
    "Nationale productie": { x: 750, y: 375, code: "PRODUCTIE", type: "supply" },
  };

  const NL = { x: 500, y: 245 };
  const rowByName = new Map((rows || []).map((r) => [String(r.hour || ""), r]));
  const values = (rows || []).map((r) => Number(r.value)).filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
  const maxAbs = Math.max(1, ...values);

  const add = (tag, attrs = {}, text = "") => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    if (text) el.textContent = text;
    svg.appendChild(el);
    return el;
  };

  const defs = add("defs");
  for (const [id, fill] of [["gas-arrow-in", "#157f76"], ["gas-arrow-out", "#c5523f"]]) {
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const tip = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tip.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    tip.setAttribute("fill", fill);
    marker.appendChild(tip);
    defs.appendChild(marker);
  }

  add("text", { x: 24, y: 28, class: "gas-map-kicker" }, "GRENSSTROMEN EN BINNENLANDSE AANVOER");
  add("circle", { cx: 655, cy: 23, r: 5, class: "gas-legend-import" });
  add("text", { x: 666, y: 28, class: "gas-map-legend" }, "naar NL / gasnet");
  add("circle", { cx: 805, cy: 23, r: 5, class: "gas-legend-export" });
  add("text", { x: 816, y: 28, class: "gas-map-legend" }, "van NL / gasnet");

  for (const [name, anchor] of Object.entries(anchors)) {
    const row = rowByName.get(name);
    const value = Number(row?.value);
    const finite = row?.value !== null && row?.value !== undefined && Number.isFinite(value);
    if (finite) {
      const isTowardNl = value >= 0;
      const x1 = isTowardNl ? anchor.x : NL.x;
      const y1 = isTowardNl ? anchor.y : NL.y;
      const x2 = isTowardNl ? NL.x : anchor.x;
      const y2 = isTowardNl ? NL.y : anchor.y;
      const widthPx = Math.max(3, Math.min(15, 3 + (Math.abs(value) / maxAbs) * 12));
      add("line", {
        x1, y1, x2, y2,
        class: `gas-flow-connector ${isTowardNl ? "is-import" : "is-export"}`,
        "stroke-width": widthPx,
        "marker-end": `url(#${isTowardNl ? "gas-arrow-in" : "gas-arrow-out"})`,
      });
      const flowWord = anchor.type === "border" ? (isTowardNl ? "import" : "export") : (isTowardNl ? "naar net" : "uit net");
      const labelX = anchor.type === "storage" ? anchor.x - 88 : (anchor.x + NL.x) / 2;
      const labelY = anchor.type === "storage" ? anchor.y - 48 : (anchor.y + NL.y) / 2 - 10;
      add("text", {
        x: labelX,
        y: labelY,
        "text-anchor": "middle",
        class: `gas-flow-number ${isTowardNl ? "is-import" : "is-export"}`,
      }, `${Math.abs(value).toFixed(0)} GWh/d · ${flowWord}`);
    }

    const nodeWidth = anchor.type === "border" ? 112 : 142;
    add("rect", {
      x: anchor.x - nodeWidth / 2,
      y: anchor.y - 32,
      width: nodeWidth,
      height: 64,
      rx: 16,
      class: `gas-map-node gas-map-node-${anchor.type}`,
    });
    add("text", { x: anchor.x, y: anchor.y - 5, "text-anchor": "middle", class: "gas-map-code" }, anchor.code);
    add("text", { x: anchor.x, y: anchor.y + 16, "text-anchor": "middle", class: "gas-map-name" }, anchor.displayName || name);
    if (!finite) add("text", { x: anchor.x, y: anchor.y + 49, "text-anchor": "middle", class: "gas-map-missing" }, "geen actuele meting");
  }

  add("circle", { cx: NL.x, cy: NL.y, r: 76, class: "gas-map-hub-ring" });
  add("circle", { cx: NL.x, cy: NL.y, r: 58, class: "gas-map-hub" });
  add("text", { x: NL.x, y: NL.y - 6, "text-anchor": "middle", class: "gas-map-hub-title" }, "NL");
  add("text", { x: NL.x, y: NL.y + 18, "text-anchor": "middle", class: "gas-map-hub-subtitle" }, "gasnet");
  add("text", { x: 24, y: 438, class: "gas-map-footnote" }, "Pijldikte = relatieve omvang. Landen tonen alleen canonieke ENTSOG-corridors; LNG, opslag en productie zijn aparte aanvoerbronnen.");

  return svg;
}

function createGenerationPieChart(rows) {
  const valid = rows
    .map((r) => ({ label: r.hour, value: Number(r.value) }))
    .filter((x) => Number.isFinite(x.value) && x.value > 0);
  if (!valid.length) return null;

  const colorsByLabel = {
    Gascentrales: "#808080",
    Kolencentrales: "#111111",
    WKK: "#C66B28",
    Overig: "#8B5A2B",
    Zon: "#FFD500",
    Wind: "#2D7FF9",
    "Wind op zee": "#2D7FF9",
    Biomassa: "#B7E67A",
    Kernenergie: "#8E44AD",
    "Overig / niet uitgesplitst": "#8B5A2B",
  };
  const fallback = ["#0f7a62", "#2e8b74", "#4ea287", "#72b89b", "#95cdb0", "#b5dfc6", "#d4efde"];
  const total = valid.reduce((s, x) => s + x.value, 0);
  const width = 380;
  const height = 250;
  const cx = 120;
  const cy = 125;
  const r = 84;

  const wrap = document.createElement("div");
  wrap.className = "pie-wrap";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "pie-chart");

  let acc = -Math.PI / 2;
  valid.forEach((v, idx) => {
    const frac = v.value / total;
    const a0 = acc;
    const a1 = acc + frac * Math.PI * 2;
    acc = a1;
    const x1 = cx + r * Math.cos(a0);
    const y1 = cy + r * Math.sin(a0);
    const x2 = cx + r * Math.cos(a1);
    const y2 = cy + r * Math.sin(a1);
    const largeArc = a1 - a0 > Math.PI ? 1 : 0;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`);
    path.setAttribute("fill", colorsByLabel[v.label] || fallback[idx % fallback.length]);
    svg.appendChild(path);
  });

  const hole = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  hole.setAttribute("cx", String(cx));
  hole.setAttribute("cy", String(cy));
  hole.setAttribute("r", "43");
  hole.setAttribute("class", "pie-hole");
  svg.appendChild(hole);

  const title = document.createElementNS("http://www.w3.org/2000/svg", "text");
  title.setAttribute("x", String(cx));
  title.setAttribute("y", String(cy + 4));
  title.setAttribute("text-anchor", "middle");
  title.setAttribute("class", "pie-center-label");
  title.textContent = "Opwek";
  svg.appendChild(title);

  const legend = document.createElement("div");
  legend.className = "pie-legend";
  valid.forEach((v, idx) => {
    const item = document.createElement("div");
    item.className = "pie-legend-item";
    const dot = document.createElement("span");
    dot.className = "pie-legend-dot";
    dot.style.background = colorsByLabel[v.label] || fallback[idx % fallback.length];
    const txt = document.createElement("span");
    txt.className = "pie-legend-text";
    txt.textContent = `${v.label}: ${v.value.toFixed(1)}%`;
    item.appendChild(dot);
    item.appendChild(txt);
    legend.appendChild(item);
  });

  wrap.appendChild(svg);
  wrap.appendChild(legend);
  return wrap;
}

function createGasFlowMap(item) {
  const get = (name) => {
    const row = (item.rows || []).find((r) => String(r.hour || "").toLowerCase() === name.toLowerCase());
    return row ? Number(row.value) : NaN;
  };

  const flow = {
    imports: get("Import totaal"),
    production: get("Lokale productie"),
    export: get("Export"),
  };

  const vals = Object.values(flow).filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
  const maxAbs = Math.max(1, ...vals);
  const strokeW = (v) => (Number.isFinite(v) ? Math.max(2, Math.min(16, (Math.abs(v) / maxAbs) * 16)) : 2);

  const width = 980;
  const height = 480;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "gas-flow-map");

  const nodes = {
    imports: { x: 120, y: 140, label: "Import" },
    production: { x: 120, y: 320, label: "Lokale productie" },
    hub: { x: 460, y: 240, label: "NL gasnet" },
    export: { x: 800, y: 240, label: "Export" },
  };

  const drawNode = (n, major = false) => {
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(n.x));
    c.setAttribute("cy", String(n.y));
    c.setAttribute("r", major ? "24" : "18");
    c.setAttribute("class", major ? "gas-node gas-node-major" : "gas-node");
    svg.appendChild(c);

    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(n.x));
    t.setAttribute("y", String(n.y - (major ? 34 : 28)));
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("class", "gas-node-label");
    t.textContent = n.label;
    svg.appendChild(t);
  };

  const drawFlow = (from, to, value, cls, label) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(from.x));
    line.setAttribute("y1", String(from.y));
    line.setAttribute("x2", String(to.x));
    line.setAttribute("y2", String(to.y));
    line.setAttribute("stroke-width", String(strokeW(value)));
    line.setAttribute("class", `gas-flow-line ${cls}`);
    svg.appendChild(line);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String((from.x + to.x) / 2));
    text.setAttribute("y", String((from.y + to.y) / 2 - 6));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("class", "gas-flow-value");
    const valText = Number.isFinite(value) ? `${formatNumber(value)} MW` : "n/a";
    text.textContent = `${label}: ${valText}`;
    svg.appendChild(text);
  };

  drawFlow(nodes.imports, nodes.hub, flow.imports, "gas-flow-in", "Import");
  drawFlow(nodes.production, nodes.hub, flow.production, "gas-flow-in", "Lokale productie");
  drawFlow(nodes.hub, nodes.export, flow.export, "gas-flow-out", "Export");

  drawNode(nodes.imports);
  drawNode(nodes.production);
  drawNode(nodes.hub, true);
  drawNode(nodes.export);

  return svg;
}

function createCard(item) {
  const node = cardTemplate.content.cloneNode(true);
  node.querySelector(".card-title").textContent = item.label;
  node.querySelector(".card-explainer").textContent = CARD_EXPLANATIONS[item.id] || "Actuele markt- of systeeminformatie uit de vermelde openbare bron.";

  const statusEl = node.querySelector(".data-status");
  const measuredAt = item.updatedAt ? new Date(item.updatedAt) : null;
  const ageHours = measuredAt && !Number.isNaN(measuredAt.getTime()) ? (Date.now() - measuredAt.getTime()) / 3_600_000 : null;
  const isDailySource = ["nlGasImport", "nlGasConsumptionBreakdown", "nlGasProduction", "gaslichtGas", "gaslichtElectricity"].includes(item.id);
  const staleLimitHours = isDailySource ? 72 : item.id === "tennetSettlement" ? 24 : item.id === "nlCrossBorderFlows" ? 12 : 3;
  const detailLower = String(item.detail || "").toLowerCase();
  if (item.dataStatus === "stale" || (Number.isFinite(ageHours) && ageHours > staleLimitHours)) {
    statusEl.textContent = "Verouderd";
    statusEl.classList.add("is-stale");
  } else if (item.dataStatus === "warning" || detailLower.includes("fout") || detailLower.includes("niet beschikbaar") || detailLower.includes("fallback")) {
    statusEl.textContent = "Let op";
    statusEl.classList.add("is-warning");
  } else if (item.dataStatus === "verified") {
    statusEl.textContent = "Gecontroleerd";
    statusEl.classList.add("is-verified");
  } else {
    statusEl.textContent = "Actueel";
    statusEl.classList.add("is-current");
  }
  statusEl.title = item.statusMessage || "Status op basis van bronmelding en meettijd";

  let shownValue = `${formatNumber(item.value)} ${item.unit}`;
  if (item.id === "nlGridFrequency" && Number.isFinite(Number(item.value))) {
    shownValue = `${Number(item.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${item.unit}`;
  }
  if (item.id === "nlCrossBorderFlows" && Number.isFinite(Number(item.value))) {
    const borderGw = Number(item.value) / 1000;
    shownValue = `${Math.abs(borderGw).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GW netto ${borderGw >= 0 ? "import" : "export"}`;
  }
  if ((item.id === "gaslichtGas" || item.id === "gaslichtElectricity") && Number.isFinite(Number(item.value))) {
    shownValue = `${formatNumberFixed2(item.value)} ${item.unit}`;
  }
  if (item.id === "nlGasImport") shownValue = "Stromen, opslag en verbruik op één gasdag";
  node.querySelector(".card-value").textContent = item.valueText ? item.valueText : shownValue;
  const detail = item.detail ? ` · ${item.detail}` : "";
  node.querySelector(".card-meta").textContent = `${item.source} · meting ${formatTime(item.updatedAt)}${detail}`;

  const cardEl = node.querySelector(".card");
  cardEl.dataset.cardId = item.id;
  if (item.id === "nlGasImport") cardEl.classList.add("card-wide");

  if (item.id === "dayAheadPower24h" && Array.isArray(item.rows) && item.rows.length > 0) {
    const chart = createDayAheadChart(orderDayAheadRowsForDisplay(item.rows));
    if (chart) cardEl.appendChild(chart);
  }

  if (item.id === "nlCrossBorderFlows" && Array.isArray(item.rows) && item.rows.length > 0) {
    const map = createCrossBorderFlowMap(item.rows, item.unit || "MW", "electricity", item.quality || {});
    if (map) cardEl.appendChild(map);
  }

  if (item.id === "nlGasImport" && Array.isArray(item.rows) && item.rows.length > 0) {
    const gasCountryMap = createCrossBorderFlowMap(item.rows, item.unit || "GWh/d", "gas", item.quality || {});
    if (gasCountryMap) cardEl.appendChild(gasCountryMap);
  }

  if (item.id === "nlGenerationMixShare" && Array.isArray(item.rows) && item.rows.length > 0) {
    const pie = createGenerationPieChart(item.rows);
    if (pie) cardEl.appendChild(pie);
  }
  if (item.id === "nlGenerationMixShare" && (!Array.isArray(item.rows) || item.rows.length === 0)) {
    const fallback = document.createElement("div");
    fallback.className = "card-series";
    const line = document.createElement("div");
    line.className = "card-series-row";
    line.textContent = "Mixdata tijdelijk niet beschikbaar.";
    fallback.appendChild(line);
    const link = document.createElement("a");
    link.className = "source-link";
    link.href = "https://ned.nl/nl/dataportaal/energie-productie/elektriciteit/totale-elektriciteitsproductie";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open NED mixpagina";
    fallback.appendChild(link);
    cardEl.appendChild(fallback);
  }

  if (
    Array.isArray(item.rows) &&
    item.rows.length > 0 &&
    !["nlGasImport", "dayAheadPower24h", "nlCrossBorderFlows", "nlGenerationMixShare"].includes(item.id)
  ) {
    const list = document.createElement("div");
    list.className = "card-series";
    const numericValues = item.rows.map((r) => Number(r.value)).filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
    const maxValue = numericValues.length > 0 ? Math.max(...numericValues) : 0;

    for (const row of item.rows) {
      const line = document.createElement("div");
      line.className = "card-series-row";
      const rowHasText = typeof row.valueText === "string" && row.valueText.trim() !== "";
      const rowValue = rowHasText ? row.valueText : (row.value === null || row.value === undefined ? "n/a" : formatNumber(row.value));
      const label = document.createElement("span");
      label.className = "card-series-label";
      label.textContent = rowHasText ? `${row.hour}: ${rowValue}` : `${row.hour}: ${rowValue} ${row.unit || ""}`.trim();
      line.appendChild(label);

      if (!rowHasText && Number.isFinite(Number(row.value))) {
        const barWrap = document.createElement("span");
        barWrap.className = "card-series-bar-wrap";
        const bar = document.createElement("span");
        bar.className = "card-series-bar";
        let pct;
        if ((row.unit || "").trim() === "%") pct = Math.max(2, Math.min(100, Math.round(Math.abs(Number(row.value)))));
        else pct = maxValue <= 0 ? 2 : Math.max(2, Math.round((Math.abs(Number(row.value)) / maxValue) * 100));
        bar.style.width = `${pct}%`;
        barWrap.appendChild(bar);
        line.appendChild(barWrap);
      }
      list.appendChild(line);
    }
    cardEl.appendChild(list);
  }

  const sourceLink = node.querySelector(".card-source");
  sourceLink.href = item.sourceUrl;
  return node;
}

function renderPageCards(targetEls, items) {
  targetEls.demand.innerHTML = "";
  targetEls.wholesale.innerHTML = "";
  targetEls.retail.innerHTML = "";

  for (const item of items.demand) targetEls.demand.appendChild(createCard(item));
  for (const item of items.wholesale) targetEls.wholesale.appendChild(createCard(item));
  for (const item of items.retail) targetEls.retail.appendChild(createCard(item));
}

function splitItems(items) {
  const electricity = { demand: [], wholesale: [], retail: [] };
  const gas = { demand: [], wholesale: [], retail: [] };

  for (const item of items) {
    if (ELECTRICITY_DEMAND_IDS.has(item.id)) electricity.demand.push(item);
    else if (ELECTRICITY_WHOLESALE_IDS.has(item.id)) electricity.wholesale.push(item);
    else if (ELECTRICITY_RETAIL_IDS.has(item.id)) electricity.retail.push(item);

    if (GAS_DEMAND_IDS.has(item.id)) gas.demand.push(item);
    else if (GAS_WHOLESALE_IDS.has(item.id)) gas.wholesale.push(item);
    else if (GAS_RETAIL_IDS.has(item.id)) gas.retail.push(item);
  }

  const electricityDemandOrder = ["nlCrossBorderFlows", "dayAheadPower24h"];
  electricity.demand.sort((a, b) => {
    const ia = electricityDemandOrder.indexOf(a.id);
    const ib = electricityDemandOrder.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const electricityWholesaleOrder = ["ets", "gaslichtElectricity"];
  electricity.wholesale.sort((a, b) => {
    const ia = electricityWholesaleOrder.indexOf(a.id);
    const ib = electricityWholesaleOrder.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const gasDemandOrder = ["nlGasImport"];
  gas.demand.sort((a, b) => {
    const ia = gasDemandOrder.indexOf(a.id);
    const ib = gasDemandOrder.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const gasWholesaleOrder = ["ttfGas", "ets", "gaslichtGas"];
  gas.wholesale.sort((a, b) => {
    const ia = gasWholesaleOrder.indexOf(a.id);
    const ib = gasWholesaleOrder.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const gasRetailOrder = [];
  gas.retail.sort((a, b) => {
    const ia = gasRetailOrder.indexOf(a.id);
    const ib = gasRetailOrder.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  return { electricity, gas };
}

async function loadOverview() {
  statusEl.textContent = "Refreshing...";
  refreshBtn.disabled = true;
  try {
    const response = await fetch(`./overview.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);

    const payload = await response.json();
    const split = splitItems(payload.items || []);

    renderPageCards(
      { demand: electricityDemandCardsEl, wholesale: electricityWholesaleCardsEl, retail: electricityRetailCardsEl },
      split.electricity
    );
    renderPageCards({ demand: gasDemandCardsEl, wholesale: gasWholesaleCardsEl, retail: gasRetailCardsEl }, split.gas);

    const generated = payload.generatedAt ? new Date(payload.generatedAt) : null;
    const generatedValid = generated && !Number.isNaN(generated.getTime());
    const generatedText = generatedValid ? generated.toLocaleString() : "onbekend";
    const ageMin = generatedValid ? Math.round((Date.now() - generated.getTime()) / 60000) : null;
    const staleNote = Number.isFinite(ageMin) && ageMin > 90 ? ` | let op: data ${ageMin} min oud` : "";

    if (payload.errors && payload.errors.length > 0) {
      statusEl.textContent = `Data: ${generatedText}${staleNote} | ${payload.errors.length} bronfout(en) [${BUILD_TAG}]`;
    } else {
      statusEl.textContent = `Data: ${generatedText}${staleNote} (${payload.durationMs} ms) [${BUILD_TAG}]`;
    }
  } catch (error) {
    statusEl.textContent = `Failed to load data: ${error.message} [${BUILD_TAG}]`;
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", loadOverview);
const pageFromPath = pathLower.startsWith("/gas") ? "gas" : (pathLower.startsWith("/elektriciteit") ? "electricity" : null);
setActivePage(pageFromPath || initialPageParam || "electricity", false);
loadOverview();
setInterval(loadOverview, 120000);

if (isWidgetMode) {
  setInterval(() => {
    setActivePage(activePage === "electricity" ? "gas" : "electricity");
  }, 30000);
}
