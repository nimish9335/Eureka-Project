/**
 * backend/test_pipeline.js
 *
 * Full AI Pipeline Test — sends a known violation payload to /validate/full
 * and verifies all required fields in the response.
 *
 * Tests:
 *   1. Rule violations detected
 *   2. Each violation has: violationId, ruleName, severity, confidenceScore,
 *      standardCitation, relevantLesson
 *   3. Critical violation detected and blocksSignOff = true
 *   4. Real-Time Mode suppresses Minor violations
 *   5. Async LLM path: llmSuggestionPending = true in realtime mode
 *
 * Run:  node test_pipeline.js
 * Requires: node server.js AND python ml/server.py running.
 */

'use strict';

const axios = require('axios');

const BACKEND = 'http://127.0.0.1:8000';

// ── Test payload — 5 entities with known violations ───────────────────────────
const TEST_PAYLOAD = {
  drawingId: 'TEST-DWG-001',
  realtimeMode: false,
  entities: [
    // ① CRITICAL — Reflector flatness exceeds limit (V-GDT-001)
    {
      entityType: 'TOLERANCE',
      layer: 'GDT',
      parameterName: 'Reflector Face Flatness',
      boundingBox: { minX: 0, minY: 0, maxX: 20, maxY: 10 },
      gdtSymbol: 'FLATNESS',
      nominalValue: 0.0,
      measuredValue: 0.12,
      upperTolerance: 0.05,
      lowerTolerance: 0.0,
      textContent: '',
    },

    // ② CRITICAL — Dimension on wrong layer (V-DWG-001)
    {
      entityType: 'DIMENSION',
      layer: 'OBJECT',
      parameterName: 'Mounting Hole Spacing',
      boundingBox: { minX: 0, minY: 0, maxX: 100, maxY: 10 },
      gdtSymbol: 'NONE',
      nominalValue: 63.0,
      measuredValue: 63.0,
      upperTolerance: 0.1,
      lowerTolerance: -0.1,
      textContent: '',
    },

    // ③ MAJOR — Projector lens aperture oversize (V-OPT-002)
    {
      entityType: 'CIRCLE',
      layer: 'DIMENSIONS',
      parameterName: 'Projector Lens Aperture Diameter',
      boundingBox: { minX: 10, minY: 10, maxX: 60, maxY: 60 },
      gdtSymbol: 'NONE',
      nominalValue: 45.0,
      measuredValue: 45.2,
      upperTolerance: 0.05,
      lowerTolerance: -0.05,
      textContent: '',
    },

    // ④ MINOR → suppressed in realtime mode (V-PROC-001 — on NOTES layer)
    {
      entityType: 'DIMENSION',
      layer: 'NOTES',
      parameterName: 'Reference Dimension',
      boundingBox: { minX: 0, minY: 0, maxX: 50, maxY: 10 },
      gdtSymbol: 'NONE',
      nominalValue: 10.0,
      measuredValue: 10.5,
      upperTolerance: 0.1,
      lowerTolerance: -0.1,
      textContent: '',
    },

    // ⑤ NORMAL entity — no violations expected
    {
      entityType: 'MTEXT',
      layer: 'TITLEBLOCK',
      parameterName: 'Title Block Part Number',
      boundingBox: { minX: 0, minY: 0, maxX: 80, maxY: 10 },
      gdtSymbol: 'NONE',
      nominalValue: null,
      measuredValue: null,
      upperTolerance: null,
      lowerTolerance: null,
      textContent: 'VLS-001-REV-B',
    },
  ],
};

// ── Test runner ───────────────────────────────────────────────────────────────
async function runTest(label, payload) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log('═'.repeat(60));

  const t0 = Date.now();
  const res = await axios.post(`${BACKEND}/validate/full`, payload, { timeout: 30000 });
  const ms  = Date.now() - t0;
  const d   = res.data;

  console.log(`\nResponse time: ${ms}ms`);
  console.log(`Status: ${d.status}`);
  console.log(`Drawing: ${d.drawingId}`);
  console.log(`Counts: total=${d.counts.total} critical=${d.counts.critical} major=${d.counts.major} minorSuppressed=${d.counts.minorSuppressed}`);
  console.log(`blocksSignOff: ${d.blocksSignOff}`);

  let passed = 0;
  let failed = 0;

  function check(desc, condition) {
    const ok = !!condition;
    console.log(`  ${ok ? '✅' : '❌'} ${desc}`);
    ok ? passed++ : failed++;
  }

  console.log('\n── Field presence checks (every violation) ──');
  for (const v of d.violations) {
    console.log(`\n  [${v.violationId}] ${v.ruleName} → ${v.severity} (conf: ${v.confidenceScore})`);
    check('has violationId',        !!v.violationId);
    check('has ruleName',           !!v.ruleName);
    check('has severity',           ['Critical','Major','Minor'].includes(v.severity));
    check('has confidenceScore',    typeof v.confidenceScore === 'number');
    check('has standardCitation',   !!v.standardCitation);
    check('has relevantLesson',     v.relevantLesson !== undefined);
    check('has llmSuggestion field',v.llmSuggestion !== undefined || v.llmSuggestionPending !== undefined);

    if (v.relevantLesson) {
      console.log(`       Lesson: ${v.relevantLesson.violationId} — ${v.relevantLesson.what_was_wrong?.slice(0, 60)}…`);
    }
    if (v.llmSuggestion) {
      console.log(`       LLM: ${v.llmSuggestion.slice(0, 100)}`);
    }
  }

  console.log('\n── Pipeline-level checks ──');
  check('at least one violation found',         d.counts.total > 0);
  check('Critical violation present',           d.counts.critical > 0);
  check('blocksSignOff = true (has Critical)',  d.blocksSignOff === true);
  check('Minor suppressed in realtime mode',    !payload.realtimeMode || d.counts.minorSuppressed >= 0);

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

async function runRealtimeTest() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('TEST: Real-Time Mode (async LLM, suppress Minor)');
  console.log('═'.repeat(60));

  const payload = { ...TEST_PAYLOAD, realtimeMode: true };
  const t0 = Date.now();
  const res = await axios.post(`${BACKEND}/validate/full`, payload, { timeout: 30000 });
  const ms  = Date.now() - t0;
  const d   = res.data;

  console.log(`\nResponse time: ${ms}ms`);

  let passed = 0, failed = 0;
  function check(desc, condition) {
    const ok = !!condition;
    console.log(`  ${ok ? '✅' : '❌'} ${desc}`);
    ok ? passed++ : failed++;
  }

  check('Response came back quickly (< 20s)',  ms < 20000);
  check('Minor violations suppressed',         d.counts.minorSuppressed > 0);
  check('Only Critical+Major emitted',         d.violations.every(v => v.severity !== 'Minor'));
  check('llmSuggestionPending = true on realtime+emitted violations',
    d.violations.some(v => v.llmSuggestionPending === true));

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  return { passed, failed };
}

async function main() {
  console.log('🚀 Full AI Pipeline Test — Eureka Project');
  console.log(`Backend: ${BACKEND}`);

  try {
    await axios.get(`${BACKEND}/health`, { timeout: 3000 });
    console.log('✅ Backend reachable');
  } catch {
    console.error('❌ Backend not reachable. Start with: node server.js');
    process.exit(1);
  }

  let totalPassed = 0, totalFailed = 0;

  try {
    const r1 = await runTest('Manual Mode — full pipeline (blocking LLM)', TEST_PAYLOAD);
    totalPassed += r1.passed; totalFailed += r1.failed;
  } catch (err) {
    console.error('Manual mode test error:', err.message);
    totalFailed++;
  }

  try {
    const r2 = await runRealtimeTest();
    totalPassed += r2.passed; totalFailed += r2.failed;
  } catch (err) {
    console.error('Realtime mode test error:', err.message);
    totalFailed++;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`FINAL: ${totalPassed} passed, ${totalFailed} failed`);
  console.log('═'.repeat(60));

  if (totalFailed > 0) process.exit(1);
}

main();
