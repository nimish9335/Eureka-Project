const express = require('express');
const cors = require('cors');
const zmq = require('zeromq');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');
const { scoreViolations, buildSeverityIndex } = require('./scoring/riskEngine');
const { checkDrawing } = require('./rules/ruleChecker');
require('dotenv').config();

const ML_URL = process.env.ML_URL || 'http://127.0.0.1:8001';

// ── Load standards severity index from YAML ───────────────────────────────────
let severityIndex = new Map();
try {
  const yamlPath = path.join(__dirname, '..', 'ml', 'data', 'standards_kb.yaml');
  const yamlData = yaml.load(fs.readFileSync(yamlPath, 'utf8'));
  severityIndex = buildSeverityIndex(yamlData);
  console.log(`[riskEngine] Loaded ${severityIndex.size} rule severities from standards_kb.yaml`);
} catch (err) {
  console.warn('[riskEngine] Could not load standards_kb.yaml:', err.message);
}

const app = express();
app.use(cors());
app.use(express.json());

// ZeroMQ PUSH socket - sends results back to AutoCAD plugin
let pushSock;
async function startPushSocket() {
  pushSock = new zmq.Push();
  await pushSock.bind('tcp://127.0.0.1:5556');
  console.log('ZeroMQ PUSH ready on port 5556');
}

// Start ZeroMQ listener (PULL from AutoCAD)
require('./zeromq-listener');

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ── POST /validate — main validation endpoint ─────────────────────────────────
app.post('/validate', (req, res) => {
  // TODO: forward entity to Python ML /anomaly and /lessons, then return results
  res.json({ status: 'ok', violations: [] });
});

// ── POST /score — risk score a list of violations ────────────────────────────
// Body: { violations: [...], realtimeMode: bool }
// Each violation needs: rule_id, layer, mlFlagged?, mlScore?
// Returns: { all, realtime, blockers, emitted }
app.post('/score', (req, res) => {
  const { violations = [], realtimeMode = false } = req.body;

  if (!Array.isArray(violations) || violations.length === 0) {
    return res.status(400).json({ error: 'violations array required' });
  }

  // Enrich each violation with defaultSeverity from the YAML index
  const enriched = violations.map(v => ({
    ...v,
    defaultSeverity: v.defaultSeverity ?? severityIndex.get(v.rule_id) ?? 'Major',
  }));

  const result = scoreViolations(enriched, realtimeMode);

  res.json({
    status: 'ok',
    counts: {
      total:    result.all.length,
      critical: result.blockers.length,
      major:    result.realtime.length - result.blockers.length,
      minor:    result.all.length - result.realtime.length,
    },
    blocksSignOff: result.blockers.length > 0,
    violations: result.emitted,
    blockers:   result.blockers,
  });
});

// ── POST /suggestion-ready — called by Python ML real-time suggestion engine ──
// Python pushes a late-arriving LLM suggestion here; we forward it to the
// AutoCAD plugin via ZeroMQ PUSH socket.
app.post('/suggestion-ready', async (req, res) => {
  const { violationId, suggestion, entity_type, layer } = req.body;

  if (!violationId || !suggestion) {
    return res.status(400).json({ error: 'violationId and suggestion are required' });
  }

  console.log(`[/suggestion-ready] Received suggestion for ${violationId}: "${suggestion}"`);

  const payload = JSON.stringify({
    type: 'SUGGESTION',
    violationId,
    suggestion,
    entity_type: entity_type || 'UNKNOWN',
    layer: layer || 'UNKNOWN',
    timestamp: new Date().toISOString(),
  });

  // Forward to AutoCAD plugin via ZeroMQ PUSH
  if (pushSock) {
    try {
      await pushSock.send(payload);
      console.log(`[ZeroMQ] Forwarded suggestion for ${violationId} to AutoCAD plugin.`);
    } catch (err) {
      console.error('[ZeroMQ] Failed to send suggestion:', err.message);
    }
  } else {
    console.warn('[ZeroMQ] Push socket not ready — suggestion not forwarded.');
  }

  res.json({ status: 'forwarded', violationId });
});

// ── POST /validate/full — Full AI Pipeline ────────────────────────────────
// Body: { drawingId, realtimeMode?, entities: [...] }
// Pipeline: Rule Check → ML Anomaly → Risk Score → Lessons → Async LLM Suggestion
// Returns enriched violations: { rule_id, ruleName, severity, confidenceScore,
//   standardCitation, relevantLesson, llmSuggestion (sync), _asyncSuggestion: pending }
app.post('/validate/full', async (req, res) => {
  const { drawingId = 'UNKNOWN', entities = [], realtimeMode = false } = req.body;

  if (!Array.isArray(entities) || entities.length === 0) {
    return res.status(400).json({ error: 'entities array required' });
  }

  console.log(`[/validate/full] drawingId=${drawingId} entities=${entities.length} realtime=${realtimeMode}`);

  // ──────────────────────────────────────────────────────────────────
  // STEP 1 — Deterministic Rule Check
  // ──────────────────────────────────────────────────────────────────
  const ruleViolations = checkDrawing(entities);
  console.log(`[Step 1] Rule violations found: ${ruleViolations.length}`);

  // ──────────────────────────────────────────────────────────────────
  // STEP 2 — ML Anomaly Detection (parallel calls for all entities)
  // ──────────────────────────────────────────────────────────────────
  const mlResults = await Promise.all(
    entities.map(async (entity, i) => {
      try {
        const r = await axios.post(`${ML_URL}/anomaly`, entity, { timeout: 5000 });
        return { index: i, ...r.data };
      } catch {
        return { index: i, anomaly: false, score: 0 };
      }
    })
  );

  // Build a map: entity index → ML result
  const mlMap = {};
  for (const m of mlResults) mlMap[m.index] = m;
  console.log(`[Step 2] ML anomalies: ${mlResults.filter(m => m.anomaly).length}/${entities.length}`);

  // ──────────────────────────────────────────────────────────────────
  // STEP 3 — Merge rule violations with ML flags + Risk Scoring
  // ──────────────────────────────────────────────────────────────────

  // Also add pure ML anomalies (entities flagged by ML but not by rules)
  const ruleEntityKeys = new Set(ruleViolations.map(v => `${v.entity_type}::${v.layer}`));
  const mlOnlyViolations = [];
  for (let i = 0; i < entities.length; i++) {
    const ml = mlMap[i];
    const e  = entities[i];
    const key = `${(e.entityType||'').toUpperCase()}::${(e.layer||'').toUpperCase()}`;
    if (ml.anomaly && !ruleEntityKeys.has(key)) {
      mlOnlyViolations.push({
        rule_id: 'ML-ANOMALY',
        ruleName: 'ML Anomaly Detector',
        category: 'ANOMALY',
        standardCitation: 'IsolationForest / ML',
        defaultSeverity: 'Major',
        violation_description: `ML anomaly detected on ${e.entityType} (layer: ${e.layer}). Score: ${ml.score}`,
        entity_type: e.entityType,
        layer: e.layer,
        parameterName: e.parameterName || e.entityType,
        _entity: e,
        mlFlagged: true,
        mlScore: ml.score,
      });
    }
  }

  // Merge all violations and attach ML flags
  const merged = [
    ...ruleViolations.map(v => {
      // find entity index by matching entity reference
      const eIdx = entities.indexOf(v._entity);
      const ml   = mlMap[eIdx] || { anomaly: false, score: 0 };
      return { ...v, mlFlagged: ml.anomaly, mlScore: ml.score };
    }),
    ...mlOnlyViolations,
  ];

  // Risk score all violations
  const scored = scoreViolations(
    merged.map(v => ({ ...v, defaultSeverity: v.defaultSeverity ?? severityIndex.get(v.rule_id) ?? 'Major' })),
    realtimeMode
  );
  console.log(`[Step 3] After scoring — Critical: ${scored.blockers.length}, suppress Minor: ${scored.all.length - scored.realtime.length}`);

  // ──────────────────────────────────────────────────────────────────
  // STEP 4 — Lessons Learned (parallel, for each emitted violation)
  // ──────────────────────────────────────────────────────────────────
  const enrichedViolations = await Promise.all(
    scored.emitted.map(async (v, idx) => {
      const violationId = `${drawingId}-V${String(idx + 1).padStart(3, '0')}`;

      // Fetch relevant past lesson
      let relevantLesson = null;
      try {
        const lr = await axios.post(`${ML_URL}/lessons`,
          { violation_description: v.violation_description }, { timeout: 5000 });
        const top = lr.data?.top_lessons?.[0];
        if (top) relevantLesson = {
          violationId:  top.violationId,
          what_was_wrong: top.what_was_wrong,
          how_it_was_fixed: top.how_it_was_fixed,
          riskScore:    top.riskScore,
        };
      } catch { /* lessons service unavailable */ }

      // ── STEP 5 — Async LLM suggestion (Real-Time Mode: fire-and-forget) ──
      let llmSuggestion = null;
      try {
        if (realtimeMode) {
          // Fire async — suggestion arrives via /suggestion-ready → ZeroMQ
          axios.post(`${ML_URL}/suggest-realtime`, {
            violation_id: violationId,
            rule_id: v.rule_id,
            entity_type: v.entity_type,
            layer: v.layer,
            violation_description: v.violation_description,
          }, { timeout: 3000 }).catch(() => {});
          llmSuggestion = null; // will arrive async
        } else {
          // Manual Mode — block and wait for suggestion
          const sr = await axios.post(`${ML_URL}/suggest`, {
            rule_id: v.rule_id,
            entity_type: v.entity_type,
            layer: v.layer,
            violation_description: v.violation_description,
          }, { timeout: 15000 });
          llmSuggestion = sr.data?.suggestion || null;
        }
      } catch { /* LLM unavailable — no API key yet */ }

      // Strip internal _entity from response
      const { _entity, ...cleanViolation } = v;
      return {
        violationId,
        ...cleanViolation,
        relevantLesson,
        llmSuggestion,
        llmSuggestionPending: realtimeMode && v.emitRealTime,
      };
    })
  );

  // ──────────────────────────────────────────────────────────────────
  // Final Response
  // ──────────────────────────────────────────────────────────────────
  const criticalCount = enrichedViolations.filter(v => v.severity === 'Critical').length;
  const majorCount    = enrichedViolations.filter(v => v.severity === 'Major').length;
  const minorCount    = scored.all.length - scored.realtime.length; // suppressed count

  console.log(`[/validate/full] Done — ${enrichedViolations.length} violations returned (${criticalCount}C/${majorCount}M/${minorCount}m suppressed)`);

  res.json({
    status: 'ok',
    drawingId,
    realtimeMode,
    counts: { total: enrichedViolations.length, critical: criticalCount, major: majorCount, minorSuppressed: minorCount },
    blocksSignOff: criticalCount > 0,
    violations: enrichedViolations,
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, async () => {
  await startPushSocket();
  console.log(`Backend running on port ${PORT}`);
});