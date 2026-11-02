// Builds data/incident-stats.json from NERIS Public: Incident Basics. Run by
// .github/workflows/incident-stats.yml, or by hand: node scripts/incident-stats.mjs
//
// Only aggregated counts are written. OUT_FIELDS leaves out addresses, coordinates
// and everything else the page doesn't count, so they never reach this machine.
//
// Any failure exits non-zero without touching the output file, so the site keeps
// serving the last good numbers.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NERIS_ID = 'FD26137918';
const SERVICE =
  'https://lPbcyJOcoLyZmvo6.svcs5.arcgis.com/lPbcyJOcoLyZmvo6/arcgis/rest/services/' +
  'NERIS%20Public%20Incident%20Basics/FeatureServer/0';
const EXPLORER = `https://public.neris.fsri.org/explorer.html?neris_id=${NERIS_ID}`;
const OUT_FIELDS = 'neris_id_incident,neris_id_dept,department_name,type_1,type_2,type_3,aid_direction,call_create,export_date';
const OUTPUT = fileURLToPath(new URL('../data/incident-stats.json', import.meta.url));

const PUBLICATION_LAG_DAYS = 60;   // USFA: these data sets update after a 60-day delay
const ROLL_OFF_AGE_MONTHS = 12;    // NERIS describes a rolling window of about 15 months
const MAX_UNEXPLAINED_DROP = 0.25; // a bigger fall in published incidents is treated as a bad feed

// Same rule as the official Explorer (classifyIncident in its app.js), so the category
// totals can be checked against it: several disciplines = multi_discipline, then alarm
// types, then the discipline of the first type. Each incident lands in exactly one category.
const ALARM_TYPES = new Set([
  'NOEMERG||FALSE_ALARM||ACCIDENTAL_ALARM',
  'NOEMERG||FALSE_ALARM||BOMB_SCARE',
  'NOEMERG||FALSE_ALARM||INTENTIONAL_FALSE_ALARM',
  'NOEMERG||FALSE_ALARM||MALFUNCTIONING_ALARM',
  'NOEMERG||FALSE_ALARM||OTHER_FALSE_CALL',
  'PUBSERV||ALARMS_NONMED||CO_ALARM',
  'PUBSERV||ALARMS_NONMED||FIRE_ALARM',
  'PUBSERV||ALARMS_NONMED||GAS_ALARM',
  'PUBSERV||ALARMS_NONMED||OTHER_ALARM',
]);
const DISCIPLINES = {
  FIRE: 'fire', MEDICAL: 'ems', RESCUE: 'rescue', HAZSIT: 'hazsit',
  PUBSERV: 'pubserv', NOEMERG: 'noemerg', LAWENFORCE: 'lawenforce',
};
const CATEGORY_KEYS = ['fire', 'ems', 'rescue', 'hazsit', 'pubserv', 'alarm', 'noemerg', 'lawenforce', 'other', 'multi_discipline'];

// Indicators may overlap and are not meant to add up. An incident counts once per
// indicator however many of its types match.
const INDICATORS = {
  structureFire: t => t.startsWith('FIRE||STRUCTURE_FIRE'),
  vehicleFire:   t => t.startsWith('FIRE||TRANSPORTATION_FIRE'),
  outdoorFire:   t => t.startsWith('FIRE||OUTSIDE_FIRE'),
  vehicleCrash:  t => t.includes('MOTOR_VEHICLE_COLLISION') || t.includes('MOTOR_VEHICLE_EXTRICATION'),
  electrical:    t => t.startsWith('HAZSIT||HAZARD_NONCHEM||ELEC_'),
  hazmat:        t => t.startsWith('HAZSIT||HAZARDOUS_MATERIALS'),
};

function typesOf(record) {
  return [record.type_1, record.type_2, record.type_3].filter(Boolean);
}

export function classify(types) {
  if (!types.length) return 'other';
  const disciplines = new Set(types.map(t => t.split('||')[0]));
  if (disciplines.size > 1) return 'multi_discipline';
  if (types.some(t => ALARM_TYPES.has(t))) return 'alarm';
  return DISCIPLINES[types[0].split('||')[0]] || 'other';
}

function emptyMonth() {
  return {
    total: 0,
    fire: 0,
    aidGiven: 0,
    aidReceived: 0,
    categories: Object.fromEntries(CATEGORY_KEYS.map(k => [k, 0])),
    indicators: Object.fromEntries(Object.keys(INDICATORS).map(k => [k, 0])),
  };
}

// call_create holds the local wall-clock time labelled as UTC (calls bottom out at 01:00–04:00
// "UTC"), so the UTC date is the local date and matches the Explorer's date range.
function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthsBetween(earlier, later) {
  const [ey, em] = earlier.split('-').map(Number);
  const [ly, lm] = later.split('-').map(Number);
  return (ly - ey) * 12 + (lm - em);
}

// Throws rather than publishing numbers that can't be trusted
export function validate(records, expectedCount) {
  if (!records.length) throw new Error('NERIS returned no incidents for this department');
  if (records.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} incidents, received ${records.length}`);
  }
  const ids = new Set();
  for (const r of records) {
    if (r.neris_id_dept !== NERIS_ID) throw new Error(`Record for another department: ${r.neris_id_dept}`);
    if (!r.neris_id_incident) throw new Error('Record without an incident ID');
    if (typeof r.call_create !== 'number') throw new Error('Record without a call date');
    if (ids.has(r.neris_id_incident)) throw new Error(`Duplicate incident: ${r.neris_id_incident}`);
    ids.add(r.neris_id_incident);
  }
}

export function aggregate(records) {
  const months = {};
  for (const r of records) {
    const key = isoDay(r.call_create).slice(0, 7);
    const m = months[key] || (months[key] = emptyMonth());
    const types = typesOf(r);
    m.total++;
    m.categories[classify(types)]++;
    if (types.some(t => t.startsWith('FIRE||'))) m.fire++;
    if (r.aid_direction === 'GIVEN') m.aidGiven++;
    if (r.aid_direction === 'RECEIVED') m.aidReceived++;
    for (const [name, matches] of Object.entries(INDICATORS)) {
      if (types.some(matches)) m.indicators[name]++;
    }
  }
  return months;
}

// Layers this run's months over what was published before. NERIS drops old incidents
// from the feed, so months that have rolled off (and an oldest month that has partly
// rolled off) keep their last published counts, marked archived.
export function merge(fresh, previous, now) {
  const today = isoDay(now.getTime()).slice(0, 7);
  const oldest = Object.keys(fresh).sort()[0];
  const merged = {};
  for (const [key, month] of Object.entries(previous)) {
    if (key < oldest) merged[key] = { ...month, archived: true };
  }
  for (const [key, month] of Object.entries(fresh)) {
    const prior = previous[key];
    const rollingOff = key === oldest && prior && prior.total > month.total &&
      monthsBetween(key, today) >= ROLL_OFF_AGE_MONTHS;
    merged[key] = rollingOff ? { ...prior, archived: true } : month;
  }
  return merged;
}

export function build(records, previous, now, sourceUpdated) {
  const days = records.map(r => isoDay(r.call_create)).sort();
  const months = merge(aggregate(records), previous?.months || {}, now);

  const previousTotal = Object.values(previous?.months || {}).reduce((sum, m) => sum + m.total, 0);
  const total = Object.values(months).reduce((sum, m) => sum + m.total, 0);
  if (previousTotal && total < previousTotal * (1 - MAX_UNEXPLAINED_DROP)) {
    throw new Error(`Published incidents fell from ${previousTotal} to ${total}; keeping the last good data`);
  }

  // A month is complete once all of it is older than the publication delay
  const cutoff = isoDay(now.getTime() - PUBLICATION_LAG_DAYS * 86400000);
  for (const key of Object.keys(months)) {
    const [y, m] = key.split('-').map(Number);
    months[key].complete = isoDay(Date.UTC(y, m, 0)) < cutoff;
  }

  const ordered = Object.fromEntries(Object.entries(months).sort(([a], [b]) => a.localeCompare(b)));
  return {
    schema: 1,
    department: {
      nerisId: NERIS_ID,
      nerisName: records[0].department_name,
    },
    source: {
      name: 'NERIS Public: Incident Basics',
      service: SERVICE,
      explorer: EXPLORER,
      updated: sourceUpdated ? new Date(sourceUpdated).toISOString() : null,
    },
    refreshedAt: now.toISOString(),
    coverage: {
      firstIncident: previous?.coverage?.firstIncident && previous.coverage.firstIncident < days[0]
        ? previous.coverage.firstIncident : days[0],
      latestIncident: days[days.length - 1],
    },
    months: ordered,
  };
}

async function query(params) {
  const url = `${SERVICE}/query?` + new URLSearchParams({
    where: `neris_id_dept='${NERIS_ID}'`,
    f: 'json',
    ...params,
  });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 15000 * attempt));
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'OtsegoCountyFireAuthority/1.0 (otsegocountyfiremi.gov)' },
        signal: AbortSignal.timeout(60000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const body = await resp.json();
      // ArcGIS reports most errors as HTTP 200 with an error object
      if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
      return body;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function fetchIncidents() {
  const { count } = await query({ returnCountOnly: 'true' });
  const records = [];
  for (;;) {
    const page = await query({
      outFields: OUT_FIELDS,
      returnGeometry: 'false',
      orderByFields: 'ObjectId',
      resultOffset: String(records.length),
      resultRecordCount: '1000',
    });
    records.push(...page.features.map(f => f.attributes));
    if (!page.exceededTransferLimit || !page.features.length) break;
  }
  return { records, count };
}

async function main() {
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(OUTPUT, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const { records, count } = await fetchIncidents();
  validate(records, count);
  const sourceUpdated = records.reduce((latest, r) => Math.max(latest, r.export_date || 0), 0) || null;
  const data = build(records, previous, new Date(), sourceUpdated);

  writeFileSync(OUTPUT + '.tmp', JSON.stringify(data, null, 2) + '\n');
  renameSync(OUTPUT + '.tmp', OUTPUT);
  console.log(`${count} incidents, ${data.coverage.firstIncident} to ${data.coverage.latestIncident}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`Incident statistics not updated: ${err.message}`);
    process.exit(1);
  });
}
