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
const OVERSTAPPEN_GAS_URL = 'https://www.overstappen.nl/energie/gasprijzen/';
const OVERSTAPPEN_POWER_URL = 'https://www.overstappen.nl/energie/stroomprijs/';

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

async function fetchNedUtilizations(params) {
  const sourceUrl = 'https://api.ned.nl/v1/utilizations';
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10);
  const url = `${sourceUrl}?${query({ classification: 2, 'validfrom[strictly_before]': tomorrow, ...params })}`;
  const payload = await fetchJson(url, {
    'X-AUTH-TOKEN': NED_TOKEN,
    authorization: `Bearer ${NED_TOKEN}`,
    accept: 'application/ld+json, application/json',
  });
  const rows = payload?.['hydra:member'] || payload?.member || payload?.items || payload?.data || payload?.results || [];
  return { rows: Array.isArray(rows) ? rows : [], url };
}

function extractRowsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.data?.rows)) return payload.data.rows;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function htmlDecode(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function pickLatestRow(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const rowScore = (r) => {
    const d = parseIsoUtc(r?.datum || r?.date || r?.time || r?.timestamp || r?.validfrom || '');
    return d ? d.getTime() : -1;
  };
  return [...rows].sort((a, b) => rowScore(a) - rowScore(b)).at(-1) || rows[rows.length - 1];
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

function getPreviousItemById(id) {
  const m = loadPreviousOverviewMap();
  return m.get(String(id)) || null;
}

function hasUsefulValue(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.id === 'nlGenerationMixShare') {
    return Array.isArray(item.rows) && item.rows.some((r) => Number.isFinite(Number(r?.value)));
  }
  if (item.value !== null && item.value !== undefined) return true;
  if (typeof item.valueText === 'string' && item.valueText.trim()) return true;
  if (Array.isArray(item.rows) && item.rows.some((r) => (r?.value !== null && r?.value !== undefined) || (typeof r?.valueText === 'string' && r.valueText.trim()))) return true;
  return false;
}

function cachedItemWithError(cachedItem, err) {
  const next = { ...cachedItem };
  const msg = err ? `tijdelijke bronstoring, laatste geldige waarde getoond | fout: ${String(err.message || err)}` : 'tijdelijke bronstoring, laatste geldige waarde getoond';
  next.detail = String(next.detail || '').includes('tijdelijke bronstoring') ? String(next.detail || '') : (next.detail ? `${next.detail} | ${msg}` : msg);
  // Keep the measurement timestamp. Overwriting it made stale data look current.
  next.dataStatus = 'stale';
  next.statusMessage = 'Bron tijdelijk niet beschikbaar; dit is de laatste geldige meting.';
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
  const hourBuckets = new Map();
  for (const p of periods) {
    const points = parsePeriodPoints(p);
    for (const pt of points) {
      const h = new Date(pt.dt);
      h.setUTCMinutes(0, 0, 0);
      const key = h.toISOString();
      const bucket = hourBuckets.get(key) || [];
      bucket.push(pt.value);
      hourBuckets.set(key, bucket);
    }
  }
  if (!hourBuckets.size) throw new Error('No day-ahead rows from ENTSO-E');

  const hourly = [...hourBuckets.entries()]
    .map(([timestamp, values]) => ({
      dt: new Date(timestamp),
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
      samples: values.length,
    }))
    .sort((a, b) => a.dt - b.dt);
  const localDate = (date) => new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
  const localHour = (date) => new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  const todayKey = localDate(new Date());
  const selected = hourly.filter((point) => localDate(point.dt) === todayKey);
  if (selected.length < 2) throw new Error('No day-ahead prices for the current Dutch delivery day');
  const rows = selected.map((point) => {
    return {
      hour: `Vandaag ${localHour(point.dt)}`,
      value: point.value,
      unit: 'EUR/MWh',
      timestamp: point.dt.toISOString(),
      samples: point.samples,
    };
  });
  const nowHourUtc = new Date();
  nowHourUtc.setUTCMinutes(0, 0, 0);
  const nowRow = rows.find((row) => row.timestamp === nowHourUtc.toISOString());
  const first = rows[0];

  return {
    id: 'dayAheadPower24h',
    label: 'Stroomprijs vandaag (day-ahead)',
    value: nowRow?.value ?? first?.value ?? null,
    unit: 'EUR/MWh',
    source: 'ENTSO-E Transparency API (EPEX SPOT NL)',
    sourceUrl: url,
    updatedAt: new Date().toISOString(),
    detail: `${rows.length} leveringsuren van vandaag; gisteren vastgesteld, kwartierprijzen gemiddeld per uur`,
    dataStatus: 'verified',
    statusMessage: `${rows.reduce((sum, row) => sum + row.samples, 0)} ENTSO-E-prijspunten gecontroleerd`,
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

const ICE_TTF_PRODUCT_URL = 'https://www.ice.com/products/82843860/ICE-Futures-Europe-Dutch-TTF-Natural-Gas-Futures/data';
const ICE_TTF_CONTRACTS_URL = 'https://www.ice.com/marketdata/api/productguide/charting/contract-data?productId=28456&hubId=29327';
const ICE_MONTH_CODES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function iceTtfContractCode(year, monthIndex) {
  return `${ICE_MONTH_CODES[monthIndex]}${String(year).slice(-2)}`;
}

function parseIceBarTimestamp(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const includesTimezone = /(?:Z|GMT|UTC|[+-]\d{2}:?\d{2})$/i.test(text);
  const parsed = new Date(includesTimezone ? text : `${text} UTC`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function getIceTtfSettlementSeries(marketId) {
  const url = `https://www.ice.com/marketdata/api/productguide/charting/data/historical?${query({ marketId, historicalSpan: 1 })}`;
  const payload = await fetchJson(url, { accept: 'application/json' });
  const bars = Array.isArray(payload?.bars) ? payload.bars : [];
  const byTimestamp = new Map();
  for (const bar of bars) {
    if (!Array.isArray(bar) || bar.length < 2) continue;
    const measuredAt = parseIceBarTimestamp(bar[0]);
    const value = toNumber(bar[1]);
    if (!measuredAt || value === null) continue;
    byTimestamp.set(measuredAt.getTime(), value);
  }
  if (!byTimestamp.size) throw new Error(`Geen ICE-slotprijzen voor markt ${marketId}`);
  return byTimestamp;
}

async function getTtfStorageSpread() {
  const now = new Date();
  const monthAheadDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthAheadCode = iceTtfContractCode(monthAheadDate.getUTCFullYear(), monthAheadDate.getUTCMonth());

  // Use the next complete storage winter: October through March.
  const winterStartYear = now.getUTCMonth() <= 8 ? now.getUTCFullYear() : now.getUTCFullYear() + 1;
  const winterMonths = [
    { year: winterStartYear, month: 9 },
    { year: winterStartYear, month: 10 },
    { year: winterStartYear, month: 11 },
    { year: winterStartYear + 1, month: 0 },
    { year: winterStartYear + 1, month: 1 },
    { year: winterStartYear + 1, month: 2 },
  ];
  const wanted = [
    { year: monthAheadDate.getUTCFullYear(), month: monthAheadDate.getUTCMonth(), code: monthAheadCode, role: 'monthAhead' },
    ...winterMonths.map(({ year, month }) => ({ year, month, code: iceTtfContractCode(year, month), role: 'winter' })),
  ];

  const markets = await fetchJson(ICE_TTF_CONTRACTS_URL, { accept: 'application/json' });
  if (!Array.isArray(markets)) throw new Error('Ongeldige ICE-contractlijst');
  const marketByCode = new Map(markets.map((market) => [String(market?.marketStrip || ''), market]));
  const missing = wanted.filter((contract) => !marketByCode.has(contract.code));
  if (missing.length) throw new Error(`ICE-contract(en) ontbreken: ${missing.map((contract) => contract.code).join(', ')}`);

  const contracts = await Promise.all(wanted.map(async (contract) => {
    const market = marketByCode.get(contract.code);
    const series = await getIceTtfSettlementSeries(market.marketId);
    return { ...contract, marketId: market.marketId, series };
  }));

  let commonTimestamps = [...contracts[0].series.keys()];
  for (const contract of contracts.slice(1)) {
    commonTimestamps = commonTimestamps.filter((timestamp) => contract.series.has(timestamp));
  }
  if (!commonTimestamps.length) throw new Error('Geen gelijk ICE-slotmoment voor alle zeven termijncontracten');
  const measuredTimestamp = Math.max(...commonTimestamps);
  const priced = contracts.map((contract) => ({ ...contract, price: contract.series.get(measuredTimestamp) }));
  const monthAhead = priced.find((contract) => contract.role === 'monthAhead');
  const winter = priced.filter((contract) => contract.role === 'winter');
  if (!monthAhead || winter.length !== 6) throw new Error('Onvolledige TTF-zomer/wintervergelijking');

  // A season is a base-load strip. Weight the monthly prices by delivery hours.
  const winterHours = winter.reduce((sum, contract) => {
    const days = new Date(Date.UTC(contract.year, contract.month + 1, 0)).getUTCDate();
    return sum + days * 24;
  }, 0);
  const winterPrice = winter.reduce((sum, contract) => {
    const days = new Date(Date.UTC(contract.year, contract.month + 1, 0)).getUTCDate();
    return sum + contract.price * days * 24;
  }, 0) / winterHours;
  const spread = winterPrice - monthAhead.price;
  const winterLabel = `${String(winterStartYear).slice(-2)}/${String(winterStartYear + 1).slice(-2)}`;
  const formatPrice = (value, signed = false) => {
    const sign = signed && value > 0 ? '+' : signed && value < 0 ? '\u2212' : '';
    return `${sign}${Math.abs(value).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR/MWh`;
  };
  const verdict = spread > 0
    ? `Mogelijk · ${formatPrice(spread, true)} bruto`
    : spread < 0
      ? `Niet opslaan · ${formatPrice(spread, true)}`
      : 'Neutraal · 0,00 EUR/MWh';

  return {
    id: 'ttfStorageSpread',
    label: 'Zomer–winterspread opslag',
    value: spread,
    valueText: verdict,
    unit: 'EUR/MWh',
    source: 'ICE TTF vertraagde slotprijzen',
    sourceUrl: ICE_TTF_PRODUCT_URL,
    updatedAt: new Date(measuredTimestamp).toISOString(),
    detail: `Winter ${winterLabel} (okt–mrt) minus Month-Ahead ${monthAheadCode}; exclusief opslagkosten, gasverlies en financiering`,
    dataStatus: 'verified',
    statusMessage: 'Zeven TTF-maandcontracten zijn vergeleken op exact hetzelfde ICE-slotmoment.',
    rows: [
      { hour: `Nu kopen · Month-Ahead ${monthAheadCode}`, valueText: formatPrice(monthAhead.price) },
      { hour: `In winter · okt–mrt ${winterLabel}`, valueText: formatPrice(winterPrice) },
    ],
    quality: {
      monthAheadContract: monthAheadCode,
      monthAheadPrice: monthAhead.price,
      winterContracts: winter.map((contract) => ({ code: contract.code, price: contract.price })),
      winterPrice,
      spread,
      winterHours,
    },
  };
}

async function getETSPrice() {
  const sourceUrl = 'https://www.barchart.com/futures/quotes/CK*0';
  const html = await fetchText(sourceUrl);
  const m = html.match(/"symbol":"(CK[A-Z]\d{2})"[\s\S]*?"lastPrice":"([^"]+)"[\s\S]*?"tradeTime":"([^"]+)"/);
  if (!m) throw new Error('Could not parse ETS price');
  const value = toNumber(m[2]);
  if (value === null) throw new Error('No ETS numeric value');
  return {
    id: 'ets',
    label: 'EU ETS (ICE EUA frontcontract)',
    value,
    unit: 'EUR/tCO2',
    source: 'Barchart',
    sourceUrl,
    updatedAt: new Date().toISOString(),
    detail: `Doorlopend EUA-frontcontract ${m[1]} | laatste handel ${m[3]}`,
  };
}

async function getEntsoeGenerationMixShare() {
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const start = new Date(now.getTime() - 24 * 3600_000);
  const end = new Date(now.getTime() + 3600_000);
  const fmt = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const attempts = [
    { documentType: 'A75', processType: 'A16', in_Domain: '10YNL----------L' },
    { documentType: 'A75', processType: 'A01', in_Domain: '10YNL----------L' },
    { documentType: 'A75', processType: 'A16', In_Domain: '10YNL----------L' },
    { documentType: 'A75', in_Domain: '10YNL----------L' },
    { documentType: 'A75', biddingZone_Domain: '10YNL----------L' },
    { documentType: 'A75', BiddingZone_Domain: '10YNL----------L' },
    { documentType: 'A75', processType: 'A16', outBiddingZone_Domain: '10YNL----------L' },
    { documentType: 'A75', processType: 'A16', inBiddingZone_Domain: '10YNL----------L' },
  ];

  let byCode = new Map();
  let usedUrl = ENTSOE_BASE;
  let measuredAt = null;
  for (const att of attempts) {
    try {
      const { xml, url } = await entsoeFetchXml({
        securityToken: ENTSOE_TOKEN,
        periodStart: fmt(start),
        periodEnd: fmt(end),
        ...att,
      });
      const series = xmlBlocks(xml, 'TimeSeries');
      const nextByCode = new Map();
      let nextMeasuredAt = null;
      for (const s of series) {
        const code = (xmlTagValue(s, 'psrType') || '').toUpperCase();
        if (!code) continue;
        let best = null;
        for (const p of xmlBlocks(s, 'Period')) {
          for (const point of parsePeriodPoints(p)) {
            if (!best || point.dt > best.dt) best = point;
          }
        }
        if (best) {
          nextByCode.set(code, best.value);
          if (!nextMeasuredAt || best.dt > nextMeasuredAt) nextMeasuredAt = best.dt;
        }
      }
      if (nextByCode.size) {
        byCode = nextByCode;
        usedUrl = url;
        measuredAt = nextMeasuredAt;
        break;
      }
    } catch {
      // try next
    }
  }

  const categoryCodes = {
    Gascentrales: ['B04'],
    Kolencentrales: ['B02', 'B03', 'B05'],
    Afval: ['B17'],
    Zon: ['B16'],
    Wind: ['B18', 'B19'],
    Biomassa: ['B01'],
    Kernenergie: ['B14'],
    Overig: ['B06', 'B07', 'B08', 'B09', 'B10', 'B11', 'B12', 'B13', 'B15', 'B20'],
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
    label: 'Nederlandse productiemix',
    value: null,
    unit: '',
    valueText: 'Verhouding per bron',
    source: 'ENTSO-E Transparency API',
    sourceUrl: usedUrl,
    updatedAt: (measuredAt || new Date()).toISOString(),
    detail: `Actuele relatieve verdeling; totaal van getoonde bronnen ${total.toFixed(0)} MW`,
    dataStatus: 'verified',
    statusMessage: `${rows.length} ENTSO-E-productiecategorieën gecontroleerd`,
    quality: { totalGenerationMw: total },
    rows: rows.map((r) => ({ hour: r.label, value: (r.mw / total) * 100, unit: '%', mw: r.mw })),
  };
}

function nedValueToMw(rec) {
  const unit = String(rec?.unit || rec?.unitofmeasure || rec?.uom || '').toLowerCase();
  const raw = toNumber(rec?.capacity ?? rec?.value ?? rec?.volume ?? rec?.percentage);
  if (raw === null) return null;
  if (unit.includes('mw')) return raw;
  if (unit.includes('kw')) return raw / 1000;
  if (unit.includes('%')) return null;
  return raw > 20000 ? raw / 1000 : raw;
}

function mixLabelFromText(text) {
  const k = String(text || '').toLowerCase();
  if (k.includes('gas') || k.includes('aardgas') || k.includes('ccgt')) return 'Gascentrales';
  if (k.includes('kool') || k.includes('coal') || k.includes('lignite')) return 'Kolencentrales';
  if (k.includes('afval') || k.includes('waste')) return 'Afval';
  if (k.includes('zon') || k.includes('solar') || k.includes('pv')) return 'Zon';
  if (k.includes('wind') || k.includes('offshore') || k.includes('onshore')) return 'Wind';
  if (k.includes('biomass') || k.includes('biomassa') || k.includes('biogas')) return 'Biomassa';
  if (k.includes('kern') || k.includes('nuclear')) return 'Kernenergie';
  return null;
}

function extractMixSumsFromObject(payload) {
  const sums = {
    Gascentrales: 0,
    Kolencentrales: 0,
    Afval: 0,
    Zon: 0,
    Wind: 0,
    Biomassa: 0,
    Kernenergie: 0,
  };

  function walk(node, path = []) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) walk(node[i], [...path, String(i)]);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const nextPath = [...path, key];
      if (value && typeof value === 'object') {
        walk(value, nextPath);
        continue;
      }
      const n = toNumber(value);
      if (n === null || !Number.isFinite(n) || n <= 0 || n > 1_000_000) continue;
      const blob = nextPath.join(' ').toLowerCase();
      const label = mixLabelFromText(blob);
      if (!label) continue;
      if (blob.includes('percentage') || blob.includes('share') || blob.includes('%')) continue;
      sums[label] += n;
    }
  }

  walk(payload, []);
  return sums;
}

async function getNedGenerationMixShare() {
  const now = new Date();
  const after = now.toISOString().slice(0, 10);
  const types = [
    [17, 'Wind op zee'],
    [2, 'Zon'],
    [18, 'Gascentrales'],
    [19, 'Kolencentrales'],
    [20, 'Kernenergie'],
    [21, 'Afval'],
    [25, 'Biomassa'],
    [35, 'WKK'],
  ];
  const byLabel = new Map();
  let sourceUrl = 'https://api.ned.nl/v1/utilizations';

  const latestForType = async (type) => {
    for (const att of [{ type, activity: 1 }, { type }, { type, activity: 2 }]) {
      try {
        const res = await fetchNedUtilizations({
          point: 0,
          granularity: 4,
          granularitytimezone: 0,
          'validfrom[after]': after,
          itemsPerPage: 200,
          ...att,
        });
        const parsed = res.rows
          .map((row) => ({ dt: parseIsoUtc(row.validfrom || row.timestamp || row.date), mw: nedValueToMw(row) }))
          .filter((entry) => entry.dt && entry.mw !== null && entry.mw >= 0)
          .sort((a, b) => a.dt - b.dt);
        if (parsed.length) return { ...parsed[parsed.length - 1], url: res.url };
      } catch {
        // Try the next official activity selection.
      }
    }
    return null;
  };

  const totalMeasurement = await latestForType(27);
  if (!totalMeasurement || !(totalMeasurement.mw > 0)) throw new Error('No current NED ElectricityMix total');
  sourceUrl = totalMeasurement.url;
  const targetDt = totalMeasurement.dt;

  for (const [type, label] of types) {
    const measurement = await latestForType(type);
    if (!measurement) continue;
    const ageMinutes = Math.abs(targetDt.getTime() - measurement.dt.getTime()) / 60_000;
    if (ageMinutes > 120) continue;
    byLabel.set(label, measurement.mw);
  }

  const knownEntries = Array.from(byLabel.entries()).filter(([, value]) => Number.isFinite(value) && value > 0);
  const knownTotal = knownEntries.reduce((sum, [, value]) => sum + value, 0);
  const total = totalMeasurement.mw;
  const residual = total - knownTotal;
  if (!knownEntries.length || total <= 0) throw new Error('No NED generation mix values');
  if (residual > 0) byLabel.set('Overig / niet uitgesplitst', residual);

  const order = ['Gascentrales', 'WKK', 'Kolencentrales', 'Afval', 'Zon', 'Wind op zee', 'Biomassa', 'Kernenergie', 'Overig / niet uitgesplitst'];
  const rows = order
    .map((label) => {
      const val = byLabel.get(label);
      return val ? { hour: label, value: (val / total) * 100, unit: '%', mw: val } : null;
    })
    .filter(Boolean);

  return {
    id: 'nlGenerationMixShare',
    label: 'Nederlandse productiemix',
    value: null,
    unit: '',
    valueText: 'Verhouding per bron',
    source: 'NED API',
    sourceUrl,
    updatedAt: targetDt.toISOString(),
    detail: `Verdeling tegen officieel NED-totaal ${total.toFixed(0)} MW; niet afzonderlijk gepubliceerde productie staat onder Overig`,
    dataStatus: residual >= -total * 0.05 ? 'verified' : 'warning',
    statusMessage: `${rows.length} categorieën sluiten aan op NED ElectricityMix totaal`,
    quality: { totalGenerationMw: total, categorizedGenerationMw: knownTotal, residualGenerationMw: residual },
    rows,
  };
}

async function getNedGenerationMixShareFromUtilizations() {
  const now = new Date();
  const after = new Date(now.getTime() - 3 * 24 * 3600_000).toISOString().slice(0, 10);
  const types = [
    [1, 'Wind'],
    [17, 'Wind'],
    [2, 'Zon'],
    [18, 'Gascentrales'],
    [19, 'Kolencentrales'],
    [20, 'Kernenergie'],
    [21, 'Afval'],
    [25, 'Biomassa'],
    [26, 'Overig'],
    [35, 'WKK'],
  ];

  const sums = new Map();
  let sourceUrl = 'https://api.ned.nl/v1/utilizations';
  let latestDt = null;
  for (const [type, label] of types) {
    let best = null;
    let bestDt = null;
    let localUrl = sourceUrl;
    const attempts = [
      { type, activity: 1 },
      { type, activity: 2 },
      { type },
    ];
    for (const att of attempts) {
      try {
        const res = await fetchNedUtilizations({
          point: 0,
          granularity: 4,
          granularitytimezone: 0,
          'validfrom[after]': after,
          itemsPerPage: 800,
          ...att,
        });
        localUrl = res.url;
        for (const r of res.rows) {
          const dt = parseIsoUtc(r.validfrom || r.timestamp || r.date);
          const mw = nedValueToMw(r);
          if (!dt || mw === null || mw <= 0) continue;
          if (!bestDt || dt > bestDt) {
            bestDt = dt;
            best = mw;
          }
        }
        if (best !== null) break;
      } catch {
        // try next
      }
    }
    if (best !== null) {
      sums.set(label, (sums.get(label) || 0) + best);
      sourceUrl = localUrl;
      if (!latestDt || (bestDt && bestDt > latestDt)) latestDt = bestDt;
    }
  }

  const total = Array.from(sums.values()).reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error('No NED utilizations generation mix values');
  const order = ['Gascentrales', 'WKK', 'Kolencentrales', 'Afval', 'Zon', 'Wind', 'Biomassa', 'Kernenergie', 'Overig'];
  const rows = order
    .map((k) => (sums.get(k) ? { hour: k, value: (sums.get(k) / total) * 100, unit: '%', mw: sums.get(k) } : null))
    .filter(Boolean);

  return {
    id: 'nlGenerationMixShare',
    label: 'Nederlandse productiemix',
    value: null,
    unit: '',
    valueText: 'Verhouding per bron',
    source: 'NED API (utilizations fallback)',
    sourceUrl,
    updatedAt: (latestDt || new Date()).toISOString(),
    detail: `Actuele relatieve verdeling; totaal van getoonde bronnen ${total.toFixed(0)} MW`,
    dataStatus: 'verified',
    statusMessage: `${rows.length} NED-productiecategorieën gecontroleerd`,
    quality: { totalGenerationMw: total },
    rows,
  };
}

async function getNedGenerationMixShareFromDataportaal() {
  const pageUrl = 'https://ned.nl/nl/dataportaal/energie-productie/elektriciteit/totale-elektriciteitsproductie';
  const pageHtml = await fetchText(pageUrl, {}, 15000);
  const candidates = new Set([
    'totale-elektriciteitsproductie',
    'elektriciteitsproductie',
    'elektriciteitsproductie-totaal',
  ]);

  const patterns = [
    /grafiek\/data\/([a-z0-9-]+)\/current/gi,
    /data-dataset=["']([a-z0-9-]+)["']/gi,
    /dataset["']?\s*:\s*["']([a-z0-9-]+)["']/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(pageHtml))) {
      if (m?.[1]) candidates.add(String(m[1]));
    }
  }

  let lastErr = null;
  for (const dataset of candidates) {
    try {
      const dataUrl = `https://www.energieopwek.nl/grafiek/data/${dataset}/current`;
      const payload = await fetchJson(dataUrl, {}, 15000);
      const rows = extractRowsFromPayload(payload);
      const latest = pickLatestRow(rows);
      if (!latest || typeof latest !== 'object') continue;

      // Try both wide rows (many numeric columns) and narrow rows (label/value pairs).
      const sums = {
        Gascentrales: 0,
        Kolencentrales: 0,
        Afval: 0,
        Zon: 0,
        Wind: 0,
        Biomassa: 0,
        Kernenergie: 0,
      };

      // wide style
      for (const [key, value] of Object.entries(latest)) {
        if (['datum', 'date', 'time', 'timestamp', 'validfrom', 'total', 'totaal'].includes(String(key).toLowerCase())) continue;
        const label = mixLabelFromText(key);
        const n = toNumber(value);
        if (!label || n === null || n <= 0) continue;
        sums[label] += n;
      }
      // narrow style fallback
      if (Object.values(sums).reduce((a, b) => a + b, 0) <= 0) {
        for (const row of rows) {
          const label = mixLabelFromText(row?.naam || row?.name || row?.label || row?.type || row?.bron);
          const n = toNumber(row?.value ?? row?.vermogen ?? row?.mw ?? row?.amount);
          if (!label || n === null || n <= 0) continue;
          sums[label] += n;
        }
      }
      // generic object walk fallback
      if (Object.values(sums).reduce((a, b) => a + b, 0) <= 0) {
        const generic = extractMixSumsFromObject(payload);
        for (const [k, v] of Object.entries(generic)) sums[k] += v;
      }

      const total = Object.values(sums).reduce((a, b) => a + b, 0);
      if (!(total > 0)) throw new Error('No NED dataportaal mix values');
      const order = ['Gascentrales', 'Kolencentrales', 'Afval', 'Zon', 'Wind', 'Biomassa', 'Kernenergie'];
      const outRows = order.filter((k) => sums[k] > 0).map((k) => ({ hour: k, value: (sums[k] / total) * 100, unit: '%' }));

      return {
        id: 'nlGenerationMixShare',
        label: 'Nederlandse productiemix',
        value: null,
        unit: '',
        valueText: 'Verhouding per bron',
        source: 'NED Dataportaal',
        sourceUrl: pageUrl,
        updatedAt: new Date().toISOString(),
        detail: 'Relatieve verdeling per opwekbron (vandaag) via NED dataportaal',
        rows: outRows,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`No NED generation mix values${lastErr ? ` (${String(lastErr.message || lastErr)})` : ''}`);
}

async function getGenerationMixShare() {
  try {
    return await getEntsoeGenerationMixShare();
  } catch (entsoeError) {
    try {
      return await getNedGenerationMixShare();
    } catch (nedCurrentError) {
      try {
        return await getNedGenerationMixShareFromDataportaal();
      } catch {
        return await getNedGenerationMixShareFromUtilizations();
      }
    }
  }
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
    try {
      const { xml } = await entsoeFetchXml({
        securityToken: ENTSOE_TOKEN,
        documentType: 'A11',
        in_Domain: inDomain,
        out_Domain: outDomain,
        periodStart: fmt(start),
        periodEnd: fmt(end),
      });
      let latest = null;
      for (const period of xmlBlocks(xml, 'Period')) {
        for (const point of parsePeriodPoints(period)) {
          if (!latest || point.dt > latest.dt) latest = point;
        }
      }
      return latest;
    } catch {
      return null;
    }
  }

  const rows = [];
  for (const [name, eics] of neighbors) {
    let net = null;
    let measuredAt = null;
    for (const eic of eics) {
      const inToNl = await latestFlow(eic, nl);
      const outFromNl = await latestFlow(nl, eic);
      if (inToNl !== null || outFromNl !== null) {
        net = (inToNl?.value || 0) - (outFromNl?.value || 0);
        const timestamps = [inToNl?.dt, outFromNl?.dt].filter(Boolean).sort((a, b) => a - b);
        measuredAt = timestamps[0] || null;
        break;
      }
    }
    rows.push({ hour: name, value: net, unit: 'MW', updatedAt: measuredAt?.toISOString() || null });
  }

  const numeric = rows.filter((r) => r.value !== null);
  if (!numeric.length) throw new Error('No ENTSO-E cross-border rows');
  const measurementTimes = numeric.map((row) => parseIsoUtc(row.updatedAt)).filter(Boolean).sort((a, b) => a - b);
  const missing = rows.length - numeric.length;
  const spreadHours = measurementTimes.length > 1
    ? (measurementTimes[measurementTimes.length - 1] - measurementTimes[0]) / 3_600_000
    : 0;
  const timingWarning = spreadHours > 2;
  return {
    id: 'nlCrossBorderFlows',
    label: 'Elektriciteitsstromen Nederland',
    value: numeric.reduce((s, r) => s + (r.value || 0), 0),
    unit: 'MW',
    source: 'ENTSO-E Transparency API',
    sourceUrl: ENTSOE_BASE,
    updatedAt: (measurementTimes[0] || new Date()).toISOString(),
    detail: 'Fysieke grensstromen; positief = netto import naar NL, negatief = netto export uit NL',
    dataStatus: missing || timingWarning ? 'warning' : 'verified',
    statusMessage: missing
      ? `${numeric.length} van ${rows.length} fysieke ENTSO-E-corridors beschikbaar`
      : timingWarning
        ? `${numeric.length} fysieke corridors; meetmomenten lopen ${spreadHours.toFixed(1)} uur uiteen`
        : `${numeric.length} fysieke ENTSO-E-corridors op vrijwel hetzelfde meetmoment`,
    rows,
  };
}

async function getGridFrequency() {
  const sourceUrl = 'https://mainsfrequency.com';
  const liveBase = 'https://dat.netzfrequenzmessung.de:9080';
  const sourceXml = await fetchText(`${liveBase}/source.xml`);
  const fileName = xmlTagValue(sourceXml, 'f');
  const valueTag = xmlTagValue(sourceXml, 't');
  if (!fileName || !valueTag) throw new Error('No live frequency source pointer');
  const liveXml = await fetchText(`${liveBase}/${fileName}`);
  const value = toNumber(xmlTagValue(liveXml, valueTag));
  if (value === null || value < 49 || value > 51) throw new Error('No valid live frequency value found');
  const stamp = xmlTagValue(liveXml, 'z');
  const stampMatch = stamp.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  const measuredAt = stampMatch
    ? new Date(Date.UTC(Number(stampMatch[3]), Number(stampMatch[2]) - 1, Number(stampMatch[1]), Number(stampMatch[4]), Number(stampMatch[5]), Number(stampMatch[6])))
    : new Date();
  return {
    id: 'nlGridFrequency',
    label: 'Netfrequentie NL (actueel)',
    value,
    unit: 'Hz',
    source: 'mainsfrequency.com',
    sourceUrl,
    updatedAt: measuredAt.toISOString(),
    detail: `Europese synchrone netfrequentie; afwijking ${(value - 50 >= 0 ? '+' : '')}${((value - 50) * 1000).toFixed(0)} mHz`,
    dataStatus: 'verified',
    statusMessage: 'Rechtstreeks uit het live meetbestand; niet uit de statische 50 Hz-doelwaarde',
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

  const net = inPower - outPower;
  const direction = net > 0 ? 'netto opregelen' : net < 0 ? 'netto afregelen' : 'geen netto activatie';
  return {
    id: 'tennetRegulation',
    label: 'Regelvermogen TenneT (actueel)',
    value: net,
    unit: 'MW',
    source: 'TenneT API (Balance Delta High Res)',
    sourceUrl,
    updatedAt: p.timeInterval_end || p.timeInterval_start || new Date().toISOString(),
    detail: `Opregelen ${inPower.toFixed(1)} MW | afregelen ${outPower.toFixed(1)} MW | ${direction}`,
    dataStatus: 'verified',
    statusMessage: 'Positief = netto opregelen; negatief = netto afregelen',
  };
}

async function getTennetSettlement() {
  if (!TENNET_TOKEN) throw new Error('TENNET_API_KEY ontbreekt');
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 3600_000);
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
      label: 'Indicatieve onbalansprijs',
      value: value2,
      unit: 'EUR/MWh',
      source: 'TenneT API (Balance Delta High Res)',
      sourceUrl: bdUrl,
      updatedAt: p2.timeInterval_end || p2.timeInterval_start || new Date().toISOString(),
      detail: `Actuele indicatie; definitieve settlement volgt later | midden ${mid ?? 'n/a'} | op ${up ?? 'n/a'} | af ${down ?? 'n/a'}`,
      dataStatus: 'verified',
      statusMessage: 'Indicatieve prijs uit Balance Delta; niet de definitieve settlementprijs',
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
    label: 'Onbalansprijs tekort (laatste PTU)',
    value: shortage ?? surplus,
    unit: 'EUR/MWh',
    source: 'TenneT API (Settlement Prices)',
    sourceUrl,
    updatedAt: p.timeInterval_end || p.timeInterval_start || new Date().toISOString(),
    detail: `Tekort ${shortage ?? 'n/a'} | overschot ${surplus ?? 'n/a'} | conditie ${p.regulating_condition || 'onbekend'}`,
    dataStatus: 'verified',
    statusMessage: 'Definitieve TenneT-settlement; de kaart toont tekort en overschot afzonderlijk in de toelichting',
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

function selectLatestCompleteGasDay(rows, minNumericRows = 1) {
  const today = new Date().toISOString().slice(0, 10);
  const byDay = new Map();
  for (const row of rows || []) {
    const day = String(row?.periodFrom || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const bucket = byDay.get(day) || [];
    bucket.push(row);
    byDay.set(day, bucket);
  }

  const candidates = [...byDay.entries()]
    .filter(([day]) => day < today)
    .map(([day, dayRows]) => ({
      day,
      rows: dayRows,
      numericRows: dayRows.filter((row) => entsogGwhDay(row?.value, row?.unit) !== null).length,
    }))
    .filter((candidate) => candidate.numericRows >= minNumericRows)
    .sort((a, b) => a.day.localeCompare(b.day));

  const selected = candidates.at(-1) || null;
  if (!selected) return null;
  const timestamps = selected.rows
    .map((row) => parseIsoUtc(row?.periodFrom))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return {
    ...selected,
    updatedAt: timestamps.at(-1)?.toISOString() || `${selected.day}T00:00:00.000Z`,
  };
}

function selectGasDay(rows, preferredDay, minNumericRows = 1) {
  if (!preferredDay) return selectLatestCompleteGasDay(rows, minNumericRows);
  const dayRows = (rows || []).filter((row) => String(row?.periodFrom || '').slice(0, 10) === preferredDay);
  const numericRows = dayRows.filter((row) => entsogGwhDay(row?.value, row?.unit) !== null).length;
  if (numericRows < minNumericRows) return null;
  const timestamps = dayRows
    .map((row) => parseIsoUtc(row?.periodFrom))
    .filter(Boolean)
    .sort((a, b) => a - b);
  return {
    day: preferredDay,
    rows: dayRows,
    numericRows,
    updatedAt: timestamps.at(-1)?.toISOString() || `${preferredDay}T00:00:00.000Z`,
  };
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

async function getNlGasProduction(preferredDay = null) {
  const { rows, sourceUrl } = await getEntsogOperational('Allocation', 5, 5000);
  const prod = rows.filter((r) => String(r.directionKey || '').toLowerCase() === 'entry' && String(r.pointLabel || '').toLowerCase().includes('production'));
  if (!prod.length) throw new Error('No ENTSOG production rows');
  const selected = selectGasDay(prod, preferredDay, 1);
  if (!selected) throw new Error('No complete ENTSOG production day');
  const dayRows = selected.rows;
  const total = dayRows.reduce((s, r) => s + (entsogGwhDay(r.value, r.unit) || 0), 0);
  return {
    id: 'nlGasProduction',
    label: preferredDay ? 'Gaswinning NL (zelfde gasdag)' : 'Gaswinning NL (laatste dag)',
    value: total,
    unit: 'GWh/d',
    source: 'ENTSOG API',
    sourceUrl,
    updatedAt: selected.updatedAt,
    detail: `Lokale productie op gasdag ${selected.day} (ENTSOG Allocation)`,
    dataStatus: 'verified',
    statusMessage: `${selected.numericRows} productiemetingen gecontroleerd`,
    rows: dayRows.slice(0, 6).map((r) => ({ hour: String(r.pointLabel || 'Productie'), value: entsogGwhDay(r.value, r.unit), unit: 'GWh/d' })),
  };
}

async function getNlGasImport(preferredDay = null) {
  const [{ rows: opRows }, { rows: flowRows, sourceUrl }] = await Promise.all([
    fetchJson(`${ENTSOG_BASE}/operatorpointdirections?${query({ operatorKey: ENTSOG_NL_OPERATOR, limit: 1200 })}`).then((p) => ({ rows: p.operatorpointdirections || [] })),
    getEntsogOperational('Physical Flow', 4, 6000),
  ]);

  const meta = new Map();
  for (const r of opRows) meta.set(`${String(r.pointKey || '')}:${String(r.directionKey || '').toLowerCase()}`, r);

  // ENTSOG publishes several start times for the same gas day. Selecting one
  // exact timestamp used to leave just one empty row and silently revive old data.
  const selected = selectGasDay(flowRows, preferredDay, 10);
  if (!selected) throw new Error('No complete ENTSOG physical-flow gas day');
  const rowsAtDay = selected.rows;

  // Prefer current virtual interconnection points (VIPs) for BE/DE. Adding VIPs
  // to their underlying legacy points double-counts the same physical corridor.
  const countryByPoint = new Map([
    ['ITP-00555', 'BE'], // VIP BENE H
    ['ITP-00648', 'BE'], // VIP BENE L
    ['ITP-10010', 'DE'], // VIP TTF-THE L
    ['ITP-10012', 'DE'], // VIP TTF-THE H
    ['ITP-00063', 'GB'], // BBL; may legitimately be unavailable
    ['ITP-00160', 'NO'], // Emden EPT
    ['ITP-00161', 'NO'], // Emden NPT
  ]);

  const countryMap = new Map();
  let lngIn = 0;
  let lngOut = 0;
  let storageIn = 0;
  let storageOut = 0;
  for (const r of rowsAtDay) {
    const pointKey = String(r.pointKey || '');
    const direction = String(r.directionKey || '').toLowerCase();
    const m = meta.get(`${pointKey}:${direction}`) || {};
    const pointType = String(m.pointType || '');
    const label = String(m.pointLabel || '').toLowerCase();
    const val = entsogGwhDay(r.value, r.unit);
    if (val === null) continue;

    if (pointType.includes('LNG')) {
      if (direction === 'entry') lngIn += val;
      if (direction === 'exit') lngOut += val;
    }
    if ((pointType.includes('Storage') || pointType.includes('Cross-Border Storage')) && ['norg', 'grijpskerk', 'bergermeer', 'zuidwending'].some((k) => label.includes(k))) {
      if (direction === 'entry') storageIn += val;
      if (direction === 'exit') storageOut += val;
    }

    const country = countryByPoint.get(pointKey);
    if (!country) continue;
    const bucket = countryMap.get(country) || { in: 0, out: 0 };
    if (direction === 'entry') bucket.in += val;
    if (direction === 'exit') bucket.out += val;
    countryMap.set(country, bucket);
  }

  const names = [
    ['BE', 'Belgie'],
    ['DE', 'Duitsland'],
    ['GB', 'Verenigd Koninkrijk'],
    ['NO', 'Noorwegen'],
  ];
  const rows = names.map(([code, name]) => {
    const c = countryMap.get(code);
    return { hour: name, value: c ? c.in - c.out : null, unit: 'GWh/d', kind: 'border' };
  });
  const lng = lngIn - lngOut;
  const storage = storageIn - storageOut;
  rows.push({ hour: 'LNG-terminals', value: lng, unit: 'GWh/d', kind: 'supply' });
  rows.push({ hour: 'Gasopslag (4 sites)', value: storage, unit: 'GWh/d', kind: 'storage' });
  let productionValue = null;
  let productionUpdatedAt = null;
  try {
    const prod = await getNlGasProduction(selected.day);
    productionValue = toNumber(prod?.value);
    productionUpdatedAt = prod?.updatedAt || null;
  } catch {
    productionValue = null;
  }
  rows.push({ hour: 'Nationale productie', value: productionValue, unit: 'GWh/d', kind: 'supply', updatedAt: productionUpdatedAt });

  const borderRows = rows.filter((row) => row.kind === 'border' && row.value !== null);
  if (!borderRows.length) throw new Error('No canonical ENTSOG border-corridor values');
  const borderNet = borderRows.reduce((sum, row) => sum + Number(row.value || 0), 0);
  const supplyNet = borderNet + lng + storage + (productionValue || 0);
  return {
    id: 'nlGasImport',
    label: 'Grensoverschrijdende gasstromen',
    value: borderNet,
    unit: 'GWh/d',
    source: 'ENTSOG API',
    sourceUrl,
    updatedAt: selected.updatedAt,
    detail: `Gasdag ${selected.day} | grenssaldo ${borderNet.toFixed(1)} GWh/d | aanvoer incl. LNG, opslag en productie ${supplyNet.toFixed(1)} GWh/d`,
    dataStatus: 'verified',
    statusMessage: `${selected.numericRows} ENTSOG-metingen; VIP-corridors voorkomen dubbeltelling`,
    rows,
  };
}

async function getNlGasStorage() {
  const pageUrl = 'https://ned.nl/nl/gasopslagen-nederland';
  try {
    const page = await fetchText(pageUrl, {}, 15000);
    const patterns = [
      /actuele\s+vullingsgraad[^0-9%]{0,120}([0-9]+(?:[.,][0-9]+)?)\s*%/i,
      /vullingsgraad[^0-9%]{0,120}([0-9]+(?:[.,][0-9]+)?)\s*%/i,
      /is\s+momenteel[^0-9%]{0,60}([0-9]+(?:[.,][0-9]+)?)\s*%/i,
      /([0-9]+(?:[.,][0-9]+)?)\s*%\s*(?:gevuld|vulling|vullingsgraad)/i,
      /"percentage"\s*:\s*"?([0-9]+(?:[.,][0-9]+)?)"?/i,
    ];
    let pct = null;
    for (const re of patterns) {
      const m = page.match(re);
      if (m) {
        pct = toNumber(m[1]);
        if (pct !== null) break;
      }
    }
    if (pct !== null) {
      const normalized = pct <= 1 ? pct * 100 : pct;
      const gwh = 136780 * (normalized / 100);
      return {
        id: 'nlGasStorage',
        label: 'NL Gasopslag (actueel)',
        value: normalized,
        unit: '%',
        source: 'NED Website',
        sourceUrl: pageUrl,
        updatedAt: new Date().toISOString(),
        detail: 'Actuele nationale vullingsgraad van NED',
        rows: [{ hour: 'Opslaginhoud', value: gwh, unit: 'GWh' }],
      };
    }
  } catch {
    // continue with API fallback chain below
  }

  const now = new Date();
  const after = new Date(now.getTime() - 10 * 24 * 3600_000).toISOString().slice(0, 10);
  const attempts = [
    { type: 28, activity: 3 },
    { type: 58, activity: 3 },
    { type: 58, activity: 1 },
    { type: 57, activity: 3 },
    { type: 57, activity: 1 },
    { type: 56, activity: 3 },
    { type: 56, activity: 1 },
    { type: 60, activity: 3 },
    { type: 60, activity: 1 },
    { type: 28 },
  ];
  let rows = [];
  let url = 'https://api.ned.nl/v1/utilizations';
  let lastErr = null;
  for (const att of attempts) {
    try {
      const res = await fetchNedUtilizations({ point: 0, granularity: 4, granularitytimezone: 0, 'validfrom[after]': after, itemsPerPage: 1200, ...att });
      rows = res.rows;
      url = res.url;
      if (rows.length) break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!Array.isArray(rows) || !rows.length) {
    // Fallback when NED endpoint shape/filters change: keep storage card meaningful.
    const imp = await getNlGasImport();
    const storageRow = (imp.rows || []).find((r) => String(r.hour || '').toLowerCase().includes('gasopslag'));
    const flow = toNumber(storageRow?.value);
    let status = 'Trend onbekend';
    if (flow !== null) {
      if (Math.abs(flow) < 0.05) status = 'In balans';
      else if (flow > 0) status = 'Leegt (uit opslag naar net)';
      else status = 'Vult (naar opslag)';
    }
    return {
      id: 'nlGasStorage',
      label: 'NL Gasopslag (actueel)',
      value: null,
      unit: '%',
      valueText: status,
      source: 'ENTSOG API (fallback)',
      sourceUrl: imp.sourceUrl || 'https://transparency.entsog.eu/api/v1/operationaldatas',
      updatedAt: imp.updatedAt || new Date().toISOString(),
      detail: 'NED tijdelijk niet beschikbaar; opslagstatus op basis van ENTSOG dagstroom',
      rows: [{ hour: 'Gasopslag nettoflow', value: flow, unit: 'GWh/d' }],
    };
  }
  const parsed = rows
    .map((r) => ({ dt: parseIsoUtc(r.validfrom || r.timestamp || r.date), pct: toNumber(r.percentage ?? r.value ?? r.capacity), rec: r }))
    .filter((x) => x.dt && x.pct !== null)
    .sort((a, b) => a.dt - b.dt);
  if (!parsed.length) throw new Error(`No parseable NED storage row${lastErr ? ` (${String(lastErr.message || lastErr)})` : ''}`);
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
    let rows = [];
    let localUrl = sourceUrl;
    const attempts = [
      { type, activity: 2 },
      { type, activity: 1 },
      { type },
    ];
    for (const att of attempts) {
      try {
        const res = await fetchNedUtilizations({ point: 0, granularity: 4, granularitytimezone: 0, 'validfrom[after]': after, itemsPerPage: 1200, ...att });
        rows = res.rows;
        localUrl = res.url;
        if (rows.length) break;
      } catch {
        // try next
      }
    }
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
    label: preferredDay ? 'Gasconsumptie NL (zelfde gasdag)' : 'Gasconsumptie NL (laatste volledige dag)',
    value: total,
    unit: 'GWh/d',
    source: 'NED API',
    sourceUrl,
    updatedAt: totals.map((t) => t[2]).sort().at(-1) || new Date().toISOString(),
    detail: 'Totaal gasverbruik laatste volledige dag',
    rows: [],
  };
}

async function getNlGasConsumptionBreakdownFallbackEntsog(preferredDay = null) {
  const { rows, sourceUrl } = await getEntsogOperational('Allocation', 6, 6000);
  const selected = selectGasDay(rows, preferredDay, 5);
  if (!selected) throw new Error('No complete ENTSOG allocation gas day');
  const dayRows = selected.rows.filter((r) => String(r.directionKey || '').toLowerCase() === 'exit');
  if (!dayRows.length) throw new Error('No ENTSOG exit rows for fallback consumption');

  const isDomesticConsumptionExit = (label) => {
    const lbl = String(label || '').toLowerCase();
    return (
      lbl.includes('local distribution') ||
      lbl.includes('dso') ||
      lbl.includes('ldc') ||
      lbl.includes('consumer') ||
      lbl.includes('power') ||
      lbl.includes('electric') ||
      lbl.includes('centrale')
    );
  };

  const domesticRows = dayRows.filter((r) => isDomesticConsumptionExit(r.pointLabel));
  const total = domesticRows.reduce((s, r) => s + (entsogGwhDay(r.value, r.unit) || 0), 0);
  if (!(total > 0)) throw new Error('ENTSOG fallback consumption total is empty');
  return {
    id: 'nlGasConsumptionBreakdown',
    label: 'Gasconsumptie NL (laatste volledige dag)',
    value: total,
    unit: 'GWh/d',
    source: 'ENTSOG API (fallback)',
    sourceUrl,
    updatedAt: selected.updatedAt,
    detail: `Gasdag ${selected.day}; ENTSOG exits naar distributie, industrie en gascentrales`,
    dataStatus: 'verified',
    statusMessage: `${domesticRows.length} verbruikspunten op dezelfde gasdag`,
    rows: [],
  };
}

async function getOverstappenReference(kind) {
  const isGas = kind === 'gas';
  const url = isGas ? OVERSTAPPEN_GAS_URL : OVERSTAPPEN_POWER_URL;
  const html = await fetchText(url, {}, 15000);
  const unit = isGas ? 'EUR/m3' : 'EUR/kWh';
  const unitToken = isGas ? '(?:m3|m³)' : 'kwh';
  const pageText = htmlDecode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  );

  const dutchDateToIso = (label) => {
    const months = {
      januari: 0, februari: 1, maart: 2, april: 3, mei: 4, juni: 5,
      juli: 6, augustus: 7, september: 8, oktober: 9, november: 10, december: 11,
    };
    const m = String(label || '').trim().toLowerCase().match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
    if (!m || months[m[2]] === undefined) return new Date().toISOString();
    return new Date(Date.UTC(Number(m[3]), months[m[2]], Number(m[1]), 12)).toISOString();
  };

  // On the electricity dashboard, use a like-for-like household offer:
  // the cheapest currently listed fixed contract with a one-year term.
  if (!isGas) {
    const fixedOneYear = [];
    const fixedOneYearPattern = /([A-Z][A-Za-z0-9&'’\-\s]{2,60}?)\s+Vast\s+1\s+jaar\s+(?:€|&euro;)\s*([0-9]+(?:[.,][0-9]{2,4})?)/ig;
    let fixedMatch;
    while ((fixedMatch = fixedOneYearPattern.exec(pageText))) {
      const provider = String(fixedMatch[1] || '').trim().replace(/\s{2,}/g, ' ');
      const value = toNumber(fixedMatch[2]);
      if (!provider || provider.length < 3 || value === null || value <= 0.03 || value >= 2) continue;
      fixedOneYear.push({ provider, value });
    }
    if (fixedOneYear.length) {
      const best = fixedOneYear.sort((a, b) => a.value - b.value)[0];
      return {
        id: 'gaslichtElectricity',
        label: 'Stroom consumentenprijs (1 jaar vast)',
        value: best.value,
        unit,
        source: 'Overstappen.nl',
        sourceUrl: url,
        updatedAt: new Date().toISOString(),
        detail: `Laagste 1-jaar-vast aanbod: ${best.provider}; inclusief belastingen, exclusief netbeheerkosten`,
        dataStatus: 'verified',
        statusMessage: 'Rechtstreeks geselecteerd uit de actuele tabel met vaste contracten van één jaar.',
      };
    }
  }

  const summaryPattern = isGas
    ? /De actuele gasprijs is vandaag\s*€\s*([0-9]+(?:[.,][0-9]+)?)\s*per\s*m[³3]\.\s*De laagste gasprijs is\s*€\s*([0-9]+(?:[.,][0-9]+)?)\s*per\s*m[³3]\.\s*Laatste update:\s*([^.]+)\./i
    : /De actuele stroomprijs is vandaag\s*€\s*([0-9]+(?:[.,][0-9]+)?)\s*per\s*kWh\.\s*De laagste stroomprijs is\s*€\s*([0-9]+(?:[.,][0-9]+)?)\s*per\s*kWh\.\s*Laatste update:\s*([^.]+)\./i;
  const summary = pageText.match(summaryPattern);
  if (summary) {
    const value = toNumber(summary[1]);
    const lowest = toNumber(summary[2]);
    if (value !== null && lowest !== null) {
      return {
        id: isGas ? 'gaslichtGas' : 'gaslichtElectricity',
        label: isGas ? 'Gas consumentenprijs (Overstappen.nl)' : 'Stroom consumentenprijs (1 jaar vast)',
        value,
        unit,
        source: 'Overstappen.nl',
        sourceUrl: url,
        updatedAt: dutchDateToIso(summary[3]),
        detail: `Actuele gemiddelde prijs inclusief belastingen; laagste aanbod € ${lowest.toFixed(2).replace('.', ',')} | bronupdate ${summary[3].trim()}`,
        dataStatus: 'verified',
        statusMessage: 'Rechtstreeks uit de actuele prijssamenvatting van de bron',
      };
    }
  }

  const topRowPatterns = [
    /(?:^|\s)1\s*[.)-]?\s*([A-Z][A-Za-z0-9&'’\-\s]{2,40})\s+(Vast|Dynamisch)\s+([0-9]{1,2}\s*(?:jaar|maand))\s+€\s*([0-9]+(?:[.,][0-9]{2,4})?)/i,
    /([A-Z][A-Za-z0-9&'’\-\s]{2,40})\s+(Vast|Dynamisch)\s+([0-9]{1,2}\s*(?:jaar|maand))\s+€\s*([0-9]+(?:[.,][0-9]{2,4})?)/i,
  ];
  for (const re of topRowPatterns) {
    const m = pageText.match(re);
    if (!m) continue;
    const provider = String(m[1] || '').trim().replace(/\s{2,}/g, ' ');
    const contractType = String(m[2] || '').trim();
    const period = String(m[3] || '').trim();
    const value = toNumber(m[4]);
    if (!provider || provider.length < 3 || value === null) continue;
    if (isGas && (value <= 0.2 || value >= 5)) continue;
    if (!isGas && (value <= 0.03 || value >= 2)) continue;
    return {
      id: isGas ? 'gaslichtGas' : 'gaslichtElectricity',
      label: isGas ? 'Gas referentieprijs (Overstappen.nl)' : 'Stroom consumentenprijs (1 jaar vast)',
      value,
      unit,
      source: 'Overstappen.nl',
      sourceUrl: url,
      updatedAt: new Date().toISOString(),
      detail: isGas
        ? `Aanbieder: ${provider} | Contract: ${contractType} ${period} | De laagste prijs voor aardgas, inclusief belastingen, voor huishoudens`
        : `Aanbieder: ${provider} | Contract: ${contractType} ${period} | De laagste prijs voor elektriciteit, inclusief belastingen, voor huishoudens`,
    };
  }

  const pricePatterns = [
    new RegExp(`€\\s*([0-9]+(?:[.,][0-9]{2,4})?)\\s*(?:per|/)\\s*${unitToken}`, 'ig'),
    new RegExp(`([0-9]+(?:[.,][0-9]{2,4})?)\\s*(?:€|eur)?\\s*(?:per|/)\\s*${unitToken}`, 'ig'),
    new RegExp(`(?:tarief|prijs)[^0-9]{0,30}([0-9]+(?:[.,][0-9]{2,4})?)`, 'ig'),
  ];
  const foundPrices = [];
  for (const re of pricePatterns) {
    let m;
    while ((m = re.exec(html))) {
      const n = toNumber(m[1]);
      if (n === null) continue;
      if (isGas && n >= 0.2 && n <= 5) foundPrices.push(n);
      if (!isGas && n >= 0.03 && n <= 2) foundPrices.push(n);
    }
  }
  if (!foundPrices.length) throw new Error('Could not parse reference commodity price from Overstappen');
  const price = foundPrices.sort((a, b) => a - b)[0];

  const providerPatterns = [
    /(?:aanbieder|leverancier)[^a-z0-9]{0,20}([A-Z][A-Za-z0-9&'’\-\s]{2,40})/i,
    /"name"\s*:\s*"([^"]{2,60})"/i,
  ];
  let provider = 'Onbekend';
  for (const re of providerPatterns) {
    const m = html.match(re);
    if (m?.[1]) {
      provider = String(m[1]).trim();
      break;
    }
  }

  const periodPatterns = [
    /(dynamisch)/i,
    /(vast)\s*([0-9]{1,2})\s*(jaar|maand)/i,
    /([0-9]{1,2})\s*(jaar|maand)\s*(vast)/i,
  ];
  let contract = 'Onbekend';
  for (const re of periodPatterns) {
    const m = html.match(re);
    if (!m) continue;
    if (m[1] && m[1].toLowerCase() === 'dynamisch') {
      contract = 'Dynamisch';
      break;
    }
    const parts = m.slice(1).filter(Boolean).map((x) => String(x).trim());
    if (parts.length) {
      contract = parts.join(' ');
      break;
    }
  }

  return {
    id: isGas ? 'gaslichtGas' : 'gaslichtElectricity',
    label: isGas ? 'Gas referentieprijs (Overstappen.nl)' : 'Stroom consumentenprijs (1 jaar vast)',
    value: price,
    unit,
    source: 'Overstappen.nl',
    sourceUrl: url,
    updatedAt: new Date().toISOString(),
    detail: isGas
      ? `Aanbieder: ${provider} | Contract: ${contract} | De laagste prijs voor aardgas, inclusief belastingen, voor huishoudens`
      : `Aanbieder: ${provider} | Contract: ${contract} | De laagste prijs voor elektriciteit, inclusief belastingen, voor huishoudens`,
  };
}

async function getOverstappenElectricityReference() {
  return getOverstappenReference('power');
}

async function getOverstappenGasReference() {
  return getOverstappenReference('gas');
}

async function collectOverview() {
  const started = Date.now();
  const items = [];
  const errors = [];
  const previousById = loadPreviousOverviewMap();

  const fallbackRows24 = Array.from({ length: 24 }, (_, i) => {
    return { hour: `Vandaag ${String(i).padStart(2, '0')}:00`, value: null, unit: 'EUR/MWh' };
  });

  const tasks = [
    [getDayAheadPower24h, { id: 'dayAheadPower24h', label: 'Stroomprijs vandaag (day-ahead)', value: null, unit: 'EUR/MWh', source: 'ENTSO-E Transparency API (EPEX SPOT NL)', sourceUrl: ENTSOE_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: fallbackRows24 }],
    [getTTFGas, { id: 'ttfGas', label: 'TTF Gas', value: null, unit: 'EUR/MWh', source: 'TradingEconomics', sourceUrl: 'https://tradingeconomics.com/commodity/eu-natural-gas', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getTtfStorageSpread, { id: 'ttfStorageSpread', label: 'Zomer–winterspread opslag', value: null, unit: 'EUR/MWh', source: 'ICE TTF vertraagde slotprijzen', sourceUrl: ICE_TTF_PRODUCT_URL, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [] }],
    [getETSPrice, { id: 'ets', label: 'EU ETS (ICE EUA frontcontract)', value: null, unit: 'EUR/tCO2', source: 'Barchart', sourceUrl: 'https://www.barchart.com/futures/quotes/CK*0', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getNlGasImport, { id: 'nlGasImport', label: 'Netto in- en uitstroom aardgas', value: null, unit: 'GWh/d', source: 'ENTSOG API', sourceUrl: ENTSOG_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [{ hour: 'Belgie', value: null, unit: 'GWh/d' }, { hour: 'Duitsland', value: null, unit: 'GWh/d' }, { hour: 'Verenigd Koninkrijk', value: null, unit: 'GWh/d' }, { hour: 'Noorwegen', value: null, unit: 'GWh/d' }, { hour: 'LNG (Gate+EET)', value: null, unit: 'GWh/d' }, { hour: 'Gasopslag (4 sites)', value: null, unit: 'GWh/d' }, { hour: 'Nationale productie', value: null, unit: 'GWh/d' }] }],
    [getNlGasProduction, { id: 'nlGasProduction', label: 'Gaswinning NL (laatste dag)', value: null, unit: 'GWh/d', source: 'ENTSOG API', sourceUrl: ENTSOG_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getEntsoeCrossBorderFlows, { id: 'nlCrossBorderFlows', label: 'Elektriciteitsstromen Nederland', value: null, unit: 'MW', source: 'ENTSO-E Transparency API', sourceUrl: ENTSOE_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [{ hour: 'Belgie', value: null, unit: 'MW' }, { hour: 'Duitsland', value: null, unit: 'MW' }, { hour: 'Verenigd Koninkrijk', value: null, unit: 'MW' }, { hour: 'Denemarken', value: null, unit: 'MW' }, { hour: 'Noorwegen', value: null, unit: 'MW' }] }],
    [getNlGasStorage, { id: 'nlGasStorage', label: 'NL Gasopslag (actueel)', value: null, unit: '%', source: 'NED API', sourceUrl: 'https://api.ned.nl/v1/utilizations', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getEntsoeElectricityOverview, { id: 'nlElectricityOverview', label: 'Elektriciteit NL (actuele load)', value: null, unit: 'MW', source: 'ENTSO-E Transparency API', sourceUrl: ENTSOE_BASE, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [] }],
    [getGridFrequency, { id: 'nlGridFrequency', label: 'Netfrequentie NL (actueel)', value: null, unit: 'Hz', source: 'mainsfrequency.com', sourceUrl: 'https://mainsfrequency.com', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [async () => {
      try {
        return await getNlGasConsumptionBreakdown();
      } catch {
        return await getNlGasConsumptionBreakdownFallbackEntsog();
      }
    }, { id: 'nlGasConsumptionBreakdown', label: 'Gasconsumptie NL (laatste volledige dag)', value: null, unit: 'GWh/d', source: 'NED API', sourceUrl: 'https://api.ned.nl/v1/utilizations', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar', rows: [] }],
    [getTennetRegulation, { id: 'tennetRegulation', label: 'Regelvermogen TenneT (actueel)', value: null, unit: 'MW', source: 'TenneT API (Balance Delta High Res)', sourceUrl: 'https://api.tennet.eu/publications/v1/balance-delta-high-res/latest', updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getOverstappenElectricityReference, { id: 'gaslichtElectricity', label: 'Stroom consumentenprijs (1 jaar vast)', value: null, unit: 'EUR/kWh', source: 'Overstappen.nl', sourceUrl: OVERSTAPPEN_POWER_URL, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
    [getOverstappenGasReference, { id: 'gaslichtGas', label: 'Gas referentieprijs (Overstappen.nl)', value: null, unit: 'EUR/m3', source: 'Overstappen.nl', sourceUrl: OVERSTAPPEN_GAS_URL, updatedAt: new Date().toISOString(), detail: 'Bron tijdelijk niet bereikbaar' }],
  ];

  // Keep the same card layout for remaining Gaslicht cards that are not migrated yet.
  const staticFallbacks = [];

  for (const [fn, fb] of tasks) {
    try {
      items.push(await fn());
    } catch (err) {
      errors.push({ source: fn.name, error: String(err.message || err) });
      const fbId = fb?.id ? String(fb.id) : null;
      const previous = fbId ? previousById.get(fbId) : null;
      const isGaslichtRetail = fbId === 'gaslichtGas' || fbId === 'gaslichtElectricity';
      if (!isGaslichtRetail && previous && hasUsefulValue(previous)) {
        items.push(cachedItemWithError(previous, err));
      } else if (fb) {
        items.push(fallbackItem(fb, err));
      }
    }
  }
  items.push(...staticFallbacks);

  // Keep the electricity map internally consistent and attach the system
  // measurements that belong in its compact net-status panel.
  const electricityFlow = items.find((item) => item?.id === 'nlCrossBorderFlows');
  const electricityLoad = items.find((item) => item?.id === 'nlElectricityOverview');
  const gridFrequency = items.find((item) => item?.id === 'nlGridFrequency');
  const regulation = items.find((item) => item?.id === 'tennetRegulation');
  if (electricityFlow) {
    const borderNetMw = toNumber(electricityFlow.value);
    const loadMw = toNumber(electricityLoad?.value);
    const frequencyHz = toNumber(gridFrequency?.value);
    const regulationMw = toNumber(regulation?.value);
    electricityFlow.quality = {
      borderNetMw,
      loadMw,
      loadUpdatedAt: electricityLoad?.updatedAt || null,
      frequencyHz,
      frequencyUpdatedAt: gridFrequency?.updatedAt || null,
      regulationMw,
      regulationUpdatedAt: regulation?.updatedAt || null,
    };
    const borderText = borderNetMw === null
      ? 'grenssaldo onbekend'
      : borderNetMw >= 0
        ? `netto import ${(borderNetMw / 1000).toFixed(1)} GW`
        : `netto export ${(Math.abs(borderNetMw) / 1000).toFixed(1)} GW`;
    electricityFlow.detail = `${borderText}${loadMw === null ? '' : ` | actuele systeembelasting ${(loadMw / 1000).toFixed(1)} GW`}`;
  }

  // Cross-check the gas balance using values that share the same GWh/day basis.
  // A small difference is expected from linepack, measurement timing and points
  // not represented in the compact country view.
  const gasFlow = items.find((item) => item?.id === 'nlGasImport');
  const gasConsumption = items.find((item) => item?.id === 'nlGasConsumptionBreakdown');
  const gasProduction = items.find((item) => item?.id === 'nlGasProduction');
  const gasStorage = items.find((item) => item?.id === 'nlGasStorage');
  if (gasFlow && gasConsumption && Array.isArray(gasFlow.rows)) {
    let flowDay = String(gasFlow.updatedAt || '').slice(0, 10);
    let consumptionDay = String(gasConsumption.updatedAt || '').slice(0, 10);
    if (flowDay && consumptionDay && flowDay !== consumptionDay) {
      try {
        Object.assign(gasConsumption, await getNlGasConsumptionBreakdownFallbackEntsog(flowDay));
        consumptionDay = String(gasConsumption.updatedAt || '').slice(0, 10);
      } catch (consumptionErr) {
        try {
          Object.assign(gasFlow, await getNlGasImport(consumptionDay));
          flowDay = String(gasFlow.updatedAt || '').slice(0, 10);
        } catch (flowErr) {
          errors.push({
            source: 'gasBalanceAlignment',
            error: `${String(consumptionErr.message || consumptionErr)}; ${String(flowErr.message || flowErr)}`,
          });
        }
      }
    }
    const productionDay = String(gasProduction?.updatedAt || '').slice(0, 10);
    if (gasProduction && flowDay && productionDay && flowDay !== productionDay) {
      try {
        Object.assign(gasProduction, await getNlGasProduction(flowDay));
      } catch (err) {
        errors.push({ source: 'gasProductionAlignment', error: String(err.message || err) });
      }
    }
    if (!flowDay || flowDay !== consumptionDay) {
      gasFlow.dataStatus = 'warning';
      gasFlow.statusMessage = `Gasbalans niet berekend: grensstromen (${flowDay || 'onbekend'}) en verbruik (${consumptionDay || 'onbekend'}) vallen niet op dezelfde gasdag.`;
    } else {
    const balanceRows = gasFlow.rows.filter((row) => row?.kind !== 'consumption');
    const supply = balanceRows.reduce((sum, row) => {
      const value = toNumber(row?.value);
      return value === null ? sum : sum + value;
    }, 0);
    const consumption = toNumber(gasConsumption.value);
    if (consumption !== null && consumption > 0) {
      const difference = supply - consumption;
      const differencePct = (difference / consumption) * 100;
      const borderNet = balanceRows
        .filter((row) => row?.kind === 'border')
        .reduce((sum, row) => sum + (toNumber(row?.value) || 0), 0);
      const balanceMessage = `aanvoer ${supply.toFixed(1)} vs. verbruik ${consumption.toFixed(1)} GWh/d; verschil ${differencePct.toFixed(1)}%`;
      gasFlow.rows = [
        ...balanceRows,
        { hour: 'Binnenlands verbruik', value: -consumption, unit: 'GWh/d', kind: 'consumption', updatedAt: gasConsumption.updatedAt },
      ];
      gasFlow.label = 'Gasbalans Nederland';
      gasFlow.value = difference;
      gasFlow.detail = `Gasdag ${String(gasFlow.updatedAt || '').slice(0, 10)} | grenssaldo ${borderNet.toFixed(1)} | netto aanvoer ${supply.toFixed(1)} | verbruik ${consumption.toFixed(1)} GWh/d`;
      gasFlow.quality = {
        borderNetGwhDay: borderNet,
        supplyGwhDay: supply,
        consumptionGwhDay: consumption,
        differenceGwhDay: difference,
        differencePct,
        storageFillPct: toNumber(gasStorage?.value),
      };
      gasFlow.statusMessage = `${gasFlow.statusMessage || 'Bron gecontroleerd'}; ${balanceMessage}`;
      gasConsumption.statusMessage = `${gasConsumption.statusMessage || 'Bron gecontroleerd'}; ${balanceMessage}`;
      if (Math.abs(differencePct) > 15) {
        gasFlow.dataStatus = 'warning';
        gasConsumption.dataStatus = 'warning';
      }
    }
    }
  }

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
