// Cloudflare Worker — OCFA Fire Status (Burn Permit + Fire Danger)
// Fetches burn permit status from Michigan DNR and fire weather alerts from NWS in parallel.
// Deploy at: https://dash.cloudflare.com → Workers & Pages → Create Worker
// After deploying, replace BURN_PERMIT_WORKER_URL in index.html with your worker's URL.

const ARCGIS_URL =
  'https://gisp.mcgi.state.mi.us/arcgis/rest/services/DNR/Burn_Permits/MapServer/1/query' +
  '?where=LABEL%3D%27OTSEGO%27&outFields=LABEL%2CSTATUS%2CPullStamp&returnGeometry=false&f=json';

// MIZ022 = Otsego County fire weather zone (NWS Grand Rapids/Gaylord)
const NWS_ALERTS_URL =
  'https://api.weather.gov/alerts/active?zone=MIZ022';

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

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const cacheKey = new Request('https://ocfa-fire-status-cache/otsego-v2', request);
    const cache    = caches.default;
    const cached   = await cache.match(cacheKey);
    if (cached) return cached;

    try {
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

      const body = JSON.stringify({
        county:  'OTSEGO',
        permit:  { status: code, label: permit.label, detail: permit.detail, color: permit.color },
        danger:  danger,
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
