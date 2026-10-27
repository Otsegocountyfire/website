// Cloudflare Worker — OCFA Fire Status (Burn Permit + Fire Danger)
// Fetches burn permit status from Michigan DNR, fire weather alerts from NWS, and the daily
// fire danger level from the DNR Lower Peninsula Morning Fire Briefing, in parallel.
// Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
// After deploying, replace BURN_PERMIT_WORKER_URL in index.html with your worker's URL.

const ARCGIS_URL =
  'https://gisp.mcgi.state.mi.us/arcgis/rest/services/DNR/Burn_Permits/MapServer/1/query' +
  '?where=LABEL%3D%27OTSEGO%27&outFields=LABEL%2CSTATUS%2CPullStamp&returnGeometry=false&f=json';

// MIZ022 = Otsego County fire weather zone (NWS Grand Rapids/Gaylord)
const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?zone=MIZ022';

// Daily DNR briefing (PDF). Its "FIRE DANGER AND STAFFING" section is written by the duty officer,
// e.g. "Fire danger is Moderate." It covers the whole Lower Peninsula, not just Otsego County.
const BRIEFING_URL = 'https://www2.dnr.state.mi.us/weather/lpmorningbriefing.pdf';
// Highest first, so "Very High" is matched before "High"
const DANGER_LEVELS = ['Extreme', 'Very High', 'High', 'Moderate', 'Low'];

const PERMIT_MAP = {
  0: { label: 'No Permit Available',  detail: 'Open burning is not permitted at this time.',                   color: 'brown'  },
  1: { label: 'Permit Available',     detail: 'Burn permits are available. A permit is required to burn.',     color: 'green'  },
  2: { label: 'Restricted Burning',   detail: 'Burning is restricted. Check the DNR site for current rules.',  color: 'orange' },
  3: { label: 'Contact Local Office', detail: 'Contact your local DNR office for permit information.',          color: 'gray'   },
};

// NWS event names that represent elevated fire danger, in descending severity
const FIRE_ALERT_PRIORITY = [
  { match: 'Red Flag Warning',       label: 'Red Flag Warning',      detail: 'Critical fire weather conditions in effect. Extreme fire danger.',      color: 'red'    },
  { match: 'Fire Weather Watch',     label: 'Fire Weather Watch',    detail: 'Conditions may develop that are conducive to extreme fire behavior.',   color: 'orange' },
  { match: 'Fire Weather Advisory',  label: 'Fire Weather Advisory', detail: 'Elevated fire weather conditions possible. Use caution when burning.',  color: 'yellow' },
];

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function parseDanger(alerts) {
  const events = alerts?.features?.map(f => f.properties?.event || '') ?? [];
  for (const tier of FIRE_ALERT_PRIORITY) {
    if (events.some(e => e.includes(tier.match))) {
      return { level: tier.match.toLowerCase().replace(/\s+/g, '_'), label: tier.label, detail: tier.detail, color: tier.color };
    }
  }
  return { level: 'none', label: 'No Active Alerts', detail: 'No elevated fire weather alerts are in effect for Otsego County.', color: 'green' };
}

// Pull the text out of the briefing PDF: inflate each compressed stream and join its literal strings
async function pdfText(bytes) {
  const latin = new TextDecoder('latin1');
  const raw = latin.decode(bytes);
  let text = '';
  let i = 0;
  while ((i = raw.indexOf('stream', i)) !== -1) {
    // Skip the "stream" inside "endstream"
    if (raw.slice(i - 3, i) === 'end') { i += 6; continue; }
    let s = i + 6;
    if (raw[s] === '\r') s++;
    if (raw[s] === '\n') s++;
    const e = raw.indexOf('endstream', s);
    if (e < 0) break;
    // Drop the line break before "endstream"; DecompressionStream rejects trailing bytes
    let end = e;
    while (end > s && (raw[end - 1] === '\n' || raw[end - 1] === '\r')) end--;
    try {
      const inflated = new Blob([bytes.slice(s, end)]).stream().pipeThrough(new DecompressionStream('deflate'));
      const content = latin.decode(await new Response(inflated).arrayBuffer());
      text += (content.match(/\((?:\\.|[^\\)])*\)/g) || []).map(t => t.slice(1, -1)).join('') + ' ';
    } catch (err) {
      // Not a deflate stream (e.g. an image); skip it
    }
    i = e + 9;
  }
  return text.replace(/en-US/g, ' ').replace(/\s+/g, ' ');
}

// Today's Lower Peninsula fire danger level, or null if the briefing is missing, stale, or unclear.
// If the sentence names more than one level ("Low to Moderate", "Moderate south, High north"), use the highest.
async function fetchBriefingRating() {
  const resp = await fetch(BRIEFING_URL, { cf: { cacheTtl: 1800 } });
  if (!resp.ok) return null;
  const text = await pdfText(new Uint8Array(await resp.arrayBuffer()));

  // Only trust today's briefing (it may stop being updated outside fire season)
  const published = text.match(/Published:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!published) return null;
  const today = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Detroit', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date());
  if (`${+published[1]}/${+published[2]}/${published[3]}` !== today) return null;

  const section  = text.match(/FIRE DANGER AND STAFFING(.*?)(?:FIRE PLANNING|AERIAL DETECTION|BURN PERMITS|$)/i);
  const sentence = section && section[1].match(/fire danger (?:is|will be|remains)[^.]*/i);
  if (!sentence) return null;
  const level = DANGER_LEVELS.find(l => new RegExp(`\\b${l}\\b`, 'i').test(sentence[0]));
  if (!level) return null;

  return {
    level:  level,
    date:   `${published[3]}-${published[1].padStart(2, '0')}-${published[2].padStart(2, '0')}`,
    area:   'Lower Peninsula',
    source: 'Michigan DNR morning fire briefing',
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const cacheKey = new Request('https://ocfa-fire-status-cache/otsego-v3', request);
    const cache    = caches.default;
    const cached   = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      // The briefing is optional: if it fails, the response just has no rating
      const ratingPromise = fetchBriefingRating().catch(() => null);

      const [permitResp, alertsResp] = await Promise.all([
        fetch(ARCGIS_URL),
        fetch(NWS_ALERTS_URL, { headers: { 'User-Agent': 'OtsegoCountyFireAuthority/1.0 (otsegocountyfiremi.gov)' } }),
      ]);

      const [permitData, alertsData] = await Promise.all([
        permitResp.json(),
        alertsResp.json(),
      ]);

      const attrs = permitData?.features?.[0]?.attributes;
      if (!attrs) throw new Error('No Otsego County record in DNR response');

      const code    = typeof attrs.STATUS === 'number' ? attrs.STATUS : -1;
      const permit  = PERMIT_MAP[code] ?? { label: 'Status Unavailable', detail: 'Could not determine current burn permit status.', color: 'gray' };
      const updated = attrs.PullStamp ? new Date(attrs.PullStamp).toISOString() : null;
      const danger  = parseDanger(alertsData);
      const rating  = await ratingPromise;

      const body = JSON.stringify({
        county:  'OTSEGO',
        permit:  { status: code, label: permit.label, detail: permit.detail, color: permit.color },
        danger:  danger,
        rating:  rating,
        updated: updated,
      });

      const response = new Response(body, {
        headers: {
          ...CORS,
          'Content-Type':  'application/json',
          'Cache-Control': 'public, max-age=3600, s-maxage=3600',
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;

    } catch (err) {
      return new Response(
        JSON.stringify({ error: true, message: err.message }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }
  },
};
