/**
 * backend/rules/ruleChecker.js
 *
 * Deterministic rule checker — validates entities against standards_kb.yaml rules.
 * Returns violations with: rule_id, ruleName, category, standardCitation,
 *   violation_description, entity_type, layer, defaultSeverity
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ── Load rules from YAML once ─────────────────────────────────────────────────
const YAML_PATH = path.join(__dirname, '..', '..', 'ml', 'data', 'standards_kb.yaml');
let _rules = [];
try {
  const data = yaml.load(fs.readFileSync(YAML_PATH, 'utf8'));
  _rules = data.standards || [];
  console.log(`[ruleChecker] Loaded ${_rules.length} rules from standards_kb.yaml`);
} catch (err) {
  console.error('[ruleChecker] Failed to load standards_kb.yaml:', err.message);
}

// ── Non-structural layers (no strict rule enforcement) ────────────────────────
const NON_STRUCTURAL = new Set(['NOTES', 'REFERENCE', 'REF', 'CONSTRUCTION', 'HIDDEN', 'CENTER', 'CENTERLINE', 'PHANTOM', 'DEFPOINTS', '0']);

/**
 * checkEntity — run all deterministic rules against a single entity.
 *
 * Entity schema (Varroc):
 *   { entityType, layer, boundingBox, upperTolerance, lowerTolerance,
 *     nominalValue, measuredValue, textContent, gdtSymbol }
 *
 * @param {Object} entity
 * @returns {Array} violations []
 */
function checkEntity(entity) {
  const violations = [];
  const entityType = (entity.entityType || '').toUpperCase();
  const layer      = (entity.layer || '').toUpperCase();
  const measured   = entity.measuredValue ?? null;
  const nominal    = entity.nominalValue  ?? null;
  const upperTol   = entity.upperTolerance ?? null;
  const lowerTol   = entity.lowerTolerance ?? null;
  const textContent= entity.textContent || '';

  for (const rule of _rules) {
    const allowedEntityTypes = (rule.entity_types || []).map(t => t.toUpperCase());
    const requiredLayer      = (rule.layer || '').toUpperCase();

    // Only check rules that apply to this entity type
    if (!allowedEntityTypes.includes(entityType)) continue;

    let violated = false;
    let description = '';

    switch (rule.rule_id) {

      // ── Layer naming rules ─────────────────────────────────────────────────
      case 'V-DWG-001':
      case 'V-DWG-002':
      case 'V-DWG-003':
        if (layer !== requiredLayer && !NON_STRUCTURAL.has(layer)) {
          violated = true;
          description = `${entityType} found on layer '${entity.layer}' — must be on ${requiredLayer} layer per ${rule.rule_id}.`;
        }
        break;

      // ── Title block completeness ───────────────────────────────────────────
      case 'V-DWG-004':
      case 'V-DWG-005':
      case 'V-PROC-002':
        if (layer === 'TITLEBLOCK' && (!textContent || textContent.trim() === '')) {
          violated = true;
          description = `TITLEBLOCK ${entityType} field is empty — ${rule.category} required by ${rule.rule_id}.`;
        }
        break;

      // ── Tolerance / dimension out-of-spec (numeric violations) ────────────
      default:
        if (measured !== null && nominal !== null) {
          const deviation = measured - nominal;
          if (upperTol !== null && deviation > upperTol) {
            violated = true;
            description = `${entity.parameterName || entityType} measured ${measured} exceeds upper limit ${nominal + upperTol} by ${(deviation - upperTol).toFixed(4)} (rule ${rule.rule_id}).`;
          } else if (lowerTol !== null && deviation < lowerTol) {
            violated = true;
            description = `${entity.parameterName || entityType} measured ${measured} below lower limit ${nominal + lowerTol} by ${(lowerTol - deviation).toFixed(4)} (rule ${rule.rule_id}).`;
          }
        }
        break;
    }

    if (violated) {
      violations.push({
        rule_id:              rule.rule_id,
        ruleName:             `${rule.standard} — ${rule.category}`,
        category:             rule.category,
        standardCitation:     `${rule.standard} / ${rule.rule_id}`,
        defaultSeverity:      rule.defaultSeverity || 'Major',
        violation_description: description,
        entity_type:          entityType,
        layer:                entity.layer,
        parameterName:        entity.parameterName || entityType,
      });
      break; // one violation per rule pass — avoid duplicating same entity
    }
  }

  return violations;
}

/**
 * checkDrawing — validate all entities in a DWG payload.
 * @param {Object[]} entities
 * @returns {Object[]} all violations across all entities
 */
function checkDrawing(entities) {
  const all = [];
  for (const entity of entities) {
    const v = checkEntity(entity);
    for (const violation of v) {
      all.push({ ...violation, _entity: entity });
    }
  }
  return all;
}

module.exports = { checkEntity, checkDrawing };
