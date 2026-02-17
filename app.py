import json
import html
import os
import re
import time
import ssl
import socket
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from statistics import mean
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlencode
from urllib.request import Request, urlopen
try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - Python without zoneinfo database
    ZoneInfo = None

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
COMMON_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
}

NED_DEFAULT_TOKEN = "14a2b9521747a7e962881d9ab640246497eeea4d9caa2adfc94d7ad39e976cf0"
ENTSOE_DEFAULT_TOKEN = "2b0fbf54-61ad-4086-b262-a044f934b56b"
ENTSOE_BASE_URLS = [
    "https://web-api.tp.entsoe.eu/api",
]
TENNET_DEFAULT_TOKEN = "eb4e6c26-e63d-43f4-b3dd-da321d144de3"
ENTSOG_BASE = "https://transparency.entsog.eu/api/v1"
ENTSOG_NL_OPERATOR = "NL-TSO-0001"
NL_GAS_STORAGE_CAPACITY_BCM = 14.0
NL_GAS_KWH_PER_M3 = 9.77
LAST_GOOD_CACHE = {}


def tls_context():
    ctx = ssl.create_default_context()
    # Force modern TLS to avoid servers rejecting older protocol negotiation.
    if hasattr(ssl, "TLSVersion"):
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


def curl_fetch(url: str, extra_headers=None, timeout: int = 20) -> bytes:
    # Disable curl URL globbing so query params like validfrom[...] are sent literally.
    cmd = ["curl", "-sL", "-g", "--http1.1", "--fail", "--max-time", str(timeout), url]
    headers = dict(COMMON_HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    for k, v in headers.items():
        cmd.extend(["-H", f"{k}: {v}"])
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or b"").decode("utf-8", "ignore").strip()
        raise URLError(f"curl failed ({proc.returncode}) for {url}: {err[:240]}")
    return proc.stdout


def fetch_text(url: str, timeout: int = 20, extra_headers=None) -> str:
    headers = dict(COMMON_HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=timeout, context=tls_context()) as resp:
            return resp.read().decode("utf-8", "ignore")
    except URLError as exc:
        # Fallback to curl for TLS/SSL and resolver quirks in local Python/OpenSSL stacks.
        try:
            return curl_fetch(url, extra_headers=extra_headers, timeout=timeout).decode("utf-8", "ignore")
        except URLError:
            raise exc
    except (TimeoutError, socket.timeout):
        return curl_fetch(url, extra_headers=extra_headers, timeout=timeout).decode("utf-8", "ignore")


def fetch_json(url: str, timeout: int = 20, extra_headers=None):
    headers = dict(COMMON_HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=timeout, context=tls_context()) as resp:
            return json.load(resp)
    except URLError as exc:
        # Fallback to curl for TLS/SSL and resolver quirks in local Python/OpenSSL stacks.
        try:
            raw = curl_fetch(url, extra_headers=extra_headers, timeout=timeout).decode("utf-8", "ignore")
            return json.loads(raw)
        except URLError:
            raise exc
    except (TimeoutError, socket.timeout):
        raw = curl_fetch(url, extra_headers=extra_headers, timeout=timeout).decode("utf-8", "ignore")
        return json.loads(raw)


def cache_set(key: str, payload: dict):
    LAST_GOOD_CACHE[key] = payload


def cache_get(key: str):
    val = LAST_GOOD_CACHE.get(key)
    if not isinstance(val, dict):
        return None
    return dict(val)


def cache_get_fresh(key: str, max_age_sec: int):
    val = LAST_GOOD_CACHE.get(key)
    if not isinstance(val, dict):
        return None
    fetched = parse_dt_any(val.get("_fetchedAt") or "")
    if fetched is None:
        return None
    age = (datetime.now(timezone.utc) - fetched).total_seconds()
    if age > max_age_sec:
        return None
    copy = dict(val)
    copy.pop("_fetchedAt", None)
    return copy


def has_tennet_key() -> bool:
    return bool((os.environ.get("TENNET_API_KEY", "").strip()) or TENNET_DEFAULT_TOKEN.strip())


def get_ned_token() -> str:
    token = os.environ.get("NED_API_TOKEN", NED_DEFAULT_TOKEN).strip()
    if not token:
        raise ValueError("NED_API_TOKEN missing")
    return token


def get_entsoe_token() -> str:
    token = os.environ.get("ENTSOE_API_TOKEN", ENTSOE_DEFAULT_TOKEN).strip()
    if not token:
        raise ValueError("ENTSOE_API_TOKEN missing")
    return token


def to_float(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("\u00a0", " ").replace("€", "").replace("EUR", "")
    text = text.replace("MWh", "").replace("kWh", "").replace("m3", "").replace("m³", "")
    text = text.strip()

    # Keep only the first numeric token and normalize decimal separators.
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", text)
    if not match:
        return None
    token = match.group(0)
    if "," in token and "." in token:
        token = token.replace(".", "").replace(",", ".")
    else:
        token = token.replace(",", ".")
    try:
        return float(token)
    except ValueError:
        return None


def parse_te_last_value(page_html: str) -> float:
    meta_match = re.search(r"TEChartsMeta = (\[.*?\]);", page_html, re.S)
    if not meta_match:
        raise ValueError("Could not find TEChartsMeta in TradingEconomics page")

    charts_meta = json.loads(meta_match.group(1))
    if not charts_meta:
        raise ValueError("TradingEconomics TEChartsMeta is empty")

    return float(charts_meta[0]["last"])


def parse_dt_any(text: str):
    t = (text or "").strip()
    if not t:
        return None

    # ISO UTC suffix handling ("Z"), common in ENTSO-E XML.
    if t.endswith("Z"):
        try:
            return datetime.fromisoformat(t.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            pass

    # Unix timestamp seconds or milliseconds
    if re.fullmatch(r"\d{10,13}", t):
        ts = int(t)
        if ts > 10**12:
            ts = ts / 1000
        return datetime.fromtimestamp(ts, tz=timezone.utc)

    # Common date formats
    for fmt in [
        "%Y-%m-%dT%H:%MZ",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%d-%m-%Y",
        "%d/%m/%Y",
    ]:
        try:
            dt = datetime.strptime(t, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError:
            pass
    return None


def ned_extract_records(payload):
    if isinstance(payload, dict):
        for key in ["hydra:member", "member", "items", "data", "results"]:
            val = payload.get(key)
            if isinstance(val, list):
                return val
            if isinstance(val, dict):
                nested = ned_extract_records(val)
                if nested:
                    return nested
    if isinstance(payload, list):
        return payload
    return []


def parse_ref_id(value):
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        m = re.search(r"(\d+)$", value)
        if m:
            return int(m.group(1))
    if isinstance(value, dict):
        return parse_ref_id(value.get("id") or value.get("@id"))
    return None


def ned_query_utilizations(
    type_id=None,
    activity=None,
    granularity: int = 4,
    classification=None,
    limit: int = 500,
    point: int = 0,
    days_back: int = 2,
    days_forward: int = 1,
):
    source_url = "https://api.ned.nl/v1/utilizations"
    token = get_ned_token()
    now_utc = datetime.now(timezone.utc)
    after = (now_utc - timedelta(days=max(1, days_back))).strftime("%Y-%m-%d")
    before = (now_utc + timedelta(days=max(0, days_forward))).strftime("%Y-%m-%d")
    params = [
        f"point={point}",
        f"granularity={granularity}",
        "granularitytimezone=0",
        f"validfrom[strictly_before]={before}",
        f"validfrom[after]={after}",
        f"itemsPerPage={limit}",
    ]
    if type_id is not None:
        params.append(f"type={type_id}")
    if activity is not None:
        params.append(f"activity={activity}")
    if classification is not None:
        params.append(f"classification={classification}")
    api_url = f"{source_url}?{'&'.join(params)}"
    payload = fetch_json(
        api_url,
        extra_headers={
            "X-AUTH-TOKEN": token,
            "Authorization": f"Bearer {token}",
            "accept": "application/ld+json, application/json",
        },
    )
    records = ned_extract_records(payload)
    if not records:
        raise ValueError(
            f"NED returned no records for type={type_id}, activity={activity}, "
            f"classification={classification}, granularity={granularity}, point={point}"
        )
    return records, api_url


def ned_pick_latest_record(records):
    latest = None
    latest_dt = None
    for rec in records:
        dt = parse_dt_any(rec.get("validfrom") or rec.get("timestamp") or rec.get("date"))
        if not dt:
            continue
        if latest is None or dt > latest_dt:
            latest = rec
            latest_dt = dt
    if latest is None:
        raise ValueError("NED records had no parseable datetime")
    return latest, latest_dt


def ned_get_latest_for_type_activity(type_id, activity, point=0):
    last_error = None
    for classification in [2, 1, None]:
        for gran in [4, 5]:
            try:
                records, api_url = ned_query_utilizations(
                    type_id=type_id,
                    activity=activity,
                    granularity=gran,
                    classification=classification,
                    point=point,
                )
                rec, dt = ned_pick_latest_record(records)
                return rec, dt, api_url
            except (ValueError, HTTPError, URLError, TimeoutError) as exc:
                last_error = exc

    # Fallback: broad query then filter by type/activity in-memory.
    try:
        records, api_url = ned_query_utilizations(
            type_id=None,
            activity=None,
            granularity=4,
            classification=None,
            point=point,
        )
        filtered = []
        for rec in records:
            rec_type = parse_ref_id(rec.get("type"))
            rec_act = parse_ref_id(rec.get("activity"))
            if rec_type == type_id and rec_act == activity:
                filtered.append(rec)
        if not filtered:
            raise ValueError(f"No broad-query records for type={type_id}, activity={activity}")
        rec, dt = ned_pick_latest_record(filtered)
        return rec, dt, api_url
    except (ValueError, HTTPError, URLError, TimeoutError) as exc:
        last_error = exc

    raise ValueError(f"NED no data for type={type_id}, activity={activity}, point={point} ({last_error})")


def ned_record_value(rec):
    for key in ["capacity", "volume", "value", "percentage"]:
        parsed = to_float(rec.get(key))
        if parsed is not None:
            return parsed, key
    return None, None


def ned_to_mw(value, value_key=None, rec=None):
    if value is None:
        return None
    unit_hint = ""
    if isinstance(rec, dict):
        unit_hint = str(rec.get("unit") or rec.get("unitofmeasure") or rec.get("uom") or "").lower()
    if "mw" in unit_hint:
        return value
    if "kw" in unit_hint:
        return value / 1000.0
    if value_key in {"capacity", "value", "volume"}:
        return value / 1000.0
    return value


def ned_to_percent(value):
    if value is None:
        return None
    # NED percentages are frequently returned as fractions (0-1).
    if 0 <= value <= 1:
        return value * 100.0
    return value


def get_ned_actual_electricity_consumption():
    # Type 59 = Electricityload, Activity 2 = Consuming
    rec, dt, api_url = ned_get_latest_for_type_activity(type_id=59, activity=2)
    value, value_key = ned_record_value(rec)
    if value is None:
        raise ValueError("No numeric electricity consumption value in NED record")
    value_mw = ned_to_mw(value, value_key=value_key, rec=rec)
    return {
        "id": "nlElectricityConsumption",
        "label": "Elektriciteitsconsumptie NL (actueel)",
        "value": value_mw,
        "unit": "MW",
        "source": "NED API",
        "sourceUrl": api_url,
        "updatedAt": dt.isoformat(),
    }


def get_ned_electricity_generation_mix():
    # Current production mix by source.
    types = [
        (1, "Wind op land"),
        (17, "Wind op zee"),
        (2, "Zon"),
        (18, "Gascentrales"),
        (19, "Steenkool"),
        (20, "Kernenergie"),
        (21, "Afval"),
        (25, "Biomassa"),
        (26, "Overig"),
    ]
    rows = []
    latest_dt = None
    source_url = "https://api.ned.nl/v1/utilizations"
    last_error = None
    for type_id, name in types:
        try:
            rec, dt, api_url = ned_get_latest_for_type_activity(type_id=type_id, activity=1)
            value, key = ned_record_value(rec)
            if value is None:
                continue
            rows.append({"hour": name, "value": ned_to_mw(value, value_key=key, rec=rec), "unit": "MW"})
            source_url = api_url
            if latest_dt is None or dt > latest_dt:
                latest_dt = dt
        except (ValueError, HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            continue

    if not rows:
        raise ValueError(f"No generation rows could be retrieved from NED ({last_error})")

    total = sum((r["value"] or 0.0) for r in rows)
    return {
        "id": "nlElectricityGenerationMix",
        "label": "Opwekmiddelen Elektriciteit NL (actueel)",
        "value": total,
        "unit": "MW",
        "source": "NED API",
        "sourceUrl": source_url,
        "updatedAt": (latest_dt.isoformat() if latest_dt else datetime.now(timezone.utc).isoformat()),
        "detail": "Uitsplitsing per energiedrager",
        "rows": rows,
    }


def get_entsoe_generation_share_pie():
    token = get_entsoe_token()
    nl = "10YNL----------L"
    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    def fetch_mix(hours_back: int):
        period_start = now_utc - timedelta(hours=hours_back)
        period_end = now_utc + timedelta(hours=1)
        base = {
            "securityToken": token,
            "documentType": "A75",
            "periodStart": period_start.strftime("%Y%m%d%H%M"),
            "periodEnd": period_end.strftime("%Y%m%d%H%M"),
        }
        attempts = [
            {**base, "in_Domain": nl, "processType": "A16"},
            {**base, "In_Domain": nl, "processType": "A16"},
            {**base, "inBiddingZone_Domain": nl, "processType": "A16"},
            {**base, "InBiddingZone_Domain": nl, "processType": "A16"},
            {**base, "in_Domain": nl},
            {**base, "In_Domain": nl},
            {**base, "inBiddingZone_Domain": nl},
            {**base, "InBiddingZone_Domain": nl},
        ]
        local_last_error = None
        for att in attempts:
            try:
                xml_text, used_url = entsoe_fetch_xml(att, timeout=8)
                root = ET.fromstring(xml_text)
                by_code_series = {}
                for ts in root.findall(".//{*}TimeSeries"):
                    psr = ts.find("./{*}MktPSRType/{*}psrType")
                    if psr is None:
                        psr = ts.find(".//{*}psrType")
                    code = str(psr.text or "").strip().upper() if psr is not None else ""
                    if not code:
                        continue
                    series = by_code_series.setdefault(code, {})
                    for period in ts.findall("./{*}Period"):
                        start_el = period.find("./{*}timeInterval/{*}start")
                        res_el = period.find("./{*}resolution")
                        if start_el is None or not (start_el.text or "").strip():
                            continue
                        start_dt = parse_dt_any(start_el.text.strip())
                        if start_dt is None:
                            continue
                        step_minutes = 60
                        if res_el is not None and (res_el.text or "").strip():
                            rtxt = res_el.text.strip().upper()
                            m = re.match(r"PT(\d+)M", rtxt)
                            h = re.match(r"PT(\d+)H", rtxt)
                            if m:
                                step_minutes = max(1, int(m.group(1)))
                            elif h:
                                step_minutes = max(1, int(h.group(1)) * 60)
                        for p in period.findall("./{*}Point"):
                            pos_el = p.find("./{*}position")
                            qty_el = p.find("./{*}quantity")
                            if pos_el is None or qty_el is None:
                                continue
                            pos = to_float(pos_el.text)
                            qty = to_float(qty_el.text)
                            if pos is None or qty is None:
                                continue
                            dt = start_dt + timedelta(minutes=(int(pos) - 1) * step_minutes)
                            series[dt] = qty

                all_dts = set()
                for s in by_code_series.values():
                    all_dts.update(s.keys())
                if not all_dts:
                    raise ValueError("No ENTSO-E generation PSR points for NL")
                best_dt = max(all_dts)
                values = {}
                for code, series in by_code_series.items():
                    if best_dt in series:
                        values[code] = series[best_dt]
                        continue
                    nearest = min(series.keys(), key=lambda d: abs((d - best_dt).total_seconds()))
                    if abs((nearest - best_dt).total_seconds()) <= 5400:
                        values[code] = series[nearest]
                if not values:
                    raise ValueError("No ENTSO-E generation values around latest timestamp")
                return best_dt, values, used_url, None
            except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout, ET.ParseError) as exc:
                local_last_error = exc
                continue
        return None, None, "https://web-api.tp.entsoe.eu/api", local_last_error

    latest_dt, code_values, source_url, last_error = fetch_mix(24)
    if code_values is None:
        raise ValueError(f"No ENTSO-E generation mix available ({last_error})")

    # Extra freshness check: retry with tight recent window if data is stale.
    age_sec = (now_utc - latest_dt).total_seconds() if latest_dt is not None else 10**9
    if age_sec > 2 * 3600:
        dt2, values2, url2, _err2 = fetch_mix(6)
        if dt2 is not None and values2 is not None and (latest_dt is None or dt2 > latest_dt):
            latest_dt = dt2
            code_values = values2
            source_url = url2

    category_codes = {
        "Gascentrales": {"B04"},
        "Kolencentrales": {"B02", "B03", "B05"},
        "Afval": {"B17"},
        "Zon": {"B16"},
        "Wind": {"B18", "B19"},
        "Biomassa": {"B01"},
        "Kernenergie": {"B14"},
    }
    cat_values = {}
    for label, codes in category_codes.items():
        cat_values[label] = sum((to_float(code_values.get(c)) or 0.0) for c in codes)

    positive = {k: v for k, v in cat_values.items() if v > 0}
    if not positive:
        raise ValueError("No positive ENTSO-E generation values in selected categories")
    total = sum(positive.values())
    order = ["Gascentrales", "Kolencentrales", "Afval", "Zon", "Wind", "Biomassa", "Kernenergie"]
    share_rows = []
    for label in order:
        if label not in positive:
            continue
        share_rows.append({"hour": label, "value": (positive[label] / total) * 100.0, "unit": "%"})

    return {
        "id": "nlGenerationMixShare",
        "label": "Opwek Mix NL (actuele verhouding)",
        "value": None,
        "unit": "",
        "valueText": "Verhouding per bron",
        "source": "ENTSO-E Transparency API",
        "sourceUrl": source_url,
        "updatedAt": latest_dt.isoformat() if latest_dt is not None else datetime.now(timezone.utc).isoformat(),
        "detail": (
            "Relatieve verdeling per opwekbron (geen absolute MW-waarden), zo actueel mogelijk via ENTSO-E"
            + (" | publicatievertraging mogelijk" if (now_utc - latest_dt).total_seconds() > 2 * 3600 else "")
        ),
        "rows": share_rows,
    }


def get_ned_gas_consumption_breakdown():
    # Type mapping based on NED API docs:
    # 55 LocalDistributionCompaniesCombination (households/small business)
    # 53 IndustrialConsumersGasCombination (industry)
    # 54 IndustrialConsumersPowerGasCombination (gas-fired power plants)
    types = [
        (55, "Huishoudens & kleinzakelijk"),
        (53, "Industrie"),
        (54, "Gascentrales"),
    ]
    by_name_day = {}
    source_url = "https://api.ned.nl/v1/utilizations"
    last_error = None
    nl_tz = ZoneInfo("Europe/Amsterdam") if ZoneInfo is not None else timezone.utc
    today_local = datetime.now(nl_tz).date()

    def day_gwh_from_records(records):
        per_day = {}
        for rec in records:
            dt = parse_dt_any(rec.get("validfrom") or rec.get("timestamp") or rec.get("date"))
            if dt is None:
                continue
            day = dt.astimezone(nl_tz).date()
            if day >= today_local:
                continue
            value, key = ned_record_value(rec)
            if value is None:
                continue
            mw = ned_to_mw(value, value_key=key, rec=rec)
            if mw is None:
                continue
            per_day.setdefault(day, []).append(mw)
        out = {}
        for day, vals in per_day.items():
            if not vals:
                continue
            out[day] = (mean(vals) * 24.0) / 1000.0
        return out

    def fetch_daily_for_category(type_id: int, name: str):
        local_last_error = None
        attempts = [
            (2, 4),
            (1, 4),
            (None, 4),
            (2, 5),
            (1, 5),
            (None, 5),
        ]
        for classification, gran in attempts:
            try:
                records, api_url = ned_query_utilizations(
                    type_id=type_id,
                    activity=2,
                    granularity=gran,
                    classification=classification,
                    point=0,
                    limit=1200,
                    days_back=10,
                )
                daily = day_gwh_from_records(records)
                if daily:
                    return daily, api_url
            except (ValueError, HTTPError, URLError, TimeoutError) as exc:
                local_last_error = exc
                continue

        # Fallback: latest available point -> pseudo day GWh estimate.
        try:
            rec, _dt, api_url = ned_get_latest_for_type_activity(type_id=type_id, activity=2, point=0)
            value, key = ned_record_value(rec)
            mw = ned_to_mw(value, value_key=key, rec=rec)
            rec_dt = parse_dt_any(rec.get("validfrom") or rec.get("timestamp") or rec.get("date"))
            if mw is not None and rec_dt is not None:
                day = rec_dt.astimezone(nl_tz).date() - timedelta(days=1)
                return {day: (mw * 24.0) / 1000.0}, api_url
        except (ValueError, HTTPError, URLError, TimeoutError) as exc:
            local_last_error = exc

        raise ValueError(f"No NED gas-consumption daily/fallback data for {name} ({local_last_error})")

    for type_id, name in types:
        try:
            daily, api_url = fetch_daily_for_category(type_id, name)
            by_name_day[name] = daily
            source_url = api_url
        except (ValueError, HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            continue

    if len(by_name_day) < 3:
        raise ValueError(f"No gas consumption rows could be retrieved from NED ({last_error})")

    common_days = None
    for day_map in by_name_day.values():
        keys = set(day_map.keys())
        common_days = keys if common_days is None else (common_days & keys)
    if not common_days:
        # As last resort, align all categories to the latest day available in all by carrying
        # the nearest available previous day per category.
        latest_any = max(max(day_map.keys()) for day_map in by_name_day.values())
        approximated = {}
        for name, day_map in by_name_day.items():
            candidates = [d for d in day_map.keys() if d <= latest_any]
            if not candidates:
                raise ValueError("No common or aligned day across NED gas-consumption categories")
            approximated[name] = day_map[max(candidates)]
        gwh_rows = [
            {"hour": "Huishoudens & kleinzakelijk", "value": approximated["Huishoudens & kleinzakelijk"], "unit": "GWh/d"},
            {"hour": "Industrie", "value": approximated["Industrie"], "unit": "GWh/d"},
            {"hour": "Gascentrales", "value": approximated["Gascentrales"], "unit": "GWh/d"},
        ]
        chosen_day = latest_any
        aligned_note = " (deels uit nabijgelegen dagen)"
    else:
        chosen_day = max(common_days)
        aligned_note = ""
        gwh_rows = [
            {"hour": "Huishoudens & kleinzakelijk", "value": by_name_day["Huishoudens & kleinzakelijk"][chosen_day], "unit": "GWh/d"},
            {"hour": "Industrie", "value": by_name_day["Industrie"][chosen_day], "unit": "GWh/d"},
            {"hour": "Gascentrales", "value": by_name_day["Gascentrales"][chosen_day], "unit": "GWh/d"},
        ]
    total_gwh_day = sum((r["value"] or 0.0) for r in gwh_rows)
    pct_rows = []
    for r in gwh_rows:
        pct = (r["value"] / total_gwh_day) * 100.0 if total_gwh_day > 0 else None
        pct_rows.append({"hour": r["hour"], "value": pct, "unit": "%"})

    updated_at = datetime(chosen_day.year, chosen_day.month, chosen_day.day, 23, 0, tzinfo=nl_tz).astimezone(timezone.utc).isoformat()
    return {
        "id": "nlGasConsumptionBreakdown",
        "label": "Gasconsumptie NL (laatste volledige dag)",
        "value": total_gwh_day,
        "unit": "GWh/d",
        "source": "NED API",
        "sourceUrl": source_url,
        "updatedAt": updated_at,
        "detail": f"Totaalverbruik van {chosen_day.isoformat()} in GWh/d{aligned_note}. Onderverdeling hieronder in percentages.",
        "rows": pct_rows,
    }


def energy_to_gwh(value, unit_hint: str):
    v = to_float(value)
    if v is None:
        return None
    u = (unit_hint or "").strip().lower().replace(" ", "")
    if "twh" in u:
        return v * 1000.0
    if "gwh" in u:
        return v
    if "mwh" in u:
        return v / 1000.0
    if "kwh" in u:
        return v / 1_000_000.0
    if "wh" in u:
        return v / 1_000_000_000.0
    return None


def ned_get_storage_latest_previous():
    # Keep scope strict to national gas storage series.
    candidates = [(28, 3), (58, 3), (58, 1), (57, 3), (57, 1), (56, 3), (56, 1), (60, 3), (60, 1)]
    last_error = None
    for type_id, activity in candidates:
        try:
            records, api_url = ned_query_utilizations(
                type_id=type_id,
                activity=activity,
                granularity=4,
                classification=None,
                point=0,
                limit=1200,
                days_back=14,
            )
            pairs = []
            for rec in records:
                dt = parse_dt_any(rec.get("validfrom") or rec.get("timestamp") or rec.get("date"))
                pct = ned_to_percent(to_float(rec.get("percentage")))
                if dt is None or pct is None:
                    continue
                pairs.append((dt, rec, pct))
            if len(pairs) < 2:
                continue
            pairs.sort(key=lambda x: x[0], reverse=True)
            latest = pairs[0]
            prev = pairs[1]
            return latest, prev, api_url
        except (ValueError, HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            continue
    raise ValueError(f"Could not retrieve latest+previous NED storage records ({last_error})")


def get_ned_electricity_overview():
    tennet_err = None
    if has_tennet_key():
        try:
            return get_tennet_electricity_overview()
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout) as exc:
            tennet_err = exc

    entsoe_err = None
    try:
        entsoe_item = get_entsoe_electricity_overview()
        if tennet_err is not None:
            entsoe_item["detail"] = f"{entsoe_item.get('detail','')} | TenneT tijdelijk niet beschikbaar ({tennet_err})".strip(" |")
        return entsoe_item
    except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout, ET.ParseError) as exc:
        entsoe_err = exc

    ned_item = get_ned_electricity_overview_fallback()
    parts = [ned_item.get("detail", "")]
    if tennet_err is not None:
        parts.append(f"TenneT niet beschikbaar: {tennet_err}")
    if entsoe_err is not None:
        parts.append(f"ENTSO-E niet beschikbaar: {entsoe_err}")
    ned_item["detail"] = " | ".join([p for p in parts if p])
    return ned_item


def get_ned_electricity_overview_fallback():
    consumption = get_ned_actual_electricity_consumption()
    load_mw = to_float(consumption.get("value"))
    if load_mw is None:
        raise ValueError("NED fallback could not determine load")
    return {
        "id": "nlElectricityOverview",
        "label": "Elektriciteit NL (actuele load)",
        "value": load_mw,
        "unit": "MW",
        "source": "NED API (fallback)",
        "sourceUrl": consumption.get("sourceUrl") or "https://api.ned.nl/v1/utilizations",
        "updatedAt": consumption.get("updatedAt") or datetime.now(timezone.utc).isoformat(),
        "detail": "ENTSO-E tijdelijk niet beschikbaar; fallback op NED load",
        "rows": [],
    }


def get_tennet_electricity_overview():
    latest_point, latest_ts, source_url = get_tennet_metered_latest_point()
    load_mw = to_float(latest_point.get("measured_infeed"))
    if load_mw is None:
        load_mw = to_float(latest_point.get("load"))
    if load_mw is None:
        raise ValueError("TenneT metered-injections has no load/measured_infeed value")

    return {
        "id": "nlElectricityOverview",
        "label": "Elektriciteit NL (actuele load)",
        "value": load_mw,
        "unit": "MW",
        "source": "TenneT Aether (Metered Injections + Scheduled Exchanges)",
        "sourceUrl": source_url,
        "updatedAt": latest_ts or datetime.now(timezone.utc).isoformat(),
        "detail": "Actuele Nederlandse load op basis van TenneT metered injections",
        "rows": [],
    }


def _entsoe_latest_quantity(params: dict, timeout: int = 10):
    xml_text, url = entsoe_fetch_xml(params, timeout=timeout)
    root = ET.fromstring(xml_text)
    latest_dt = None
    latest_val = None
    for period in root.findall(".//{*}Period"):
        start_el = period.find("./{*}timeInterval/{*}start")
        res_el = period.find("./{*}resolution")
        if start_el is None or not (start_el.text or "").strip():
            continue
        start_dt = parse_dt_any(start_el.text.strip())
        if start_dt is None:
            continue
        step_minutes = 60
        if res_el is not None and (res_el.text or "").strip():
            rtxt = res_el.text.strip().upper()
            m = re.match(r"PT(\d+)M", rtxt)
            h = re.match(r"PT(\d+)H", rtxt)
            if m:
                step_minutes = max(1, int(m.group(1)))
            elif h:
                step_minutes = max(1, int(h.group(1)) * 60)
        for p in period.findall("./{*}Point"):
            pos_el = p.find("./{*}position")
            qty_el = p.find("./{*}quantity")
            if pos_el is None or qty_el is None:
                continue
            pos = to_float(pos_el.text)
            qty = to_float(qty_el.text)
            if pos is None or qty is None:
                continue
            dt = start_dt + timedelta(minutes=(int(pos) - 1) * step_minutes)
            if latest_dt is None or dt > latest_dt:
                latest_dt = dt
                latest_val = qty
    return latest_dt, latest_val, url


def _entsoe_latest_total_quantity(params: dict, timeout: int = 10):
    xml_text, url = entsoe_fetch_xml(params, timeout=timeout)
    root = ET.fromstring(xml_text)

    totals = {}
    for ts in root.findall(".//{*}TimeSeries"):
        for period in ts.findall("./{*}Period"):
            start_el = period.find("./{*}timeInterval/{*}start")
            res_el = period.find("./{*}resolution")
            if start_el is None or not (start_el.text or "").strip():
                continue
            start_dt = parse_dt_any(start_el.text.strip())
            if start_dt is None:
                continue
            step_minutes = 60
            if res_el is not None and (res_el.text or "").strip():
                rtxt = res_el.text.strip().upper()
                m = re.match(r"PT(\d+)M", rtxt)
                h = re.match(r"PT(\d+)H", rtxt)
                if m:
                    step_minutes = max(1, int(m.group(1)))
                elif h:
                    step_minutes = max(1, int(h.group(1)) * 60)
            for p in period.findall("./{*}Point"):
                pos_el = p.find("./{*}position")
                qty_el = p.find("./{*}quantity")
                if pos_el is None or qty_el is None:
                    continue
                pos = to_float(pos_el.text)
                qty = to_float(qty_el.text)
                if pos is None or qty is None:
                    continue
                dt = start_dt + timedelta(minutes=(int(pos) - 1) * step_minutes)
                totals[dt] = totals.get(dt, 0.0) + qty

    if not totals:
        return None, None, url
    latest_dt = max(totals.keys())
    return latest_dt, totals[latest_dt], url


def entsoe_fetch_xml(params: dict, timeout: int = 10):
    last_error = None
    for base in ENTSOE_BASE_URLS:
        url = f"{base}?{urlencode(params)}"
        for _attempt in range(3):
            try:
                xml_text = fetch_text(url, timeout=timeout, extra_headers={"Accept": "application/xml, text/xml"})
                prefix = xml_text.lstrip()[:400].lower()
                if "<html" in prefix:
                    raise ValueError(f"ENTSO-E endpoint returned HTML instead of XML ({base})")
                if not prefix.startswith("<"):
                    raise ValueError(f"ENTSO-E endpoint returned non-XML payload ({base})")
                return xml_text, url
            except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout, ET.ParseError) as exc:
                last_error = exc
                continue
    raise ValueError(f"All ENTSO-E endpoints failed ({last_error})")


def get_entsoe_electricity_overview():
    token = get_entsoe_token()
    hard_deadline = time.time() + 12.0
    nl = "10YNL----------L"
    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    period_start = now_utc - timedelta(days=2)
    period_end = now_utc + timedelta(hours=1)

    load_base = {
        "securityToken": token,
        "documentType": "A65",
        "periodStart": period_start.strftime("%Y%m%d%H%M"),
        "periodEnd": period_end.strftime("%Y%m%d%H%M"),
    }
    load_attempts = [
        {**load_base, "outBiddingZone_Domain": nl, "processType": "A16"},
        {**load_base, "OutBiddingZone_Domain": nl, "processType": "A16"},
        {**load_base, "out_Domain": nl, "processType": "A16"},
        {**load_base, "Out_Domain": nl, "processType": "A16"},
        {**load_base, "outBiddingZone_Domain": nl, "processType": "A01"},
        {**load_base, "OutBiddingZone_Domain": nl, "processType": "A01"},
        {**load_base, "out_Domain": nl, "processType": "A01"},
        {**load_base, "Out_Domain": nl, "processType": "A01"},
        {**load_base, "outBiddingZone_Domain": nl},
        {**load_base, "OutBiddingZone_Domain": nl},
        {**load_base, "out_Domain": nl},
        {**load_base, "Out_Domain": nl},
        {**load_base, "biddingZone_Domain": nl},
        {**load_base, "BiddingZone_Domain": nl},
    ]
    load_dt, load_mw, load_url = None, None, None
    for att in load_attempts:
        if time.time() > hard_deadline:
            break
        try:
            load_dt, load_mw, load_url = _entsoe_latest_quantity(att, timeout=3)
            if load_mw is not None:
                break
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout, ET.ParseError):
            continue
    if load_mw is None:
        raise ValueError("No ENTSO-E NL load points (A65)")

    updated_at = load_dt.isoformat() if load_dt is not None else datetime.now(timezone.utc).isoformat()
    source_url = load_url or "https://web-api.tp.entsoe.eu/api"

    result = {
        "id": "nlElectricityOverview",
        "label": "Elektriciteit NL (actuele load)",
        "value": load_mw,
        "unit": "MW",
        "source": "ENTSO-E Transparency API",
        "sourceUrl": source_url,
        "updatedAt": updated_at,
        "detail": "Actuele load uit ENTSO-E",
        "rows": [],
    }
    cache_set("nlElectricityOverview", result)
    return result


def extract_chart_points_from_html(page_html: str, value_key_hints):
    points = []

    # Pattern 1: object-like entries with explicit date/time and value field
    value_key_group = "|".join([re.escape(k) for k in value_key_hints])
    obj_pattern = re.compile(
        r'(?P<date_key>date|datum|day|x|timestamp)\s*"?\s*:\s*"?'
        r'(?P<date>(?:\d{4}-\d{2}-\d{2}(?:[T ][0-9:]+(?:Z|[+-][0-9:]+)?)?)|(?:\d{10,13})|(?:\d{2}-\d{2}-\d{4})|(?:\d{2}/\d{2}/\d{4}))"?'
        r'.{0,220}?'
        r'(?P<value_key>' + value_key_group + r')\s*"?\s*:\s*"?(?P<value>-?[0-9]+(?:[.,][0-9]+)?)',
        re.I | re.S,
    )
    for m in obj_pattern.finditer(page_html):
        dt = parse_dt_any(m.group("date"))
        value = to_float(m.group("value"))
        if dt and value is not None:
            points.append((dt, value))

    # Pattern 2: pairs [timestamp, value]
    for m in re.finditer(r"\[\s*(\d{10,13})\s*,\s*(-?[0-9]+(?:\.[0-9]+)?)\s*\]", page_html):
        dt = parse_dt_any(m.group(1))
        value = to_float(m.group(2))
        if dt and value is not None:
            points.append((dt, value))

    return points


def summarize_latest_day(points):
    if not points:
        return None, None, None
    grouped = {}
    for dt, value in points:
        day = dt.date().isoformat()
        grouped.setdefault(day, []).append(value)
    latest_day = sorted(grouped.keys())[-1]
    day_values = grouped[latest_day]
    return latest_day, sum(day_values), day_values


def get_ttf_gas():
    source_url = "https://tradingeconomics.com/commodity/eu-natural-gas"
    html = fetch_text(source_url)
    value = parse_te_last_value(html)

    return {
        "id": "ttfGas",
        "label": "TTF Gas",
        "value": value,
        "unit": "EUR/MWh",
        "source": "TradingEconomics",
        "sourceUrl": source_url,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _extract_nl_baseload_y1_from_text(page_text: str):
    target_year = datetime.now(timezone.utc).year + 1
    yy = str(target_year)[-2:]
    markers = [
        rf"cal(?:endar)?[\s\-\/]*{target_year}",
        rf"cal[\s\-\/]*{yy}\b",
        rf"jaar[\s\+]*1",
        rf"year[\s\+]*1",
    ]
    best = None
    for pat in markers:
        for m in re.finditer(pat, page_text, re.I):
            start = max(0, m.start() - 80)
            end = min(len(page_text), m.end() + 240)
            chunk = page_text[start:end]
            nums = []
            for nm in re.finditer(r"-?\d+(?:[.,]\d+)?", chunk):
                v = to_float(nm.group(0))
                if v is None:
                    continue
                # Filter obvious non-price tokens (year, tiny ids, huge ids).
                if abs(v - target_year) < 0.001 or abs(v - int(yy)) < 0.001:
                    continue
                if not (1.0 <= v <= 1000.0):
                    continue
                nums.append(v)
            if nums:
                cand = nums[-1]
                if best is None:
                    best = cand
    return best


def get_nl_power_baseload_year_ahead():
    sources = [
        (
            "ICE",
            "https://www.ice.com/products/27993085/Dutch-Power-Baseload-Futures",
        ),
        (
            "EEX",
            "https://www.eex.com/en/market-data/power/futures",
        ),
    ]

    last_error = None
    for source_name, url in sources:
        try:
            text = fetch_text(url, timeout=12)
            value = _extract_nl_baseload_y1_from_text(text)
            if value is None:
                raise ValueError("Could not parse Year+1 baseload price from page")
            return {
                "id": "nlBaseloadY1",
                "label": "NL Baseload Stroom Jaar+1 (futures)",
                "value": value,
                "unit": "EUR/MWh",
                "source": source_name,
                "sourceUrl": url,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Year-ahead baseload indicatie (CAL+1)",
            }
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout) as exc:
            last_error = exc
            continue

    raise ValueError(f"No NL year-ahead baseload futures price available ({last_error})")


def get_day_ahead_electricity():
    token = get_entsoe_token()
    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    market_tz = ZoneInfo("Europe/Brussels") if ZoneInfo is not None else timezone.utc
    now_market = datetime.now(market_tz).replace(minute=0, second=0, microsecond=0)

    # Query a wider window and then choose one full delivery day (00:00-23:00) with most datapoints.
    local_midnight = now_market.replace(hour=0, minute=0, second=0, microsecond=0)
    q_start_utc = (local_midnight - timedelta(days=2)).astimezone(timezone.utc)
    q_end_utc = (local_midnight + timedelta(days=4)).astimezone(timezone.utc)
    points = {}
    source_url = None
    day_ahead_attempts = [
        {
            "securityToken": token,
            "documentType": "A44",
            "processType": "A01",
            "auction.Type": "A01",
            "in_Domain": "10YNL----------L",
            "out_Domain": "10YNL----------L",
            "periodStart": q_start_utc.strftime("%Y%m%d%H%M"),
            "periodEnd": q_end_utc.strftime("%Y%m%d%H%M"),
        },
        {
            "securityToken": token,
            "documentType": "A44",
            "processType": "A01",
            "in_Domain": "10YNL----------L",
            "out_Domain": "10YNL----------L",
            "periodStart": q_start_utc.strftime("%Y%m%d%H%M"),
            "periodEnd": q_end_utc.strftime("%Y%m%d%H%M"),
        },
        {
            "securityToken": token,
            "documentType": "A44",
            "auction.Type": "A01",
            "in_Domain": "10YNL----------L",
            "out_Domain": "10YNL----------L",
            "periodStart": q_start_utc.strftime("%Y%m%d%H%M"),
            "periodEnd": q_end_utc.strftime("%Y%m%d%H%M"),
        },
        {
            "securityToken": token,
            "documentType": "A44",
            "biddingZone_Domain": "10YNL----------L",
            "periodStart": q_start_utc.strftime("%Y%m%d%H%M"),
            "periodEnd": q_end_utc.strftime("%Y%m%d%H%M"),
        },
        {
            "securityToken": token,
            "documentType": "A44",
            "BiddingZone_Domain": "10YNL----------L",
            "In_Domain": "10YNL----------L",
            "Out_Domain": "10YNL----------L",
            "periodStart": q_start_utc.strftime("%Y%m%d%H%M"),
            "periodEnd": q_end_utc.strftime("%Y%m%d%H%M"),
        },
    ]
    for att in day_ahead_attempts:
        try:
            xml_text, used_url = entsoe_fetch_xml(att, timeout=8)
            source_url = used_url
            root = ET.fromstring(xml_text)
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout, ET.ParseError):
            continue

        for period in root.findall(".//{*}Period"):
            start_el = period.find("./{*}timeInterval/{*}start")
            res_el = period.find("./{*}resolution")
            if start_el is None or not (start_el.text or "").strip():
                continue
            start_dt = parse_dt_any(start_el.text.strip())
            if start_dt is None:
                continue

            # ENTSO-E day-ahead is typically hourly (PT60M). Keep fallback to 60 min.
            step_minutes = 60
            if res_el is not None and (res_el.text or "").strip():
                rtxt = res_el.text.strip().upper()
                m = re.match(r"PT(\d+)M", rtxt)
                h = re.match(r"PT(\d+)H", rtxt)
                if m:
                    step_minutes = max(1, int(m.group(1)))
                elif h:
                    step_minutes = max(1, int(h.group(1)) * 60)

            for p in period.findall("./{*}Point"):
                pos_el = p.find("./{*}position")
                if pos_el is None:
                    continue
                pos = to_float(pos_el.text)
                val = None
                for child in list(p):
                    tag = child.tag.split("}")[-1]
                    if tag == "price.amount" or "price" in tag.lower():
                        val = to_float(child.text)
                        if val is not None:
                            break
                if pos is None or val is None:
                    continue
                point_dt = start_dt + timedelta(minutes=(int(pos) - 1) * step_minutes)
                hour_market = point_dt.astimezone(market_tz).replace(minute=0, second=0, microsecond=0)
                points[hour_market] = val
        if points:
            break
    if source_url is None:
        source_url = ENTSOE_BASE_URLS[0]

    # Prefer today explicitly; only fallback to next/previous day if today is unavailable.
    candidate_days = [
        local_midnight.date(),
        local_midnight.date() + timedelta(days=1),
        local_midnight.date() - timedelta(days=1),
        local_midnight.date() + timedelta(days=2),
    ]
    best_day = None
    best_count = -1
    for day in candidate_days:
        count = 0
        for h in range(24):
            dt = datetime(day.year, day.month, day.day, h, 0, tzinfo=market_tz)
            if points.get(dt) is not None:
                count += 1
        if day == local_midnight.date() and count > 0:
            best_day = day
            best_count = count
            break
        if count > best_count:
            best_count = count
            best_day = day

    rows = []
    first_available = None
    if best_day is not None and best_count > 0:
        for h in range(24):
            dt = datetime(best_day.year, best_day.month, best_day.day, h, 0, tzinfo=market_tz)
            val = points.get(dt)
            row = {"hour": dt.strftime("%H:00"), "value": val, "unit": "EUR/MWh"}
            if first_available is None and val is not None:
                first_available = row
            rows.append(row)

    if first_available is not None:
        now_label = now_market.strftime("%H:00")
        now_row = next((r for r in rows if r["hour"] == now_label and r["value"] is not None), None)
        headline_value = now_row["value"] if now_row is not None else first_available["value"]
        result = {
            "id": "dayAheadPower24h",
            "label": "EPEX SPOT Day-Ahead NL (24h vooruit)",
            "value": headline_value,
            "unit": "EUR/MWh",
            "source": "ENTSO-E Transparency API (EPEX SPOT NL)",
            "sourceUrl": source_url,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "detail": (
                f"Volledige leveringsdag {best_day.isoformat()} (Europe/Brussels)"
                + (f" | Topwaarde = huidig uur {now_label}" if now_row is not None else " | Topwaarde = eerst beschikbare uurprijs")
            ),
            "rows": rows,
        }
        cache_set("dayAheadPower24h", result)
        return result

    # Fallback: parse from dayahead.nl when ENTSO-E yields no usable day block.
    fallback_url = "https://www.dayahead.nl"
    html_page = fetch_text(fallback_url, timeout=10)
    points2 = extract_chart_points_from_html(html_page, ["price", "prijs", "dayahead", "value", "y"])
    hourly_values = {}  # keyed by market timezone hour
    for dt, val in points2:
        hour_dt = dt.astimezone(market_tz).replace(minute=0, second=0, microsecond=0)
        hourly_values.setdefault(hour_dt, []).append(val)

    best_day_fb = None
    best_count_fb = -1
    for day in candidate_days:
        count = 0
        for h in range(24):
            dt = datetime(day.year, day.month, day.day, h, 0, tzinfo=market_tz)
            if hourly_values.get(dt):
                count += 1
        if day == local_midnight.date() and count > 0:
            best_day_fb = day
            best_count_fb = count
            break
        if count > best_count_fb:
            best_count_fb = count
            best_day_fb = day

    fb_rows = []
    if best_day_fb is not None and best_count_fb > 0:
        for h in range(24):
            dt = datetime(best_day_fb.year, best_day_fb.month, best_day_fb.day, h, 0, tzinfo=market_tz)
            vals = hourly_values.get(dt) or []
            fb_rows.append({"hour": dt.strftime("%H:00"), "value": (mean(vals) if vals else None), "unit": "EUR/MWh"})
    fb_first = next((r for r in fb_rows if r["value"] is not None), None)
    if fb_first is None:
        cached = cache_get("dayAheadPower24h")
        if cached:
            cached["detail"] = f"{cached.get('detail','')} | tijdelijke ENTSO-E storing, cached waarden getoond".strip()
            cached["updatedAt"] = datetime.now(timezone.utc).isoformat()
            return cached
        raise ValueError(
            "No ENTSO-E day-ahead NL prices returned as complete delivery-day series "
            f"(query={q_start_utc.strftime('%Y-%m-%d %H:%M')}..{q_end_utc.strftime('%Y-%m-%d %H:%M')} UTC)"
        )
    now_label = now_market.strftime("%H:00")
    now_row_fb = next((r for r in fb_rows if r["hour"] == now_label and r["value"] is not None), None)
    result = {
        "id": "dayAheadPower24h",
        "label": "EPEX SPOT Day-Ahead NL (24h vooruit)",
        "value": (now_row_fb["value"] if now_row_fb is not None else fb_first["value"]),
        "unit": "EUR/MWh",
        "source": "EPEX SPOT NL (fallback via dayahead.nl)",
        "sourceUrl": fallback_url,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "detail": (
            f"Volledige leveringsdag {best_day_fb.isoformat()} (fallback via dayahead.nl)"
            + (f" | Topwaarde = huidig uur {now_label}" if now_row_fb is not None else " | Topwaarde = eerst beschikbare uurprijs")
        ),
        "rows": fb_rows,
    }
    cache_set("dayAheadPower24h", result)
    return result


def get_entsoe_nl_cross_border_flows(target_dt=None):
    token = get_entsoe_token()
    source_base = ENTSOE_BASE_URLS[0]
    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    period_start = now_utc - timedelta(hours=6)
    period_end = now_utc + timedelta(hours=1)

    nl = "10YNL----------L"
    # Keep alternatives because ENTSO-E domain coverage varies by dataset.
    neighbors = [
        ("Belgie", ["10YBE----------2"]),
        ("Duitsland", ["10Y1001A1001A82H", "10Y1001A1001A83F"]),
        ("Verenigd Koninkrijk", ["10YGB----------A"]),
        ("Denemarken", ["10YDK-1--------W"]),
        ("Noorwegen", ["10YNO-2--------T"]),
    ]

    def parse_series(xml_text):
        root = ET.fromstring(xml_text)
        series = {}
        for period in root.findall(".//{*}Period"):
            start_el = period.find("./{*}timeInterval/{*}start")
            res_el = period.find("./{*}resolution")
            if start_el is None or not (start_el.text or "").strip():
                continue
            start_dt = parse_dt_any(start_el.text.strip())
            if start_dt is None:
                continue
            step_minutes = 60
            if res_el is not None and (res_el.text or "").strip():
                rtxt = res_el.text.strip().upper()
                m = re.match(r"PT(\d+)M", rtxt)
                h = re.match(r"PT(\d+)H", rtxt)
                if m:
                    step_minutes = max(1, int(m.group(1)))
                elif h:
                    step_minutes = max(1, int(h.group(1)) * 60)
            for p in period.findall("./{*}Point"):
                pos_el = p.find("./{*}position")
                qty_el = p.find("./{*}quantity")
                if pos_el is None or qty_el is None:
                    continue
                pos = to_float(pos_el.text)
                qty = to_float(qty_el.text)
                if pos is None or qty is None:
                    continue
                point_dt = start_dt + timedelta(minutes=(int(pos) - 1) * step_minutes)
                series[point_dt] = qty
        return series

    def pick_value(series):
        if not series:
            return None, None
        if target_dt is None:
            latest_dt = max(series.keys())
            return latest_dt, series[latest_dt]
        nearest_dt = min(series.keys(), key=lambda d: abs((d - target_dt).total_seconds()))
        return nearest_dt, series[nearest_dt]

    def latest_flow(in_domain, out_domain):
        # Try physical first (A11), fallback to scheduled exchange (A09).
        attempts = [
            ("A11", None),
            ("A09", None),
        ]
        key_variants = [("in_Domain", "out_Domain"), ("In_Domain", "Out_Domain")]
        last_exc = None
        for doc_type, process_type in attempts:
            for in_key, out_key in key_variants:
                params = {
                    "securityToken": token,
                    "documentType": doc_type,
                    in_key: in_domain,
                    out_key: out_domain,
                    "periodStart": period_start.strftime("%Y%m%d%H%M"),
                    "periodEnd": period_end.strftime("%Y%m%d%H%M"),
                }
                if process_type:
                    params["processType"] = process_type
                try:
                    xml_text, url = entsoe_fetch_xml(params, timeout=3)
                    series = parse_series(xml_text)
                    dt, val = pick_value(series)
                    if val is not None:
                        return val, dt, url, doc_type
                except (ValueError, HTTPError, URLError, TimeoutError, ET.ParseError) as exc:
                    last_exc = exc
                    continue
        if last_exc:
            raise last_exc
        return None, None, None, None

    rows = []
    source_urls = []
    row_dts = []
    last_error = None
    diagnostics = []
    empty_pairs = []
    for name, eics in neighbors:
        found = False
        for eic in eics:
            try:
                in_to_nl, in_dt, url_in, doc_in = latest_flow(eic, nl)
                out_from_nl, out_dt, url_out, doc_out = latest_flow(nl, eic)
                if in_to_nl is None and out_from_nl is None:
                    empty_pairs.append(f"{name}:{eic}")
                    continue
                net_to_nl = (in_to_nl or 0.0) - (out_from_nl or 0.0)
                if url_in:
                    source_urls.append(url_in)
                if url_out:
                    source_urls.append(url_out)
                if in_dt is not None:
                    row_dts.append(in_dt)
                if out_dt is not None:
                    row_dts.append(out_dt)
                rows.append({"hour": name, "value": net_to_nl, "unit": "MW"})
                diagnostics.append(f"{name}:{eic} in={doc_in or 'n/a'} out={doc_out or 'n/a'}")
                found = True
                break
            except (ValueError, HTTPError, URLError, TimeoutError, ET.ParseError) as exc:
                last_error = exc
                continue
        if not found and name not in [r["hour"] for r in rows]:
            rows.append({"hour": name, "value": None, "unit": "MW"})

    numeric_rows = [r for r in rows if r.get("value") is not None]
    if not numeric_rows:
        diag = f"empty border pairs={empty_pairs}" if empty_pairs else "no border points in response"
        try:
            if has_tennet_key():
                nl_net = get_nl_import_export_position()
                net_val = to_float(nl_net.get("value"))
                if net_val is not None:
                    fallback_rows = [
                        {"hour": "Belgie", "value": None, "unit": "MW"},
                        {"hour": "Duitsland", "value": net_val, "unit": "MW"},
                        {"hour": "Verenigd Koninkrijk", "value": None, "unit": "MW"},
                        {"hour": "Denemarken", "value": None, "unit": "MW"},
                        {"hour": "Noorwegen", "value": None, "unit": "MW"},
                    ]
                    return {
                        "id": "nlCrossBorderFlows",
                        "label": "Cross-Border Physical Flows NL (live, netto)",
                        "value": net_val,
                        "unit": "MW",
                        "source": "TenneT API (fallback)",
                        "sourceUrl": nl_net.get("sourceUrl") or "https://api.tennet.eu/publications/v1/metered-injections",
                        "updatedAt": nl_net.get("updatedAt") or datetime.now(timezone.utc).isoformat(),
                        "detail": "ENTSO-E tijdelijk niet beschikbaar; fallback op TenneT netto import/export",
                        "rows": fallback_rows,
                    }
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout):
            pass
        if last_error:
            cached = cache_get("nlCrossBorderFlows")
            if cached:
                cached["detail"] = f"{cached.get('detail','')} | tijdelijke ENTSO-E storing, cached waarden getoond".strip()
                cached["updatedAt"] = datetime.now(timezone.utc).isoformat()
                return cached
            raise ValueError(f"No ENTSO-E physical flow rows for NL neighbors ({last_error})")
        cached = cache_get("nlCrossBorderFlows")
        if cached:
            cached["detail"] = f"{cached.get('detail','')} | tijdelijke ENTSO-E storing, cached waarden getoond".strip()
            cached["updatedAt"] = datetime.now(timezone.utc).isoformat()
            return cached
        raise ValueError(f"No ENTSO-E physical flow rows for NL neighbors ({diag})")

    total_import = sum((r["value"] or 0.0) for r in numeric_rows)
    source_url = source_urls[0] if source_urls else source_base
    updated_at = max(row_dts).isoformat() if row_dts else datetime.now(timezone.utc).isoformat()
    result = {
        "id": "nlCrossBorderFlows",
        "label": "Cross-Border Physical Flows NL (live, netto)",
        "value": total_import,
        "unit": "MW",
        "source": "ENTSO-E Transparency API",
        "sourceUrl": source_url,
        "updatedAt": updated_at,
        "detail": "Positief = netto import naar NL, negatief = netto export uit NL" + (f" | {', '.join(diagnostics)}" if diagnostics else ""),
        "rows": rows,
    }
    cache_set("nlCrossBorderFlows", result)
    return result


def get_entsoe_nl_imbalance_prices_week():
    token = get_entsoe_token()
    source_base = "https://web-api.tp.entsoe.eu/api"
    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    period_end = now_utc
    period_start = period_end - timedelta(days=7)

    nl_domain = "10YNL----------L"

    def parse_points(xml_text):
        root = ET.fromstring(xml_text)
        points = []
        for period in root.findall(".//{*}Period"):
            start_el = period.find("./{*}timeInterval/{*}start")
            res_el = period.find("./{*}resolution")
            if start_el is None or not (start_el.text or "").strip():
                continue
            start_dt = parse_dt_any(start_el.text.strip())
            if start_dt is None:
                continue
            step_minutes = 15
            if res_el is not None and (res_el.text or "").strip():
                rtxt = res_el.text.strip().upper()
                m = re.match(r"PT(\d+)M", rtxt)
                h = re.match(r"PT(\d+)H", rtxt)
                if m:
                    step_minutes = max(1, int(m.group(1)))
                elif h:
                    step_minutes = max(1, int(h.group(1)) * 60)

            for p in period.findall("./{*}Point"):
                pos_el = p.find("./{*}position")
                if pos_el is None:
                    continue
                pos = to_float(pos_el.text)
                if pos is None:
                    continue
                dt = start_dt + timedelta(minutes=(int(pos) - 1) * step_minutes)
                price = None
                for child in list(p):
                    tag = child.tag.split("}")[-1]
                    if tag in {"price.amount", "imbalance_Price.amount"}:
                        price = to_float(child.text)
                        if price is not None:
                            break
                if price is None:
                    # Fallback: pick first numeric field except position.
                    for child in list(p):
                        tag = child.tag.split("}")[-1]
                        if tag == "position":
                            continue
                        val = to_float(child.text)
                        if val is not None:
                            price = val
                            break
                if price is not None:
                    points.append((dt, price))
        return points

    points = []
    used_url = None
    last_error = None
    attempts = [
        {"documentType": "A85", "controlArea_Domain": nl_domain},
        {"documentType": "A85", "ControlArea_Domain": nl_domain},
        {"documentType": "A85", "biddingZone_Domain": nl_domain},
        {"documentType": "A85", "BiddingZone_Domain": nl_domain},
    ]
    for extra in attempts:
        params = {
            "securityToken": token,
            "periodStart": period_start.strftime("%Y%m%d%H%M"),
            "periodEnd": period_end.strftime("%Y%m%d%H%M"),
        }
        params.update(extra)
        url = f"{source_base}?{urlencode(params)}"
        try:
            xml_text = fetch_text(url, timeout=10, extra_headers={"Accept": "application/xml, text/xml"})
            parsed = parse_points(xml_text)
            if parsed:
                points = parsed
                used_url = url
                break
        except (ValueError, HTTPError, URLError, TimeoutError, ET.ParseError) as exc:
            last_error = exc
            continue

    if not points:
        # Fallback to public TenneT imbalance prices if ENTSO-E does not return rows.
        tennet_points = []
        tennet_urls = []
        for i in range(8):
            day = (now_utc - timedelta(days=i)).strftime("%Y%m%d")
            url = f"https://www.tennet.org/xml/imbalanceprice/{day}.xml"
            try:
                xml_text = fetch_text(url, timeout=10)
                root = ET.fromstring(xml_text)
                day_points = []
                for node in root.iter():
                    tag = node.tag.split("}")[-1].lower()
                    if "price" not in tag:
                        continue
                    val = to_float(node.text)
                    if val is None:
                        continue
                    # Try timestamp from siblings/parents is too variable; use day fallback.
                    dt_fallback = parse_dt_any(f"{day[:4]}-{day[4:6]}-{day[6:8]}T00:00:00Z") or datetime.now(timezone.utc)
                    day_points.append((dt_fallback, val))
                if day_points:
                    # Keep daily peak to avoid noisy XML variants.
                    tennet_points.append(max(day_points, key=lambda x: x[1]))
                    tennet_urls.append(url)
            except (ValueError, HTTPError, URLError, TimeoutError, ET.ParseError):
                continue
        if tennet_points:
            points = tennet_points
            used_url = tennet_urls[0]
        else:
            cached = cache_get("nlImbalanceWeek")
            if cached:
                cached["detail"] = f"{cached.get('detail','')} | tijdelijke storing, cached waarde getoond".strip()
                cached["updatedAt"] = datetime.now(timezone.utc).isoformat()
                return cached
            raise ValueError(f"No ENTSO-E imbalance prices for NL in last 7 days ({last_error})")

    max_dt, max_val = max(points, key=lambda x: x[1])
    result = {
        "id": "nlImbalanceWeek",
        "label": "Onbalanskosten NL (hoogste 7 dagen)",
        "value": max_val,
        "unit": "EUR/MWh",
        "source": "ENTSO-E Transparency API" if (used_url or "").find("web-api.tp.entsoe.eu") >= 0 else "TenneT XML (fallback)",
        "sourceUrl": used_url or source_base,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "detail": f"Hoogste onbalansprijs in laatste 7 dagen op {max_dt.isoformat()}",
    }
    cache_set("nlImbalanceWeek", result)
    return result


def get_ets_price():
    source_url = "https://www.barchart.com/futures/quotes/CKJ26"
    html = fetch_text(source_url)

    match = re.search(
        r'"symbol":"CKJ26".*?"lastPrice":"([^"]+)".*?"tradeTime":"([^"]+)"',
        html,
        re.S,
    )
    if not match:
        raise ValueError("Could not parse EUA quote from Barchart")

    raw_price = match.group(1).replace("s", "")
    trade_time = match.group(2)

    return {
        "id": "ets",
        "label": "EU ETS (ICE EUA Futures)",
        "value": float(raw_price),
        "unit": "EUR/tCO2",
        "source": "Barchart",
        "sourceUrl": source_url,
        "updatedAt": trade_time,
    }


def get_coal_price():
    source_url = "https://markets.businessinsider.com/commodities/coal-price"
    html = fetch_text(source_url)

    match = re.search(r'priceSection:\s*\{.*?"currentValue":([0-9.]+)', html, re.S)
    if not match:
        raise ValueError("Could not parse coal price from Business Insider")

    return {
        "id": "coal",
        "label": "Coal",
        "value": float(match.group(1)),
        "unit": "USD/T",
        "source": "Business Insider Markets",
        "sourceUrl": source_url,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


def get_tennet_api_key():
    api_key = os.environ.get("TENNET_API_KEY", TENNET_DEFAULT_TOKEN).strip()
    if not api_key:
        raise ValueError("TENNET_API_KEY is missing (required for live TenneT NL data)")
    return api_key


def get_latest_row(rows):
    if not rows:
        return None
    return max(rows, key=lambda row: str(row.get("datum") or row.get("date") or row.get("time") or ""))


def extract_rows(payload):
    if isinstance(payload, dict):
        if isinstance(payload.get("rows"), list):
            return payload.get("rows")
        data = payload.get("data")
        if isinstance(data, dict) and isinstance(data.get("rows"), list):
            return data.get("rows")
    return []


def parse_first_numeric(row: dict, excludes=None):
    excludes = excludes or set()
    for key, value in row.items():
        if key.lower() in excludes:
            continue
        parsed = to_float(value)
        if parsed is not None:
            return parsed, key
    return None, None


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def kwh_per_day_to_mw(value):
    v = to_float(value)
    if v is None:
        return None
    return v / 24000.0


def kwh_per_day_to_gwh_per_day(value):
    v = to_float(value)
    if v is None:
        return None
    return v / 1_000_000.0


def entsog_value_to_gwh_day(value, unit):
    v = to_float(value)
    if v is None:
        return None
    u = str(unit or "").strip().lower().replace(" ", "")
    if u in {"kwh/d", "kwhday", "kwh/day"}:
        return v / 1_000_000.0
    if u in {"kwh/h", "kwhhour", "kwh/hour"}:
        return (v * 24.0) / 1_000_000.0
    if u in {"mwh/d", "mwhday", "mwh/day"}:
        return v / 1000.0
    if u in {"mwh/h", "mwhhour", "mwh/hour"}:
        return (v * 24.0) / 1000.0
    if u in {"gwh/d", "gwhday", "gwh/day"}:
        return v
    if u in {"gwh/h", "gwhhour", "gwh/hour"}:
        return v * 24.0
    if u in {"wh/d", "whday", "wh/day"}:
        return v / 1_000_000_000.0
    if u in {"wh/h", "whhour", "wh/hour"}:
        return (v * 24.0) / 1_000_000_000.0
    # Fallback for missing/unknown unit: ENTSOG flow values are commonly in kWh/d.
    return v / 1_000_000.0


def entsog_row_value_gwh_day(row):
    return entsog_value_to_gwh_day(row.get("value"), row.get("unit"))


def entsog_fetch_operational(indicator: str, days_back: int = 3, limit: int = 1000):
    date_to = datetime.now(timezone.utc).date()
    date_from = date_to - timedelta(days=days_back)
    params = {
        "operatorKey": ENTSOG_NL_OPERATOR,
        "indicator": indicator,
        "from": date_from.isoformat(),
        "to": date_to.isoformat(),
        "limit": str(limit),
    }
    url = f"{ENTSOG_BASE}/operationaldatas?{urlencode(params)}"
    payload = fetch_json(url, timeout=12)
    rows = payload.get("operationaldatas") or []
    if not rows:
        raise ValueError(f"ENTSOG returned no operational data for indicator={indicator}")
    return rows, url


def entsog_fetch_operatorpointdirections(limit: int = 800):
    params = {"operatorKey": ENTSOG_NL_OPERATOR, "limit": str(limit)}
    url = f"{ENTSOG_BASE}/operatorpointdirections?{urlencode(params)}"
    payload = fetch_json(url, timeout=12)
    rows = payload.get("operatorpointdirections") or []
    if not rows:
        raise ValueError("ENTSOG returned no operatorpointdirections for NL")
    return rows, url


def get_entsog_nl_physical_snapshot():
    cached = cache_get_fresh("entsogNlPhysicalSnapshot", 900)
    if cached:
        return cached

    op_rows, op_url = entsog_fetch_operatorpointdirections(limit=1200)
    point_meta = {}
    for r in op_rows:
        key = str(r.get("pointKey") or "")
        if not key:
            continue
        point_meta[key] = {
            "pointType": str(r.get("pointType") or ""),
            "adjacentCountry": str(r.get("adjacentCountry") or ""),
            "pointLabel": str(r.get("pointLabel") or ""),
        }

    flow_rows, flow_url = entsog_fetch_operational("Physical Flow", days_back=4, limit=6000)
    numeric = []
    for r in flow_rows:
        v = to_float(r.get("value"))
        ts = str(r.get("periodFrom") or "")
        key = str(r.get("pointKey") or "")
        if v is None or not ts or not key:
            continue
        numeric.append(r)
    if not numeric:
        raise ValueError("ENTSOG Physical Flow returned no non-empty rows for NL")

    by_ts = {}
    for r in numeric:
        ts = str(r.get("periodFrom") or "")
        by_ts.setdefault(ts, []).append(r)
    best_ts = max(by_ts.keys())

    result = {
        "timestamp": best_ts,
        "rows": by_ts[best_ts],
        "pointMeta": point_meta,
        "sourceUrl": flow_url,
        "metaUrl": op_url,
    }
    cache_payload = dict(result)
    cache_payload["_fetchedAt"] = datetime.now(timezone.utc).isoformat()
    cache_set("entsogNlPhysicalSnapshot", cache_payload)
    return result


def get_energyopwek_dataset(dataset: str):
    url = f"https://www.energieopwek.nl/grafiek/data/{dataset}/current"
    payload = fetch_json(url)
    rows = extract_rows(payload)
    if not rows:
        raise ValueError(f"No rows in energieopwek dataset: {dataset}")
    latest = get_latest_row(rows)
    if latest is None:
        raise ValueError(f"No latest row in energieopwek dataset: {dataset}")
    return payload, latest, url


def tennet_date(dt: datetime) -> str:
    return dt.strftime("%d-%m-%Y %H:%M:%S")


def get_tennet_metered_latest_point():
    api_key = get_tennet_api_key()
    local_tz = ZoneInfo("Europe/Amsterdam") if ZoneInfo is not None else datetime.now().astimezone().tzinfo
    date_to = datetime.now(local_tz)
    date_from = date_to - timedelta(hours=4)
    api_url = "https://api.tennet.eu/publications/v1/metered-injections?" + urlencode(
        {
            "date_from": tennet_date(date_from),
            "date_to": tennet_date(date_to),
        }
    )
    payload = fetch_json(
        api_url,
        extra_headers={"Accept": "application/json", "apikey": api_key},
    )

    points = []
    for ts in as_list(payload.get("Response", {}).get("TimeSeries")):
        for period in as_list(ts.get("Period")):
            points.extend(as_list(period.get("Points") or period.get("points")))

    if not points:
        raise ValueError("No metered injection points returned by TenneT API")

    def point_key(p):
        return p.get("timeInterval_end") or p.get("timeInterval_start") or ""

    latest_point = max(points, key=point_key)
    latest_ts = latest_point.get("timeInterval_end") or latest_point.get("timeInterval_start")
    return latest_point, latest_ts, api_url


def get_grid_load():
    latest_point, latest_ts, source_url = get_tennet_metered_latest_point()
    measured_infeed = to_float(latest_point.get("measured_infeed"))
    if measured_infeed is None:
        raise ValueError("TenneT metered_injections point has no measured_infeed value")

    return {
        "id": "gridLoad",
        "label": "Electricity Grid Load (NL)",
        "value": measured_infeed,
        "unit": "MWh",
        "source": "TenneT API (Metered Injections)",
        "sourceUrl": source_url,
        "updatedAt": latest_ts,
    }


def get_nl_import_export_position():
    latest_point, latest_ts, source_url = get_tennet_metered_latest_point()
    scheduled_import = to_float(latest_point.get("scheduled_import")) or 0.0
    scheduled_export = to_float(latest_point.get("scheduled_export")) or 0.0
    net_import = scheduled_import + scheduled_export

    detail = (
        f"Import {scheduled_import:.2f} MWh | Export {abs(scheduled_export):.2f} MWh | "
        f"Net {'import' if net_import >= 0 else 'export'} {abs(net_import):.2f} MWh"
    )

    return {
        "id": "nlImportExport",
        "label": "NL Electricity Import/Export Position",
        "value": net_import,
        "unit": "MWh",
        "source": "TenneT API (Metered Injections)",
        "sourceUrl": source_url,
        "updatedAt": latest_ts,
        "detail": detail,
    }


def get_tennet_balance_delta_latest_point():
    api_key = get_tennet_api_key()
    api_url = "https://api.tennet.eu/publications/v1/balance-delta-high-res/latest"
    payload = fetch_json(
        api_url,
        extra_headers={"Accept": "application/json", "apikey": api_key},
    )

    points = []
    for ts in as_list(payload.get("Response", {}).get("TimeSeries")):
        for period in as_list(ts.get("Period")):
            points.extend(as_list(period.get("points") or period.get("Points")))

    if not points:
        raise ValueError("No balance-delta points returned by TenneT API")

    def point_key(p):
        return p.get("timeInterval_end") or p.get("timeInterval_start") or ""

    latest_point = max(points, key=point_key)
    updated_at = latest_point.get("timeInterval_end") or latest_point.get("timeInterval_start")
    return latest_point, updated_at, api_url


def get_tennet_regulation():
    latest_point, updated_at, api_url = get_tennet_balance_delta_latest_point()

    in_power = sum(
        [
            to_float(latest_point.get("power_afrr_in")) or 0.0,
            to_float(latest_point.get("power_igcc_in")) or 0.0,
            to_float(latest_point.get("power_mari_in")) or 0.0,
            to_float(latest_point.get("power_mfrrda_in")) or 0.0,
            to_float(latest_point.get("power_picasso_in")) or 0.0,
        ]
    )
    out_power = sum(
        [
            to_float(latest_point.get("power_afrr_out")) or 0.0,
            to_float(latest_point.get("power_igcc_out")) or 0.0,
            to_float(latest_point.get("power_mari_out")) or 0.0,
            to_float(latest_point.get("power_mfrrda_out")) or 0.0,
            to_float(latest_point.get("power_picasso_out")) or 0.0,
        ]
    )
    net_mw = out_power - in_power
    if net_mw > 0:
        direction = "Opgeregeld"
    elif net_mw < 0:
        direction = "Afgeregeld"
    else:
        direction = "In balans"

    up_price = to_float(latest_point.get("max_upw_regulation_price"))
    down_price = to_float(latest_point.get("min_downw_regulation_price"))
    mid_price = to_float(latest_point.get("mid_price"))
    detail = (
        f"{direction} | In {in_power:.1f} MW | Out {out_power:.1f} MW | "
        f"Up price {up_price if up_price is not None else 'n/a'} EUR/MWh | "
        f"Down price {down_price if down_price is not None else 'n/a'} EUR/MWh | "
        f"Mid {mid_price if mid_price is not None else 'n/a'} EUR/MWh"
    )

    return {
        "id": "tennetRegulation",
        "label": "TenneT Balance Delta (actueel, 12s)",
        "value": net_mw,
        "unit": "MW",
        "source": "TenneT API (Balance Delta High Res)",
        "sourceUrl": api_url,
        "updatedAt": updated_at,
        "detail": detail,
    }


def get_tennet_grid_frequency():
    # Primary source requested by user.
    mains_url = "https://mainsfrequency.com"
    try:
        page = fetch_text(mains_url, timeout=10)
        text = re.sub(r"\s+", " ", page)
        candidates = []

        # Prefer Netherlands-specific value if present.
        nl_patterns = [
            r"(?:netherlands|nederland)[^0-9]{0,80}([4-5][0-9](?:[.,][0-9]{1,4})?)\s*hz",
            r"([4-5][0-9](?:[.,][0-9]{1,4})?)\s*hz[^<]{0,80}(?:netherlands|nederland)",
        ]
        for pat in nl_patterns:
            for m in re.finditer(pat, text, re.I):
                v = to_float(m.group(1))
                if v is not None and 45.0 <= v <= 55.0:
                    candidates.append(v)
        if candidates:
            return {
                "id": "nlGridFrequency",
                "label": "Netfrequentie NL (actueel)",
                "value": candidates[0],
                "unit": "Hz",
                "source": "mainsfrequency.com",
                "sourceUrl": mains_url,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Doelwaarde rond 50 Hz",
            }

        # Fallback on generic frequency value from page.
        generic_patterns = [
            r"([4-5][0-9](?:[.,][0-9]{1,4})?)\s*hz",
            r'"(?:frequency|freq|hz)"\s*:\s*([4-5][0-9](?:[.,][0-9]{1,4})?)',
            r'data-(?:frequency|freq|hz)\s*=\s*"([4-5][0-9](?:[.,][0-9]{1,4})?)"',
        ]
        for pat in generic_patterns:
            for m in re.finditer(pat, text, re.I):
                v = to_float(m.group(1))
                if v is not None and 45.0 <= v <= 55.0:
                    candidates.append(v)
        if candidates:
            return {
                "id": "nlGridFrequency",
                "label": "Netfrequentie NL (actueel)",
                "value": candidates[0],
                "unit": "Hz",
                "source": "mainsfrequency.com",
                "sourceUrl": mains_url,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Doelwaarde rond 50 Hz",
            }
    except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout):
        pass

    # Fallbacks below.
    try:
        latest_point, updated_at, api_url = get_tennet_balance_delta_latest_point()
        freq = None
        direct_keys = [
            "frequency",
            "system_frequency",
            "actual_frequency",
            "grid_frequency",
            "frequency_hz",
        ]
        for key in direct_keys:
            val = to_float(latest_point.get(key))
            if val is not None and 45.0 <= val <= 55.0:
                freq = val
                break
        if freq is None:
            for key, value in latest_point.items():
                if "freq" not in str(key).lower():
                    continue
                val = to_float(value)
                if val is not None and 45.0 <= val <= 55.0:
                    freq = val
                    break
        if freq is not None:
            return {
                "id": "nlGridFrequency",
                "label": "Netfrequentie NL (actueel)",
                "value": freq,
                "unit": "Hz",
                "source": "TenneT API (fallback)",
                "sourceUrl": api_url,
                "updatedAt": updated_at or datetime.now(timezone.utc).isoformat(),
                "detail": "Doelwaarde rond 50 Hz",
            }
    except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout):
        pass

    # Fallback: public TenneT XML (legacy balance delta feed).
    xml_url = "https://www.tennet.org/xml/balancedelta2017/balans-delta.xml"
    xml_text = fetch_text(xml_url, timeout=10)
    root = ET.fromstring(xml_text)
    best_freq = None
    for node in root.iter():
        tag = node.tag.split("}")[-1].lower()
        if "freq" not in tag:
            continue
        val = to_float(node.text)
        if val is None:
            continue
        if 45.0 <= val <= 55.0:
            best_freq = val
            break
    if best_freq is None:
        raise ValueError("No frequency value found in TenneT API or XML fallback")

    return {
        "id": "nlGridFrequency",
        "label": "Netfrequentie NL (actueel)",
        "value": best_freq,
        "unit": "Hz",
        "source": "TenneT XML (fallback)",
        "sourceUrl": xml_url,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "detail": "Doelwaarde rond 50 Hz",
    }


def get_tennet_settlement_prices():
    api_key = get_tennet_api_key()
    local_tz = ZoneInfo("Europe/Amsterdam") if ZoneInfo is not None else datetime.now().astimezone().tzinfo

    def quarter_floor(dt: datetime):
        return dt.replace(minute=(dt.minute // 15) * 15, second=0, microsecond=0)

    # Query closed ISP windows first (most reliable for this endpoint), then step back.
    end0 = quarter_floor(datetime.now(local_tz)) - timedelta(minutes=15)
    windows = []
    for i in range(4):
        end = end0 - timedelta(hours=i)
        start = end - timedelta(hours=1)
        windows.append((start, end))

    last_error = None
    points = []
    api_url = None
    for date_from, date_to in windows:
        api_url = "https://api.tennet.eu/publications/v1/settlement-prices?" + urlencode(
            {
                "date_from": tennet_date(date_from),
                "date_to": tennet_date(date_to),
            }
        )
        try:
            payload = fetch_json(
                api_url,
                timeout=6,
                extra_headers={"Accept": "application/json", "apikey": api_key},
            )
            points = []
            for ts in as_list(payload.get("Response", {}).get("TimeSeries")):
                for period in as_list(ts.get("Period")):
                    point_list = period.get("Points") or period.get("points")
                    points.extend(as_list(point_list))
            if points:
                break
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout) as exc:
            last_error = exc
            continue

    if not points:
        # Fallback: use latest balance-delta mid price when settlement endpoint is temporarily unavailable.
        try:
            reg = get_tennet_regulation()
            mid = None
            m = re.search(r"Mid ([^ ]+)", str(reg.get("detail") or ""))
            if m:
                mid = to_float(m.group(1))
            if mid is not None:
                result = {
                    "id": "tennetSettlement",
                    "label": "TenneT Settlement Price (actueel)",
                    "value": mid,
                    "unit": "EUR/MWh",
                    "source": "TenneT API (fallback via Balance Delta High Res)",
                    "sourceUrl": "https://api.tennet.eu/publications/v1/balance-delta-high-res/latest",
                    "updatedAt": reg.get("updatedAt") or datetime.now(timezone.utc).isoformat(),
                    "detail": "Settlement endpoint tijdelijk niet beschikbaar, fallback op mid price",
                }
                cache_set("tennetSettlement", result)
                return result
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout):
            pass
        if last_error is not None:
            raise ValueError(f"No settlement price points returned by TenneT API ({last_error})")
        raise ValueError("No settlement price points returned by TenneT API")

    def point_key(p):
        return p.get("timeInterval_end") or p.get("timeInterval_start") or ""

    latest_point = max(points, key=point_key)
    updated_at = latest_point.get("timeInterval_end") or latest_point.get("timeInterval_start")

    shortage = to_float(latest_point.get("shortage"))
    surplus = to_float(latest_point.get("surplus"))
    dispatch_up = to_float(latest_point.get("dispatch_up"))
    dispatch_down = to_float(latest_point.get("dispatch_down"))
    regulating_condition = str(latest_point.get("regulating_condition") or "").strip().upper()

    chosen_value = None
    chosen_label = ""
    if regulating_condition == "UP" and shortage is not None:
        chosen_value = shortage
        chosen_label = "Shortage"
    elif regulating_condition == "DOWN" and surplus is not None:
        chosen_value = surplus
        chosen_label = "Surplus"
    else:
        for label, val in [("Shortage", shortage), ("Surplus", surplus), ("Dispatch up", dispatch_up), ("Dispatch down", dispatch_down)]:
            if val is not None:
                chosen_value = val
                chosen_label = label
                break

    if chosen_value is None:
        raise ValueError("Settlement price point contains no numeric price fields")

    detail_parts = []
    if regulating_condition:
        detail_parts.append(f"Condition {regulating_condition}")
    detail_parts.append(f"Actief: {chosen_label}")
    detail_parts.append(f"Shortage {shortage if shortage is not None else 'n/a'}")
    detail_parts.append(f"Surplus {surplus if surplus is not None else 'n/a'}")
    detail_parts.append(f"Dispatch up {dispatch_up if dispatch_up is not None else 'n/a'}")
    detail_parts.append(f"Dispatch down {dispatch_down if dispatch_down is not None else 'n/a'}")

    result = {
        "id": "tennetSettlement",
        "label": "TenneT Settlement Price (actueel)",
        "value": chosen_value,
        "unit": "EUR/MWh",
        "source": "TenneT API (Settlement Prices)",
        "sourceUrl": api_url,
        "updatedAt": updated_at,
        "detail": " | ".join(detail_parts),
    }
    cache_set("tennetSettlement", result)
    return result


def get_nl_gas_usage_load():
    source_url = (
        "https://www.gasunietransportservices.nl/netwerk-operations/"
        "dashboard-leveringszekerheid-gas/gasverbruik-in-nederland"
    )
    html_page = fetch_text(source_url)
    points = extract_chart_points_from_html(
        html_page,
        ["value", "verbruik", "consumption", "gasverbruik", "y"],
    )
    if not points:
        raise ValueError("Could not parse gas usage series from GTS gasverbruik page")

    latest_day, total_value, _values = summarize_latest_day(points)
    if latest_day is None or total_value is None:
        raise ValueError("Could not summarize latest day gas usage from GTS")

    return {
        "id": "nlGasLoad",
        "label": "Gasverbruik Nederland (Laatste dag)",
        "value": total_value,
        "unit": "m3",
        "source": "Gasunie Transport Services",
        "sourceUrl": source_url,
        "updatedAt": latest_day + "T00:00:00+00:00",
        "detail": f"Som over {latest_day}",
    }


def get_entsog_nl_balance_snapshot():
    cached = cache_get_fresh("entsogNlSnapshot", 900)
    if cached:
        return cached

    op_url = f"{ENTSOG_BASE}/operatorpointdirections?{urlencode({'operatorKey': ENTSOG_NL_OPERATOR, 'limit': 800})}"
    op_payload = fetch_json(op_url, timeout=12)
    op_rows = op_payload.get("operatorpointdirections") or []

    point_types = {}
    for r in op_rows:
        key = str(r.get("pointKey") or "")
        pt = str(r.get("pointType") or "")
        if not key or not pt:
            continue
        point_types.setdefault(key, set()).add(pt)

    rows, source_url = entsog_fetch_operational("Allocation", days_back=5, limit=5000)
    numeric = []
    for r in rows:
        v = to_float(r.get("value"))
        if v is None:
            continue
        ts = str(r.get("periodFrom") or "")
        if not ts:
            continue
        numeric.append(r)
    if not numeric:
        raise ValueError("ENTSOG Allocation returned no non-empty rows for NL")

    by_ts = {}
    for r in numeric:
        ts = str(r.get("periodFrom") or "")
        by_ts.setdefault(ts, []).append(r)

    def row_type_set(r):
        key = str(r.get("pointKey") or "")
        return point_types.get(key, set())

    def is_consumer_row(r):
        lbl = str(r.get("pointLabel") or "").lower()
        return ("consumers" in lbl) or ("local distribution companies" in lbl) or ("ldc" in lbl)

    def is_cross_border_type(pts):
        joined = " | ".join(pts)
        return "Cross-Border Transmission IP" in joined

    def is_lng_type(pts):
        return "LNG Entry point" in " | ".join(pts)

    def is_storage_type(pts):
        joined = " | ".join(pts)
        return ("Storage point" in joined) or ("Cross-Border Storage IP" in joined)

    best_ts = None
    for ts in sorted(by_ts.keys(), reverse=True):
        ts_rows = by_ts[ts]
        has_consumers = any(is_consumer_row(r) and str(r.get("directionKey") or "").lower() == "exit" for r in ts_rows)
        has_io = any(is_cross_border_type(row_type_set(r)) or is_lng_type(row_type_set(r)) for r in ts_rows)
        if has_consumers and has_io:
            best_ts = ts
            break
    if best_ts is None:
        best_ts = max(by_ts.keys())
    ts_rows = by_ts[best_ts]

    import_pipeline_kwh_day = 0.0
    import_lng_kwh_day = 0.0
    storage_withdrawal_kwh_day = 0.0
    local_production_kwh_day = 0.0

    cat = {
        "Huishoudens & kleinzakelijk": 0.0,
        "Industrie": 0.0,
        "Gascentrales": 0.0,
        "Gasopslagen": 0.0,
        "Overig": 0.0,
    }
    export_kwh_day = 0.0

    for r in ts_rows:
        v = to_float(r.get("value")) or 0.0
        direction = str(r.get("directionKey") or "").lower()
        lbl = str(r.get("pointLabel") or "").lower()
        pts = row_type_set(r)

        if direction == "entry":
            if is_cross_border_type(pts):
                import_pipeline_kwh_day += v
            elif is_lng_type(pts):
                import_lng_kwh_day += v
            elif is_storage_type(pts):
                storage_withdrawal_kwh_day += v

        if direction == "entry" and ("production" in lbl):
            local_production_kwh_day += v

        if direction == "exit" and is_cross_border_type(pts):
            export_kwh_day += v

        if direction == "exit" and is_consumer_row(r):
            if ("local distribution companies" in lbl) or ("ldc" in lbl):
                cat["Huishoudens & kleinzakelijk"] += v
            elif ("industrial consumers power" in lbl) or ("power" in lbl and "consumers" in lbl):
                cat["Gascentrales"] += v
            else:
                cat["Industrie"] += v
        elif direction == "exit" and is_storage_type(pts):
            cat["Gasopslagen"] += v
        elif direction == "exit" and not is_cross_border_type(pts):
            cat["Overig"] += v

    total_consumption_kwh_day = sum(cat.values())
    import_total_kwh_day = import_pipeline_kwh_day + import_lng_kwh_day
    total_supply_kwh_day = import_total_kwh_day + storage_withdrawal_kwh_day + local_production_kwh_day
    remaining_for_export_kwh_day = total_supply_kwh_day - total_consumption_kwh_day

    result = {
        "timestamp": best_ts,
        "sourceUrl": source_url,
        "supply_import_pipeline_mw": kwh_per_day_to_mw(import_pipeline_kwh_day),
        "supply_import_lng_mw": kwh_per_day_to_mw(import_lng_kwh_day),
        "supply_import_total_mw": kwh_per_day_to_mw(import_total_kwh_day),
        "supply_storage_mw": kwh_per_day_to_mw(storage_withdrawal_kwh_day),
        "supply_local_production_mw": kwh_per_day_to_mw(local_production_kwh_day),
        "supply_total_mw": kwh_per_day_to_mw(total_supply_kwh_day),
        "consumption_total_mw": kwh_per_day_to_mw(total_consumption_kwh_day),
        "remaining_for_export_mw": kwh_per_day_to_mw(remaining_for_export_kwh_day),
        "observed_export_mw": kwh_per_day_to_mw(export_kwh_day),
        "consumption_categories_kwh_day": cat,
    }
    cache_payload = dict(result)
    cache_payload["_fetchedAt"] = datetime.now(timezone.utc).isoformat()
    cache_set("entsogNlSnapshot", cache_payload)
    return result


def get_entsog_nl_gas_consumption_total():
    rows, source_url = entsog_fetch_operational("Allocation", days_back=5, limit=5000)
    dso_rows = []
    for r in rows:
        label = str(r.get("pointLabel") or "").lower()
        direction = str(r.get("directionKey") or "").lower()
        val = to_float(r.get("value"))
        ts = str(r.get("periodFrom") or "")
        if val is None or not ts:
            continue
        if direction != "exit":
            continue
        if ("local distribution companies" in label) or ("ldc" in label):
            dso_rows.append(r)

    if not dso_rows:
        raise ValueError("No ENTSOG DSO (Local Distribution Companies) consumption rows found")

    by_ts = {}
    for r in dso_rows:
        ts = str(r.get("periodFrom") or "")
        by_ts.setdefault(ts, []).append(r)
    latest_ts = max(by_ts.keys())
    ts_rows = by_ts[latest_ts]

    total_gwh_day = sum((entsog_row_value_gwh_day(r) or 0.0) for r in ts_rows)
    if total_gwh_day is None:
        raise ValueError("Could not convert ENTSOG DSO gas consumption to GWh/d")

    detail_rows = []
    for r in ts_rows:
        lbl = str(r.get("pointLabel") or "")
        val = entsog_row_value_gwh_day(r)
        detail_rows.append({"hour": lbl, "value": val, "unit": "GWh/d"})

    result = {
        "id": "nlGasConsumptionBreakdown",
        "label": "Gasconsumptie NL via DSO levering (laatste dag)",
        "value": total_gwh_day,
        "unit": "GWh/d",
        "source": "ENTSOG API",
        "sourceUrl": source_url,
        "updatedAt": parse_dt_any(latest_ts).isoformat() if parse_dt_any(latest_ts) else datetime.now(timezone.utc).isoformat(),
        "detail": "Som van ENTSOG Allocation exits naar Local Distribution Companies (LDC/DSO)",
        "rows": detail_rows,
    }
    cache_set("nlGasConsumptionBreakdown", result)
    return result


def get_entsog_nl_gas_production_last_day():
    rows, source_url = entsog_fetch_operational("Allocation", days_back=5, limit=5000)
    prod_rows = []
    for r in rows:
        label = str(r.get("pointLabel") or "").lower()
        direction = str(r.get("directionKey") or "").lower()
        val = to_float(r.get("value"))
        ts = str(r.get("periodFrom") or "")
        if val is None or not ts:
            continue
        if direction != "entry":
            continue
        if "production" in label:
            prod_rows.append(r)
    if not prod_rows:
        raise ValueError("No ENTSOG production entry rows found")

    by_ts = {}
    for r in prod_rows:
        ts = str(r.get("periodFrom") or "")
        by_ts.setdefault(ts, []).append(r)
    latest_ts = max(by_ts.keys())
    ts_rows = by_ts[latest_ts]

    production_gwh_day = sum((entsog_row_value_gwh_day(r) or 0.0) for r in ts_rows)
    if production_gwh_day is None:
        raise ValueError("Could not convert ENTSOG production to GWh/d")

    detail_rows = []
    for r in ts_rows:
        detail_rows.append({"hour": str(r.get("pointLabel") or "Productie"), "value": entsog_row_value_gwh_day(r), "unit": "GWh/d"})
    result = {
        "id": "nlGasProduction",
        "label": "Gaswinning NL (laatste dag)",
        "value": production_gwh_day,
        "unit": "GWh/d",
        "source": "ENTSOG API",
        "sourceUrl": source_url,
        "updatedAt": parse_dt_any(latest_ts).isoformat() if parse_dt_any(latest_ts) else datetime.now(timezone.utc).isoformat(),
        "detail": "Lokale productie (ENTSOG Allocation, laatste beschikbare dag)",
        "rows": detail_rows,
    }
    cache_set("nlGasProduction", result)
    return result


def get_entsog_nl_gas_border_flows():
    snap = get_entsog_nl_physical_snapshot()
    ts_rows = snap.get("rows") or []
    point_meta = snap.get("pointMeta") or {}

    sums = {}
    lng_total = 0.0
    storage_sites = ["norg", "grijpskerk", "bergermeer", "zuidwending"]
    storage_entry_total = 0.0
    storage_exit_total = 0.0
    for r in ts_rows:
        key = str(r.get("pointKey") or "")
        direction = str(r.get("directionKey") or "").lower()
        val_gwh_day = entsog_row_value_gwh_day(r) or 0.0
        meta = point_meta.get(key) or {}
        pt = str(meta.get("pointType") or "")
        country = str(meta.get("adjacentCountry") or "")
        label = str(meta.get("pointLabel") or "").lower()

        if "LNG Entry point" in pt and direction == "entry":
            if any(s in label for s in ["gate", "maasvlakte", "rotterdam", "eems", "eemshaven", "eet"]):
                lng_total += val_gwh_day
            else:
                lng_total += val_gwh_day

        if ("Storage point" in pt or "Cross-Border Storage IP" in pt) and any(site in label for site in storage_sites):
            if direction == "entry":
                storage_entry_total += val_gwh_day
            elif direction == "exit":
                storage_exit_total += val_gwh_day

        if "Cross-Border Transmission IP" not in pt:
            continue
        if not country or country == "NL":
            continue
        csum = sums.setdefault(country, {"entry": 0.0, "exit": 0.0})
        if direction == "entry":
            csum["entry"] += val_gwh_day
        elif direction == "exit":
            csum["exit"] += val_gwh_day

    mapping = {
        "BE": "Belgie",
        "DE": "Duitsland",
        "GB": "Verenigd Koninkrijk",
        "DK": "Denemarken",
        "NO": "Noorwegen",
        "FR": "Frankrijk",
    }
    order = ["BE", "DE", "GB", "DK", "NO", "FR"]
    rows = []
    for code in order:
        v = None
        if code in sums:
            v = sums[code]["entry"] - sums[code]["exit"]
        rows.append({"hour": mapping.get(code, code), "value": v, "unit": "GWh/d"})
    for code in sorted(sums.keys()):
        if code in order:
            continue
        rows.append({"hour": mapping.get(code, code), "value": sums[code]["entry"] - sums[code]["exit"], "unit": "GWh/d"})

    # Add LNG inflow as one combined point and one aggregated storage point.
    rows.append({"hour": "LNG (Gate+EET)", "value": lng_total, "unit": "GWh/d"})
    # ENTSOG direction convention at storage points can be counterintuitive.
    # For this dashboard we define positive as net flow OUT of storage into the NL gas network.
    storage_net_out = storage_entry_total - storage_exit_total
    rows.append({"hour": "Gasopslag (4 sites)", "value": storage_net_out, "unit": "GWh/d"})

    numeric = [r for r in rows if r.get("value") is not None]
    if not numeric:
        raise ValueError("ENTSOG Physical Flow has no cross-border rows with adjacent country at latest timestamp")
    total_net = sum((to_float(r.get("value")) or 0.0) for r in numeric)

    result = {
        "id": "nlGasImport",
        "label": "Gas Cross-Border Flows NL (per land, netto)",
        "value": total_net,
        "unit": "GWh/d",
        "source": "ENTSOG API",
        "sourceUrl": snap.get("sourceUrl") or "https://transparency.entsog.eu",
        "updatedAt": parse_dt_any(snap.get("timestamp") or "").isoformat() if parse_dt_any(snap.get("timestamp") or "") else datetime.now(timezone.utc).isoformat(),
        "detail": "Positief = netto import naar NL, negatief = netto export uit NL (dagstroom). Inclusief LNG (Gate+EET) en opslagnetto (Norg, Grijpskerk, Bergermeer, Zuidwending; positief = uit opslag naar net).",
        "rows": rows,
    }
    cache_set("nlGasImport", result)
    return result


def get_entsog_nl_gas_storage_flows():
    snap = get_entsog_nl_physical_snapshot()
    ts_rows = snap.get("rows") or []
    point_meta = snap.get("pointMeta") or {}

    into_storage = 0.0
    from_storage = 0.0
    count = 0
    for r in ts_rows:
        key = str(r.get("pointKey") or "")
        direction = str(r.get("directionKey") or "").lower()
        val_gwh_day = entsog_row_value_gwh_day(r)
        if val_gwh_day is None:
            continue
        meta = point_meta.get(key) or {}
        pt = str(meta.get("pointType") or "")
        if ("Storage point" not in pt) and ("Cross-Border Storage IP" not in pt):
            continue
        count += 1
        if direction == "entry":
            into_storage += val_gwh_day
        elif direction == "exit":
            from_storage += val_gwh_day

    if count == 0:
        raise ValueError("ENTSOG Physical Flow has no storage rows at latest timestamp")

    net_gwh_day = from_storage - into_storage
    if abs(net_gwh_day) < 0.05:
        status = "In balans"
    elif net_gwh_day > 0:
        status = "Wordt geleegd"
    else:
        status = "Wordt gevuld"

    result = {
        "id": "nlGasStorageFlows",
        "label": "Gasopslagen NL (actuele status)",
        "value": None,
        "unit": "",
        "valueText": status,
        "source": "ENTSOG API",
        "sourceUrl": snap.get("sourceUrl") or "https://transparency.entsog.eu",
        "updatedAt": parse_dt_any(snap.get("timestamp") or "").isoformat() if parse_dt_any(snap.get("timestamp") or "") else datetime.now(timezone.utc).isoformat(),
        "detail": "Kwalitatieve status op basis van ENTSOG dagstromen naar/uit opslag",
        "rows": [],
    }
    cache_set("nlGasStorageFlows", result)
    return result


def get_nl_gas_import_actual():
    source_url = (
        "https://www.gasunietransportservices.nl/netwerk-operations/"
        "dashboard-leveringszekerheid-gas/aanvoer-gas-voor-europa"
    )
    html_page = fetch_text(source_url)
    points = extract_chart_points_from_html(
        html_page,
        ["value", "aanvoer", "import", "flow", "y"],
    )
    if not points:
        raise ValueError("Could not parse gas import series from GTS aanvoer page")

    latest_day, total_value, _values = summarize_latest_day(points)
    if latest_day is None or total_value is None:
        raise ValueError("Could not summarize latest day gas import from GTS")

    return {
        "id": "nlGasImport",
        "label": "Aanvoer Gas voor Europa (Laatste dag)",
        "value": total_value,
        "unit": "m3",
        "source": "Gasunie Transport Services",
        "sourceUrl": source_url,
        "updatedAt": latest_day + "T00:00:00+00:00",
        "detail": f"Som over {latest_day}",
    }


def get_ned_gas_storage_fill_api():
    # Datacatalog: Type 28 (Gasopslag), Activity 3 (Storage), Point 0 (NL total).
    try:
        rec, dt, api_url = ned_get_latest_for_type_activity(type_id=28, activity=3, point=0)
        value = to_float(rec.get("percentage"))
        if value is None:
            value, _key = ned_record_value(rec)
        value = ned_to_percent(value)
        if value is None:
            raise ValueError("No gas storage percentage found for NL total")
        return {
            "id": "nlGasStorage",
            "label": "NL Gas Storage Fill Level (Actueel)",
            "value": value,
            "unit": "%",
            "source": "NED API",
            "sourceUrl": api_url,
            "updatedAt": dt.isoformat(),
        }
    except (ValueError, HTTPError, URLError, TimeoutError):
        pass

    # Fallback to likely type/activity combinations.
    candidates = [
        (58, 3),
        (58, 1),
        (57, 3),
        (57, 1),
        (56, 3),
        (56, 1),
        (60, 3),
        (60, 1),
    ]
    last_error = None
    for type_id, activity in candidates:
        try:
            rec, dt, api_url = ned_get_latest_for_type_activity(type_id=type_id, activity=activity, point=0)
            value = to_float(rec.get("percentage"))
            if value is None:
                value, key = ned_record_value(rec)
                if value is None:
                    continue
                # If capacity/volume/value is returned, keep only plausible percentage values.
                if key != "percentage" and not (0.0 <= value <= 100.0):
                    continue
            value = ned_to_percent(value)
            return {
                "id": "nlGasStorage",
                "label": "NL Gas Storage Fill Level (Actueel)",
                "value": value,
                "unit": "%",
                "source": "NED API",
                "sourceUrl": api_url,
                "updatedAt": dt.isoformat(),
            }
        except (ValueError, HTTPError, URLError, TimeoutError) as exc:
            last_error = exc
            continue
    raise ValueError(f"NED gas storage not found in utilizations ({last_error})")


def get_nl_gas_storage_fill():
    source_url = "https://ned.nl/nl/gasopslagen-nederland"
    last_error = None
    website_pct = None
    try:
        page = fetch_text(source_url)
        patterns = [
            r"actuele\s+vullingsgraad[^0-9%]{0,80}([0-9]+(?:[.,][0-9]+)?)\s*%",
            r"is\s+momenteel[^0-9%]{0,30}([0-9]+(?:[.,][0-9]+)?)\s*%",
            r"vullingsgraad[^0-9%]{0,50}([0-9]+(?:[.,][0-9]+)?)\s*%",
        ]
        for pat in patterns:
            m = re.search(pat, page, re.I | re.S)
            if m:
                website_pct = to_float(m.group(1))
                if website_pct is not None:
                    break
    except (ValueError, HTTPError, URLError, TimeoutError) as exc:
        last_error = exc

    # Prefer NED API for trend (today vs yesterday) and approximate stored energy in GWh.
    try:
        latest, prev, api_url = ned_get_storage_latest_previous()
        latest_dt, latest_rec, latest_pct = latest
        _prev_dt, _prev_rec, prev_pct = prev
        shown_pct = website_pct if website_pct is not None else latest_pct

        unit_hint = str(latest_rec.get("unit") or latest_rec.get("unitofmeasure") or latest_rec.get("uom") or "")
        volume_gwh = energy_to_gwh(latest_rec.get("volume"), unit_hint)
        if volume_gwh is None:
            volume_gwh = energy_to_gwh(latest_rec.get("value"), unit_hint)
        if volume_gwh is None:
            capacity_gwh = energy_to_gwh(latest_rec.get("capacity"), unit_hint)
            if capacity_gwh is not None and shown_pct is not None:
                volume_gwh = capacity_gwh * (shown_pct / 100.0)
        if volume_gwh is None and shown_pct is not None:
            # National rule of thumb requested by user: 14 bcm working gas capacity.
            capacity_gwh_rule = (NL_GAS_STORAGE_CAPACITY_BCM * 1_000_000_000.0 * NL_GAS_KWH_PER_M3) / 1_000_000.0
            volume_gwh = capacity_gwh_rule * (shown_pct / 100.0)

        trend = None
        # Prefer trend by actual storage net flow of the 4 main storages (ENTSOG).
        try:
            gas_rows = get_entsog_nl_gas_border_flows().get("rows") or []
            storage_row = next((r for r in gas_rows if str(r.get("hour") or "") == "Gasopslag (4 sites)"), None)
            storage_net = to_float(storage_row.get("value")) if storage_row else None
            if storage_net is not None:
                if abs(storage_net) < 0.05:
                    trend = "In balans"
                elif storage_net > 0:
                    trend = "Legen (uit opslag naar net)"
                else:
                    trend = "Vullen (naar opslag)"
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout):
            trend = None

        # Fallback trend from national fill-level day-over-day.
        if trend is None:
            if latest_pct is None or prev_pct is None:
                trend = "Trend onbekend"
            elif latest_pct > prev_pct:
                trend = "Gisteren gevuld"
            elif latest_pct < prev_pct:
                trend = "Gisteren geleegd"
            else:
                trend = "Gisteren nagenoeg gelijk"

        rows = []
        rows.append({"hour": "Opslaginhoud", "value": volume_gwh, "unit": "GWh"})
        rows.append({"hour": "Trend (4 opslagen)", "valueText": trend, "unit": ""})
        return {
            "id": "nlGasStorage",
            "label": "NL Gasopslag (actueel)",
            "value": shown_pct,
            "unit": "%",
            "source": "NED Website + NED API",
            "sourceUrl": source_url,
            "updatedAt": latest_dt.isoformat(),
            "detail": "Nationale vullingsgraad met opslaginhoud (GWh, incl. 14 bcm rekenregel) en opslagtrend",
            "rows": rows,
        }
    except (ValueError, HTTPError, URLError, TimeoutError) as exc:
        if website_pct is not None:
            volume_gwh = ((NL_GAS_STORAGE_CAPACITY_BCM * 1_000_000_000.0 * NL_GAS_KWH_PER_M3) / 1_000_000.0) * (website_pct / 100.0)
            return {
                "id": "nlGasStorage",
                "label": "NL Gasopslag (actueel)",
                "value": website_pct,
                "unit": "%",
                "source": "NED Website",
                "sourceUrl": source_url,
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": f"Actuele nationale vullingsgraad. NED API trend niet beschikbaar ({exc})",
                "rows": [
                    {"hour": "Opslaginhoud", "value": volume_gwh, "unit": "GWh"},
                    {"hour": "Trend (4 opslagen)", "valueText": "Trend onbekend", "unit": ""},
                ],
            }
        raise ValueError(f"Could not retrieve national gas storage fill level (website: {last_error}; api: {exc})")


def _gaslicht_walk(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k, v
            yield from _gaslicht_walk(v)
    elif isinstance(obj, list):
        for item in obj:
            yield from _gaslicht_walk(item)


def _gaslicht_provider_name(data):
    for key in ["ProviderName", "Brand", "SupplierName", "Provider", "Name"]:
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return "Unknown provider"


def _gaslicht_package_name(data):
    for key in ["PackageName", "Name", "ProductName", "TariffName"]:
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _gaslicht_feed_in_eur_per_kwh(data):
    key_hints = ["terug", "invoed", "feed", "inject", "salder", "teruglever", "reimburs", "vergoeding"]
    candidates = []
    scalars = []
    if isinstance(data, dict):
        for _k, _v in _gaslicht_walk(data):
            if isinstance(_v, (dict, list)):
                continue
            sval = str(_v).strip()
            if sval:
                scalars.append(sval.lower())

    # Case 1: numeric values on feed-in related keys.
    for k, v in _gaslicht_walk(data):
        lk = str(k).lower()
        if not any(h in lk for h in key_hints):
            continue
        if isinstance(v, (dict, list)):
            continue
        parsed = to_float(v)
        if parsed is None:
            continue
        # Heuristic ranges: EUR/kWh usually ~0.01..1.00; cents/kWh often 1..100.
        if 0 < parsed <= 1.5:
            candidates.append(parsed)
        elif 1.5 < parsed <= 150:
            candidates.append(parsed / 100.0)

    # Case 2: context object mentions feed-in in string values; then scan numeric fields in same object.
    def walk_dicts(obj):
        if isinstance(obj, dict):
            yield obj
            for vv in obj.values():
                yield from walk_dicts(vv)
        elif isinstance(obj, list):
            for ii in obj:
                yield from walk_dicts(ii)

    for obj in walk_dicts(data):
        blob = " ".join([str(k).lower() for k in obj.keys()] + [str(v).lower() for v in obj.values() if not isinstance(v, (dict, list))])
        if not any(h in blob for h in key_hints):
            continue
        for vv in obj.values():
            if isinstance(vv, (dict, list)):
                continue
            parsed = to_float(vv)
            if parsed is None:
                continue
            if 0 < parsed <= 1.5:
                candidates.append(parsed)
            elif 1.5 < parsed <= 150:
                candidates.append(parsed / 100.0)

    # Case 3: regex on serialized payload for explicit "teruglever..." labels near a number.
    try:
        serialized = json.dumps(data, ensure_ascii=False)
        for m in re.finditer(
            r"(?:teruglever(?:vergoeding|tarief)?|feed[\s_-]?in|injectie|invoed)[^0-9]{0,40}([0-9]+(?:[.,][0-9]+)?)",
            serialized,
            re.I,
        ):
            parsed = to_float(m.group(1))
            if parsed is None:
                continue
            if 0 < parsed <= 1.5:
                candidates.append(parsed)
            elif 1.5 < parsed <= 150:
                candidates.append(parsed / 100.0)
    except Exception:
        pass

    if not candidates:
        return None
    return max(candidates)


def _gaslicht_extract_products(html_text: str):
    products = []
    for match in re.finditer(r'data-product=(?:"([^"]+)"|\'([^\']+)\')', html_text):
        raw = html.unescape(match.group(1) or match.group(2) or "")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        products.append(data)
    return products


def _gaslicht_extract_impressions(html_text: str):
    impressions = []
    for match in re.finditer(r'data-js-gtminfo="([^"]*Impressions[^"]*)"', html_text):
        raw = html.unescape(match.group(1))
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        ecommerce = parsed.get("Ecommerce") or {}
        impressions.extend(ecommerce.get("Impressions") or [])
    return impressions


def _gaslicht_product_cost_ex_bonus(product):
    total_cost = None
    for key in ["PackageCosts", "Price", "PackageCost", "TotalPrice", "MonthlyCosts"]:
        value = to_float(product.get(key))
        if value is not None:
            total_cost = value
            break
    if total_cost is None:
        return None
    bonus = 0.0
    for key in ["WelcomeBonus", "welcomeBonus", "Bonus"]:
        value = to_float(product.get(key))
        if value is not None:
            bonus = value
            break
    return total_cost + bonus


def _gaslicht_product_key(product):
    provider = _gaslicht_provider_name(product)
    package = _gaslicht_package_name(product)
    duration = str(product.get("ContractDuration") or product.get("ContractTerm") or "")
    return f"{provider}|{package}|{duration}"


def _gaslicht_contract_months(product):
    direct_keys = [
        "ContractDuration",
        "ContractTerm",
        "DurationMonths",
        "ContractDurationMonths",
    ]
    for key in direct_keys:
        val = product.get(key)
        if isinstance(val, (int, float)) and val > 0:
            return int(val)
        if isinstance(val, str):
            m = re.search(r"(\d+)", val)
            if m:
                num = int(m.group(1))
                if "jaar" in val.lower() or "year" in val.lower():
                    return num * 12
                return num

    # Deep scan all scalar fields for duration hints.
    word_to_num = {
        "een": 1,
        "one": 1,
        "twee": 2,
        "two": 2,
        "drie": 3,
        "three": 3,
        "vier": 4,
        "four": 4,
        "vijf": 5,
        "five": 5,
    }
    best_months = None
    for key, value in _gaslicht_walk(product):
        key_l = str(key).lower()
        if isinstance(value, (dict, list)):
            continue
        if isinstance(value, (int, float)):
            v = int(value)
            if v <= 0:
                continue
            if "year" in key_l or "jaar" in key_l:
                months = v * 12
            elif "month" in key_l or "maand" in key_l:
                months = v
            elif any(h in key_l for h in ["contract", "duration", "looptijd", "term"]):
                months = v * 12 if 1 <= v <= 10 else v
            else:
                continue
            if best_months is None or months > best_months:
                best_months = months
            continue
        sval = str(value).strip().lower()
        if not sval:
            continue
        m_year = re.search(r"(\d+)\s*[- ]?\s*(?:jaar|year|yr|jarige|jarig)", sval)
        if m_year:
            months = int(m_year.group(1)) * 12
            if best_months is None or months > best_months:
                best_months = months
        m_month = re.search(r"(\d+)\s*[- ]?\s*(?:maand|month|mnd)", sval)
        if m_month:
            months = int(m_month.group(1))
            if best_months is None or months > best_months:
                best_months = months
        for word, num in word_to_num.items():
            if re.search(rf"\b{word}\b\s*(?:jaar|year|yr|jarige|jarig)", sval):
                months = num * 12
                if best_months is None or months > best_months:
                    best_months = months

    text_blob = " ".join(
        str(product.get(k) or "")
        for k in ["PackageName", "Name", "ProductName", "TariffName", "Description"]
    ).lower()
    m_year = re.search(r"(\d+)\s*(?:jaar|year)", text_blob)
    if m_year:
        return int(m_year.group(1)) * 12
    m_month = re.search(r"(\d+)\s*(?:maand|month)", text_blob)
    if m_month:
        best_months = max(best_months or 0, int(m_month.group(1)))
    return best_months


def _gaslicht_contract_months_from_impression(imp):
    # GTM impressions usually carry text fields like Name/Variant/Category.
    blob = " ".join(
        str(imp.get(k) or "")
        for k in ["Name", "Variant", "Category", "Brand", "List"]
    ).lower()
    m_year = re.search(r"(\d+)\s*(?:jaar|year)", blob)
    if m_year:
        return int(m_year.group(1)) * 12
    m_month = re.search(r"(\d+)\s*(?:maand|month)", blob)
    if m_month:
        return int(m_month.group(1))
    return None


def _gaslicht_longest_years_from_html(html_text: str):
    years = []
    patterns = [
        r"(\d+)\s*(?:jaar|year)\s*(?:vast|fixed)",
        r"(\d+)\s*[- ]?\s*(?:jarig|jarige)",
        r"(?:vast|fixed)[^0-9]{0,20}(\d+)\s*(?:jaar|year)",
    ]
    for pat in patterns:
        for m in re.finditer(pat, html_text, re.I):
            val = to_float(m.group(1))
            if val is None:
                continue
            y = int(val)
            if 1 <= y <= 10:
                years.append(y)
    words = {
        "een": 1,
        "one": 1,
        "twee": 2,
        "two": 2,
        "drie": 3,
        "three": 3,
        "vier": 4,
        "four": 4,
        "vijf": 5,
        "five": 5,
    }
    for w, y in words.items():
        if re.search(rf"\b{w}\b\s*(?:jaar|year|jarige|jarig)\s*(?:vast|fixed)?", html_text, re.I):
            years.append(y)
    if not years:
        return None
    return max(years)


def _parse_feed_in_from_html(html_text):
    candidates = []
    patterns = [
        r"teruglever(?:vergoeding|tarief)?[^0-9€]{0,100}(?:€\s*)?([0-9]+(?:[.,][0-9]+)?)\s*(ct|cent|eur|€)?\s*/?\s*kwh",
        r"(?:feed[\s_-]?in|invoed(?:vergoeding|tarief)?)"
        r"[^0-9€]{0,100}(?:€\s*)?([0-9]+(?:[.,][0-9]+)?)\s*(ct|cent|eur|€)?\s*/?\s*kwh",
    ]
    for pat in patterns:
        for m in re.finditer(pat, html_text, re.I):
            val = to_float(m.group(1))
            if val is None:
                continue
            unit_hint = (m.group(2) or "").lower()
            if unit_hint in {"ct", "cent"} and val > 0:
                val = val / 100.0
            elif val > 1.5:
                val = val / 100.0
            if 0 < val <= 1.5:
                candidates.append(val)
    if not candidates:
        return None
    return max(candidates)


def get_gaslicht_cheapest(url: str, kind: str, usage: float):
    html_text = fetch_text(url)
    products = []
    for match in re.finditer(r'data-product=(?:"([^"]+)"|\'([^\']+)\')', html_text):
        raw = html.unescape(match.group(1) or match.group(2) or "")
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        products.append(data)

    impressions = []
    for match in re.finditer(r'data-js-gtminfo="([^"]*Impressions[^"]*)"', html_text):
        raw = html.unescape(match.group(1))
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        ecommerce = parsed.get("Ecommerce") or {}
        impressions.extend(ecommerce.get("Impressions") or [])

    if not products and not impressions:
        raise ValueError(f"Could not parse Gaslicht products for {kind}")

    def extract_total_cost(product):
        for key in ["PackageCosts", "Price", "PackageCost", "TotalPrice", "MonthlyCosts"]:
            value = to_float(product.get(key))
            if value is not None:
                return value
        return None

    def extract_welcome_bonus(product):
        for key in ["WelcomeBonus", "welcomeBonus", "Bonus"]:
            value = to_float(product.get(key))
            if value is not None:
                return value
        return 0.0

    best_product = None
    best_cost_ex_bonus = None
    best_bonus = 0.0
    for product in products:
        total_cost = extract_total_cost(product)
        if total_cost is None:
            continue
        bonus = extract_welcome_bonus(product)
        cost_ex_bonus = total_cost + bonus
        if best_product is None or cost_ex_bonus < best_cost_ex_bonus:
            best_product = product
            best_cost_ex_bonus = cost_ex_bonus
            best_bonus = bonus

    if best_product is not None:
        provider = best_product.get("ProviderName") or best_product.get("Brand") or "Unknown provider"
        package_name = best_product.get("PackageName") or ""
        package_cost = extract_total_cost(best_product) or 0.0
        effective_unit = best_cost_ex_bonus / usage if usage else None
        if kind == "electricity":
            unit = "EUR/kWh"
            label = "Cheapest Electricity Provider (Gaslicht)"
            usage_label = f"{int(usage)} kWh"
        else:
            unit = "EUR/m3"
            label = "Cheapest Gas Provider (Gaslicht)"
            usage_label = f"{int(usage)} m3"
        detail = (
            f"{provider} - {package_name} | "
            f"Annual cost excl. bonus: {best_cost_ex_bonus:.2f} EUR "
            f"(Package {package_cost:.2f} + bonus {best_bonus:.2f}) | "
            f"Assumed usage: {usage_label}"
        )

        package_url = best_product.get("PackageUrl")
        if package_url and package_url.startswith("/"):
            source_url = f"https://www.gaslicht.com{package_url}"
        else:
            source_url = url
    else:
        # Fallback path from GTM impressions if data-product was unavailable.
        def impression_cost(item):
            return to_float(item.get("Price"))

        best_impression = None
        best_impression_cost = None
        for impression in impressions:
            price = impression_cost(impression)
            if price is None:
                continue
            if best_impression is None or price < best_impression_cost:
                best_impression = impression
                best_impression_cost = price

        if best_impression is None:
            raise ValueError(f"Could not determine cheapest Gaslicht product for {kind}")

        provider = best_impression.get("Brand") or "Unknown provider"
        package_name = best_impression.get("Name") or ""
        unit_value = best_impression_cost / usage if usage else best_impression_cost
        unit = "EUR/kWh" if kind == "electricity" else "EUR/m3"
        label = (
            "Cheapest Electricity Provider (Gaslicht)"
            if kind == "electricity"
            else "Cheapest Gas Provider (Gaslicht)"
        )
        usage_label = f"{int(usage)} kWh" if kind == "electricity" else f"{int(usage)} m3"
        detail = (
            f"{provider} - {package_name} | "
            f"Unit price estimated from annual package cost {best_impression_cost:.2f} EUR and assumed usage {usage_label}."
        )
        source_url = url

    updated_at = datetime.now(timezone.utc).isoformat()

    return {
        "id": f"gaslicht{kind.title()}",
        "label": label,
        "value": effective_unit if best_product is not None else unit_value,
        "unit": unit,
        "source": "Gaslicht",
        "sourceUrl": source_url,
        "updatedAt": updated_at,
        "detail": detail,
    }


def get_cheapest_electricity_provider():
    return get_gaslicht_cheapest(
        "https://www.gaslicht.com/stroom-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&stroomhoogverbruik=1000&stroomlaagverbruik=1000",
        "electricity",
        2000.0,
    )


def get_cheapest_gas_provider():
    return get_gaslicht_cheapest(
        "https://www.gaslicht.com/gas-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&gasverbruik=1000",
        "gas",
        1000.0,
    )


def get_gaslicht_longest_contract():
    urls = [
        (
            "electricity",
            "https://www.gaslicht.com/stroom-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&stroomhoogverbruik=1000&stroomlaagverbruik=1000",
        ),
        (
            "gas",
            "https://www.gaslicht.com/gas-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&gasverbruik=1000",
        ),
    ]
    best = None
    for kind, url in urls:
        html_text = fetch_text(url)
        products = _gaslicht_extract_products(html_text)
        impressions = _gaslicht_extract_impressions(html_text)
        for product in products:
            months = _gaslicht_contract_months(product)
            if months is None or months <= 0:
                continue
            if best is None or months > best["months"]:
                best = {
                    "months": months,
                    "kind": kind,
                    "provider": _gaslicht_provider_name(product),
                    "package": _gaslicht_package_name(product),
                    "url": f"https://www.gaslicht.com{product.get('PackageUrl')}" if str(product.get("PackageUrl") or "").startswith("/") else url,
                }
        for imp in impressions:
            months = _gaslicht_contract_months_from_impression(imp)
            if months is None or months <= 0:
                continue
            if best is None or months > best["months"]:
                best = {
                    "months": months,
                    "kind": kind,
                    "provider": str(imp.get("Brand") or "Onbekend"),
                    "package": str(imp.get("Name") or imp.get("Variant") or ""),
                    "url": url,
                }
    if best is None:
        raise ValueError("Could not determine longest contract duration from Gaslicht")

    years = best["months"] / 12.0
    return {
        "id": "gaslichtLongestContract",
        "label": "Langste Contractduur (Gaslicht)",
        "value": years,
        "unit": "jaar",
        "source": "Gaslicht",
        "sourceUrl": best["url"],
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "detail": f"{best['provider']} - {best['package']} ({best['kind']}) | {best['months']} maanden",
    }


def get_gaslicht_longest_contract_electricity():
    best = None
    urls = [
        "https://www.gaslicht.com/stroom-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&stroomhoogverbruik=1000&stroomlaagverbruik=1000",
        "https://www.gaslicht.com/stroom-vergelijken/resultaten?showonlyswitchable=False&stroomhoogverbruik=1000&stroomlaagverbruik=1000",
        "https://www.gaslicht.com/energievergelijken/",
    ]
    for url in urls:
        try:
            html_text = fetch_text(url)
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout):
            continue
        products = _gaslicht_extract_products(html_text)
        impressions = _gaslicht_extract_impressions(html_text)
        for product in products:
            months = _gaslicht_contract_months(product)
            if months is None or months <= 0:
                continue
            if best is None or months > best["months"]:
                best = {
                    "months": months,
                    "provider": _gaslicht_provider_name(product),
                    "package": _gaslicht_package_name(product),
                    "url": f"https://www.gaslicht.com{product.get('PackageUrl')}" if str(product.get("PackageUrl") or "").startswith("/") else url,
                }
        for imp in impressions:
            months = _gaslicht_contract_months_from_impression(imp)
            if months is None or months <= 0:
                continue
            if best is None or months > best["months"]:
                best = {
                    "months": months,
                    "provider": str(imp.get("Brand") or "Onbekend"),
                    "package": str(imp.get("Name") or imp.get("Variant") or ""),
                    "url": url,
                }
        html_years = _gaslicht_longest_years_from_html(html_text)
        if html_years is not None:
            html_months = html_years * 12
            if best is None or html_months > best["months"]:
                best = {
                    "months": html_months,
                    "provider": "Gaslicht aanbod",
                    "package": f"{html_years} jaar vast",
                    "url": url,
                }
    if best is None:
        raise ValueError("Could not determine longest electricity contract duration from Gaslicht")

    return {
        "id": "gaslichtLongestContractElectricity",
        "label": "Langste Contractduur Stroom",
        "value": best["months"] / 12.0,
        "unit": "jaar",
        "source": "Gaslicht",
        "sourceUrl": best["url"],
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "detail": f"{best['provider']} - {best['package']} | {best['months']} maanden",
    }


def collect_overview():
    started = time.time()
    items = []
    errors = []

    now_utc = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    empty_rows = []
    for i in range(24):
        hour_dt = now_utc + timedelta(hours=i)
        empty_rows.append({"hour": hour_dt.strftime("%d %b %H:00 UTC"), "value": None, "unit": "EUR/MWh"})

    tasks = [
        (
            get_day_ahead_electricity,
            {
                "id": "dayAheadPower24h",
                "label": "EPEX SPOT Day-Ahead NL (24h vooruit)",
                "value": None,
                "unit": "EUR/MWh",
                "source": "ENTSO-E Transparency API (EPEX SPOT NL)",
                "sourceUrl": "https://web-api.tp.entsoe.eu/api",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Komende 24 uur per uur (bron tijdelijk niet bereikbaar)",
                "rows": empty_rows,
            },
        ),
        (get_ttf_gas, None),
        (
            get_ets_price,
            {
                "id": "ets",
                "label": "EU ETS (ICE EUA Futures)",
                "value": None,
                "unit": "EUR/tCO2",
                "source": "Barchart",
                "sourceUrl": "https://www.barchart.com/futures/quotes/CKJ26",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
            },
        ),
        (
            get_entsoe_generation_share_pie,
            {
                "id": "nlGenerationMixShare",
                "label": "Opwek Mix NL (actuele verhouding)",
                "value": None,
                "unit": "",
                "valueText": "Verhouding per bron",
                "source": "ENTSO-E Transparency API",
                "sourceUrl": "https://web-api.tp.entsoe.eu/api",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
                "rows": [],
            },
        ),
        (
            get_entsog_nl_gas_border_flows,
            {
                "id": "nlGasImport",
                "label": "Gas Cross-Border Flows NL (per land, netto)",
                "value": None,
                "unit": "GWh/d",
                "source": "ENTSOG API",
                "sourceUrl": "https://transparency.entsog.eu",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
                "rows": [
                    {"hour": "Belgie", "value": None, "unit": "GWh/d"},
                    {"hour": "Duitsland", "value": None, "unit": "GWh/d"},
                    {"hour": "Verenigd Koninkrijk", "value": None, "unit": "GWh/d"},
                    {"hour": "Denemarken", "value": None, "unit": "GWh/d"},
                    {"hour": "Noorwegen", "value": None, "unit": "GWh/d"},
                    {"hour": "LNG (Gate+EET)", "value": None, "unit": "GWh/d"},
                    {"hour": "Gasopslag (4 sites)", "value": None, "unit": "GWh/d"},
                ],
            },
        ),
        (
            get_entsog_nl_gas_production_last_day,
            {
                "id": "nlGasProduction",
                "label": "Gaswinning NL (laatste dag)",
                "value": None,
                "unit": "GWh/d",
                "source": "ENTSOG API",
                "sourceUrl": "https://transparency.entsog.eu",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
            },
        ),
        (
            get_entsoe_nl_cross_border_flows,
            {
                "id": "nlCrossBorderFlows",
                "label": "Cross-Border Physical Flows naar NL (live)",
                "value": None,
                "unit": "MW",
                "source": "ENTSO-E Transparency API",
                "sourceUrl": "https://web-api.tp.entsoe.eu/api",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
                "rows": [
                    {"hour": "Belgie", "value": None, "unit": "MW"},
                    {"hour": "Duitsland", "value": None, "unit": "MW"},
                    {"hour": "Verenigd Koninkrijk", "value": None, "unit": "MW"},
                    {"hour": "Denemarken", "value": None, "unit": "MW"},
                    {"hour": "Noorwegen", "value": None, "unit": "MW"},
                ],
            },
        ),
        (
            get_nl_gas_storage_fill,
            {
                "id": "nlGasStorage",
                "label": "NL Gasopslag (actueel)",
                "value": None,
                "unit": "%",
                "source": "NED",
                "sourceUrl": "https://ned.nl/nl/gasopslagen-nederland",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
            },
        ),
        (
            get_cheapest_electricity_provider,
            {
                "id": "gaslichtElectricity",
                "label": "Cheapest Electricity Provider (Gaslicht)",
                "value": None,
                "unit": "EUR/kWh",
                "source": "Gaslicht",
                "sourceUrl": "https://www.gaslicht.com/stroom-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&stroomhoogverbruik=1000&stroomlaagverbruik=1000",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
            },
        ),
        (
            get_cheapest_gas_provider,
            {
                "id": "gaslichtGas",
                "label": "Cheapest Gas Provider (Gaslicht)",
                "value": None,
                "unit": "EUR/m3",
                "source": "Gaslicht",
                "sourceUrl": "https://www.gaslicht.com/gas-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&gasverbruik=1000",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
            },
        ),
        (
            get_gaslicht_longest_contract,
            {
                "id": "gaslichtLongestContract",
                "label": "Langste Contractduur (Gaslicht)",
                "value": None,
                "unit": "jaar",
                "source": "Gaslicht",
                "sourceUrl": "https://www.gaslicht.com/energievergelijken/",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
            },
        ),
        (
            get_gaslicht_longest_contract_electricity,
            {
                "id": "gaslichtLongestContractElectricity",
                "label": "Langste Contractduur Stroom",
                "value": None,
                "unit": "jaar",
                "source": "Gaslicht",
                "sourceUrl": "https://www.gaslicht.com/stroom-vergelijken/resultaten?showonlyswitchable=False&contracttype=Vast&stroomhoogverbruik=1000&stroomlaagverbruik=1000",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
            },
        ),
        (
            get_ned_electricity_overview,
            {
                "id": "nlElectricityOverview",
                "label": "Elektriciteit NL (actuele load)",
                "value": None,
                "unit": "MW",
                "source": "ENTSO-E Transparency API",
                "sourceUrl": "https://web-api.tp.entsoe.eu/api",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "ENTSO-E bron tijdelijk niet bereikbaar | actuele load",
                "rows": [],
            },
        ),
        (
            get_tennet_grid_frequency,
            {
                "id": "nlGridFrequency",
                "label": "Netfrequentie NL (actueel)",
                "value": None,
                "unit": "Hz",
                "source": "mainsfrequency.com",
                "sourceUrl": "https://mainsfrequency.com",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "Bron tijdelijk niet bereikbaar",
            },
        ),
        (
            get_ned_gas_consumption_breakdown,
            {
                "id": "nlGasConsumptionBreakdown",
                "label": "Gasconsumptie NL (laatste volledige dag)",
                "value": None,
                "unit": "GWh/d",
                "source": "NED API",
                "sourceUrl": "https://api.ned.nl/v1/utilizations",
                "updatedAt": datetime.now(timezone.utc).isoformat(),
                "detail": "NED bron tijdelijk niet bereikbaar",
                "rows": [],
            },
        ),
    ]
    if has_tennet_key():
        tasks.extend(
            [
                (get_grid_load, None),
                (get_nl_import_export_position, None),
                (
                    get_tennet_regulation,
                    {
                        "id": "tennetRegulation",
                        "label": "TenneT Balance Delta (actueel, 12s)",
                        "value": None,
                        "unit": "MW",
                        "source": "TenneT API (Balance Delta High Res)",
                        "sourceUrl": "https://api.tennet.eu/publications/v1/balance-delta-high-res/latest",
                        "updatedAt": datetime.now(timezone.utc).isoformat(),
                        "detail": "Bron tijdelijk niet bereikbaar",
                    },
                ),
                (
                    get_tennet_settlement_prices,
                    {
                        "id": "tennetSettlement",
                        "label": "TenneT Settlement Price (actueel)",
                        "value": None,
                        "unit": "EUR/MWh",
                        "source": "TenneT API (Settlement Prices)",
                        "sourceUrl": "https://api.tennet.eu/publications/v1/settlement-prices",
                        "updatedAt": datetime.now(timezone.utc).isoformat(),
                        "detail": "Bron tijdelijk niet bereikbaar",
                    },
                ),
            ]
        )

    for fn, fallback_item in tasks:
        try:
            value = fn()
            if isinstance(value, list):
                items.extend(value)
            else:
                items.append(value)
                if isinstance(value, dict) and value.get("id"):
                    cache_set(str(value.get("id")), value)
        except (ValueError, HTTPError, URLError, TimeoutError, socket.timeout) as exc:
            errors.append({"source": fn.__name__, "error": str(exc)})
            cache_id = None
            if fallback_item and isinstance(fallback_item, dict):
                cache_id = fallback_item.get("id")
            cached_item = cache_get(str(cache_id)) if cache_id else None
            if cached_item:
                cached_detail = cached_item.get("detail", "")
                msg = f"tijdelijke bronstoring, laatste geldige waarde getoond | fout: {exc}"
                cached_item["detail"] = f"{cached_detail} | {msg}".strip(" |")
                cached_item["updatedAt"] = datetime.now(timezone.utc).isoformat()
                items.append(cached_item)
                continue
            if fallback_item:
                fb = dict(fallback_item)
                base_detail = fb.get("detail", "")
                err_text = str(exc)
                fb["detail"] = f"{base_detail} | fout: {err_text}" if base_detail else f"fout: {err_text}"
                items.append(fb)
        except Exception as exc:
            # Keep the dashboard up even when a source parser crashes unexpectedly.
            errors.append({"source": fn.__name__, "error": f"unexpected: {exc}"})
            cache_id = None
            if fallback_item and isinstance(fallback_item, dict):
                cache_id = fallback_item.get("id")
            cached_item = cache_get(str(cache_id)) if cache_id else None
            if cached_item:
                cached_detail = cached_item.get("detail", "")
                msg = f"tijdelijke bronstoring, laatste geldige waarde getoond | fout: unexpected: {exc}"
                cached_item["detail"] = f"{cached_detail} | {msg}".strip(" |")
                cached_item["updatedAt"] = datetime.now(timezone.utc).isoformat()
                items.append(cached_item)
                continue
            if fallback_item:
                fb = dict(fallback_item)
                base_detail = fb.get("detail", "")
                err_text = f"unexpected: {exc}"
                fb["detail"] = f"{base_detail} | fout: {err_text}" if base_detail else f"fout: {err_text}"
                items.append(fb)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "durationMs": int((time.time() - started) * 1000),
        "items": items,
        "errors": errors,
        "note": "Data is scraped from public pages/APIs and may lag or change format.",
    }


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def _serve_static(self, rel_path="index.html"):
        path = os.path.normpath(rel_path).lstrip("/")
        full_path = os.path.join(STATIC_DIR, path)
        if not full_path.startswith(STATIC_DIR):
            self.send_error(403)
            return

        if not os.path.isfile(full_path):
            self.send_error(404)
            return

        if full_path.endswith(".html"):
            ctype = "text/html; charset=utf-8"
        elif full_path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif full_path.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        else:
            ctype = "application/octet-stream"

        with open(full_path, "rb") as f:
            data = f.read()

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            return

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/overview":
            self._send_json(collect_overview())
            return

        if path == "/":
            self._serve_static("index.html")
            return

        if path.startswith("/"):
            self._serve_static(path[1:])
            return

        self.send_error(404)


def run():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Server running on http://localhost:{port}")
    server.serve_forever()


if __name__ == "__main__":
    run()
