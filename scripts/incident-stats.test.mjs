// Run with: node --test scripts/incident-stats.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregate, build, classify, merge, validate, NERIS_ID } from './incident-stats.mjs';

let serial = 0;
function incident(date, type_1, extra = {}) {
  return {
    neris_id_incident: `${NERIS_ID}|${++serial}`,
    neris_id_dept: NERIS_ID,
    department_name: 'Test',
    type_1,
    type_2: null,
    type_3: null,
    aid_direction: 'NEITHER',
    call_create: Date.parse(date + 'T12:00:00Z'),
    ...extra,
  };
}
const FIRE = 'FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE';
const POWER = 'HAZSIT||HAZARD_NONCHEM||ELEC_POWER_LINE_DOWN_ARCHING_MALFUNC';

test('classify follows the Explorer: multi-discipline, then alarm, then first type', () => {
  assert.equal(classify([FIRE]), 'fire');
  assert.equal(classify(['MEDICAL||INJURY||MOTOR_VEHICLE_COLLISION']), 'ems');
  assert.equal(classify(['NOEMERG||FALSE_ALARM||MALFUNCTIONING_ALARM']), 'alarm');
  assert.equal(classify(['PUBSERV||ALARMS_NONMED||CO_ALARM']), 'alarm');
  assert.equal(classify(['PUBSERV||OTHER||STANDBY']), 'pubserv');
  assert.equal(classify(['NOEMERG||CANCELLED']), 'noemerg');
  assert.equal(classify(['LAWENFORCE']), 'lawenforce');
  assert.equal(classify([POWER, FIRE]), 'multi_discipline');
  assert.equal(classify([]), 'other');
  assert.equal(classify(['SOMETHING_NEW||X']), 'other');
});

test('a multi-type incident counts once in total, categories and each indicator', () => {
  const m = aggregate([
    incident('2026-03-10', 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE', { type_2: FIRE }),
    incident('2026-03-11', POWER, { type_2: 'FIRE||OUTSIDE_FIRE||VEGETATION_GRASS_FIRE' }),
  ])['2026-03'];
  assert.equal(m.total, 2);
  assert.equal(m.fire, 2);
  assert.equal(m.categories.fire, 1);
  assert.equal(m.categories.multi_discipline, 1);
  assert.equal(m.indicators.structureFire, 1);
  assert.equal(m.indicators.outdoorFire, 1);
  assert.equal(m.indicators.electrical, 1);
  assert.equal(Object.values(m.categories).reduce((a, b) => a + b), m.total);
});

test('aid direction is counted', () => {
  const m = aggregate([
    incident('2026-03-10', FIRE, { aid_direction: 'GIVEN' }),
    incident('2026-03-10', FIRE, { aid_direction: 'RECEIVED' }),
    incident('2026-03-10', FIRE),
  ])['2026-03'];
  assert.deepEqual([m.aidGiven, m.aidReceived], [1, 1]);
});

test('validate rejects bad feeds', () => {
  const good = incident('2026-03-10', FIRE);
  assert.doesNotThrow(() => validate([good], 1));
  assert.throws(() => validate([], 0), /no incidents/);
  assert.throws(() => validate([good], 2), /Expected 2/);
  assert.throws(() => validate([good, good], 2), /Duplicate/);
  assert.throws(() => validate([{ ...good, neris_id_dept: 'FD00000000' }], 1), /another department/);
  assert.throws(() => validate([{ ...good, call_create: null }], 1), /call date/);
});

test('months that rolled off the feed are kept and marked archived', () => {
  const now = new Date('2027-06-01T00:00:00Z');
  const merged = merge({ '2026-03': { total: 40 } }, { '2025-12': { total: 44 }, '2026-03': { total: 40 } }, now);
  assert.deepEqual(merged['2025-12'], { total: 44, archived: true });
  assert.deepEqual(merged['2026-03'], { total: 40 });
});

test('a partly rolled-off oldest month keeps its published count', () => {
  const now = new Date('2027-06-01T00:00:00Z');
  const merged = merge({ '2026-03': { total: 12 } }, { '2026-03': { total: 40 } }, now);
  assert.deepEqual(merged['2026-03'], { total: 40, archived: true });
});

test('a recent correction to the oldest month is accepted', () => {
  const now = new Date('2026-11-02T00:00:00Z');
  const merged = merge({ '2025-12': { total: 43 } }, { '2025-12': { total: 44 } }, now);
  assert.deepEqual(merged['2025-12'], { total: 43 });
});

test('months are complete only once past the publication delay', () => {
  const now = new Date('2026-11-02T00:00:00Z'); // cutoff 2026-09-03
  const data = build([incident('2026-08-31', FIRE), incident('2026-09-01', FIRE)], null, now, null);
  assert.equal(data.months['2026-08'].complete, true);
  assert.equal(data.months['2026-09'].complete, false);
  assert.equal(data.coverage.latestIncident, '2026-09-01');
});

test('an unexplained large drop keeps the last good data', () => {
  const now = new Date('2026-11-02T00:00:00Z');
  const previous = { months: { '2026-03': { total: 100 } } };
  assert.throws(() => build([incident('2026-03-10', FIRE)], previous, now, null), /fell from 100 to 1/);
});

test('the published file holds aggregates only', () => {
  const data = JSON.parse(readFileSync(new URL('../data/incident-stats.json', import.meta.url), 'utf8'));
  const text = JSON.stringify(data);
  for (const banned of ['civic_location', 'neris_id_incident', 'type_1', '"x"', '"y"', 'narrative', 'displacement']) {
    assert.ok(!text.includes(banned), `found ${banned}`);
  }
  const allowed = new Set(['total', 'fire', 'aidGiven', 'aidReceived', 'categories', 'indicators', 'complete', 'archived']);
  for (const month of Object.values(data.months)) {
    for (const key of Object.keys(month)) assert.ok(allowed.has(key), `unexpected field ${key}`);
    assert.equal(Object.values(month.categories).reduce((a, b) => a + b), month.total);
  }
});

test('NFIRS history matches the totals printed on the BFS reports', () => {
  const { years } = JSON.parse(readFileSync(new URL('../data/nfirs-annual.json', import.meta.url), 'utf8'));
  const printed = { 2016: [253, 15], 2018: [376, 26], 2019: [334, 19], 2020: [281, 13], 2021: [207, 10], 2023: [324, 13], 2024: [379, 23], 2025: [486, 29] };
  const sum = list => list.reduce((a, b) => a + b, 0);
  assert.deepEqual(Object.keys(years).filter(y => years[y]), Object.keys(printed));
  for (const [year, [total, aid]] of Object.entries(printed)) {
    const y = years[year];
    assert.equal(y.counts.length, 12);
    assert.equal(sum(y.counts), total, `${year} counts`);
    assert.equal(y.total, total, `${year} total`);
    assert.equal(sum(y.aidGiven), aid, `${year} aid given`);
    // Only months with nothing reported may be left out of comparisons
    for (const month of y.excludedMonths) assert.equal(y.counts[month - 1], 0, `${year}-${month}`);
  }
});

// Figures read from the official Explorer (FD26137918, all time) on 2026-11-02. Skipped once
// newer incidents are published: re-read the Explorer and update them to re-check by hand.
test('published file matches the official Explorer snapshot', t => {
  const data = JSON.parse(readFileSync(new URL('../data/incident-stats.json', import.meta.url), 'utf8'));
  if (data.coverage.latestIncident !== '2026-08-31') return t.skip('feed has moved past the snapshot');
  assert.equal(data.coverage.firstIncident, '2025-12-03');
  const months = Object.values(data.months);
  const sum = key => months.reduce((n, m) => n + m.categories[key], 0);
  assert.equal(months.reduce((n, m) => n + m.total, 0), 380);
  assert.deepEqual(
    ['fire', 'ems', 'rescue', 'hazsit', 'pubserv', 'alarm', 'noemerg', 'lawenforce', 'multi_discipline'].map(sum),
    [48, 2, 7, 127, 3, 93, 94, 1, 5],
  );
});
