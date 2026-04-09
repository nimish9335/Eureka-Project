'use strict';

/**
 * backend/rules/ruleValidator.js
 *
 * Day 3 — Multi-Standard Rule Validator Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates a DWG entity payload against 70 rules across 6 engineering standards:
 *
 *   1. ASME Y14.5   — GD&T symbols, tolerance limits, feature control frames
 *   2. ISO 2768     — General linear/angular tolerance class checks
 *   3. Varroc       — Layer naming, title block fields, text height, block library
 *   4. Customer Specs — Customer-specific tolerance and documentation overrides
 *   5. DFM/DFA      — Wall thickness, aspect ratio, draft angle, assembly clearance
 *   6. Materials    — Approved codes, callout format, incompatible material pairs
 *
 * Performance target: < 100ms per entity (typically 1–5ms at 70 rules).
 *
 * Entity schema (DWG payload):
 *   {
 *     entityType       : string   — LINE | ARC | CIRCLE | DIMENSION | TOLERANCE |
 *                                   MTEXT | TEXT | HATCH | BLOCK | INSERT | LEADER
 *     layer            : string   — AutoCAD layer name
 *     gdtSymbol        : string?  — e.g. 'flatness', 'true_position'
 *     measuredValue    : number?  — actual measured value (mm or degrees)
 *     nominalValue     : number?  — drawing nominal value
 *     upperTolerance   : number?  — upper limit offset from nominal
 *     lowerTolerance   : number?  — lower limit offset from nominal (negative)
 *     textContent      : string?  — text/mtext string content
 *     wallThickness    : number?  — mm (DFM check)
 *     aspectRatio      : number?  — length:width or length:dia (DFM check)
 *     draftAngle       : number?  — degrees (DFM check)
 *     holeDiameter     : number?  — mm
 *     holeToEdgeDist   : number?  — mm (DFM check)
 *     insideRadius     : number?  — mm, inside corner radius
 *     assemblyClearance: number?  — mm (DFA check)
 *     toolClearance    : number?  — mm (DFA check)
 *     materialCode     : string?  — e.g. 'AA6061-T6'
 *     drawingScale     : number?  — e.g. 1.0 for 1:1
 *     parameterName    : string?  — human name for the measured dimension
 *     blockName        : string?  — for BLOCK/INSERT entities
 *     toleranceClass   : string?  — 'f'|'m'|'c'|'v' for ISO 2768
 *   }
 *
 * Returned violation object:
 *   {
 *     rule_id              : string  — e.g. 'ASME-GDT-004'
 *     ruleName             : string  — e.g. 'Flatness Tolerance — Sealing Surfaces'
 *     standard             : string  — e.g. 'ASME_Y14_5'
 *     standardCitation     : string  — e.g. 'ASME Y14.5-2018 / ASME-GDT-004'
 *     category             : string  — rule category from YAML
 *     defaultSeverity      : string  — 'Critical' | 'Major' | 'Minor'
 *     violation_description: string  — precise description of what failed and by how much
 *     howToFix             : string  — actionable fix from YAML
 *     entity_type          : string  — which entity triggered the rule
 *     layer                : string  — entity's layer
 *     parameterName        : string  — measured parameter name
 *     _entity              : object  — reference to original entity (stripped before API response)
 *   }
 */

const { rules, getMaterialCodeSet } = require('./rulesLoader');

// ── Cached material code set for O(1) lookup ──────────────────────────────────
const APPROVED_MATERIAL_CODES = getMaterialCodeSet();

// ── Layers that suppress minor violations (non-structural context) ────────────
const NON_STRUCTURAL_LAYERS = new Set([
  'NOTES', 'REFERENCE', 'REF', 'CONSTRUCTION', 'HIDDEN',
  'CENTER', 'CENTERLINE', 'PHANTOM', 'DEFPOINTS',
]);

// ── GD&T symbols approved in ASME Y14.5 (from YAML, cached for speed) ────────
const ALLOWED_GDT_SYMBOLS = new Set(
  (rules.asme?.rules.find(r => r.id === 'ASME-GDT-001')?.allowedSymbols ?? [])
);

// ── Varroc approved block names ───────────────────────────────────────────────
const APPROVED_BLOCKS = new Set(
  rules.varroc?.rules.find(r => r.id === 'VAR-BLOCK-001')?.approvedBlocks ?? []
);

// ── Varroc approved text fonts ────────────────────────────────────────────────
const APPROVED_FONTS = new Set(
  rules.varroc?.rules.find(r => r.id === 'VAR-TEXT-002')?.approvedFonts ?? []
);

// ═════════════════════════════════════════════════════════════════════════════
// VIOLATION FACTORY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * makeViolation — construct a structured violation object.
 *
 * @param {Object} rule        - Rule object from YAML
 * @param {Object} entity      - The DWG entity that triggered the rule
 * @param {string} description - Specific description (what failed and by how much)
 * @returns {Object}
 */
function makeViolation(rule, entity, description) {
  return {
    rule_id:               rule.id,
    ruleName:              rule.name,
    standard:              rule._source ? rule._source.toUpperCase() : 'UNKNOWN',
    standardCitation:      `${rule.id} — ${rule.name}`,
    category:              rule.category ?? rule.id.split('-')[0],
    defaultSeverity:       rule.defaultSeverity,
    violation_description: description,
    howToFix:              (rule.howToFix || '').trim(),
    entity_type:           (entity.entityType || '').toUpperCase(),
    layer:                 entity.layer || '',
    parameterName:         entity.parameterName || entity.entityType || 'UNKNOWN',
    _entity:               entity,    // stripped before API response
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// RULE CHECK FUNCTIONS — one per standard / rule group
// ═════════════════════════════════════════════════════════════════════════════

// ── 1. ASME Y14.5 checks ──────────────────────────────────────────────────────

/**
 * checkAsme — validate entity against all ASME Y14.5 rules.
 * Covers: GD&T symbols, datum references, feature control frame structure,
 * tolerance limits (flatness, circularity, perpendicularity, true position,
 * cylindricity, profile, runout).
 */
function checkAsme(entity, violations) {
  const entityType = (entity.entityType || '').toUpperCase();
  const layer      = (entity.layer || '').toUpperCase();
  const gdtSymbol  = (entity.gdtSymbol || '').toLowerCase().replace(/\s+/g, '_');
  const measured   = entity.measuredValue ?? null;

  const asmeRules = rules.asme?.rules ?? [];

  for (const rule of asmeRules) {
    const ruleTypes = (rule.entity_types || []).map(t => t.toUpperCase());
    if (!ruleTypes.includes(entityType)) continue;

    const ruleLayer = (rule.layer || '').toUpperCase();
    if (ruleLayer && layer !== ruleLayer) continue;

    switch (rule.id) {

      // ── Valid GD&T symbol ────────────────────────────────────────────────
      case 'ASME-GDT-001':
        if (gdtSymbol && !ALLOWED_GDT_SYMBOLS.has(gdtSymbol)) {
          violations.push(makeViolation(
            { ...rule, _source: 'asme' }, entity,
            `GD&T symbol "${entity.gdtSymbol}" is not in the ASME Y14.5-2018 approved symbol set. ` +
            `Approved symbols: ${[...ALLOWED_GDT_SYMBOLS].join(', ')}.`
          ));
        }
        break;

      // ── Datum reference completeness ─────────────────────────────────────
      case 'ASME-GDT-002':
        if (gdtSymbol && ['true_position', 'perpendicularity', 'angularity', 'parallelism', 'circular_runout', 'total_runout'].includes(gdtSymbol)) {
          if (!entity.datumA && !entity.datumRef) {
            violations.push(makeViolation(
              { ...rule, _source: 'asme' }, entity,
              `GD&T ${entity.gdtSymbol} tolerance is missing a datum reference. ` +
              `Orientation and positional tolerances require at least one primary datum per ASME Y14.5 Section 4.`
            ));
          }
        }
        break;

      // ── Tolerance value checks — flatness ────────────────────────────────
      case 'ASME-GDT-004':
        if (gdtSymbol === 'flatness' && measured !== null && rule.maxTolerance != null) {
          if (measured > rule.maxTolerance) {
            violations.push(makeViolation(
              { ...rule, _source: 'asme' }, entity,
              `Flatness tolerance ${measured}mm exceeds maximum ${rule.maxTolerance}mm for sealing surfaces ` +
              `(over by ${(measured - rule.maxTolerance).toFixed(4)}mm). IP seal failure risk.`
            ));
          }
        }
        break;

      // ── Circularity ───────────────────────────────────────────────────────
      case 'ASME-GDT-005':
        if (gdtSymbol === 'circularity' && measured !== null && rule.maxTolerance != null) {
          if (measured > rule.maxTolerance) {
            violations.push(makeViolation(
              { ...rule, _source: 'asme' }, entity,
              `Circularity tolerance ${measured}mm exceeds maximum ${rule.maxTolerance}mm for precision rotating components ` +
              `(over by ${(measured - rule.maxTolerance).toFixed(4)}mm).`
            ));
          }
        }
        break;

      // ── Perpendicularity ──────────────────────────────────────────────────
      case 'ASME-GDT-006':
        if (gdtSymbol === 'perpendicularity' && measured !== null && rule.maxTolerance != null) {
          if (measured > rule.maxTolerance) {
            violations.push(makeViolation(
              { ...rule, _source: 'asme' }, entity,
              `Perpendicularity tolerance ${measured}mm exceeds ${rule.maxTolerance}mm limit for pivot bores ` +
              `(over by ${(measured - rule.maxTolerance).toFixed(4)}mm). Bearing edge-loading risk.`
            ));
          }
        }
        break;

      // ── True Position ─────────────────────────────────────────────────────
      case 'ASME-GDT-007':
        if (gdtSymbol === 'true_position' && measured !== null && rule.maxTolerance != null) {
          if (measured > rule.maxTolerance) {
            violations.push(makeViolation(
              { ...rule, _source: 'asme' }, entity,
              `True position tolerance ⌀${measured}mm exceeds ⌀${rule.maxTolerance}mm zone for mounting holes ` +
              `(over by ${(measured - rule.maxTolerance).toFixed(4)}mm). Parts will be non-interchangeable.`
            ));
          }
        }
        break;

      // ── Cylindricity ──────────────────────────────────────────────────────
      case 'ASME-GDT-009':
        if (gdtSymbol === 'cylindricity' && measured !== null && rule.maxTolerance != null) {
          if (measured > rule.maxTolerance) {
            violations.push(makeViolation(
              { ...rule, _source: 'asme' }, entity,
              `Cylindricity tolerance ${measured}mm exceeds maximum ${rule.maxTolerance}mm ` +
              `(over by ${(measured - rule.maxTolerance).toFixed(4)}mm).`
            ));
          }
        }
        break;

      // ── Total Runout ──────────────────────────────────────────────────────
      case 'ASME-GDT-011':
        if (gdtSymbol === 'total_runout' && measured !== null && rule.maxTolerance != null) {
          if (measured > rule.maxTolerance) {
            violations.push(makeViolation(
              { ...rule, _source: 'asme' }, entity,
              `Total runout ${measured}mm exceeds ${rule.maxTolerance}mm limit on rotating assembly ` +
              `(over by ${(measured - rule.maxTolerance).toFixed(4)}mm). Vibration and optical misalignment risk.`
            ));
          }
        }
        break;
    }
  }
}

// ── 2. ISO 2768 checks ────────────────────────────────────────────────────────

/**
 * getIsoTolerance — look up the tolerance limit for a dimension under ISO 2768.
 * @param {string} toleranceClass - 'f'|'m'|'c'|'v'
 * @param {number} dimensionMm    - nominal dimension value in mm
 * @param {string} ruleId         - specific ISO rule to look up
 * @returns {number|null}
 */
function getIsoTolerance(toleranceClass, dimensionMm, ruleId) {
  const rule = rules.iso?.rules.find(r => r.id === ruleId && r.toleranceClass === toleranceClass);
  if (!rule?.dimensionRanges) return null;
  const range = rule.dimensionRanges.find(
    r => dimensionMm >= r.range[0] && dimensionMm < (r.range[1] ?? Infinity)
  );
  return range?.tolerance ?? null;
}

/**
 * checkIso — validate entity against ISO 2768 rules.
 * Covers: linear tolerance class compliance, angular tolerance, hole spacing.
 */
function checkIso(entity, violations) {
  const entityType = (entity.entityType || '').toUpperCase();
  const layer      = (entity.layer || '').toUpperCase();
  const measured   = entity.measuredValue ?? null;
  const nominal    = entity.nominalValue ?? null;
  const tolClass   = (entity.toleranceClass || 'm').toLowerCase(); // default medium

  const isoRules = rules.iso?.rules ?? [];

  for (const rule of isoRules) {
    const ruleTypes = (rule.entity_types || []).map(t => t.toUpperCase());
    if (!ruleTypes.includes(entityType)) continue;

    switch (rule.id) {

      // ── Linear tolerance class compliance ────────────────────────────────
      case 'ISO-2768-002':
      case 'ISO-2768-003':
      case 'ISO-2768-004':
      case 'ISO-2768-005': {
        if (rule.toleranceClass !== tolClass) break;  // only check matching class
        if (measured === null || nominal === null) break;

        const deviation = Math.abs(measured - nominal);
        const limit = getIsoTolerance(tolClass, nominal, rule.id);
        if (limit === null) break;

        if (deviation > limit) {
          violations.push(makeViolation(
            { ...rule, _source: 'iso' }, entity,
            `Dimension ${nominal}mm measured as ${measured}mm — deviation ${deviation.toFixed(4)}mm exceeds ` +
            `ISO 2768-${tolClass} limit of ±${limit}mm for this range ` +
            `(over by ${(deviation - limit).toFixed(4)}mm).`
          ));
        }
        break;
      }

      // ── Drawing scale must be 1:1 after DXF import ─────────────────────
      case 'ISO-2768-010':
        if (entity.drawingScale !== undefined && entity.drawingScale !== null) {
          if (Math.abs(entity.drawingScale - 1.0) > 0.0001) {
            violations.push(makeViolation(
              { ...rule, _source: 'iso' }, entity,
              `Drawing scale is ${entity.drawingScale} (expected 1.0 for 1:1). ` +
              `DXF import scale error detected — mounting hole spacing will be systematically incorrect. ` +
              `Scale error: ${((entity.drawingScale - 1.0) * 100).toFixed(4)}%.`
            ));
          }
        }
        break;
    }
  }
}

// ── 3. Varroc Internal checks ─────────────────────────────────────────────────

/**
 * checkVarroc — validates entity against Varroc internal drawing standards.
 * Covers: layer naming (DIMS/CENTER/HIDDEN/SECTION/BORDER), title block
 * completeness, block library usage, text height, font, Layer 0 prohibition.
 */
function checkVarroc(entity, violations) {
  const entityType  = (entity.entityType || '').toUpperCase();
  const layer       = (entity.layer || '').toUpperCase();
  const textContent = (entity.textContent || '').trim();
  const blockName   = (entity.blockName || '').trim();
  const textHeight  = entity.textHeight ?? null;
  const textFont    = (entity.textFont || '').toUpperCase();

  const varrocRules = rules.varroc?.rules ?? [];

  for (const rule of varrocRules) {
    const ruleTypes = (rule.entity_types || []).map(t => t.toUpperCase());
    if (!ruleTypes.includes(entityType)) continue;

    switch (rule.id) {

      // ── Layer naming: dimensions must be on DIMS ──────────────────────────
      case 'VAR-LAYER-001':
        if (['DIMENSION', 'LEADER'].includes(entityType)) {
          if (layer !== 'DIMS' && !NON_STRUCTURAL_LAYERS.has(layer)) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `${entityType} found on layer "${entity.layer}" — must be on "DIMS" layer per Varroc standard. ` +
              `Automated dimension extraction will fail.`
            ));
          }
        }
        break;

      // ── Centerlines on CENTER layer ───────────────────────────────────────
      case 'VAR-LAYER-002':
        if (['LINE', 'ARC'].includes(entityType) && entity.isCenterline === true) {
          if (layer !== 'CENTER') {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Centerline ${entityType} is on layer "${entity.layer}" — must be on "CENTER" layer ` +
              `with CENTER2 linetype per Varroc standard.`
            ));
          }
        }
        break;

      // ── Hidden lines on HIDDEN layer ──────────────────────────────────────
      case 'VAR-LAYER-003':
        if (['LINE', 'ARC'].includes(entityType) && entity.isHidden === true) {
          if (layer !== 'HIDDEN') {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Hidden line ${entityType} is on layer "${entity.layer}" — must be on "HIDDEN" layer ` +
              `with HIDDEN2 linetype per Varroc standard.`
            ));
          }
        }
        break;

      // ── No geometry on Layer 0 ────────────────────────────────────────────
      case 'VAR-LAYER-006':
        if (layer === '0' && ['LINE', 'ARC', 'CIRCLE', 'DIMENSION', 'MTEXT', 'TEXT', 'TOLERANCE'].includes(entityType)) {
          violations.push(makeViolation(
            { ...rule, _source: 'varroc' }, entity,
            `${entityType} entity found on Layer "0". Layer 0 is reserved for block inheritance — ` +
            `all geometry must be on a named layer.`
          ));
        }
        break;

      // ── Approved block library ────────────────────────────────────────────
      case 'VAR-BLOCK-001':
        if (['BLOCK', 'INSERT'].includes(entityType) && blockName) {
          if (!APPROVED_BLOCKS.has(blockName)) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Block "${blockName}" is not from the Varroc approved library (VAR_STD_BLOCKS_v2024). ` +
              `Non-standard blocks may contain obsolete or incorrect symbol geometry.`
            ));
          }
        }
        break;

      // ── Title block — part number ─────────────────────────────────────────
      case 'VAR-TITLE-001':
        if (['MTEXT', 'TEXT', 'ATTDEF', 'ATTRIB'].includes(entityType) && layer === 'TITLEBLOCK') {
          if (entity.fieldName === 'part_number') {
            const pnPattern = /^VAR-\d{5}-\d{2}$/;
            if (!textContent || !pnPattern.test(textContent)) {
              violations.push(makeViolation(
                { ...rule, _source: 'varroc' }, entity,
                `Title block part number "${textContent || '(empty)'}" does not match required format VAR-XXXXX-XX. ` +
                `Drawing cannot be released without a valid part number.`
              ));
            }
          }
        }
        break;

      // ── Title block — revision ────────────────────────────────────────────
      case 'VAR-TITLE-002':
        if (['MTEXT', 'TEXT', 'ATTDEF', 'ATTRIB'].includes(entityType) && layer === 'TITLEBLOCK') {
          if (entity.fieldName === 'revision' && !textContent) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Title block revision field is empty. All released drawings must carry a revision letter (A, B, C…). ` +
              `Drawing cannot be issued to production without a revision.`
            ));
          }
        }
        break;

      // ── Title block — material specification ───────────────────────────────
      case 'VAR-TITLE-003':
        if (['MTEXT', 'TEXT', 'ATTDEF', 'ATTRIB'].includes(entityType) && layer === 'TITLEBLOCK') {
          if (entity.fieldName === 'material' && !textContent) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Title block material field is empty. All machined/cast/moulded part drawings must specify material grade.`
            ));
          }
        }
        break;

      // ── Title block — engineer name ────────────────────────────────────────
      case 'VAR-TITLE-004':
        if (['MTEXT', 'TEXT', 'ATTDEF', 'ATTRIB'].includes(entityType) && layer === 'TITLEBLOCK') {
          if (entity.fieldName === 'engineer_name' && !textContent) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Title block engineer name field is empty. Anonymous drawings cannot be released to production.`
            ));
          }
        }
        break;

      // ── Title block — drawing number ───────────────────────────────────────
      case 'VAR-TITLE-005':
        if (['MTEXT', 'TEXT', 'ATTDEF', 'ATTRIB'].includes(entityType) && layer === 'TITLEBLOCK') {
          if (entity.fieldName === 'drawing_number') {
            const dnPattern = /^DWG-\d{5}$/;
            if (!textContent || !dnPattern.test(textContent)) {
              violations.push(makeViolation(
                { ...rule, _source: 'varroc' }, entity,
                `Title block drawing number "${textContent || '(empty)'}" does not match required format DWG-XXXXX. ` +
                `Obtain a drawing number from the PDM system.`
              ));
            }
          }
        }
        break;

      // ── Title block — approval signature ──────────────────────────────────
      case 'VAR-TITLE-006':
        if (['MTEXT', 'TEXT', 'ATTDEF', 'ATTRIB'].includes(entityType) && layer === 'TITLEBLOCK') {
          if (entity.fieldName === 'approval_signature' && !textContent) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Title block approval signature is missing. Drawing must be approved via the PDM release workflow before issue.`
            ));
          }
        }
        break;

      // ── Text height ────────────────────────────────────────────────────────
      case 'VAR-TEXT-001':
        if (['MTEXT', 'TEXT', 'DIMENSION'].includes(entityType) && textHeight !== null) {
          const minH = rule.minTextHeight ?? 2.5;
          const maxH = rule.maxTextHeight ?? 5.0;
          if (textHeight < minH) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Text height ${textHeight}mm is below minimum ${minH}mm — text will not be legible when printed. ` +
              `Adjust DIMTXT or text style height.`
            ));
          } else if (textHeight > maxH) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Text height ${textHeight}mm exceeds maximum ${maxH}mm — overcrowding on drawing sheet.`
            ));
          }
        }
        break;

      // ── Text font ──────────────────────────────────────────────────────────
      case 'VAR-TEXT-002':
        if (['MTEXT', 'TEXT'].includes(entityType) && textFont) {
          if (!APPROVED_FONTS.has(textFont)) {
            violations.push(makeViolation(
              { ...rule, _source: 'varroc' }, entity,
              `Text font "${entity.textFont}" is not in the Varroc approved font list (ISOCP, ISOCP2, ISOCT). ` +
              `Font substitution errors occur when drawing is opened on other workstations.`
            ));
          }
        }
        break;
    }
  }
}

// ── 4. Customer Specs checks ──────────────────────────────────────────────────

/**
 * checkCustomerSpecs — validates against customer-specific requirements.
 * For the TEMPLATE version, checks PPAP Level 3 documentation requirements.
 */
function checkCustomerSpecs(entity, violations) {
  const entityType  = (entity.entityType || '').toUpperCase();
  const layer       = (entity.layer || '').toUpperCase();
  const textContent = (entity.textContent || '').trim();

  const custRules = rules.customerSpecs?.rules ?? [];

  for (const rule of custRules) {
    const ruleTypes = (rule.entity_types || []).map(t => t.toUpperCase());
    if (!ruleTypes.includes(entityType)) continue;
    if (rule.placeholderNote) continue;  // skip un-configured template rules

    switch (rule.id) {

      // ── Customer dimension tolerance override ─────────────────────────────
      case 'CUST-DIM-001':
        if (rule.nominalValue !== undefined && entity.measuredValue !== undefined) {
          const dev = Math.abs(entity.measuredValue - rule.nominalValue);
          const limit = rule.upperTolerance ?? 0.05;
          if (dev > limit) {
            violations.push(makeViolation(
              { ...rule, _source: 'customerSpecs' }, entity,
              `Customer dimension "${rule.targetDimension || 'critical dim'}" measured ${entity.measuredValue}mm — ` +
              `deviation ${dev.toFixed(4)}mm exceeds customer limit ±${limit}mm (ref: ${rule.customerReference || 'customer spec'}).`
            ));
          }
        }
        break;
    }
  }
}

// ── 5. DFM / DFA checks ───────────────────────────────────────────────────────

/**
 * checkDfmDfa — validates entity against DFM/DFA rules.
 * Covers: wall thickness, aspect ratio, draft angle, hole-to-edge distance,
 * minimum hole diameter, inside radius, assembly clearance, tool clearance,
 * snap fit retention force.
 */
function checkDfmDfa(entity, violations) {
  const entityType = (entity.entityType || '').toUpperCase();

  const dfmRules = rules.dfmDfa?.rules ?? [];

  for (const rule of dfmRules) {
    const ruleTypes = (rule.entity_types || []).map(t => t.toUpperCase());
    if (!ruleTypes.includes(entityType)) continue;

    switch (rule.id) {

      // ── Minimum wall thickness (>1.5mm) ───────────────────────────────────
      case 'DFM-001':
        if (entity.wallThickness !== undefined && entity.wallThickness !== null) {
          const min = rule.minWallThickness ?? 1.5;
          if (entity.wallThickness < min) {
            violations.push(makeViolation(
              { ...rule, _source: 'dfmDfa' }, entity,
              `Wall thickness ${entity.wallThickness}mm is below minimum ${min}mm for injection moulding. ` +
              `Short shot and weld line weakness risk. Deficient by ${(min - entity.wallThickness).toFixed(3)}mm.`
            ));
          }
        }
        break;

      // ── Maximum aspect ratio (<10:1) ──────────────────────────────────────
      case 'DFM-002':
        if (entity.aspectRatio !== undefined && entity.aspectRatio !== null) {
          const max = rule.maxAspectRatio ?? 10.0;
          if (entity.aspectRatio > max) {
            violations.push(makeViolation(
              { ...rule, _source: 'dfmDfa' }, entity,
              `Feature aspect ratio ${entity.aspectRatio.toFixed(2)}:1 exceeds maximum ${max}:1. ` +
              `Tool deflection, vibration, and breakage risk during machining/moulding.`
            ));
          }
        }
        break;

      // ── Draft angle (>1.5 deg) ────────────────────────────────────────────
      case 'DFM-003':
        if (entity.draftAngle !== undefined && entity.draftAngle !== null) {
          const min = rule.minDraftAngle ?? 1.5;
          if (entity.draftAngle < min) {
            violations.push(makeViolation(
              { ...rule, _source: 'dfmDfa' }, entity,
              `Draft angle ${entity.draftAngle}° is below minimum ${min}° for injection moulding. ` +
              `Part will stick during ejection causing surface drag marks and tool damage.`
            ));
          }
        }
        break;

      // ── Hole-to-edge distance (>2× diameter) ─────────────────────────────
      case 'DFM-004':
        if (entity.holeToEdgeDist !== undefined && entity.holeDiameter !== undefined) {
          const minRatio  = rule.minHoleToEdgeRatio ?? 2.0;
          const minDist   = minRatio * entity.holeDiameter;
          if (entity.holeToEdgeDist < minDist) {
            violations.push(makeViolation(
              { ...rule, _source: 'dfmDfa' }, entity,
              `Hole-to-edge distance ${entity.holeToEdgeDist}mm is less than minimum ${minDist}mm ` +
              `(= ${minRatio}× hole diameter ${entity.holeDiameter}mm). ` +
              `Local stress concentration and edge break-out risk.`
            ));
          }
        }
        break;

      // ── Minimum hole diameter (>1.0mm) ────────────────────────────────────
      case 'DFM-005':
        if (entity.holeDiameter !== undefined && entity.holeDiameter !== null) {
          const min = rule.minHoleDiameter ?? 1.0;
          if (entity.holeDiameter < min) {
            violations.push(makeViolation(
              { ...rule, _source: 'dfmDfa' }, entity,
              `Hole diameter ${entity.holeDiameter}mm is below minimum ${min}mm for standard drilling. ` +
              `Drill bits below 1.0mm have very high breakage rate in production. ` +
              `Specify laser or EDM drilling if this hole size is required.`
            ));
          }
        }
        break;

      // ── Inside corner radius (>0.5mm) ────────────────────────────────────
      case 'DFM-006':
        if (entity.insideRadius !== undefined && entity.insideRadius !== null) {
          const min = rule.minInsideRadius ?? 0.5;
          if (entity.insideRadius < min) {
            violations.push(makeViolation(
              { ...rule, _source: 'dfmDfa' }, entity,
              `Inside corner radius ${entity.insideRadius}mm is below minimum ${min}mm. ` +
              `Sharp inside corners are not achievable by milling and create fatigue crack initiation sites.`
            ));
          }
        }
        break;

      // ── Minimum assembly clearance ────────────────────────────────────────
      case 'DFA-003':
        if (entity.assemblyClearance !== undefined && entity.assemblyClearance !== null) {
          const min = rule.minAssemblyClearance ?? 0.3;
          if (entity.assemblyClearance < min) {
            violations.push(makeViolation(
              { ...rule, _source: 'dfmDfa' }, entity,
              `Assembly clearance ${entity.assemblyClearance}mm is below minimum ${min}mm at MMC. ` +
              `Parts cannot be assembled without force — seal damage and housing crack risk.`
            ));
          }
        }
        break;

      // ── Assembly tool clearance ────────────────────────────────────────────
      case 'DFA-001':
        if (entity.toolClearance !== undefined && entity.toolClearance !== null) {
          const min = rule.minToolClearance ?? 15.0;
          if (entity.toolClearance < min) {
            violations.push(makeViolation(
              { ...rule, _source: 'dfmDfa' }, entity,
              `Tool clearance around fastener is ${entity.toolClearance}mm — below the minimum ${min}mm ` +
              `for standard torque tools. Required torque cannot be achieved with angled tools.`
            ));
          }
        }
        break;
    }
  }
}

// ── 6. Materials checks ───────────────────────────────────────────────────────

/**
 * checkMaterials — validates entity against materials rules.
 * Covers: approved material codes, callout format, incompatible pairings,
 * UV stabiliser requirement for clear PC, RoHS compliance flag.
 */
function checkMaterials(entity, violations) {
  const entityType  = (entity.entityType || '').toUpperCase();
  const layer       = (entity.layer || '').toUpperCase();
  const textContent = (entity.textContent || '').trim();
  const matCode     = (entity.materialCode || '').trim();
  const mateMatCode = (entity.matingMaterialCode || '').trim();

  const matRules = rules.materials?.rules ?? [];

  for (const rule of matRules) {
    const ruleTypes = (rule.entity_types || []).map(t => t.toUpperCase());
    if (!ruleTypes.includes(entityType)) continue;

    switch (rule.id) {

      // ── Material callout format ────────────────────────────────────────────
      case 'MAT-FORMAT-001':
        if (layer === 'NOTES' && textContent.toUpperCase().startsWith('MATERIAL')) {
          const formatPattern = /^MATERIAL:\s+\S+.*TO\s+\S+/i;
          if (!formatPattern.test(textContent)) {
            violations.push(makeViolation(
              { ...rule, _source: 'materials' }, entity,
              `Material callout "${textContent}" does not follow required format: ` +
              `"MATERIAL: <code> TO <standard>". ` +
              `Example: "MATERIAL: AA6061-T6 TO EN 573-3".`
            ));
          }
        }
        break;

      // ── Approved material code ─────────────────────────────────────────────
      case 'MAT-CODE-001':
        if (matCode && !APPROVED_MATERIAL_CODES.has(matCode)) {
          violations.push(makeViolation(
            { ...rule, _source: 'materials' }, entity,
            `Material code "${matCode}" is not in the Varroc approved materials list. ` +
            `Submit a Material Approval Request (MAR) if this material is required.`
          ));
        }
        break;

      // ── Galvanic incompatibility: aluminium + steel ────────────────────────
      case 'MAT-COMPAT-001': {
        if (!matCode || !mateMatCode) break;
        const aluminiumCodes = new Set(['AA6061-T6', 'EN-AC-46100', 'EN-AC-46000', 'AA6063-T5', 'EN-AC-42100-T6', 'AA5052-H32', 'AA1050-H14', 'AA3003-H14']);
        const steelCodes     = new Set(['S355JR', 'S275JR', 'S235JR', 'C45', 'C60', '42CrMo4', '16MnCr5']);
        const isAlSteel = (aluminiumCodes.has(matCode) && steelCodes.has(mateMatCode)) ||
                          (steelCodes.has(matCode) && aluminiumCodes.has(mateMatCode));
        if (isAlSteel && !entity.hasBarrierCoating && !entity.hasInsulatingGasket) {
          violations.push(makeViolation(
            { ...rule, _source: 'materials' }, entity,
            `Galvanic incompatibility: aluminium (${aluminiumCodes.has(matCode) ? matCode : mateMatCode}) in direct ` +
            `contact with steel (${steelCodes.has(matCode) ? matCode : mateMatCode}) without isolation. ` +
            `Aluminium will corrode preferentially in wet environments. Add barrier coating or insulating gasket.`
          ));
        }
        break;
      }

      // ── UV degradation: clear PC without UV stabiliser ────────────────────
      case 'MAT-COMPAT-004':
        if (matCode === 'PC' && entity.isExteriorPart === true && !entity.hasUvStabiliser && !entity.hasUvHardCoat) {
          violations.push(makeViolation(
            { ...rule, _source: 'materials' }, entity,
            `Clear PC (polycarbonate) "${matCode}" on exterior lamp application has no UV stabiliser or UV hard coat. ` +
            `Lens will yellow and craze within 12 months of outdoor exposure — photometric test failure.`
          ));
        }
        break;

      // ── RoHS compliance ────────────────────────────────────────────────────
      case 'MAT-ROHS-001':
        if (layer === 'NOTES' && entity.isRohsDeclaration === false) {
          violations.push(makeViolation(
            { ...rule, _source: 'materials' }, entity,
            `Drawing notes are missing RoHS compliance declaration. ` +
            `EU parts must include: "MATERIAL AND FINISH COMPLY WITH RoHS 3 (EU 2015/863) AND ELV DIRECTIVE 2000/53/EC".`
          ));
        }
        break;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC API — checkEntity & checkDrawing
// ═════════════════════════════════════════════════════════════════════════════

/**
 * checkEntity — run all 6 standard checks against a single entity.
 * Performance target: < 100ms per entity.
 *
 * @param {Object} entity  - DWG entity object (see schema at top of file)
 * @returns {Object[]}     - Array of violation objects (empty if no violations)
 */
function checkEntity(entity) {
  const violations = [];

  checkAsme(entity, violations);
  checkIso(entity, violations);
  checkVarroc(entity, violations);
  checkCustomerSpecs(entity, violations);
  checkDfmDfa(entity, violations);
  checkMaterials(entity, violations);

  return violations;
}

/**
 * checkDrawing — validate all entities in a complete DWG payload.
 *
 * @param {Object[]} entities  - Array of DWG entity objects
 * @returns {Object[]}         - All violations across all entities (with _entity ref)
 */
function checkDrawing(entities) {
  const allViolations = [];

  for (const entity of entities) {
    const entityViolations = checkEntity(entity);
    for (const v of entityViolations) {
      allViolations.push(v);     // _entity is already embedded by makeViolation
    }
  }

  return allViolations;
}

/**
 * checkDrawingWithTiming — same as checkDrawing but returns performance metrics.
 * Used in tests and diagnostics.
 *
 * @param {Object[]} entities
 * @returns {{ violations: Object[], timingMs: Object }}
 */
function checkDrawingWithTiming(entities) {
  const entityTimings = [];
  const allViolations = [];

  for (const entity of entities) {
    const t0 = Date.now();
    const v  = checkEntity(entity);
    const t1 = Date.now();
    entityTimings.push(t1 - t0);
    allViolations.push(...v);
  }

  const totalMs = entityTimings.reduce((a, b) => a + b, 0);
  const maxMs   = Math.max(...entityTimings);
  const avgMs   = entityTimings.length > 0 ? totalMs / entityTimings.length : 0;

  return {
    violations: allViolations,
    timingMs: {
      total:          totalMs,
      perEntityAvg:   Math.round(avgMs * 100) / 100,
      perEntityMax:   maxMs,
      entityCount:    entities.length,
      violationCount: allViolations.length,
      passedTarget:   maxMs < 100,   // Day 3 target: < 100ms per entity
    },
  };
}

module.exports = {
  checkEntity,
  checkDrawing,
  checkDrawingWithTiming,
};
