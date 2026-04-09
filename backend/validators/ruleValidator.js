'use strict';

/**
 * backend/validators/ruleValidator.js
 *
 * RuleValidator — Pure JS Class, 12 Engineering Rules, <100ms
 * ─────────────────────────────────────────────────────────────────────────────
 * The core validation engine. Checks a single entity (or full drawing) against
 * all loaded KB rules. Pure JS — no heavy libraries — so it stays fast.
 *
 * Usage:
 *   const { RuleValidator } = require('./validators/ruleValidator');
 *   const validator = new RuleValidator(loadedRules);  // pass rulesLoader.rules
 *   const violations = validator.validate(entity, drawingMeta);
 *
 * Entity schema (DWG payload):
 *   {
 *     entityId         : string   — unique entity identifier
 *     entityType       : string   — 'LINE' | 'ARC' | 'CIRCLE' | 'DIMENSION' |
 *                                   'AlignedDimension' | 'TOLERANCE' | 'MTEXT' |
 *                                   'TEXT' | 'HATCH' | 'BLOCK' | 'INSERT' | 'LEADER'
 *     layer            : string   — AutoCAD layer name
 *     gdtSymbol        : string?  — e.g. 'flatness', 'true_position'
 *     toleranceValue   : number?  — stated tolerance value (mm)
 *     nominalValue     : number?  — dimension nominal (mm)
 *     wallThickness    : number?  — mm
 *     draftAngle       : number?  — degrees
 *     blockName        : string?  — for INSERT entities
 *     datumRef         : string?  — datum letter referenced (e.g. 'A')
 *     materialCode     : string?  — e.g. 'AA6061-T6'
 *     textContent      : string?  — text string content
 *     fieldName        : string?  — title block attribute field name
 *   }
 *
 * DrawingMeta schema:
 *   {
 *     toleranceClass   : string   — 'f' | 'm' | 'c' | 'v' (from title block)
 *     datums           : string[] — datum identifiers present in drawing (e.g. ['A','B','C'])
 *     titleBlock       : { part_number, revision, material, engineer_name,
 *                          drawing_number, approval_signature }
 *     materialNote     : string?  — full material callout text
 *     customerProject  : string?  — customer code if customer specs apply
 *     customerRules    : Object[] — customer-specific rule objects (from customer_specs.yaml)
 *   }
 *
 * Violation object:
 *   {
 *     entityId         : string
 *     ruleId           : string   — e.g. 'RULE-03'
 *     ruleName         : string   — human readable rule name
 *     severity         : string   — 'Critical' | 'Major' | 'Minor'
 *     description      : string   — what failed and by how much
 *     suggestedFix     : string   — actionable steps
 *     standardCitation : string   — standard + rule reference
 *   }
 */

// ── ISO 2768 tolerance tables (embedded for zero-dependency fast lookup) ───────
const ISO_2768_LIMITS = {
  f: [             // fine
    { min: 0.5,   max: 3,    tol: 0.05 },
    { min: 3,     max: 30,   tol: 0.10 },
    { min: 30,    max: 120,  tol: 0.15 },
    { min: 120,   max: 400,  tol: 0.20 },
    { min: 400,   max: 1000, tol: 0.30 },
    { min: 1000,  max: 2000, tol: 0.50 },
  ],
  m: [             // medium (Varroc default)
    { min: 0.5,   max: 3,    tol: 0.10 },
    { min: 3,     max: 30,   tol: 0.20 },
    { min: 30,    max: 120,  tol: 0.30 },
    { min: 120,   max: 400,  tol: 0.50 },
    { min: 400,   max: 1000, tol: 0.80 },
    { min: 1000,  max: 2000, tol: 1.20 },
  ],
  c: [             // coarse
    { min: 0.5,   max: 3,    tol: 0.20 },
    { min: 3,     max: 30,   tol: 0.50 },
    { min: 30,    max: 120,  tol: 0.80 },
    { min: 120,   max: 400,  tol: 1.20 },
    { min: 400,   max: 1000, tol: 2.00 },
    { min: 1000,  max: 2000, tol: 3.00 },
  ],
  v: [             // very coarse
    { min: 0.5,   max: 3,    tol: 0.50 },
    { min: 3,     max: 30,   tol: 1.00 },
    { min: 30,    max: 120,  tol: 1.50 },
    { min: 120,   max: 400,  tol: 2.50 },
    { min: 400,   max: 1000, tol: 4.00 },
    { min: 1000,  max: 2000, tol: 6.00 },
  ],
};

// ── Lookup ISO 2768 tolerance for a given class + nominal dimension ────────────
function getIso2768Limit(toleranceClass, nominalMm) {
  const table = ISO_2768_LIMITS[(toleranceClass || 'm').toLowerCase()];
  if (!table) return null;
  const row = table.find(r => nominalMm >= r.min && nominalMm < r.max);
  return row ? row.tol : null;
}

// ── Valid ASME Y14.5 GD&T symbols ─────────────────────────────────────────────
const ASME_VALID_SYMBOLS = new Set([
  'flatness', 'straightness', 'circularity', 'cylindricity',
  'profile_of_a_line', 'profile_of_a_surface',
  'angularity', 'perpendicularity', 'parallelism',
  'true_position', 'concentricity', 'symmetry',
  'circular_runout', 'total_runout',
]);

// ── Varroc required layer names (from varroc_internal.yaml) ───────────────────
const VARROC_VALID_LAYERS = new Set([
  'DIMS', 'GDT', 'TITLEBLOCK', 'CENTER', 'HIDDEN',
  'SECTION', 'BORDER', 'NOTES', 'OBJECT', 'REFERENCE',
  'CONSTRUCTION', 'PHANTOM', 'DEFPOINTS',
]);

// ── Varroc approved block names ───────────────────────────────────────────────
const VARROC_APPROVED_BLOCKS = new Set([
  'VAR_DATUM_FLAG', 'VAR_GDT_FRAME', 'VAR_SURFACE_FINISH',
  'VAR_WELD_SYMBOL', 'VAR_TITLE_BLOCK_A0', 'VAR_TITLE_BLOCK_A1',
  'VAR_TITLE_BLOCK_A2', 'VAR_TITLE_BLOCK_A3', 'VAR_TITLE_BLOCK_A4',
  'VAR_REVISION_TABLE', 'VAR_NORTH_ARROW', 'VAR_SCALE_BAR',
]);

// ── Title block mandatory fields ──────────────────────────────────────────────
const TITLEBLOCK_MANDATORY_FIELDS = [
  'part_number', 'revision', 'material',
  'engineer_name', 'drawing_number', 'approval_signature',
];

// ── Material callout format regex ─────────────────────────────────────────────
const MATERIAL_CALLOUT_PATTERN = /^MATERIAL:\s+\S+.*TO\s+\S+/i;

// ══════════════════════════════════════════════════════════════════════════════
// RuleValidator CLASS
// ══════════════════════════════════════════════════════════════════════════════

class RuleValidator {
  /**
   * @param {Object} loadedRules  - The rules object from rulesLoader.js
   *                                Pass null to use built-in KB defaults.
   */
  constructor(loadedRules = null) {
    this._kb = loadedRules;

    // Build approved material code set from KB (or use empty set as safe fallback)
    this._approvedMaterials = new Set();
    if (loadedRules?.materials?.approvedMaterials) {
      for (const family of Object.values(loadedRules.materials.approvedMaterials)) {
        if (Array.isArray(family.codes)) {
          family.codes.forEach(c => this._approvedMaterials.add(c));
        }
      }
    }

    // Extract allowed GD&T symbols from KB if provided, else use built-in set
    this._validGdtSymbols = ASME_VALID_SYMBOLS;
    if (loadedRules?.asme?.rules) {
      const symbolRule = loadedRules.asme.rules.find(r => r.id === 'ASME-GDT-001');
      if (symbolRule?.allowedSymbols) {
        this._validGdtSymbols = new Set(symbolRule.allowedSymbols);
      }
    }

    // Extract approved blocks from KB if provided
    this._approvedBlocks = VARROC_APPROVED_BLOCKS;
    if (loadedRules?.varroc?.rules) {
      const blockRule = loadedRules.varroc.rules.find(r => r.id === 'VAR-BLOCK-001');
      if (blockRule?.approvedBlocks) {
        this._approvedBlocks = new Set(blockRule.approvedBlocks);
      }
    }

    // DFM thresholds from KB
    this._minWallThickness = 1.5;
    this._minDraftAngle = 1.5;
    if (loadedRules?.dfmDfa?.rules) {
      const wallRule  = loadedRules.dfmDfa.rules.find(r => r.id === 'DFM-001');
      const draftRule = loadedRules.dfmDfa.rules.find(r => r.id === 'DFM-003');
      if (wallRule?.minWallThickness)  this._minWallThickness = wallRule.minWallThickness;
      if (draftRule?.minDraftAngle)    this._minDraftAngle    = draftRule.minDraftAngle;
    }
  }

  // ── Violation factory ──────────────────────────────────────────────────────
  _violation(entity, ruleNum, ruleName, severity, description, suggestedFix, standardCitation) {
    return {
      entityId:         entity.entityId || `entity_${entity.entityType || 'UNKNOWN'}`,
      ruleId:           `RULE-${String(ruleNum).padStart(2, '0')}`,
      ruleName,
      severity,
      description,
      suggestedFix,
      standardCitation,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 1 — Layer Naming
  // Entity layer must match allowed layer patterns from varroc_internal.yaml
  // ══════════════════════════════════════════════════════════════════════════
  _rule01_layerNaming(entity) {
    const layer = (entity.layer || '').toUpperCase();
    if (!layer) {
      return this._violation(entity, 1,
        'Layer Naming — Entity Must Have a Named Layer',
        'Major',
        `Entity "${entity.entityType}" has no layer assigned. ` +
        `All entities must be on a named Varroc-approved layer.`,
        'Assign the entity to the correct layer (DIMS, GDT, NOTES, TITLEBLOCK, CENTER, HIDDEN, SECTION, BORDER, OBJECT).',
        'Varroc Internal Standard / VAR-LAYER-001'
      );
    }
    if (!VARROC_VALID_LAYERS.has(layer)) {
      return this._violation(entity, 1,
        'Layer Naming — Non-Standard Layer Name',
        'Major',
        `Entity "${entity.entityType}" is on layer "${entity.layer}" which is not ` +
        `in the Varroc approved layer set. Non-standard layer names prevent automated extraction.`,
        `Move entity to one of the approved layers: ${[...VARROC_VALID_LAYERS].join(', ')}.`,
        'Varroc Internal Standard / VAR-LAYER-001'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 2 — ISO 2768 Tolerance
  // If entity has toleranceValue, check it is within ISO 2768 limits
  // ══════════════════════════════════════════════════════════════════════════
  _rule02_isoTolerance(entity, drawingMeta) {
    if (entity.toleranceValue === undefined || entity.toleranceValue === null) return null;
    if (entity.nominalValue   === undefined || entity.nominalValue   === null) return null;

    const tolClass = (drawingMeta?.toleranceClass || 'm').toLowerCase();
    const nominal  = Math.abs(entity.nominalValue);
    const limit    = getIso2768Limit(tolClass, nominal);

    if (limit === null) return null; // dimension out of table range — no check

    const deviation = Math.abs(entity.toleranceValue);
    if (deviation > limit) {
      return this._violation(entity, 2,
        'ISO 2768 Tolerance — Dimension Out of Class Limits',
        'Major',
        `Tolerance ±${entity.toleranceValue}mm on ${nominal}mm nominal exceeds ` +
        `ISO 2768-${tolClass.toUpperCase()} limit of ±${limit}mm for this range ` +
        `(over by ${(deviation - limit).toFixed(4)}mm).`,
        `Tighten the manufacturing process to achieve ±${limit}mm, or switch to a tighter ` +
        `tolerance class and apply individual tolerance callout on the drawing.`,
        `ISO 2768:1989 / Tolerance Class ${tolClass.toUpperCase()} / RULE-02`
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 3 — GD&T Symbol
  // TOLERANCE entities must use only valid symbols from asme_y14_5.yaml
  // ══════════════════════════════════════════════════════════════════════════
  _rule03_gdtSymbol(entity) {
    if ((entity.entityType || '').toUpperCase() !== 'TOLERANCE') return null;
    if (!entity.gdtSymbol) {
      return this._violation(entity, 3,
        'GD&T Symbol — Missing Symbol',
        'Critical',
        `TOLERANCE entity has no GD&T symbol specified. ` +
        `Every feature control frame must include a valid GD&T characteristic symbol.`,
        `Set gdtSymbol to one of: ${[...this._validGdtSymbols].join(', ')}.`,
        'ASME Y14.5-2018 Section 3 / RULE-03'
      );
    }
    const symbol = entity.gdtSymbol.toLowerCase().replace(/\s+/g, '_');
    if (!this._validGdtSymbols.has(symbol)) {
      return this._violation(entity, 3,
        'GD&T Symbol — Invalid or Non-Standard Symbol',
        'Critical',
        `GD&T symbol "${entity.gdtSymbol}" is not in the ASME Y14.5-2018 approved symbol set. ` +
        `Non-standard symbols cannot be interpreted by manufacturing or CMM programs.`,
        `Replace "${entity.gdtSymbol}" with an approved symbol: ${[...this._validGdtSymbols].join(', ')}.`,
        'ASME Y14.5-2018 Section 3 / RULE-03'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 4 — Datum Reference
  // GD&T feature control frames must reference a datum that exists in the drawing
  // ══════════════════════════════════════════════════════════════════════════
  _rule04_datumReference(entity, drawingMeta) {
    if ((entity.entityType || '').toUpperCase() !== 'TOLERANCE') return null;

    // Only positional/orientation tolerances require datum references
    const DATUM_REQUIRED_SYMBOLS = new Set([
      'true_position', 'perpendicularity', 'angularity', 'parallelism',
      'circular_runout', 'total_runout', 'symmetry', 'concentricity',
    ]);
    const symbol = (entity.gdtSymbol || '').toLowerCase().replace(/\s+/g, '_');
    if (!DATUM_REQUIRED_SYMBOLS.has(symbol)) return null;

    const ref     = entity.datumRef;
    const datums  = drawingMeta?.datums ?? [];

    if (!ref) {
      return this._violation(entity, 4,
        'Datum Reference — Missing Datum Reference',
        'Critical',
        `GD&T ${entity.gdtSymbol} tolerance has no datum reference. ` +
        `${symbol} requires at least one primary datum per ASME Y14.5 Section 4.`,
        'Add the primary datum reference (e.g., |A|) to the feature control frame. ' +
        'Ensure the datum feature is identified with a datum flag on the drawing.',
        'ASME Y14.5-2018 Section 4 / RULE-04'
      );
    }
    if (datums.length > 0 && !datums.includes(ref.toUpperCase())) {
      return this._violation(entity, 4,
        'Datum Reference — Datum Not Defined on Drawing',
        'Critical',
        `GD&T feature control frame references datum "${ref}" which is not defined ` +
        `on this drawing. Defined datums: [${datums.join(', ')}].`,
        `Add a datum flag labelled "${ref}" to the corresponding datum feature, ` +
        `or correct the datum reference to an existing datum [${datums.join(', ')}].`,
        'ASME Y14.5-2018 Section 4 / RULE-04'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 5 — Dimension on Correct Layer
  // AlignedDimension entities must be on the DIMS layer
  // ══════════════════════════════════════════════════════════════════════════
  _rule05_dimensionLayer(entity) {
    const type  = (entity.entityType || '').toUpperCase();
    const layer = (entity.layer || '').toUpperCase();

    const DIMENSION_TYPES = new Set(['ALIGNEDDIMENSION', 'DIMENSION', 'LINEARDIMENSION',
                                     'ANGULARDIMENSION', 'RADIALDIMENSION', 'DIAMETERDIMENSION',
                                     'ORDINATEDIMENSION', 'LEADER']);
    if (!DIMENSION_TYPES.has(type)) return null;

    if (layer !== 'DIMS') {
      return this._violation(entity, 5,
        'Dimension Layer — Must Be on DIMS Layer',
        'Major',
        `${entity.entityType} entity is on layer "${entity.layer}" instead of "DIMS". ` +
        `All dimension and leader entities must reside on the DIMS layer for automated extraction.`,
        'Select all dimension entities and change their layer property to "DIMS" using the Layer dropdown or LAYMCH command.',
        'Varroc Internal Standard / VAR-LAYER-001 / RULE-05'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 6 — Title Block Completeness
  // All mandatory fields from varroc_internal.yaml must be non-empty
  // ══════════════════════════════════════════════════════════════════════════
  _rule06_titleBlockCompleteness(entity, drawingMeta) {
    // Only check MTEXT/TEXT entities on TITLEBLOCK layer, or the drawingMeta summary
    const type  = (entity.entityType || '').toUpperCase();
    const layer = (entity.layer || '').toUpperCase();

    if (!['MTEXT', 'TEXT', 'ATTDEF', 'ATTRIB'].includes(type)) return null;
    if (layer !== 'TITLEBLOCK') return null;
    if (!entity.fieldName) return null;

    if (TITLEBLOCK_MANDATORY_FIELDS.includes(entity.fieldName)) {
      const content = (entity.textContent || '').trim();
      if (!content) {
        return this._violation(entity, 6,
          'Title Block — Mandatory Field Empty',
          'Critical',
          `Title block field "${entity.fieldName}" is empty. ` +
          `All mandatory title block fields must be populated before drawing release: ` +
          `[${TITLEBLOCK_MANDATORY_FIELDS.join(', ')}].`,
          `Enter a valid value for "${entity.fieldName}" in the title block attribute editor. ` +
          `For part_number use format VAR-XXXXX-XX. For drawing_number use format DWG-XXXXX.`,
          'Varroc Internal Standard / VAR-TITLE-001 through VAR-TITLE-006 / RULE-06'
        );
      }
    }

    // Extra: validate part_number format
    if (entity.fieldName === 'part_number' && entity.textContent?.trim()) {
      const pn = entity.textContent.trim();
      if (!/^VAR-\d{5}-\d{2}$/.test(pn)) {
        return this._violation(entity, 6,
          'Title Block — Part Number Format Invalid',
          'Critical',
          `Part number "${pn}" does not match required format VAR-XXXXX-XX.`,
          'Correct the part number to follow the format VAR-XXXXX-XX (e.g. VAR-12345-01). Obtain from the PDM system.',
          'Varroc Internal Standard / VAR-TITLE-001 / RULE-06'
        );
      }
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 7 — Approved Block Library
  // INSERT entities must use block names from varroc_internal.yaml approved_blocks
  // ══════════════════════════════════════════════════════════════════════════
  _rule07_approvedBlockLibrary(entity) {
    const type = (entity.entityType || '').toUpperCase();
    if (!['BLOCK', 'INSERT'].includes(type)) return null;
    if (!entity.blockName) return null;

    if (!this._approvedBlocks.has(entity.blockName)) {
      return this._violation(entity, 7,
        'Approved Block Library — Non-Standard Block Used',
        'Major',
        `Block "${entity.blockName}" is not from the Varroc approved library (VAR_STD_BLOCKS_v2024). ` +
        `Unapproved blocks may contain obsolete symbol geometry or incorrect standards references.`,
        `Delete the non-standard block and re-insert from VAR_STD_BLOCKS_v2024 library using ` +
        `the DesignCenter (ADCENTER command). Do not explode approved blocks.`,
        'Varroc Internal Standard / VAR-BLOCK-001 / RULE-07'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 8 — DFM Wall Thickness
  // Wall feature thickness must be above minimum from dfm_dfa.yaml (min 1.5mm)
  // ══════════════════════════════════════════════════════════════════════════
  _rule08_dfmWallThickness(entity) {
    if (entity.wallThickness === undefined || entity.wallThickness === null) return null;

    const min = this._minWallThickness;
    if (entity.wallThickness < min) {
      return this._violation(entity, 8,
        'DFM — Wall Thickness Below Minimum',
        'Critical',
        `Wall thickness ${entity.wallThickness}mm is below the minimum ${min}mm for injection moulding. ` +
        `Walls thinner than ${min}mm cause incomplete fill (short shot), weld line weakness, and warpage. ` +
        `Deficient by ${(min - entity.wallThickness).toFixed(3)}mm.`,
        `Increase wall thickness to at least ${min}mm. If design space is constrained, ` +
        `specify a glass-fibre reinforced grade (PP-GF30) which may allow 1.2mm walls. ` +
        `Run mould flow simulation before tool manufacture.`,
        'DFM/DFA Rules / DFM-001 / RULE-08'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 9 — DFM Draft Angle
  // Surface entities must have required draft angle for casting/moulding (min 1.5°)
  // ══════════════════════════════════════════════════════════════════════════
  _rule09_dfmDraftAngle(entity) {
    if (entity.draftAngle === undefined || entity.draftAngle === null) return null;

    const min = this._minDraftAngle;
    if (entity.draftAngle < min) {
      return this._violation(entity, 9,
        'DFM — Draft Angle Below Minimum',
        'Critical',
        `Draft angle ${entity.draftAngle}° is below the minimum ${min}° for injection moulding. ` +
        `Walls with less than 1.0° draft cause part sticking during ejection, surface drag marks, ` +
        `and mould tool damage.`,
        `Increase wall draft to at least ${min}° (3.0° for textured surfaces). ` +
        `Update the 3D CAD model, regenerate the drawing, and notify the tooling team. ` +
        `Verify with mould flow analysis.`,
        'DFM/DFA Rules / DFM-003 / RULE-09'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 10 — Material Callout Format
  // Drawing must have material specification annotation matching materials.yaml format
  // ══════════════════════════════════════════════════════════════════════════
  _rule10_materialCallout(entity) {
    // Check MTEXT/TEXT on NOTES layer that looks like a material callout
    const type    = (entity.entityType || '').toUpperCase();
    const layer   = (entity.layer || '').toUpperCase();
    const content = (entity.textContent || '').trim();

    if (!['MTEXT', 'TEXT'].includes(type)) return null;
    if (layer !== 'NOTES') return null;
    if (!content.toUpperCase().startsWith('MATERIAL')) return null;

    if (!MATERIAL_CALLOUT_PATTERN.test(content)) {
      return this._violation(entity, 10,
        'Material Callout — Non-Standard Format',
        'Critical',
        `Material callout "${content}" does not follow the required Varroc format. ` +
        `Required format: "MATERIAL: <code> TO <standard> [TREATMENT]". ` +
        `Example: "MATERIAL: AA6061-T6 TO EN 573-3".`,
        'Rewrite the material note using the standard format: ' +
        '"MATERIAL: <material_code> TO <standard_code>". ' +
        'Add surface treatment after the standard reference if applicable.',
        'Varroc Materials Standard / MAT-FORMAT-001 / RULE-10'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 11 — Approved Material Code
  // The material code in the annotation must exist in materials.yaml approved list
  // ══════════════════════════════════════════════════════════════════════════
  _rule11_approvedMaterial(entity) {
    const type    = (entity.entityType || '').toUpperCase();
    const layer   = (entity.layer || '').toUpperCase();
    const matCode = (entity.materialCode || '').trim();

    if (!['MTEXT', 'TEXT'].includes(type)) return null;
    if (layer !== 'NOTES') return null;
    if (!matCode) return null;

    // If no KB loaded, skip (safe fallback)
    if (this._approvedMaterials.size === 0) return null;

    if (!this._approvedMaterials.has(matCode)) {
      return this._violation(entity, 11,
        'Approved Material — Unapproved Material Code',
        'Critical',
        `Material code "${matCode}" is not in the Varroc approved materials list. ` +
        `Using unapproved materials risks supply chain issues, certification failures, ` +
        `and customer reject.`,
        'Submit a Material Approval Request (MAR) to Materials Engineering before using this code. ' +
        'Alternatively, replace with an approved equivalent from the materials.yaml approved list. ' +
        'Obtain written approval before updating production drawings.',
        'Varroc Materials Standard / MAT-CODE-001 / RULE-11'
      );
    }
    return null; // PASS
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RULE 12 — Customer Spec Check
  // If customer_specs.yaml is loaded for this project, check customer-specific rules
  // ══════════════════════════════════════════════════════════════════════════
  _rule12_customerSpec(entity, drawingMeta) {
    // No customer project → no check
    if (!drawingMeta?.customerProject) return null;
    const customerRules = drawingMeta?.customerRules ?? [];
    if (customerRules.length === 0) return null;

    const violations = [];
    for (const custRule of customerRules) {
      // Skip template placeholder rules
      if (custRule.placeholderNote) continue;

      // Customer dimension tolerance check
      if (custRule.id === 'CUST-DIM-001' && custRule.nominalValue !== undefined) {
        if (entity.nominalValue !== undefined && entity.toleranceValue !== undefined) {
          const limit = custRule.upperTolerance ?? 0.05;
          if (Math.abs(entity.toleranceValue) > limit) {
            violations.push(this._violation(entity, 12,
              `Customer Spec — ${drawingMeta.customerProject} Tolerance Exceeded`,
              'Critical',
              `Customer "${drawingMeta.customerProject}" requires ±${limit}mm tolerance on ` +
              `"${custRule.targetDimension || 'critical dimension'}". ` +
              `Drawing specifies ±${entity.toleranceValue}mm ` +
              `(ref: ${custRule.customerReference || 'customer spec'}).`,
              'Tighten process capability to achieve the customer tolerance requirement. ' +
              'Obtain written waiver from customer engineering if the tolerance cannot be met.',
              `Customer Spec ${drawingMeta.customerProject} / ${custRule.id} / RULE-12`
            ));
          }
        }
      }
    }
    return violations.length > 0 ? violations[0] : null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC: validate(entity, drawingMeta)
  // Runs all 12 rules against a single entity. Returns array of violations.
  // Performance target: <100ms per entity.
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * @param {Object}  entity      - DWG entity object
   * @param {Object}  drawingMeta - Drawing-level metadata (tolerance class, datums, etc.)
   * @returns {Object[]}  Array of violation objects (empty = all rules pass)
   */
  validate(entity, drawingMeta = {}) {
    const violations = [];

    const checks = [
      this._rule01_layerNaming(entity),
      this._rule02_isoTolerance(entity, drawingMeta),
      this._rule03_gdtSymbol(entity),
      this._rule04_datumReference(entity, drawingMeta),
      this._rule05_dimensionLayer(entity),
      this._rule06_titleBlockCompleteness(entity, drawingMeta),
      this._rule07_approvedBlockLibrary(entity),
      this._rule08_dfmWallThickness(entity),
      this._rule09_dfmDraftAngle(entity),
      this._rule10_materialCallout(entity),
      this._rule11_approvedMaterial(entity),
      this._rule12_customerSpec(entity, drawingMeta),
    ];

    for (const result of checks) {
      if (result) violations.push(result);
    }

    return violations;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC: validateDrawing(entities, drawingMeta)
  // Validates all entities in a full DWG payload. Returns all violations.
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * @param {Object[]} entities    - Array of DWG entity objects
   * @param {Object}   drawingMeta - Drawing-level metadata
   * @returns {{ violations: Object[], timingMs: Object }}
   */
  validateDrawing(entities, drawingMeta = {}) {
    const t0     = Date.now();
    const all    = [];
    const timings= [];

    for (const entity of entities) {
      const te = Date.now();
      const v  = this.validate(entity, drawingMeta);
      timings.push(Date.now() - te);
      all.push(...v);
    }

    const total  = Date.now() - t0;
    const maxMs  = timings.length > 0 ? Math.max(...timings) : 0;
    const avgMs  = timings.length > 0
      ? Math.round((timings.reduce((a, b) => a + b, 0) / timings.length) * 100) / 100
      : 0;

    return {
      violations: all,
      timingMs: {
        total,
        perEntityAvg:   avgMs,
        perEntityMax:   maxMs,
        entityCount:    entities.length,
        violationCount: all.length,
        passedTarget:   maxMs < 100,
      },
    };
  }
}

module.exports = { RuleValidator, getIso2768Limit, ASME_VALID_SYMBOLS };
