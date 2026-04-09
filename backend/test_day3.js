'use strict';

/**
 * backend/test_day3.js
 *
 * Day 3 — Rule Validator Integration Test
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests the multi-standard rule validator against a realistic DWG payload.
 * Validates that:
 *   ✓ All 6 KB YAML files are loaded (rulesLoader)
 *   ✓ Each standard's rules fire on relevant entities
 *   ✓ Structured violation objects are returned with all required fields
 *   ✓ Rule check completes in < 100ms per entity (performance target)
 *
 * Run: node test_day3.js
 */

const { rules, getAllRules, getRuleById, getMaterialCodeSet } = require('./rules/rulesLoader');
const { checkEntity, checkDrawing, checkDrawingWithTiming } = require('./rules/ruleValidator');

// ── Helpers ────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, testName, detail = '') {
  if (condition) {
    console.log(`  ✓ PASS  ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL  ${testName}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(70));
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Rules Loader Verification
// ═════════════════════════════════════════════════════════════════════════════
section('1. Rules Loader — KB Integrity Check');

const requiredKeys = ['asme', 'iso', 'varroc', 'customerSpecs', 'dfmDfa', 'materials'];
assert(
  JSON.stringify(Object.keys(rules)) === JSON.stringify(requiredKeys),
  'All 6 standard keys present',
  `Got: ${JSON.stringify(Object.keys(rules))}`
);

for (const key of requiredKeys) {
  const ruleSet = rules[key];
  assert(Array.isArray(ruleSet.rules) && ruleSet.rules.length > 0,
    `${key}: has rules array (${ruleSet.rules.length} rules)`);
}

assert(getAllRules().length >= 60, `Total rule count ≥ 60 (got ${getAllRules().length})`);

const dfm001 = getRuleById('DFM-001');
assert(dfm001 !== null, 'getRuleById("DFM-001") finds a rule');
assert(dfm001?.defaultSeverity === 'Critical', 'DFM-001 is Critical severity');

const matCodes = getMaterialCodeSet();
assert(matCodes.has('AA6061-T6'), 'Material code set includes AA6061-T6');
assert(matCodes.has('EN-GJL-250'), 'Material code set includes EN-GJL-250');
assert(matCodes.has('PP-GF30'), 'Material code set includes PP-GF30');
assert(!matCodes.has('FAKE-MATERIAL'), 'Material code set rejects non-approved code');

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Real DWG Payload (16 entities covering all 6 standards)
// ═════════════════════════════════════════════════════════════════════════════
section('2. Rule Validator — Real DWG Payload Entities');

// ── Entity 1: ASME — flatness violation (0.12mm > 0.05mm limit) ────────────
const e_flatness = {
  entityType: 'TOLERANCE', layer: 'GDT',
  gdtSymbol: 'flatness', measuredValue: 0.12,
  parameterName: 'Sealing face flatness',
};

// ── Entity 2: ASME — valid GD&T symbol (no violation) ─────────────────────
const e_validGdt = {
  entityType: 'TOLERANCE', layer: 'GDT',
  gdtSymbol: 'circularity', measuredValue: 0.02,
  parameterName: 'Bore circularity',
};

// ── Entity 3: ASME — invalid GD&T symbol ──────────────────────────────────
const e_badSymbol = {
  entityType: 'TOLERANCE', layer: 'GDT',
  gdtSymbol: 'concentricity_zone',   // not in ASME Y14.5
  parameterName: 'Pivot bore',
};

// ── Entity 4: ASME — true position violation (0.08mm > 0.05mm limit) ───────
const e_position = {
  entityType: 'TOLERANCE', layer: 'GDT',
  gdtSymbol: 'true_position', measuredValue: 0.08,
  parameterName: 'Mounting hole position',
};

// ── Entity 5: ISO 2768 — linear dimension out of medium class (m) ──────────
// Nominal 80mm, measured 80.45mm — deviation 0.45mm > ±0.30mm limit for 30–120mm
const e_isoLinear = {
  entityType: 'DIMENSION', layer: 'DIMS',
  toleranceClass: 'm', nominalValue: 80.0, measuredValue: 80.45,
  parameterName: 'Housing width',
};

// ── Entity 6: ISO 2768 — DXF import scale error ────────────────────────────
const e_scale = {
  entityType: 'DIMENSION', layer: 'DIMS',
  drawingScale: 0.9969,
  parameterName: 'Drawing scale',
};

// ── Entity 7: Varroc — dimension on wrong layer (OBJECT instead of DIMS) ───
const e_wrongLayer = {
  entityType: 'DIMENSION', layer: 'OBJECT',
  parameterName: 'Hole spacing',
};

// ── Entity 8: Varroc — title block part number in wrong format ─────────────
const e_badPartNo = {
  entityType: 'MTEXT', layer: 'TITLEBLOCK',
  fieldName: 'part_number', textContent: '12345',
};

// ── Entity 9: Varroc — missing revision ────────────────────────────────────
const e_noRevision = {
  entityType: 'MTEXT', layer: 'TITLEBLOCK',
  fieldName: 'revision', textContent: '',
};

// ── Entity 10: Varroc — text too small (1.8mm < 2.5mm minimum) ─────────────
const e_smallText = {
  entityType: 'DIMENSION', layer: 'DIMS',
  textHeight: 1.8,
  parameterName: 'Dimension text',
};

// ── Entity 11: DFM — wall thickness too thin (1.1mm < 1.5mm) ──────────────
const e_thinWall = {
  entityType: 'DIMENSION', layer: 'DIMS',
  wallThickness: 1.1,
  parameterName: 'Housing wall thickness',
};

// ── Entity 12: DFM — draft angle too shallow (0.8° < 1.5°) ───────────────
const e_draft = {
  entityType: 'LINE', layer: 'DIMS',
  draftAngle: 0.8,
  parameterName: 'Side wall draft angle',
};

// ── Entity 13: DFM — hole too close to edge (4mm at ⌀3mm = 1.33× < 2×) ───
const e_holeEdge = {
  entityType: 'CIRCLE', layer: 'DIMS',
  holeDiameter: 3.0, holeToEdgeDist: 4.0,
  parameterName: 'Mounting hole to edge',
};

// ── Entity 14: DFA — assembly clearance too tight (0.1mm < 0.3mm) ─────────
const e_clearance = {
  entityType: 'TOLERANCE', layer: 'DIMS',
  assemblyClearance: 0.1,
  parameterName: 'Lens-to-housing clearance',
};

// ── Entity 15: Materials — non-approved material code ─────────────────────
const e_badMat = {
  entityType: 'MTEXT', layer: 'NOTES',
  materialCode: 'A380-CUSTOM',
  textContent: 'MATERIAL: A380-CUSTOM TO ASTM B85',
};

// ── Entity 16: Materials — galvanic incompatibility ────────────────────────
const e_galvanic = {
  entityType: 'MTEXT', layer: 'NOTES',
  materialCode: 'AA6061-T6',
  matingMaterialCode: 'S355JR',
  hasBarrierCoating: false,
  hasInsulatingGasket: false,
  textContent: 'MATERIAL: AA6061-T6 TO EN 573-3',
};

const testEntities = [
  e_flatness, e_validGdt, e_badSymbol, e_position,
  e_isoLinear, e_scale,
  e_wrongLayer, e_badPartNo, e_noRevision, e_smallText,
  e_thinWall, e_draft, e_holeEdge, e_clearance,
  e_badMat, e_galvanic,
];

// ── Run validator with timing ─────────────────────────────────────────────────
const { violations, timingMs } = checkDrawingWithTiming(testEntities);

console.log(`\n  Entities checked : ${timingMs.entityCount}`);
console.log(`  Violations found : ${timingMs.violationCount}`);
console.log(`  Avg time/entity  : ${timingMs.perEntityAvg}ms`);
console.log(`  Max time/entity  : ${timingMs.perEntityMax}ms`);
console.log(`  Total time       : ${timingMs.total}ms`);
console.log(`  < 100ms target   : ${timingMs.passedTarget ? '✓ PASS' : '✗ FAIL'}`);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Assertion: correct violations detected per entity
// ═════════════════════════════════════════════════════════════════════════════
section('3. Violation Correctness — Per-Entity Assertions');

// Helper: find violation for an entity by rule prefix
function hasViolation(entity, rulePrefix) {
  return violations.some(v => v._entity === entity && v.rule_id.startsWith(rulePrefix));
}
function getViolation(entity, rulePrefix) {
  return violations.find(v => v._entity === entity && v.rule_id.startsWith(rulePrefix));
}

// ASME checks
assert(hasViolation(e_flatness, 'ASME-GDT-004'), 'E1: ASME-GDT-004 fires for flatness 0.12mm > 0.05mm');
assert(!hasViolation(e_validGdt, 'ASME'), 'E2: No ASME violation for circularity 0.02mm (valid)');
assert(hasViolation(e_badSymbol, 'ASME-GDT-001'), 'E3: ASME-GDT-001 fires for invalid GD&T symbol');
assert(hasViolation(e_position, 'ASME-GDT-007'), 'E4: ASME-GDT-007 fires for true position 0.08mm > 0.05mm');

// ISO checks
assert(hasViolation(e_isoLinear, 'ISO-2768'), 'E5: ISO-2768 fires for dimension deviation 0.45mm > ±0.30mm');
assert(hasViolation(e_scale, 'ISO-2768-010'), 'E6: ISO-2768-010 fires for DXF scale error 0.9969≠1.0');

// Varroc checks
assert(hasViolation(e_wrongLayer, 'VAR-LAYER-001'), 'E7: VAR-LAYER-001 fires for DIMENSION on OBJECT layer');
assert(hasViolation(e_badPartNo, 'VAR-TITLE-001'), 'E8: VAR-TITLE-001 fires for bad part number format');
assert(hasViolation(e_noRevision, 'VAR-TITLE-002'), 'E9: VAR-TITLE-002 fires for empty revision field');
assert(hasViolation(e_smallText, 'VAR-TEXT-001'), 'E10: VAR-TEXT-001 fires for text height 1.8mm < 2.5mm');

// DFM/DFA checks
assert(hasViolation(e_thinWall, 'DFM-001'), 'E11: DFM-001 fires for wall thickness 1.1mm < 1.5mm');
assert(hasViolation(e_draft, 'DFM-003'), 'E12: DFM-003 fires for draft angle 0.8° < 1.5°');
assert(hasViolation(e_holeEdge, 'DFM-004'), 'E13: DFM-004 fires for hole-to-edge 4mm < 2×3=6mm');
assert(hasViolation(e_clearance, 'DFA-003'), 'E14: DFA-003 fires for assembly clearance 0.1mm < 0.3mm');

// Materials checks
assert(hasViolation(e_badMat, 'MAT-CODE-001'), 'E15: MAT-CODE-001 fires for non-approved material code');
assert(hasViolation(e_galvanic, 'MAT-COMPAT-001'), 'E16: MAT-COMPAT-001 fires for Al+Steel without gasket/coating');

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Structured Violation Object Schema Validation
// ═════════════════════════════════════════════════════════════════════════════
section('4. Violation Object Schema — Required Fields Check');

const REQUIRED_FIELDS = [
  'rule_id', 'ruleName', 'standard', 'standardCitation',
  'defaultSeverity', 'violation_description', 'howToFix',
  'entity_type', 'layer', 'parameterName',
];

let allHaveRequiredFields = true;
for (const v of violations) {
  for (const field of REQUIRED_FIELDS) {
    if (!v[field] && v[field] !== 0) {
      console.error(`  ✗ Violation ${v.rule_id} missing field: ${field}`);
      allHaveRequiredFields = false;
      failed++;
    }
  }
}
if (allHaveRequiredFields) {
  assert(true, `All ${violations.length} violations have the 10 required fields`);
}

// Severity values are valid
const validSeverities = new Set(['Critical', 'Major', 'Minor']);
const allValidSev = violations.every(v => validSeverities.has(v.defaultSeverity));
assert(allValidSev, 'All violations have valid defaultSeverity (Critical/Major/Minor)');

// Violation descriptions are non-trivial (>20 chars)
const allDescribed = violations.every(v => (v.violation_description || '').length > 20);
assert(allDescribed, 'All violations have meaningful descriptions (>20 chars)');

// howToFix is non-empty
const allFixes = violations.every(v => (v.howToFix || '').length > 10);
assert(allFixes, 'All violations have howToFix guidance (>10 chars)');

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Performance Test (100 entities, target < 100ms each)
// ═════════════════════════════════════════════════════════════════════════════
section('5. Performance Test — 100 Entity Batch (target < 100ms/entity)');

// Generate a diverse set of 100 entities
const PERF_ENTITIES = [];
for (let i = 0; i < 100; i++) {
  PERF_ENTITIES.push({
    entityType: ['DIMENSION','TOLERANCE','CIRCLE','LINE','MTEXT'][i % 5],
    layer: ['DIMS','GDT','DIMS','DIMS','TITLEBLOCK'][i % 5],
    gdtSymbol: ['flatness','true_position','circularity','perpendicularity','cylindricity'][i % 5],
    measuredValue: 0.01 + (i % 10) * 0.03,    // some will violate, some won't
    nominalValue: 50.0 + (i % 20),
    toleranceClass: ['f','m','m','c','m'][i % 5],
    wallThickness: 1.0 + (i % 8) * 0.2,
    draftAngle: 0.5 + (i % 6) * 0.5,
    holeDiameter: 2.0 + (i % 5),
    holeToEdgeDist: 3.0 + (i % 8),
    textHeight: 1.5 + (i % 8) * 0.4,
    fieldName: ['part_number','revision','material','engineer_name','approval_signature'][i % 5],
    textContent: i % 3 === 0 ? '' : 'VAR-12345-01',
    materialCode: ['AA6061-T6','PP-GF30','S355JR','EN-GJL-250','FAKE-CODE'][i % 5],
    parameterName: `param_${i}`,
  });
}

const perf = checkDrawingWithTiming(PERF_ENTITIES);
console.log(`\n  Entities in batch : ${perf.timingMs.entityCount}`);
console.log(`  Violations found  : ${perf.timingMs.violationCount}`);
console.log(`  Avg per entity    : ${perf.timingMs.perEntityAvg}ms`);
console.log(`  Max per entity    : ${perf.timingMs.perEntityMax}ms`);
console.log(`  Total batch time  : ${perf.timingMs.total}ms`);

assert(perf.timingMs.perEntityMax < 100, `Max per-entity time ${perf.timingMs.perEntityMax}ms < 100ms target`);
assert(perf.timingMs.perEntityAvg < 10,  `Avg per-entity time ${perf.timingMs.perEntityAvg}ms < 10ms (excellent)`);

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Sample Violation Dump (first 5, for inspection)
// ═════════════════════════════════════════════════════════════════════════════
section('6. Sample Violations (first 5) — Structured Object Output');

violations.slice(0, 5).forEach((v, i) => {
  const { _entity, ...clean } = v;
  console.log(`\n  [Violation ${i + 1}]`);
  console.log(`    rule_id             : ${clean.rule_id}`);
  console.log(`    ruleName            : ${clean.ruleName}`);
  console.log(`    standard            : ${clean.standard}`);
  console.log(`    defaultSeverity     : ${clean.defaultSeverity}`);
  console.log(`    violation_description: ${clean.violation_description.trim().slice(0, 80)}...`);
  console.log(`    howToFix            : ${clean.howToFix.trim().slice(0, 60)}...`);
});

// ═════════════════════════════════════════════════════════════════════════════
// FINAL SUMMARY
// ═════════════════════════════════════════════════════════════════════════════
section('Test Summary');
console.log(`\n  Tests PASSED: ${passed}`);
console.log(`  Tests FAILED: ${failed}`);
console.log(`  Total       : ${passed + failed}`);

if (failed === 0) {
  console.log('\n  ✅  ALL TESTS PASSED — Day 3 Rule Validator is production-ready!\n');
} else {
  console.log(`\n  ❌  ${failed} test(s) failed — review output above.\n`);
  process.exitCode = 1;
}
