'use strict';

/**
 * backend/rules/rulesLoader.js
 *
 * Standards Knowledge Base Loader
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads all 6 YAML rule files from /backend/standards/ at server startup into
 * a single, validated JS object. Each file represents one engineering standard.
 *
 * Returned shape:
 *   {
 *     asme        : { standard, version, description, rules: [...] },
 *     iso         : { standard, version, description, rules: [...] },
 *     varroc      : { standard, version, description, rules: [...] },
 *     customerSpecs: { standard, version, customer,   rules: [...] },
 *     dfmDfa      : { standard, version, description, rules: [...] },
 *     materials   : { standard, version, description, rules: [...], approvedMaterials: {...} },
 *   }
 *
 * Usage:
 *   const { rules } = require('./rulesLoader');
 *   console.log(Object.keys(rules));         // ['asme','iso','varroc',...]
 *   console.log(rules.asme.rules[0].id);    // 'ASME-GDT-001'
 *   console.log(rules.materials.approvedMaterials.aluminium_wrought.codes);
 *
 * Performance:
 *   Files are read synchronously at startup (once). After loading the module
 *   is cached by Node's require() — subsequent requires have zero I/O cost.
 *   Rule checking against loaded rules is O(rules × entities), completing
 *   well under 100ms per entity for the current rule set sizes.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// ── Path to the standards folder ──────────────────────────────────────────────
const STANDARDS_DIR = path.join(__dirname, '..', 'standards');

// ── File map: logical key → YAML filename ─────────────────────────────────────
const STANDARDS_FILES = {
  asme:         'asme_y14_5.yaml',
  iso:          'iso_2768.yaml',
  varroc:       'varroc_internal.yaml',
  customerSpecs:'customer_specs.yaml',
  dfmDfa:       'dfm_dfa.yaml',
  materials:    'materials.yaml',
};

// ── Load and validate a single YAML file ──────────────────────────────────────
/**
 * @param {string} key   - Logical key (e.g., 'asme')
 * @param {string} file  - Filename (e.g., 'asme_y14_5.yaml')
 * @returns {Object}     - Parsed YAML object, guaranteed to have .rules array
 * @throws               - If file is missing or YAML is malformed
 */
function loadYaml(key, file) {
  const filePath = path.join(STANDARDS_DIR, file);

  if (!fs.existsSync(filePath)) {
    throw new Error(`[rulesLoader] Missing standards file: ${filePath}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`[rulesLoader] Cannot read ${file}: ${err.message}`);
  }

  let data;
  try {
    data = yaml.load(raw);
  } catch (err) {
    throw new Error(`[rulesLoader] YAML parse error in ${file}: ${err.message}`);
  }

  if (!data || typeof data !== 'object') {
    throw new Error(`[rulesLoader] ${file} did not yield a valid YAML object`);
  }

  // Normalise: guarantee a .rules array (some files may have zero rules)
  if (!Array.isArray(data.rules)) {
    data.rules = [];
  }

  return data;
}

// ── Validate individual rule objects for required fields ──────────────────────
const REQUIRED_RULE_FIELDS = ['id', 'name', 'defaultSeverity', 'description', 'howToFix'];
const VALID_SEVERITIES      = new Set(['Critical', 'Major', 'Minor']);

/**
 * validateRule — checks that a rule has all required fields and valid severity.
 * Logs warnings for invalid rules (does not throw — allows partial load).
 *
 * @param {Object} rule
 * @param {string} sourceFile - For error messages
 * @returns {boolean}
 */
function validateRule(rule, sourceFile) {
  if (!rule || typeof rule !== 'object') return false;

  const missing = REQUIRED_RULE_FIELDS.filter(f => !rule[f]);
  if (missing.length > 0) {
    console.warn(`[rulesLoader] Rule ${rule.id || 'UNKNOWN'} in ${sourceFile} missing fields: ${missing.join(', ')}`);
    return false;
  }

  if (!VALID_SEVERITIES.has(rule.defaultSeverity)) {
    console.warn(`[rulesLoader] Rule ${rule.id} in ${sourceFile} has invalid severity "${rule.defaultSeverity}" — must be Critical|Major|Minor`);
    return false;
  }

  return true;
}

// ── Main loader ───────────────────────────────────────────────────────────────
/**
 * loadAllStandards — loads all 6 YAML files and returns a unified object.
 * Called once at module initialisation (startup).
 *
 * Logs a startup summary showing counts per standard.
 */
function loadAllStandards() {
  const startMs = Date.now();
  const loaded  = {};
  const summary = [];
  let   totalRules = 0;

  for (const [key, file] of Object.entries(STANDARDS_FILES)) {
    let data;
    try {
      data = loadYaml(key, file);
    } catch (err) {
      console.error(err.message);
      // Provide a safe empty structure so the server still boots
      loaded[key] = { standard: key, rules: [], _loadError: err.message };
      summary.push(`  ✗ ${key.padEnd(14)} — FAILED (${err.message})`);
      continue;
    }

    // Validate and filter rules
    const validRules   = data.rules.filter(r => validateRule(r, file));
    const invalidCount = data.rules.length - validRules.length;
    data.rules = validRules;
    loaded[key] = data;

    totalRules += validRules.length;
    const invalidStr = invalidCount > 0 ? ` (${invalidCount} invalid skipped)` : '';
    summary.push(
      `  ✓ ${key.padEnd(14)} — ${validRules.length} rules loaded${invalidStr}  [${file}]`
    );
  }

  const elapsedMs = Date.now() - startMs;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║         EUREKA Standards Knowledge Base — Loaded             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  summary.forEach(line => console.log(`║ ${line.padEnd(61)}║`));
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Total: ${String(totalRules).padStart(3)} rules across ${String(Object.keys(loaded).length).padStart(1)} standards  (loaded in ${elapsedMs}ms)`.padEnd(63) + '║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  return loaded;
}

// ── Load once at module initialisation ────────────────────────────────────────
const rules = loadAllStandards();

// ── Utility: get all rules flattened across all standards ─────────────────────
/**
 * getAllRules — returns every rule from every standard as a flat array.
 * Each rule is augmented with a _source field identifying which standard
 * it came from.
 *
 * @returns {Object[]}
 */
function getAllRules() {
  const all = [];
  for (const [key, standard] of Object.entries(rules)) {
    for (const rule of standard.rules) {
      all.push({ ...rule, _source: key });
    }
  }
  return all;
}

// ── Utility: get rules for a specific standard key ────────────────────────────
/**
 * getRulesByStandard — returns rules for one standard.
 * @param {'asme'|'iso'|'varroc'|'customerSpecs'|'dfmDfa'|'materials'} standardKey
 * @returns {Object[]}
 */
function getRulesByStandard(standardKey) {
  return rules[standardKey]?.rules ?? [];
}

// ── Utility: find a single rule by its id ─────────────────────────────────────
/**
 * getRuleById — look up a specific rule across all standards.
 * Returns null if not found.
 *
 * @param {string} ruleId
 * @returns {Object|null}
 */
function getRuleById(ruleId) {
  for (const standard of Object.values(rules)) {
    const found = standard.rules.find(r => r.id === ruleId);
    if (found) return found;
  }
  return null;
}

// ── Utility: get approved material codes as a flat Set for O(1) lookup ────────
/**
 * getMaterialCodeSet — returns a Set of all approved material codes.
 * Used by material validation rules for fast O(1) lookup.
 *
 * @returns {Set<string>}
 */
function getMaterialCodeSet() {
  const approvedMaterials = rules.materials?.approvedMaterials ?? {};
  const codeSet = new Set();
  for (const family of Object.values(approvedMaterials)) {
    if (Array.isArray(family.codes)) {
      family.codes.forEach(c => codeSet.add(c));
    }
  }
  return codeSet;
}

// ── Exports ────────────────────────────────────────────────────────────────────
module.exports = {
  rules,           // { asme, iso, varroc, customerSpecs, dfmDfa, materials }
  getAllRules,      // flat array of all rules across all standards
  getRulesByStandard,
  getRuleById,
  getMaterialCodeSet,
};
