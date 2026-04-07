/**
 * backend/scoring/riskEngine.js
 *
 * Risk Scoring Engine — assigns Critical / Major / Minor severity to each violation.
 *
 * Severity tiers:
 *   Critical — incorrect manufacturing, safety issues, or compliance failure → blocks sign-off
 *   Major    — drawing readability or standard compliance issues, not directly bad parts → shown in Real-Time
 *   Minor    — style / cosmetic best-practice violations → suppressed in Real-Time Mode
 *
 * Rules:
 *   Base:      defaultSeverity from the YAML rule definition
 *   Upgrade:   if ML anomaly detector ALSO flags the entity → upgrade 1 tier (Minor→Major, Major→Critical)
 *   Downgrade: if entity layer is non-structural (NOTES, REFERENCE, etc.) → downgrade 1 tier
 *
 * Confidence:
 *   1.0   for deterministic rule violations
 *   0.75–0.90 for ML-flagged anomalies (based on anomaly score)
 */

'use strict';

// ── Severity tier order (index = rank, higher = more severe) ─────────────────
const TIERS = ['Minor', 'Major', 'Critical'];

// ── Non-structural layers that trigger a downgrade ───────────────────────────
const NON_STRUCTURAL_LAYERS = new Set([
  'NOTES',
  'REFERENCE',
  'REF',
  'CONSTRUCTION',
  'HIDDEN',
  'CENTER',
  'CENTERLINE',
  'PHANTOM',
  'DEFPOINTS',
  '0',
]);

/**
 * Upgrade severity by 1 tier.
 * Critical stays Critical.
 */
function upgradeSeverity(severity) {
  const idx = TIERS.indexOf(severity);
  if (idx === -1) return 'Major'; // unknown → default Major
  return TIERS[Math.min(idx + 1, TIERS.length - 1)];
}

/**
 * Downgrade severity by 1 tier.
 * Minor stays Minor.
 */
function downgradeSeverity(severity) {
  const idx = TIERS.indexOf(severity);
  if (idx === -1) return 'Minor';
  return TIERS[Math.max(idx - 1, 0)];
}

/**
 * Calculate confidence score.
 *   - Deterministic rule violation (no ML flag):  1.0
 *   - ML-flagged anomaly: maps anomaly score → 0.75–0.90
 *     anomalyScore is the raw decision_function value from IsolationForest
 *     (negative = more anomalous, 0 = boundary, positive = normal)
 */
function calcConfidence(isMLFlagged, anomalyScore) {
  if (!isMLFlagged) return 1.0;
  // anomalyScore is typically -0.5 to 0; more negative = more anomalous
  // map [-0.5, -0.025] → [0.90, 0.75]
  const clamped = Math.max(-0.5, Math.min(-0.025, anomalyScore ?? -0.2));
  const t = (clamped - -0.025) / (-0.5 - -0.025); // 0 at -0.025, 1 at -0.5
  const confidence = 0.75 + t * (0.90 - 0.75);
  return Math.round(confidence * 100) / 100;
}

/**
 * scoreViolation — score a single violation object.
 *
 * @param {Object} violation
 * @param {string} violation.rule_id          - e.g. "V-DWG-001"
 * @param {string} violation.defaultSeverity  - "Critical" | "Major" | "Minor" from YAML
 * @param {string} violation.layer            - AutoCAD layer name
 * @param {boolean} violation.mlFlagged       - true if ML anomaly detector also flagged this entity
 * @param {number}  violation.mlScore         - raw decision_function score from IsolationForest
 * @param {string}  [violation.entity_type]   - optional, for context
 *
 * @returns {Object} enriched violation with: severity, confidenceScore, blocksSignOff, emitRealTime
 */
function scoreViolation(violation) {
  const {
    rule_id,
    defaultSeverity = 'Major',
    layer = '',
    mlFlagged = false,
    mlScore = null,
  } = violation;

  let severity = defaultSeverity;

  // ── Upgrade rule: ML also flagged this entity ───────────────────────────
  if (mlFlagged) {
    severity = upgradeSeverity(severity);
  }

  // ── Downgrade rule: entity on non-structural layer ──────────────────────
  if (NON_STRUCTURAL_LAYERS.has(layer.toUpperCase())) {
    severity = downgradeSeverity(severity);
  }

  // ── Confidence score ────────────────────────────────────────────────────
  const confidenceScore = calcConfidence(mlFlagged, mlScore);

  // ── Derived flags ───────────────────────────────────────────────────────
  const blocksSignOff = severity === 'Critical';           // only Critical blocks sign-off
  const emitRealTime  = severity === 'Critical' || severity === 'Major'; // Minor suppressed

  return {
    ...violation,
    severity,
    confidenceScore,
    blocksSignOff,
    emitRealTime,
  };
}

/**
 * scoreViolations — score a list of violations and apply Real-Time Mode filter.
 *
 * @param {Object[]} violations  - array of violation objects
 * @param {boolean}  realtimeMode - if true, suppress Minor violations from output
 * @returns {{ all: Object[], realtime: Object[], blockers: Object[] }}
 */
function scoreViolations(violations, realtimeMode = false) {
  const scored = violations.map(scoreViolation);

  const realtime = scored.filter(v => v.emitRealTime); // Critical + Major only
  const blockers = scored.filter(v => v.blocksSignOff); // Critical only
  const output   = realtimeMode ? realtime : scored;

  return {
    all: scored,         // full scored list (all severities)
    realtime,            // Critical + Major (for Real-Time Mode emission)
    blockers,            // Critical only (blocks drawing sign-off)
    emitted: output,     // what to actually send back (respects realtimeMode flag)
  };
}

/**
 * buildSeverityIndex — build a lookup map { rule_id → defaultSeverity }
 * from a loaded standards YAML object.
 *
 * @param {Object} yamlData - parsed YAML (from js-yaml or similar)
 * @returns {Map<string, string>}
 */
function buildSeverityIndex(yamlData) {
  const index = new Map();
  const standards = yamlData?.standards ?? [];
  for (const rule of standards) {
    if (rule.rule_id && rule.defaultSeverity) {
      index.set(rule.rule_id, rule.defaultSeverity);
    }
  }
  return index;
}

module.exports = {
  scoreViolation,
  scoreViolations,
  buildSeverityIndex,
  upgradeSeverity,
  downgradeSeverity,
  TIERS,
  NON_STRUCTURAL_LAYERS,
};
