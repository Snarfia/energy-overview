const urlParams = new URLSearchParams(window.location.search);
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

const ELECTRICITY_DEMAND_IDS = new Set(["nlElectricityOverview", "tennetRegulation", "nlGridFrequency", "nlCrossBorderFlows"]);
const ELECTRICITY_WHOLESALE_IDS = new Set(["dayAheadPower24h", "ets", "tennetSettlement"]);
const ELECTRICITY_RETAIL_IDS = new Set(["gaslichtElectricity"]);

const GAS_DEMAND_IDS = new Set(["nlGasConsumptionBreakdown", "nlGasImport", "nlGasProduction", "nlGasStorage"]);
const GAS_WHOLESALE_IDS = new Set(["ttfGas", "ets"]);
const GAS_RETAIL_IDS = new Set(["gaslichtGas"]);

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

  const width = 980;
  const height = 420;
  const m = { top: 14, right: 14, bottom: 36, left: 52 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;
  const yMin = -100;
  const yMax = 300;

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

  const xTicks = [0, 4, 8, 12, 16, 20, 23];
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
  const nowIdx = rows.findIndex((r) => extractHourLabel(r.hour) === nowLabel);
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

function createCrossBorderFlowMap(rows, unitLabel = "MW", mode = "electricity") {
  if (mode === "gas") return createGasNetHubMap(rows);

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

function createGasNetHubMap(rows) {
  const width = 980;
  const height = 420;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "flow-map");

  const anchors = {
    "Verenigd Koninkrijk": { x: 150, y: 220, label: "GB" },
    Belgie: { x: 300, y: 340, label: "BE" },
    Duitsland: { x: 830, y: 220, label: "DE" },
    Denemarken: { x: 770, y: 90, label: "DK" },
    Noorwegen: { x: 620, y: 44, label: "NO" },
    "LNG (Gate+EET)": { x: 430, y: 120, label: "LNG" },
    "Gasopslag (4 sites)": { x: 500, y: 336, label: "OPS" },
    "Nationale productie": { x: 620, y: 318, label: "PROD" },
  };

  const NL = { x: 500, y: 220 };
  const rowByName = new Map((rows || []).map((r) => [String(r.hour || ""), r]));
  const values = (rows || []).map((r) => Number(r.value)).filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
  const maxAbs = Math.max(1, ...values);

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

  const nlNode = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  nlNode.setAttribute("x", String(NL.x - 18));
  nlNode.setAttribute("y", String(NL.y - 18));
  nlNode.setAttribute("width", "36");
  nlNode.setAttribute("height", "36");
  nlNode.setAttribute("rx", "8");
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

      const valText = document.createElementNS("http://www.w3.org/2000/svg", "text");
      valText.setAttribute("x", String((anchor.x + NL.x) / 2));
      valText.setAttribute("y", String((anchor.y + NL.y) / 2 - 4));
      valText.setAttribute("text-anchor", "middle");
      valText.setAttribute("class", `flow-map-value ${value < 0 ? "flow-map-value-export" : "flow-map-value-import"}`);
      valText.textContent = `${Math.round(value)}`;
      svg.appendChild(valText);
    }

    const node = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    node.setAttribute("x", String(anchor.x - 12));
    node.setAttribute("y", String(anchor.y - 12));
    node.setAttribute("width", "24");
    node.setAttribute("height", "24");
    node.setAttribute("rx", "6");
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

    const nameText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    nameText.setAttribute("x", String(anchor.x));
    nameText.setAttribute("y", String(anchor.y + 24));
    nameText.setAttribute("text-anchor", "middle");
    nameText.setAttribute("class", "flow-map-country-name");
    nameText.textContent = name;
    svg.appendChild(nameText);
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

function createGenerationPieChart(rows) {
  const valid = rows
    .map((r) => ({ label: r.hour, value: Number(r.value) }))
    .filter((x) => Number.isFinite(x.value) && x.value > 0);
  if (!valid.length) return null;

  const colorsByLabel = {
    Gascentrales: "#808080",
    Kolencentrales: "#111111",
    Afval: "#8B5A2B",
    Zon: "#FFD500",
    Wind: "#2D7FF9",
    Biomassa: "#B7E67A",
    Kernenergie: "#8E44AD",
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
  title.textContent = "Mix";
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
  let shownValue = `${formatNumber(item.value)} ${item.unit}`;
  if (item.id === "nlGridFrequency" && Number.isFinite(Number(item.value))) {
    shownValue = `${Number(item.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${item.unit}`;
  }
  if (item.id === "nlCrossBorderFlows" && Number.isFinite(Number(item.value))) {
    shownValue = `${(Number(item.value) / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GW`;
  }
  if ((item.id === "gaslichtGas" || item.id === "gaslichtElectricity") && Number.isFinite(Number(item.value))) {
    shownValue = `${formatNumberFixed2(item.value)} ${item.unit}`;
  }
  node.querySelector(".card-value").textContent = item.valueText ? item.valueText : shownValue;
  const detail = item.detail ? ` | ${item.detail}` : "";
  node.querySelector(".card-meta").textContent = `${item.source} | ${formatTime(item.updatedAt)}${detail}`;

  const cardEl = node.querySelector(".card");
  cardEl.dataset.cardId = item.id;
  if (item.id === "dayAheadPower24h" || item.id === "nlCrossBorderFlows" || item.id === "nlGasImport") cardEl.classList.add("card-wide");

  if (item.id === "dayAheadPower24h" && Array.isArray(item.rows) && item.rows.length > 0) {
    const chart = createDayAheadChart(orderDayAheadRowsForDisplay(item.rows));
    if (chart) cardEl.appendChild(chart);
  }

  if (item.id === "nlCrossBorderFlows" && Array.isArray(item.rows) && item.rows.length > 0) {
    const map = createCrossBorderFlowMap(item.rows, item.unit || "MW", "electricity");
    if (map) cardEl.appendChild(map);
  }

  if (item.id === "nlGasImport" && Array.isArray(item.rows) && item.rows.length > 0) {
    const gasCountryMap = createCrossBorderFlowMap(item.rows, item.unit || "GWh/d", "gas");
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

  const electricityDemandOrder = ["nlElectricityOverview", "tennetRegulation", "nlGridFrequency", "nlCrossBorderFlows"];
  electricity.demand.sort((a, b) => {
    const ia = electricityDemandOrder.indexOf(a.id);
    const ib = electricityDemandOrder.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  const gasDemandOrder = ["nlGasConsumptionBreakdown", "nlGasStorage", "nlGasProduction", "nlGasImport"];
  gas.demand.sort((a, b) => {
    const ia = gasDemandOrder.indexOf(a.id);
    const ib = gasDemandOrder.indexOf(b.id);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  return { electricity, gas };
}

async function loadOverview() {
  statusEl.textContent = "Refreshing...";
  refreshBtn.disabled = true;
  try {
    const response = await fetch(`/overview.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);

    const payload = await response.json();
    const split = splitItems(payload.items || []);

    renderPageCards(
      { demand: electricityDemandCardsEl, wholesale: electricityWholesaleCardsEl, retail: electricityRetailCardsEl },
      split.electricity
    );
    renderPageCards({ demand: gasDemandCardsEl, wholesale: gasWholesaleCardsEl, retail: gasRetailCardsEl }, split.gas);

    if (payload.errors && payload.errors.length > 0) {
      statusEl.textContent = `Loaded with ${payload.errors.length} source error(s) at ${new Date().toLocaleTimeString()}.`;
    } else {
      statusEl.textContent = `Updated at ${new Date().toLocaleTimeString()} (${payload.durationMs} ms).`;
    }
  } catch (error) {
    statusEl.textContent = `Failed to load data: ${error.message}`;
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
