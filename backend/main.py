"""
FastAPI middle layer for querying GDELT DOC 2.0 API and exposing
aggregated news endpoints for the world dashboard.

Endpoints
---------
- /api/global : latest high-impact articles from the past 24 hours.
- /api/country/{iso2} : last 10 articles mentioning the selected country.
"""
from __future__ import annotations

import os
from functools import lru_cache
from typing import Dict, List, Optional
from urllib.parse import unquote

import httpx
import pycountry
from fastapi import FastAPI, HTTPException, Path, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"

# Default query behaviour. Adjust keywords to emphasise geopolitics & major events.
GLOBAL_QUERY = (
    "(theme:ARMEDCONFLICT OR theme:POLITICS OR theme:SECURITY "
    "OR theme:ECONOMY OR theme:GOVERNMENT OR theme:TERROR)"
)

DEFAULT_TIMESPAN = "1d"
GLOBAL_MAX_RECORDS = 50
COUNTRY_MAX_RECORDS = 50
DEFAULT_SORT = "DateDesc"
DEFAULT_TRANSLATION = os.getenv("GDELT_TRANSLATION", "googtrans")

# Optional: configure via environment variables.
GLOBAL_QUERY = os.getenv("GDELT_GLOBAL_QUERY", GLOBAL_QUERY)
DEFAULT_TIMESPAN = os.getenv("GDELT_TIMESPAN", DEFAULT_TIMESPAN)

COMMON_COUNTRY_ALIASES: Dict[str, Optional[str]] = {
"AF":"Afghanistan",
"AX":"Akrotiri Sovereign Base Area",
"AL":"Albania",
"AG":"Algeria",
"AQ":"American Samoa",
"AN":"Andorra",
"AO":"Angola",
"AV":"Anguilla",
"AY":"Antarctica",
"AC":"Antigua and Barbuda",
"AR":"Argentina",
"AM":"Armenia",
"AA":"Aruba",
"AT":"Ashmore and Cartier Islands",
"AS":"Australia",
"AU":"Austria",
"AJ":"Azerbaijan",
"BF":"Bahamas, The",
"BA":"Bahrain",
"FQ":"Baker Island",
"BG":"Bangladesh",
"BB":"Barbados",
"BS":"Bassas da India",
"BO":"Belarus",
"BE":"Belgium",
"BH":"Belize",
"BN":"Benin",
"BD":"Bermuda",
"BT":"Bhutan",
"BL":"Bolivia",
"BK":"Bosnia-Herzegovina",
"BC":"Botswana",
"BV":"Bouvet Island",
"BR":"Brazil",
"IO":"British Indian Ocean Territory",
"VI":"British Virgin Islands",
"BX":"Brunei",
"BU":"Bulgaria",
"UV":"Burkina Faso",
"BY":"Burundi",
"CB":"Cambodia",
"CM":"Cameroon",
"CA":"Canada",
"CV":"Cape Verde",
"CJ":"Cayman Islands",
"CT":"Central African Republic",
"CD":"Chad",
"CI":"Chile",
"CH":"China",
"KT":"Christmas Island",
"IP":"Clipperton Island",
"CK":"Cocos Keeling Islands",
"CO":"Colombia",
"CN":"Comoros",
"CF":"Congo",
"CW":"Cook Islands",
"CR":"Coral Sea Islands",
"CS":"Costa Rica",
"IV":"Cote dIvoire",
"HR":"Croatia",
"CU":"Cuba",
"CY":"Cyprus",
"EZ":"Czech Republic",
"LO":"Slovakia",
"CG":"Democratic Republic of the Congo",
"DA":"Denmark",
"DX":"Dhekelia Sovereign Base Area",
"DJ":"Djibouti",
"DO":"Dominica",
"DR":"Dominican Republic",
"TT":"East Timor",
"EC":"Ecuador",
"EG":"Egypt",
"ES":"El Salvador",
"GV":"Equatorial Guinea",
"EK":"Equatorial Guinea",
"ER":"Eritrea",
"EN":"Estonia",
"ET":"Ethiopia",
"PJ":"Etorofu, Habomai, Kunashiri and Shikotan Islands",
"EU":"Europa Island",
"FK":"Falkland Islands Islas Malvinas",
"FO":"Faroe Islands",
"FJ":"Fiji",
"FI":"Finland",
"FR":"France",
"FG":"French Guiana",
"FP":"French Polynesia",
"FS":"French Southern and Antarctic Lands",
"GB":"Gabon",
"GA":"Gambia",
"GZ":"Gaza Strip",
"GG":"Georgia",
"GM":"Germany",
"GH":"Ghana",
"GI":"Gibraltar",
"GO":"Glorioso Islands",
"GR":"Greece",
"GL":"Greenland",
"GJ":"Grenada",
"GP":"Guadeloupe",
"GQ":"Guam",
"GT":"Guatemala",
"GK":"Guernsey",
"PU":"Guinea-Bissau",
"GY":"Guyana",
"HA":"Haiti",
"HM":"Heard Island and McDonald Islands",
"HO":"Honduras",
"HK":"Hong Kong",
"HQ":"Howland Island",
"HU":"Hungary",
"IC":"Iceland",
"IN":"India",
"ID":"Indonesia",
"IR":"Iran",
"IZ":"Iraq",
"EI":"Ireland",
"IM":"Isle of Man",
"IS":"Israel",
"IT":"Italy",
"JM":"Jamaica",
"JN":"Jan Mayen",
"JA":"Japan",
"DQ":"Jarvis Island",
"JE":"Jersey",
"JQ":"Johnston Atoll",
"JO":"Jordan",
"JU":"Juan de Nova Island",
"KZ":"Kazakhstan",
"KE":"Kenya",
"KQ":"Kingman Reef",
"KR":"Kiribati",
"KV":"Kosovo",
"KU":"Kuwait",
"KG":"Kyrgyzstan",
"LA":"Laos",
"LG":"Latvia",
"LE":"Lebanon",
"LT":"Lesotho",
"LI":"Liberia",
"LY":"Libya",
"LS":"Liechtenstein",
"LH":"Lithuania",
"LU":"Luxembourg",
"MC":"Macau",
"MK":"Macedonia",
"MA":"Madagascar",
"MI":"Malawi",
"MY":"Malaysia",
"MV":"Maldives",
"ML":"Mali",
"MT":"Malta",
"RM":"Marshall Islands",
"MB":"Martinique",
"MR":"Mauritania",
"MP":"Mauritius",
"MF":"Mayotte",
"MX":"Mexico",
"FM":"Micronesia",
"MQ":"Midway Islands",
"MD":"Moldova",
"MN":"Monaco",
"MG":"Mongolia",
"MJ":"Montenegro",
"MH":"Montserrat",
"MO":"Morocco",
"MZ":"Mozambique",
"BM":"Myanmar",
"WA":"Namibia",
"NR":"Nauru",
"BQ":"Navassa Island",
"NP":"Nepal",
"NL":"Netherlands",
"NT":"Netherlands Antilles",
"NC":"New Caledonia",
"NZ":"New Zealand",
"NU":"Nicaragua",
"NG":"Niger",
"NI":"Nigeria",
"NE":"Niue",
"NM":"No Mans Land",
"NF":"Norfolk Island",
"KN":"North Korea",
"CQ":"Northern Mariana Islands",
"NO":"Norway",
"OS":"Oceans",
"MU":"Oman",
"PK":"Pakistan",
"PS":"Palau",
"LQ":"Palmyra Atoll",
"PM":"Panama",
"PP":"Papua New Guinea",
"PF":"Paracel Islands",
"PA":"Paraguay",
"PE":"Peru",
"RP":"Philippines",
"PC":"Pitcairn Islands",
"PL":"Poland",
"PO":"Portugal",
"RQ":"Puerto Rico",
"QA":"Qatar",
"RE":"Reunion",
"RO":"Romania",
"RS":"Russia",
"RW":"Rwanda",
"SH":"Saint Helena",
"SC":"Saint Kitts and Nevis",
"ST":"Saint Lucia",
"RN":"Saint Martin",
"SB":"Saint Pierre and Miquelon",
"VC":"Saint Vincent and the Grenadines",
"TB":"Saint-Barthelemy Island",
"WS":"Samoa",
"SM":"San Marino",
"TP":"Sao Tome and Principe",
"SA":"Saudi Arabia",
"SG":"Senegal",
"RI":"Serbia",
"SE":"Seychelles",
"SL":"Sierra Leone",
"SN":"Singapore",
"SI":"Slovenia",
"BP":"Solomon Islands",
"SO":"Somalia",
"SF":"South Africa",
"SX":"South Georgia and the South Sandwich Islands",
"KS":"South Korea",
"OD":"South Sudan",
"SP":"Spain",
"PG":"Spratly Islands",
"CE":"Sri Lanka",
"SU":"Sudan",
"NS":"Suriname",
"SV":"Svalbard",
"WZ":"Swaziland",
"SW":"Sweden",
"SZ":"Switzerland",
"SY":"Syria",
"TW":"Taiwan",
"TI":"Tajikistan",
"TZ":"Tanzania",
"TH":"Thailand",
"TO":"Togo",
"TL":"Tokelau",
"TN":"Tonga",
"TD":"Trinidad and Tobago",
"TE":"Tromelin Island",
"TS":"Tunisia",
"TU":"Turkey",
"TX":"Turkmenistan",
"TK":"Turks and Caicos Islands",
"TV":"Tuvalu",
"UG":"Uganda",
"UP":"Ukraine",
"UF":"Undersea Features",
"UU":"Undesignated Sovereignty",
"AE":"United Arab Emirates",
"UK":"United Kingdom",
"US":"United States",
"UY":"Uruguay",
"UZ":"Uzbekistan",
"NH":"Vanuatu",
"VT":"Vatican City",
"VE":"Venezuela",
"VM":"Vietnam, Democratic Republic of",
"VQ":"Virgin Islands",
"WQ":"Wake Island",
"WF":"Wallis and Futuna",
"WE":"West Bank",
"WI":"Western Sahara",
"YM":"Yemen",
"ZA":"Zambia",
"ZI":"Zimbabwe",
}

NAME_REWRITES: Dict[str, str] = {
    "Bahamas, The": "Bahamas",
    "Czech Republic": "Czechia",
    "Micronesia": "Micronesia, Federated States of",
    "Macedonia": "North Macedonia",
    "Russia": "Russian Federation",
    "South Korea": "Korea, Republic of",
    "North Korea": "Korea, Democratic People's Republic of",
    "Ivory Coast": "Cote d'Ivoire",
    "Cote dIvoire": "Cote d'Ivoire",
    "Swaziland": "Eswatini",
    "Vatican City": "Holy See",
    "Palestine": "Palestine, State of",
    "Gaza Strip": "Palestine, State of",
}

ISO_TO_FIPS: Dict[str, str] = {}

for fips_code, display_name in COMMON_COUNTRY_ALIASES.items():
    if not display_name:
        continue

    normalized_name = NAME_REWRITES.get(display_name, display_name)

    try:
        country = pycountry.countries.lookup(normalized_name or display_name)
    except LookupError:
        continue

    iso_code = country.alpha_2.upper()
    ISO_TO_FIPS[iso_code] = fips_code

FIPS_TO_ISO: Dict[str, str] = {fips: iso for iso, fips in ISO_TO_FIPS.items()}

EXTRA_FIPS_ALIASES: Dict[str, str] = {
    "usa": "US",
    "united states": "US",
    "united states of america": "US",
    "america": "US",
    "uk": "UK",
    "united kingdom": "UK",
    "great britain": "UK",
    "britain": "UK",
    "england": "UK",
    "russia": "RS",
    "russian federation": "RS",
    "south korea": "KS",
    "republic of korea": "KS",
    "north korea": "KN",
    "dprk": "KN",
    "palestine": "WE",
    "state of palestine": "WE",
    "gaza strip": "GZ",
    "west bank": "WE",
    "holy see": "VT",
    "vatican city": "VT",
    "laos": "LA",
    "cote d'ivoire": "IV",
    "cote d’ivoire": "IV",
    "ivory coast": "IV",
    "hong kong": "HK",
    "macau": "MC",
    "macao": "MC",
    "republic of moldova": "MD",
    "islamic republic of iran": "IR",
}

NAME_TO_ISO: Dict[str, str] = {}

def _register_country_alias(name: Optional[str], code: str) -> None:
    if not name:
        return
    normalized = name.strip().lower()
    if not normalized:
        return
    NAME_TO_ISO.setdefault(normalized, code.upper())

for fips_code, display_name in COMMON_COUNTRY_ALIASES.items():
    if not display_name:
        continue
    _register_country_alias(display_name, fips_code)
    rewritten = NAME_REWRITES.get(display_name)
    if rewritten:
        _register_country_alias(rewritten, fips_code)

for alias, code in EXTRA_FIPS_ALIASES.items():
    _register_country_alias(alias, code)



class CountryRef(BaseModel):
    name: Optional[str]
    iso2: Optional[str]
    lat: Optional[float]
    lon: Optional[float]


class Article(BaseModel):
    id: str
    title: str
    url: str
    time: Optional[str]
    source: Optional[str]
    source_country: Optional[str]
    summary: Optional[str]
    tone: Optional[float]
    themes: List[str] = []
    countries: List[CountryRef] = []


class ArticlesResponse(BaseModel):
    query: str
    count: int
    articles: List[Article]


app = FastAPI(title="World Dashboard News API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_methods=["GET"],
    allow_headers=["*"],
)


class GDELTError(RuntimeError):
    """Raised when GDELT returns an error payload."""


@lru_cache(maxsize=256)
def _country_from_alpha2(code: str) -> Optional[pycountry.db.Country]:
    try:
        return pycountry.countries.get(alpha_2=code.upper())
    except (AttributeError, KeyError):
        return None


def _decode_country_identifier(value: Optional[str]) -> Optional[str]:
    """Decode percent-encoded or '+' separated country identifiers."""
    if not value:
        return value

    decoded = value.strip()
    previous: Optional[str] = None
    while decoded and previous != decoded:
        previous = decoded
        decoded = unquote(decoded)
    if decoded:
        decoded = decoded.replace("+", " ").strip()
    return decoded


def _normalize_country_code(name_or_code: str) -> Optional[str]:
    if not name_or_code:
        return None
    code = _decode_country_identifier(name_or_code) or ""
    upper_code = code.upper()
    if len(upper_code) == 2:
        if upper_code in ISO_TO_FIPS:
            # Already ISO
            return upper_code
        iso_from_fips = FIPS_TO_ISO.get(upper_code)
        if iso_from_fips:
            return iso_from_fips

    alias_match = NAME_TO_ISO.get(code.lower())
    if alias_match:
        return alias_match.upper()

    if len(code) == 2 and code.isalpha():
        return upper_code

    # Try to look up by name.
    try:
        match = pycountry.countries.lookup(code)
    except LookupError:
        # search_fuzzy handles partial matches (e.g. "Russia")
        try:
            fuzzy_matches = pycountry.countries.search_fuzzy(code)
        except LookupError:
            return None
        if not fuzzy_matches:
            return None
        match = fuzzy_matches[0]

    iso_code = getattr(match, "alpha_2", None)
    if not iso_code:
        return None
    return iso_code.upper()


def _extract_countries(article: Dict) -> List[CountryRef]:
    countries: List[CountryRef] = []
    seen_codes: set[str] = set()

    for loc in article.get("locations") or []:
        iso2 = _normalize_country_code(loc.get("countrycode") or loc.get("iso2"))
        if not iso2:
            continue
        if iso2 in seen_codes:
            continue

        countries.append(
            CountryRef(
                name=loc.get("name") or loc.get("countryname"),
                iso2=iso2,
                lat=_safe_float(loc.get("latitude") or loc.get("lat")),
                lon=_safe_float(loc.get("longitude") or loc.get("lon")),
            )
        )
        seen_codes.add(iso2)

    if countries:
        return countries

    iso2 = _normalize_country_code(article.get("sourcecountry"))
    if iso2:
        country_obj = _country_from_alpha2(iso2)
        countries.append(
            CountryRef(
                name=getattr(country_obj, "name", iso2),
                iso2=iso2,
                lat=_safe_float(article.get("lat")),
                lon=_safe_float(article.get("lon")),
            )
        )

    return countries


def _safe_float(value) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _format_article(raw: Dict) -> Article:
    themes = raw.get("themes") or []
    if isinstance(themes, str):
        themes = [theme.strip() for theme in themes.split(",") if theme.strip()]

    return Article(
        id=str(raw.get("id") or raw.get("url") or raw.get("guid") or raw.get("seendate")),
        title=raw.get("title", "Untitled"),
        url=raw.get("url"),
        time=raw.get("seendate"),
        source=raw.get("domain") or raw.get("source"),
        source_country=_normalize_country_code(raw.get("sourcecountry") or raw.get("domaincountry")),
        summary=raw.get("excerpt") or raw.get("summary"),
        tone=_safe_float(raw.get("tone")),
        themes=themes,
        countries=_extract_countries(raw),
    )


async def _call_gdelt(params: Dict[str, str]) -> Dict:
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(GDELT_DOC_URL, params=params)
    response.raise_for_status()
    try:
        data = response.json()
    except ValueError as exc:
        snippet = response.text[:200]
        raise GDELTError(f"Non-JSON response from GDELT: {snippet}") from exc

    if isinstance(data, dict) and data.get("status") == "error":
        raise GDELTError(data.get("error") or "Unknown GDELT error")
    return data


async def _fetch_articles(
    query: str,
    timespan: str,
    maxrecords: int,
    sort: str = DEFAULT_SORT,
) -> List[Dict]:
    params: Dict[str, str] = {
        "query": query,
        "mode": "ArtList",
        "format": "json",
        "maxrecords": str(maxrecords),
        "timespan": timespan,
        "sort": sort,
    }
    if DEFAULT_TRANSLATION:
        params["trans"] = DEFAULT_TRANSLATION

    data = await _call_gdelt(params)
    articles = data.get("articles", [])
    if not isinstance(articles, list):
        return []
    return articles


def deduplicate_articles(articles: List[Article]) -> List[Article]:
    seen_urls: set[str] = set()
    deduped: List[Article] = []
    for article in articles:
        url = article.url
        if url and url in seen_urls:
            continue
        deduped.append(article)
        if url:
            seen_urls.add(url)
    return deduped


@app.get("/api/global", response_model=ArticlesResponse)
async def global_news(
    max_records: int = Query(20, ge=1, le=200, description="Maximum number of articles to return."),
    timespan: str = Query(DEFAULT_TIMESPAN, description="Timespan window (e.g. 24H, 48H, 7D)."),
    query: str = Query(GLOBAL_QUERY, description="GDELT query string."),
) -> ArticlesResponse:
    try:
        raw_articles = await _fetch_articles(query=query, timespan=timespan, maxrecords=min(max_records, GLOBAL_MAX_RECORDS))
    except (httpx.HTTPError, GDELTError) as exc:
        raise HTTPException(status_code=502, detail=f"GDELT request failed: {exc}") from exc

    articles = [ _format_article(article) for article in raw_articles ]
    articles = deduplicate_articles(articles)[:max_records]
    return ArticlesResponse(query=query, count=len(articles), articles=articles)


@app.get("/api/country/{country}", response_model=ArticlesResponse)
async def country_news(
    country: str = Path(..., description="Country code or name (ISO-2, ISO-3, or full name)."),
    max_records: int = Query(50, ge=1, le=100, description="Maximum number of articles to return."),
    timespan: str = Query(DEFAULT_TIMESPAN, description="Timespan window (e.g. 24H, 48H, 7D)."),
) -> ArticlesResponse:
    decoded_country = _decode_country_identifier(country) or country
    iso2 = _normalize_country_code(decoded_country)
    if not iso2:
        raise HTTPException(status_code=400, detail=f"Unsupported country identifier: {decoded_country}")

    candidate_queries = [
        f"sourcecountry:{iso2} {GLOBAL_QUERY}",
        f"locationcountry:{iso2} {GLOBAL_QUERY}",
        f"locationcountry:{iso2}",
    ]

    raw_articles = []
    chosen_query = candidate_queries[0]
    last_error: Optional[Exception] = None

    for candidate in candidate_queries:
        try:
            result = await _fetch_articles(
                query=candidate,
                timespan=timespan,
                maxrecords=min(max_records, COUNTRY_MAX_RECORDS),
            )
        except (httpx.HTTPError, GDELTError) as exc:
            last_error = exc
            continue

        if result:
            raw_articles = result
            chosen_query = candidate
            break
        # store empty result but keep searching for fallback
        raw_articles = result
        chosen_query = candidate

    if last_error and not raw_articles:
        raise HTTPException(status_code=502, detail=f"GDELT request failed: {last_error}") from last_error

    articles = [_format_article(article) for article in raw_articles]
    articles = deduplicate_articles(articles)[:max_records]

    return ArticlesResponse(query=chosen_query, count=len(articles), articles=articles)


@app.get("/health", include_in_schema=False)
@app.get("/api/health", include_in_schema=False)
async def healthcheck() -> Dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=True,
    )
