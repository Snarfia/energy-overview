const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const STATIC_DIR = path.join(ROOT, 'static');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const COMMON_HEADERS = {
  'user-agent': USER_AGENT,
  'accept-language': 'en-US,en;q=0.9',
};

const ENTSOE_TOKEN = (process.env.ENTSOE_API_TOKEN || '2b0fbf54-61ad-4086-b262-a044f934b56b').trim();
const NED_TOKEN = (process.env.NED_API_TOKEN || '14a2b9521747a7e962881d9ab640246497eeea4d9caa2adfc94d7ad39e976cf0').trim();
const TENNET_TOKEN = (process.env.TENNET_API_KEY || 'eb4e6c26-e63d-43f4-b3dd-da321d144de3').trim();

const ENTSOE_BASE = 'https://web-api.tp.entsoe.eu/api';
const ENTSOG_BASE = 'https://transparency.entsog.eu/api/v1';
const ENTSOG_NL_OPERATOR = 'NL-TSO-0001';

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (!text) return null;
  const m = text.match(/[-+]?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const raw = m[0].replace(',', '.');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseIsoUtc(text) {
  if (!text) return null;
  const d = new Date(text);
  return Number.isFinite(d.getTime()) ? d : null;
}

function toIso(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    q.set(k, String(v));
  }
  return q.toString();
}

async function fetchText(url, extraHeaders = {}, timeoutMs = 15000) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { ...COMMON_HEADERS, ...extraHeaders }, signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

async function fetchJson(url, extraHeaders = {}, timeoutMs = 15000) {
  const txt = await fetchText(url, extraHeaders, timeoutMs);
  return JSON.parse(txt);
}

function xmlTagValue(block, tagName) {
  const safe = tagName.replace('.', '\\.');
  const re = new RegExp(`<[^>]*${safe}[^>]*>([\\s\\S]*?)<\\/[^>]*${safe}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : '';
}

function xmlAll(block, tagName) {
  const safe = tagName.replace('.', '\\.');
  const re = new RegExp(`<[^>]*${safe}[^>]*>([\\s\\S]*?)<\\/[^>]*${safe}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(m[1]);
  return out;
}

function xmlBlocks(xml, tagName) {
  const safe = tagName.replace('.', '\\.');
  const re = new RegExp(`<[^>]*${safe}[^>]*>([\\s\\S]*?)<\\/[^>]*${safe}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function parsePeriodPoints(periodXml) {
  const start = parseIsoUtc(xmlTagValue(periodXml, 'start'));
  if (!start) return [];

  const resolution = (xmlTagValue(periodXml, 'resolution') || 'PT60M').toUpperCase();
  let stepMinutes = 60;
  const mM = resolution.match(/PT(\d+)M/);
  const mH = resolution.match(/PT(\d+)H/);
  if (mM) stepMinutes = Math.max(1, Number(mM[1]));
  else if (mH) stepMinutes = Math.max(1, Number(mH[1]) * 60);

  const pointBlocks = xmlBlocks(periodXml, 'Point');
  const points = [];
  for (const p of pointBlocks) {
    const pos = toNumber(xmlTagValue(p, 'position'));
    let val = toNumber(xmlTagValue(p, 'quantity'));
    if (val === null) val = toNumber(xmlTagValue(p, 'price.amount'));
    if (val === null) {
      const genericNums = xmlAll(p, 'amount').map(toNumber).filter((v) => v !== null);
      if (genericNums.length) val = genericNums[0];
    }
    if (pos === null || val === null) continue;
    const dt = new Date(start.getTime() + (Math.floor(pos) - 1) * stepMinutes * 60_000);
    points.push({ dt, value: val });
  }
  return points;
}

async function entsoeFetchXml(params) {
  const url = `${ENTSOE_BASE}?${query(params)}`;
  const xml = await fetchText(url, { accept: 'application/xml, text/xml' }, 12000);
  if (!xml.includes('<')) throw new Error('Invalid ENTSO-E XML');
  return { xml, url };
}

function fallbackItem(base, err) {
  const next = { ...base };
  const msg = err ? `fout: ${String(err.message || err)}` : 'bron tijdelijk niet bereikbaar';
  next.detail = base.detail ? `${base.detail} | ${msg}` : msg;
  next.updatedAt = new Date().toISOString();
  return next;
}

function loadPreviousOverviewMap() {
  try {
    const overviewPath = path.join(STATIC_DIR, 'overview.json');
    if (!fs.existsSync(overviewPath)) return new Map();
    const raw = fs.readFileSync(overviewPath, 'utf8');
    const payload = JSON.parse(raw);
    const rows = Array.isArray(payload?.items) ? payload.items : [];
    const out = new Map();
    for (const item of rows) {
      if (item && typeof item === 'object' && item.id) out.set(String(item.id), item);
    }
    return out;
  } catch {
    return new Map();
  }
}

function hasUsefulValue(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.value !== null && item.value !== undefined) return true;
  if (typeof item.valueText === 'string' && item.valueText.trim()) return true;
  if (Array.isArray(item.rows) && item.rows.some((r) => (r?.value !== null && r?.value !== undefined) || (typeof r?.valueText === 'string' && r.valueText.trim()))) return true;
  return false;
}

function cachedItemWithError(cachedItem, err) {
  const next = { ...cachedItem };
  const msg = err ? `tijdelijke bronstoring, laatste geldige waarde getoond | fout: ${String(err.message || err)}` : 'tijdelijke bronstoring, laatste geldige waarde getoond';
  next.detail = String(next.detail || '').includes('tijdelijke bronstoring') ? String(next.detail || '') : (next.detail ? `${next.detail} | ${msg}` : msg);
  next.updatedAt = new Date().toISOString();
  return next;
}

function sanitizeSourceUrl(raw) {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    for (const key of ['securityToken', 'apikey', 'authorization', 'token']) {
      u.searchParams.delete(key);
    }
    // Keep links user-friendly for cards.
    if (u.hostname.includes('web-api.tp.entsoe.eu')) return `${u.origin}${u.pathname}`;
    if (u.hostname.includes('api.tennet.eu')) return `${u.origin}${u.pathname}`;
    return u.toString();
  } catch {
    return raw;
  }
}

async function getDayAheadPower24h() {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);

  const start = new Date(now.getTime() - 2 * 24 * 3600_000);
  const end = new Date(now.getTime() + 4 * 24 * 3600_000);
  const fmt = (d) => {
    const y = d.getUTCFullYear();
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    const da = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return `${y}${mo}${da}${hh}${mi}`;
  };

  const params = {
    securityToken: ENTSOE_TOKEN,
    documentType: 'A44',
    processType: 'A01',
    in_Domain: '10YNL----------L',
    out_Domain: '10YNL----------L',
    periodStart: fmt(start),
    periodEnd: fmt(end),
  };

  const { xml, url } = await entsoeFetchXml(params);
  const periods = xmlBlocks(xml, 'Period');
  const hourMap = new Map();
  for (const p of periods) {
    const points = parsePeriodPoints(p);
    for (const pt of points) {
      const h = new Date(pt.dt);
      h.setUTCMinutes(0, 0, 0);
      hourMap.set(h.toISOString(), pt.value);
    }
  }
  if (!hourMap.size) throw new Error('No day-ahead rows from ENTSO-E');

  const nowHourUtc = new Date();
  nowHourUtc.setUTCMinutes(0, 0, 0);
  const rows = [];
  for (let i = 0; i < 24; i += 1) {
    const t = new Date(nowHourUtc.getTime() + i * 3600_000);
    const hh = String(t.getHours()).padStart(2, '0');
    rows.push({ hour: `${hh}:00`, value: hourMap.get(t.toISOString()) ?? null, unit: 'EUR/MWh' });
  }
  const first = rows.find((r) => r.value !== null);
  const nowLabel = `${String(new Date().getHours()).padStart(2, '0')}:00`;
  const nowRow = rows.find((r) => r.hour === nowLabel && r.value !== null);

  return {
    id: 'dayAheadPower24h',
    label: 'EPEX SPOT Day-Ahead NL (24h vooruit)',
    value: nowRow?.value ?? first?.value ?? null,
    unit: 'EUR/MWh',
    source: 'ENTSO-E Transparency API (EPEX SPOT NL)',
    sourceUrl: url,
    updatedAt: new Date().toISOString(),
    detail: 'Komende 24 uur per uur',
    rows,
  };
}

async function getTTFGas() {
  const sourceUrl = 'https://tradingeconomics.com/commodity/eu-natural-gas';
  let value = null;
  try {
    const html = await fetchText(sourceUrl);
    const m = html.match(/TEChartsMeta\s*=\s*(\[.*?\]);/s);
    if (m) {
      const arr = JSON.parse(m[1]);
      value = toNumber(arr?.[0]?.last);
    }
  } catch {
    // fallback below
  }
  if (value === null) {
    const altUrl = 'https://markets.businessinsider.com/commodities/dutch-ttf-gas';
    const html2 = await fetchText(altUrl);
    const m2 = html2.match(/"price"\s*:\s*{"raw"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i) || html2.match(/currentValue":([0-9]+(?:\.[0-9]+)?)/i);
    value = m2 ? toNumber(m2[1]) : null;
    if (value === null) throw new Error('Could not parse TTF from primary/fallback source');
    return {
      id: 'ttfGas',
      label: 'TTF Gas',
      value,
      unit: 'EUR/MWh',
      source: 'Business Insider Markets (fallback)',
      sourceUrl: altUrl,
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    id: 'ttfGas',
    label: 'TTF Gas',
    value,
    unit: 'EUR/MWh',
    source: 'TradingEconomics',
    sourceUrl,
    updatedAt: new Date().toISOString(),
  };
}

async function getETSPrice() {
  const sourceUrl = 'https://www.barchart.com/futures/quotes/CKJ26';
  const html = await fetchText(sourceUrl);
  const m = html.match(/"symbol":"CKJ26"[\s\S]*?"lastPrice":"([^"]+)"[\s\S]*?"tradeTime":"([^"]+)"/);
  if (!m) throw new Error('Could not parse ETS price');
  const value = toNumber(m[1]);
  if (value === null) throw new Error('No ETS numeric value');
  return {
    id: 'ets',
    label: 'EU ETS (ICE EUA Futures)',
    value,
    unit: 'EUR/tCO2',
    source: 'Barchart',
    sourceUrl,
    updatedAt: m[2] || new Date().toISOString(),
  };
}

async function getEntsoeGenerationMixShare() {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const start = new Date(now.getTime() - 24 * 3600_000);
  const end = new Date(now.getTime() + 3600_000);
  const fmt = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const { xml, url } = await entsoeFetchXml({
    securityToken: ENTSOE_TOKEN,
    documentType: 'A75',
    processType: 'A16',
    in_Domain: '10YNL----------L',
    periodStart: fmt(start),
    periodEnd: fmt(end),
  });

  const series = xmlBlocks(xml, 'TimeSeries');
  const byCode = new Map();
  for (const s of series) {
    const code = (xmlTagValue(s, 'psrType') || '').toUpperCase();
    if (!code) continue;
    let best = null;
    for (const p of xmlBlocks(s, 'Period')) {
      for (const point of parsePeriodPoints(p)) {
        if (!best || point.dt > best.dt) best = point;
      }
    }
    if (best) byCode.set(code, best.value);
  }

  const categoryCodes = {
    Gascentrales: ['B04'],
    Kolencentrales: ['B02', 'B03', 'B05'],
    Afval: ['B17'],
    Zon: ['B16'],
    Wind: ['B18', 'B19'],
    Biomassa: ['B01'],
    Kernenergie: ['B14'],
  };

  const rows = [];
  let total = 0;
  for (const [label, codes] of Object.entries(categoryCodes)) {
    const mw = codes.reduce((s, code) => s + (toNumber(byCode.get(code)) || 0), 0);
    if (mw > 0) {
      rows.push({ label, mw });
      total += mw;
    }
  }
  if (!rows.length || total <= 0) throw new Error('No generation mix values');

  return {
    id: 'nlGenerationMixShare',
    label: 'Opwek Mix NL (actuele verhouding)',
    value: null,
    unit: '',
    valueText: 'Verhouding per bron',
    source: 'ENTSO-E Transparency API',
    sourceUrl: url,
    updatedAt: new Date().toISOString(),
    detail: 'Relatieve verdeling per opwekbron',
    rows: rows.map((r) => ({ hour: r.label, value: (r.mw / total) * 100, unit: '%' })),
  };
}

async function getEntsoeElectricityOverview() {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const start = new Date(now.getTime() - 6 * 3600_000);
  const end = new Date(now.getTime() + 3600_000);
  const fmt = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;

  const { xml, url } = await entsoeFetchXml({
    securityToken: ENTSOE_TOKEN,
    documentType: 'A65',
    processType: 'A16',
    outBiddingZone_Domain: '10YNL----------L',
    periodStart: fmt(start),
    periodEnd: fmt(end),
  });

  let latest = null;
  for (const period of xmlBlocks(xml, 'Period')) {
    for (const point of parsePeriodPoints(period)) {
      if (!latest || point.dt > latest.dt) latest = point;
    }
  }
  if (!latest) throw new Error('No ENTSO-E load points');

  return {
    id: 'nlElectricityOverview',
    label: 'Elektriciteit NL (actuele load)',
    value: latest.value,
    unit: 'MW',
    source: 'ENTSO-E Transparency API',
    sourceUrl: url,
    updatedAt: latest.dt.toISOString(),
    detail: 'Actuele load uit ENTSO-E',
    rows: [],
  };
}

async function getEntsoeCrossBorderFlows() {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const start = new Date(now.getTime() - 6 * 3600_000);
  const end = new Date(now.getTime() + 3600_000);
  const fmt = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;

  const nl = '10YNL----------L';
  const neighbors = [
    ['Belgie', ['10YBE----------2']],
    ['Duitsland', ['10Y1001A1001A82H', '10Y1001A1001A83F']],
    ['Verenigd Koninkrijk', ['10YGB----------A']],
    ['Denemarken', ['10YDK-1--------W']],
    ['Noorwegen', ['10YNO-2--------T']],
  ];

  async function latestFlow(inDomain, outDomain) {
    const tries = ['A11', 'A09'];
    for (const doc of tries) {
      try {
        const { xml } = await entsoeFetchXml({
          securityToken: ENTSOE_TOKEN,
          documentType: doc,
          in_Domain: inDomain,
          out_Domain: outDomain,
          periodStart: fmt(start),
          periodEnd: fmt(end),
        });
        let latest = null;
        for (const period of xmlBlocks(xml, 'Period')) {
          for (const p of parsePeriodPoints(period)) {
            if (!latest || p.dt > latest.dt) latest = p;
          }
        }
        if (latest) return latest.value;
      } catch {
        // try next
      }
    }
    return null;
  }

  const rows = [];
  for (const [name, eics] of neighbors) {
    let net = null;
    for (const eic of eics) {
      const inToNl = await latestFlow(eic, nl);
      const outFromNl = await latestFlow(nl, eic);
      if (inToNl !== null || outFromNl !== null) {
        net = (inToNl || 0) - (outFromNl || 0);
        break;
      }
    }
    rows.push({ hour: name, value: net, unit: 'MW' });
  }

  const numeric = rows.filter((r) => r.value !== null);
  if (!numeric.length) throw new Error('No ENTSO-E cross-border rows');
  return {
    id: 'nlCrossBorderFlows',
    label: 'Cross-Border Physical Flows NL (live, netto)',
    value: numeric.reduce((s, r) => s + (r.value || 0), 0),
    unit: 'MW',
    source: 'ENTSO-E Transparency API',
    sourceUrl: ENTSOE_BASE,
    updatedAt: new Date().toISOString(),
    detail: 'Positief = netto import naar NL, negatief = netto export uit NL',
    rows,
  };
}

async function getGridFrequency() {
  const sourceUrl = 'https://mainsfrequency.com';
  const html = await fetchText(sourceUrl);
  const text = html.replace(/\s+/g, ' ');
  const m = text.match(/([4-5][0-9](?:[.,][0-9]{1,4})?)\s*hz/i);
  const value = m ? toNumber(m[1]) : null;
  if (value === null) throw new Error('No frequency value found');
  return {
    id: 'nlGridFrequency',
    label: 'Netfrequentie NL (actueel)',
    value,
    unit: 'Hz',
    source: 'mainsfrequency.com',
    sourceUrl,
    updatedAt: new Date().toISOString(),
    detail: 'Doelwaarde rond 50 Hz',
  };
}

async function getTennetRegulation() {
  if (!TENNET_TOKEN) throw new Error('TENNET_API_KEY ontbreekt');
  const sourceUrl = 'https://api.tennet.eu/publications/v1/balance-delta-high-res/latest';
  const payload = await fetchJson(sourceUrl, { apikey: TENNET_TOKEN, accept: 'application/json' }, 12000);
  const points = [];
  const series = payload?.Response?.TimeSeries || [];
  for (const ts of Array.isArray(series) ? series : [series]) {
    const periods = ts?.Period || [];
    for (const period of Array.isArray(periods) ? periods : [periods]) {
      const ps = period?.points || period?.Points || [];
      points.push(...(Array.isArray(ps) ? ps : [ps]));
    }
  }
  if (!points.length) throw new Error('No TenneT balance delta points');
  points.sort((a, b) => String(a.timeInterval_end || '').localeCompare(String(b.timeInterval_end || '')));
  const p = points[points.length - 1];

  const inPower = ['power_afrr_in', 'power_igcc_in', 'power_mari_in', 'power_mfrrda_in', 'power_picasso_in']
    .map((k) => toNumber(p[k]) || 0)
    .reduce((s, v) => s + v, 0);
  const outPower = ['power_afrr_out', 'power_igcc_out', 'power_mari_out', 'power_mfrrda_out', 'power_picasso_out']
    .map((k) => toNumber(p[k]) || 0)
    .reduce((s, v) => s + v, 0);

  const net = outPower - inPower;
  return {
    id: 'tennetRegulation',
    label: 'TenneT Balance Delta (actueel, 12s)',
    value: net,
    unit: 'MW',
    source: 'TenneT API (Balance Delta High Res)',
    sourceUrl,
    updatedAt: p.timeInterval_end || p.timeInterval_start || new Date().toISOString(),
    detail: `In ${inPower.toFixed(1)} MW | Out ${outPower.toFixed(1)} MW`,
  };
}

async function getTennetSettlement() {
  if (!TENNET_TOKEN) throw new Error('TENNET_API_KEY ontbreekt');
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 3600_000);
  const fmt = (d) => {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
  };
  const sourceUrl = `https://api.tennet.eu/publications/v1/settlement-prices?${query({ date_from: fmt(from), date_to: fmt(now) })}`;
  const payload = await fetchJson(sourceUrl, { apikey: TENNET_TOKEN, accept: 'application/json' }, 12000);
  const points = [];
  const series = payload?.Response?.TimeSeries || [];
  for (const ts of Array.isArray(series) ? series : [series]) {
    const periods = ts?.Period || [];
    for (const period of Array.isArray(periods) ? periods : [periods]) {
      const ps = period?.Points || period?.points || [];
      points.push(...(Array.isArray(ps) ? ps : [ps]));
    }
  }
  if (!points.length) {
    // Fallback to latest balance-delta prices when settlement endpoint has gaps.
    const bdUrl = 'https://api.tennet.eu/publications/v1/balance-delta-high-res/latest';
    const payload2 = await fetchJson(bdUrl, { apikey: TENNET_TOKEN, accept: 'application/json' }, 12000);
    const points2 = [];
    const series2 = payload2?.Response?.TimeSeries || [];
    for (const ts of Array.isArray(series2) ? series2 : [series2]) {
      const periods2 = ts?.Period || [];
      for (const period2 of Array.isArray(periods2) ? periods2 : [periods2]) {
        const ps2 = period2?.points || period2?.Points || [];
        points2.push(...(Array.isArray(ps2) ? ps2 : [ps2]));
      }
    }
    if (!points2.length) throw new Error('No settlement points');
    points2.sort((a, b) => String(a.timeInterval_end || '').localeCompare(String(b.timeInterval_end || '')));
    const p2 = points2[points2.length - 1];
    const mid = toNumber(p2.mid_price);
    const up = toNumber(p2.max_upw_regulation_price);
    const down = toNumber(p2.min_downw_regulation_price);
    const value2 = mid ?? up ?? down;
    if (value2 === null) throw new Error('No settlement points');
    return {
      id: 'tennetSettlement',
      label: 'TenneT Settlement Price (actueel)',
      value: value2,
      unit: 'EUR/MWh',
      source: 'TenneT API (fallback via Balance Delta)',
      sourceUrl: bdUrl,
      updatedAt: p2.timeInterval_end || p2.timeInterval_start || new Date().toISOString(),
      detail: `Fallback | Mid ${mid ?? 'n/a'} | Up ${up ?? 'n/a'} | Down ${down ?? 'n/a'}`,
    };
  }
  points.sort((a, b) => String(a.timeInterval_end || '').localeCompare(String(b.timeInterval_end || '')));
  const p = points[points.length - 1];
  const shortage = toNumber(p.shortage);
  const surplus = toNumber(p.surplus);
  const value = shortage ?? surplus;
  if (value === null) throw new Error('Settlement point has no shortage/surplus');

  return {
    id: 'tennetSettlement',
    label: 'TenneT Settlement Price (actueel)',
    value,
    unit: 'EUR/MWh',
    source: 'TenneT API (Settlement Prices)',
    sourceUrl,
    updatedAt: p.timeInterval_end || p.timeInterval_start || new Date().toISOString(),
    detail: `Shortage ${shortage ?? 'n/a'} | Surplus ${surplus ?? 'n/a'}`,
  };
}

function entsogGwhDay(value, unit) {
  const v = toNumber(value);
  if (v === null) return null;
  const u = String(unit || '').toLowerCase().replace(/\s+/g, '');
  if (u.includes('kwh')) return v / 1_000_000;
  if (u.includes('mwh')) return v / 1000;
  if (u.includes('gwh')) return v;
  return v / 1_000_000;
}

async function getEntsogOperational(indicator, daysBack = 4, limit = 6000) {
  const to = new Date();
  const from = new Date(to.getTime() - daysBack * 24 * 3600_000);
  const toDate = to.toISOString().slice(0, 10);
  const fromDate = from.toISOString().slice(0, 10);
  const sourceUrl = `${ENTSOG_BASE}/operationaldatas?${query({ operatorKey: ENTSOG_NL_OPERATOR, indicator, from: fromDate, to: toDate, limit })}`;
  const payload = await fetchJson(sourceUrl);
  const rows = payload?.operationaldatas || [];
  if (!rows.length) throw new Error(`No ENTSOG rows (${indicator})`);
  return { rows, sourceUrl };
}

async function getNlGasProduction() {
  const { rows, sourceUrl } = await getEntsogOperational('Allocation', 5, 5000);
  const prod = rows.filter((r) => String(r.directionKey || '').toLowerCase() === 'entry' && String(r.pointLabel || '').toLowerCase().includes('production'));
  if (!prod.length) throw new Error('No ENTSOG production rows');
  const latestTs = prod.map((r) => String(r.periodFrom || '')).sort().at(-1);
  const dayRows = prod.filter((r) => String(r.periodFrom || '') === latestTs);
  const total = dayRows.reduce((s, r) => s + (entsogGwhDay(r.value, r.unit) || 0), 0);
  return {
    id: 'nlGasProduction',
    label: 'Gaswinning NL (laatste dag)',
    value: total,
    unit: 'GWh/d',
    source: 'ENTSOG API',
    sourceUrl,
    updatedAt: parseIsoUtc(latestTs)?.toISOString() || new Date().toISOString(),
    detail: 'Lokale productie (ENTSOG Allocation)',
    rows: dayRows.slice(0, 6).map((r) => ({ hour: String(r.pointLabel || 'Productie'), value: entsogGwhDay(r.value, r.unit), unit: 'GWh/d' })),
  };
}

async function getNlGasImport() {
  const [{ rows: opRows }, { rows: flowRows, sourceUrl }] = await Promise.all([
    fetchJson(`${ENTSOG_BASE}/operatorpointdirections?${query({ operatorKey: ENTSOG_NL_OPERATOR, limit: 1200 })}`).then((p) => ({ rows: p.operatorpointdirections || [] })),
    getEntsogOperational('Physical Flow', 4, 6000),
  ]);

  const meta = new Map();
  for (const r of opRows) meta.set(String(r.pointKey || ''), r);

  const latestTs = flowRows.map((r) => String(r.periodFrom || '')).filter(Boolean).sort().at(-1);
  const rowsAtTs = flowRows.filter((r) => String(r.periodFrom || '') === latestTs);

  const countryMap = new Map();
  let lng = 0;
  let storage = 0;
  for (const r of rowsAtTs) {
    const m = meta.get(String(r.pointKey || '')) || {};
    const pointType = String(m.pointType || '');
    const country = String(m.adjacentCountry || '');
    const label = String(m.pointLabel || '').toLowerCase();
    const direction = String(r.directionKey || '').toLowerCase();
    const val = entsogGwhDay(r.value, r.unit);
    if (val === null) continue;

    if (pointType.includes('LNG') && direction === 'entry') lng += val;
    if ((pointType.includes('Storage') || pointType.includes('Cross-Border Storage')) && ['norg', 'grijpskerk', 'bergermeer', 'zuidwending'].some((k) => label.includes(k))) {
      storage += direction === 'entry' ? val : -val;
    }

    if (!pointType.includes('Cross-Border Transmission') || !country || country === 'NL') continue;
    const bucket = countryMap.get(country) || { in: 0, out: 0 };
    if (direction === 'entry') bucket.in += val;
    if (direction === 'exit') bucket.out += val;
    countryMap.set(country, bucket);
  }

  const names = [
    ['BE', 'Belgie'],
    ['DE', 'Duitsland'],
    ['GB', 'Verenigd Koninkrijk'],
    ['DK', 'Denemarken'],
    ['NO', 'Noorwegen'],
  ];
  const rows = names.map(([code, name]) => {
    const c = countryMap.get(code);
    return { hour: name, value: c ? c.in - c.out : null, unit: 'GWh/d' };
  });
  rows.push({ hour: 'LNG (Gate+EET)', value: lng, unit: 'GWh/d' });
  rows.push({ hour: 'Gasopslag (4 sites)', value: storage, unit: 'GWh/d' });

  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  return {
    id: 'nlGasImport',
    label: 'Gas Cross-Border Flows NL (per land, netto)',
    value: total,
    unit: 'GWh/d',
    source: 'ENTSOG API',
    sourceUrl,
    updatedAt: parseIsoUtc(latestTs)?.toISOString() || new Date().toISOString(),
    detail: 'Positief = netto import naar NL, negatief = netto export uit NL',
    rows,
  };
}

async function getNlGasStorage() {
  const sourceUrl = 'https://api.ned.nl/v1/utilizations';
  const now = new Date();
  const after = new Date(now.getTime() - 10 * 24 * 3600_000).toISOString().slice(0, 10);
  const before = new Date(now.getTime() + 24 * 3600_000).toISOString().slice(0, 10);
  const url = `${sourceUrl}?${query({ point: 0, granularity: 4, granularitytimezone: 0, 'validfrom[after]': after, itemsPerPage: 1200, type: 28, activity: 3 })}`;
  const payload = await fetchJson(url, {
    'X-AUTH-TOKEN': NED_TOKEN,
    authorization: `Bearer ${NED_TOKEN}`,
    accept: 'application/ld+json, application/json',
  });

  const rows = payload?.['hydra:member'] || payload?.member || payload?.items || payload?.data || [];
  if (!Array.isArray(rows) || !rows.length) throw new Error('No NED storage rows');
  const parsed = rows
    .map((r) => ({ dt: parseIsoUtc(r.validfrom || r.timestamp || r.date), pct: toNumber(r.percentage ?? r.value), rec: r }))
    .filter((x) => x.dt && x.pct !== null)
    .sort((a, b) => a.dt - b.dt);
  if (!parsed.length) throw new Error('No parseable NED storage row');
  const latest = parsed[parsed.length - 1];
  const pct = latest.pct <= 1 ? latest.pct * 100 : latest.pct;
  const gwh = 136780 * (pct / 100);

  return {
    id: 'nlGasStorage',
    label: 'NL Gasopslag (actueel)',
    value: pct,
    unit: '%',
    source: 'NED API',
    sourceUrl: url,
    updatedAt: latest.dt.toISOString(),
    detail: 'Nationale vullingsgraad met opslaginhoud (14 bcm rekenregel)',
    rows: [
      { hour: 'Opslaginhoud', value: gwh, unit: 'GWh' },
      { hour: 'Trend (4 opslagen)', valueText: 'Trend onbekend', unit: '' },
    ],
  };
}

async function getNlGasConsumptionBreakdown() {
  const sourceUrl = 'https://api.ned.nl/v1/utilizations';
  const map = [
    [55, 'Huishoudens & kleinzakelijk'],
    [53, 'Industrie'],
    [54, 'Gascentrales'],
  ];

  const now = new Date();
  const after = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString().slice(0, 10);
  const before = new Date(now.getTime() + 24 * 3600_000).toISOString().slice(0, 10);

  const totals = [];
  for (const [type, label] of map) {
    const url = `${sourceUrl}?${query({ point: 0, granularity: 4, granularitytimezone: 0, 'validfrom[after]': after, itemsPerPage: 1200, type, activity: 2 })}`;
    const payload = await fetchJson(url, {
      'X-AUTH-TOKEN': NED_TOKEN,
      authorization: `Bearer ${NED_TOKEN}`,
      accept: 'application/ld+json, application/json',
    });
    const rows = payload?.['hydra:member'] || payload?.member || payload?.items || payload?.data || [];
    const parsed = (Array.isArray(rows) ? rows : [])
      .map((r) => ({ dt: parseIsoUtc(r.validfrom || r.timestamp || r.date), value: toNumber(r.capacity ?? r.value ?? r.volume) }))
      .filter((x) => x.dt && x.value !== null)
      .sort((a, b) => a.dt - b.dt);
    if (!parsed.length) throw new Error(`No NED rows for ${label}`);
    const latest = parsed[parsed.length - 1];
    const mw = latest.value > 20_000 ? latest.value / 1000 : latest.value;
    const gwhDay = (mw * 24) / 1000;
    totals.push([label, gwhDay, latest.dt.toISOString()]);
  }

  const total = totals.reduce((s, t) => s + t[1], 0);
  const rows = totals.map(([label, gwh]) => ({ hour: label, value: (gwh / total) * 100, unit: '%' }));
  return {
    id: 'nlGasConsumptionBreakdown',
    label: 'Gasconsumptie NL (laatste volledige dag)',
    value: total,
    unit: 'GWh/d',
    source: 'NED API',
    sourceUrl,
    updatedAt: totals.map((t) => t[2]).sort().at(-1) || new Date().toISOString(),
    detail: 'Onderverdeling hieronder in percentages',
    rows,
  };
}

async function collectOverview() {
  const started = Date.now();
  const items = [];
  const errors = [];
  const previousById = loadPreviousOverviewMap();

  const fallbackRows24 = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(Date.now() + i * 3600_000);
    return { hour: `${String(d.getHours()).padStart(2, '0')}:00`, value: null, unit: 'EUR/MWh' };
  });

  const tasks = [
    [getDayAheadPower24h, { id: 'dayAheadPower24h', label: 'EPEX SPOT Day-Ahead NL (24h vooruit)', value: null, unit: 'EUR/MWh', source: 'ENTSO-E Transparency API (EPEX SPOT NL)', sourceUrl: ENTSOE_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: fallbackRows24 }],
    [getTTFGas, { id: 'ttfGas', label: 'TTF Gas', value: null, unit: 'EUR/MWh', source: 'TradingEconomics', sourceUrl: 'https://tradingeconomics.com/commodity/eu-natural-gas', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getETSPrice, { id: 'ets', label: 'EU ETS (ICE EUA Futures)', value: null, unit: 'EUR/tCO2', source: 'Barchart', sourceUrl: 'https://www.barchart.com/futures/quotes/CKJ26', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getEntsoeGenerationMixShare, { id: 'nlGenerationMixShare', label: 'Opwek Mix NL (actuele verhouding)', value: null, unit: '', valueText: 'Verhouding per bron', source: 'ENTSO-E Transparency API', sourceUrl: ENTSOE_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [] }],
    [getNlGasImport, { id: 'nlGasImport', label: 'Gas Cross-Border Flows NL (per land, netto)', value: null, unit: 'GWh/d', source: 'ENTSOG API', sourceUrl: ENTSOG_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [{ hour: 'Belgie', value: null, unit: 'GWh/d' }, { hour: 'Duitsland', value: null, unit: 'GWh/d' }, { hour: 'Verenigd Koninkrijk', value: null, unit: 'GWh/d' }, { hour: 'Denemarken', value: null, unit: 'GWh/d' }, { hour: 'Noorwegen', value: null, unit: 'GWh/d' }, { hour: 'LNG (Gate+EET)', value: null, unit: 'GWh/d' }, { hour: 'Gasopslag (4 sites)', value: null, unit: 'GWh/d' }] }],
    [getNlGasProduction, { id: 'nlGasProduction', label: 'Gaswinning NL (laatste dag)', value: null, unit: 'GWh/d', source: 'ENTSOG API', sourceUrl: ENTSOG_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getEntsoeCrossBorderFlows, { id: 'nlCrossBorderFlows', label: 'Cross-Border Physical Flows NL (live, netto)', value: null, unit: 'MW', source: 'ENTSO-E Transparency API', sourceUrl: ENTSOE_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [{ hour: 'Belgie', value: null, unit: 'MW' }, { hour: 'Duitsland', value: null, unit: 'MW' }, { hour: 'Verenigd Koninkrijk', value: null, unit: 'MW' }, { hour: 'Denemarken', value: null, unit: 'MW' }, { hour: 'Noorwegen', value: null, unit: 'MW' }] }],
    [getNlGasStorage, { id: 'nlGasStorage', label: 'NL Gasopslag (actueel)', value: null, unit: '%', source: 'NED API', sourceUrl: 'https://api.ned.nl/v1/utilizations', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getEntsoeElectricityOverview, { id: 'nlElectricityOverview', label: 'Elektriciteit NL (actuele load)', value: null, unit: 'MW', source: 'ENTSO-E Transparency API', sourceUrl: ENTSOE_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [] }],
    [getGridFrequency, { id: 'nlGridFrequency', label: 'Netfrequentie NL (actueel)', value: null, unit: 'Hz', source: 'mainsfrequency.com', sourceUrl: 'https://mainsfrequency.com', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getNlGasConsumptionBreakdown, { id: 'nlGasConsumptionBreakdown', label: 'Gasconsumptie NL (laatste volledige dag)', value: null, unit: 'GWh/d', source: 'NED API', sourceUrl: 'https://api.ned.nl/v1/utilizations', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [] }],
    [getTennetRegulation, { id: 'tennetRegulation', label: 'TenneT Balance Delta (actueel, 12s)', value: null, unit: 'MW', source: 'TenneT API (Balance Delta High Res)', sourceUrl: 'https://api.tennet.eu/publications/v1/balance-delta-high-res/latest', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getTennetSettlement, { id: 'tennetSettlement', label: 'TenneT Settlement Price (actueel)', value: null, unit: 'EUR/MWh', source: 'TenneT API (Settlement Prices)', sourceUrl: 'https://api.tennet.eu/publications/v1/settlement-prices', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
  ];

  // Keep the same card layout; unavailable Gaslicht sources stay visible with placeholders.
  const staticFallbacks = [
    { id: 'gaslichtElectricity', label: 'Cheapest Electricity Provider (Gaslicht)', value: null, unit: 'EUR/kWh', source: 'Gaslicht', sourceUrl: 'https://www.gaslicht.com/stroom-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&stroomhoogverbruik=1000&stroomlaagverbruik=1000', updatedAt: new Date().toISOString(), detail: 'Deze scraper is nog niet omgezet naar JavaScript backend' },
    { id: 'gaslichtGas', label: 'Cheapest Gas Provider (Gaslicht)', value: null, unit: 'EUR/m3', source: 'Gaslicht', sourceUrl: 'https://www.gaslicht.com/gas-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&gasverbruik=1000', updatedAt: new Date().toISOString(), detail: 'Deze scraper is nog niet omgezet naar JavaScript backend' },
    { id: 'gaslichtLongestContract', label: 'Langste Contractduur (Gaslicht)', value: null, unit: 'jaar', source: 'Gaslicht', sourceUrl: 'https://www.gaslicht.com/energievergelijken/', updatedAt: new Date().toISOString(), detail: 'Deze scraper is nog niet omgezet naar JavaScript backend' },
    { id: 'gaslichtLongestContractElectricity', label: 'Langste Contractduur Stroom', value: null, unit: 'jaar', source: 'Gaslicht', sourceUrl: 'https://www.gaslicht.com/stroom-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&stroomhoogverbruik=1000&stroomlaagverbruik=1000', updatedAt: new Date().toISOString(), detail: 'Deze scraper is nog niet omgezet naar JavaScript backend' },
  ];

  for (const [fn, fb] of tasks) {
    try {
      items.push(await fn());
    } catch (err) {
      errors.push({ source: fn.name, error: String(err.message || err) });
      const fbId = fb?.id ? String(fb.id) : null;
      const previous = fbId ? previousById.get(fbId) : null;
      if (previous && hasUsefulValue(previous)) {
        items.push(cachedItemWithError(previous, err));
      } else if (fb) {
        items.push(fallbackItem(fb, err));
      }
    }
  }
  items.push(...staticFallbacks);

  const cleanedItems = items.map((it) => ({ ...it, sourceUrl: sanitizeSourceUrl(it?.sourceUrl) }));
  return {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    items: cleanedItems,
    errors,
    note: 'Data is fetched from public APIs/sources and may lag or change format.',
  };
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/overview') {
      const payload = await collectOverview();
      const body = Buffer.from(JSON.stringify(payload));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) });
      res.end(body);
      return;
    }

    let rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.normalize(path.join(STATIC_DIR, rel));
    if (!full.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const data = fs.readFileSync(full);
    res.writeHead(200, { 'content-type': contentType(full), 'content-length': String(data.length) });
    res.end(data);
  } catch (err) {
    const msg = String(err?.message || err || 'Internal error');
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: msg }));
  }
}

async function generateStaticOverview() {
  const payload = await collectOverview();
  const outPath = path.join(STATIC_DIR, 'overview.json');
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
}

async function main() {
  if (process.argv.includes('--generate-static')) {
    await generateStaticOverview();
    return;
  }

  const port = Number(process.env.PORT || 8000);
  http.createServer(handler).listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
