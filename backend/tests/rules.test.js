'use strict';

/**
 * backend/tests/rules.test.js
 *
 * Jest Test Suite — RuleValidator (12 Rules)
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests PASS and FAIL case for every single rule.
 * Also includes a demo DWG payload with 3 intentional violations for showcase.
 *
 * Run: npx jest tests/rules.test.js --verbose
 */

const { RuleValidator, getIso2768Limit } = require('../validators/ruleValidator');

// ── Instantiate validator with no KB (uses built-in defaults) ─────────────────
const validator = new RuleValidator(null);

// ── Try to load KB for material/block-aware tests ─────────────────────────────
let validatorWithKb;
try {
  const { rules } = require('../rules/rulesLoader');
  validatorWithKb = new RuleValidator(rules);
} catch {
  validatorWithKb = validator; // fallback if KB not available
}

// ── Common drawingMeta fixture ────────────────────────────────────────────────
const META = {
  toleranceClass: 'm',           // ISO 2768 medium
  datums: ['A', 'B', 'C'],
  titleBlock: {
    part_number: 'VAR-12345-01',
    revision: 'A',
    material: 'AA6061-T6',
    engineer_name: 'R. Sharma',
    drawing_number: 'DWG-00042',
    approval_signature: 'V. Patil',
  },
  materialNote: 'MATERIAL: AA6061-T6 TO EN 573-3',
  customerProject: null,
  customerRules: [],
};

// ── Helper: first violation from validate() ────────────────────────────────────
function firstViolation(entity, meta = META) {
  const v = validator.validate(entity, meta);
  return v.length > 0 ? v[0] : null;
}

function noViolations(entity, meta = META) {
  return validator.validate(entity, meta).length === 0;
}

// ═════════════════════════════════════════════════════════════════════════════
// ISO 2768 Utility Test
// ═════════════════════════════════════════════════════════════════════════════
describe('ISO 2768 Tolerance Table', () => {
  test('getIso2768Limit returns correct limit for medium class 80mm nominal', () => {
    expect(getIso2768Limit('m', 80)).toBe(0.30);
  });
  test('getIso2768Limit returns correct limit for fine class 80mm nominal', () => {
    expect(getIso2768Limit('f', 80)).toBe(0.15);
  });
  test('getIso2768Limit returns correct limit for coarse class 15mm nominal', () => {
    expect(getIso2768Limit('c', 15)).toBe(0.50);
  });
  test('getIso2768Limit returns null for dimensions outside table range', () => {
    expect(getIso2768Limit('m', 0.1)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 1 — Layer Naming
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-01 — Layer Naming', () => {
  test('PASS: entity on approved layer DIMS', () => {
    const entity = { entityId: 'e1', entityType: 'LINE', layer: 'DIMS' };
    expect(noViolations(entity)).toBe(true);
  });

  test('PASS: entity on approved layer NOTES', () => {
    const entity = { entityId: 'e2', entityType: 'MTEXT', layer: 'NOTES' };
    expect(noViolations(entity)).toBe(true);
  });

  test('FAIL: entity on non-standard layer "MY_CUSTOM_LAYER"', () => {
    const entity = { entityId: 'e3', entityType: 'LINE', layer: 'MY_CUSTOM_LAYER' };
    const v = firstViolation(entity);
    expect(v).not.toBeNull();
    expect(v.ruleId).toBe('RULE-01');
    expect(v.severity).toBe('Major');
    expect(v.description).toContain('MY_CUSTOM_LAYER');
    expect(v.standardCitation).toContain('VAR-LAYER-001');
  });

  test('FAIL: entity with no layer assigned', () => {
    const entity = { entityId: 'e4', entityType: 'ARC', layer: '' };
    const v = firstViolation(entity);
    expect(v).not.toBeNull();
    expect(v.ruleId).toBe('RULE-01');
    expect(v.description).toContain('no layer assigned');
  });

  test('violation object has all required fields', () => {
    const entity = { entityId: 'e5', entityType: 'LINE', layer: 'BAD_LAYER' };
    const v = firstViolation(entity);
    expect(v).toHaveProperty('entityId');
    expect(v).toHaveProperty('ruleId');
    expect(v).toHaveProperty('ruleName');
    expect(v).toHaveProperty('severity');
    expect(v).toHaveProperty('description');
    expect(v).toHaveProperty('suggestedFix');
    expect(v).toHaveProperty('standardCitation');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 2 — ISO 2768 Tolerance
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-02 — ISO 2768 Tolerance', () => {
  test('PASS: tolerance ±0.25mm on 80mm nominal (within medium class ±0.30mm)', () => {
    const entity = {
      entityId: 'e10', entityType: 'DIMENSION', layer: 'DIMS',
      nominalValue: 80, toleranceValue: 0.25,
    };
    expect(noViolations(entity)).toBe(true);
  });

  test('PASS: entity with no toleranceValue is skipped', () => {
    const entity = { entityId: 'e11', entityType: 'DIMENSION', layer: 'DIMS' };
    expect(noViolations(entity)).toBe(true);
  });

  test('FAIL: tolerance ±0.45mm on 80mm nominal exceeds medium class ±0.30mm', () => {
    const entity = {
      entityId: 'e12', entityType: 'DIMENSION', layer: 'DIMS',
      nominalValue: 80, toleranceValue: 0.45,
    };
    const v = firstViolation(entity);
    expect(v).not.toBeNull();
    expect(v.ruleId).toBe('RULE-02');
    expect(v.severity).toBe('Major');
    expect(v.description).toContain('0.45mm');
    expect(v.description).toContain('0.3mm');
  });

  test('FAIL: tolerance ±0.12mm on 80mm nominal exceeds fine class ±0.15mm', () => {
    const entity = {
      entityId: 'e13', entityType: 'DIMENSION', layer: 'DIMS',
      nominalValue: 80, toleranceValue: 0.18,
    };
    const metaFine = { ...META, toleranceClass: 'f' };
    const v = validator.validate(entity, metaFine);
    expect(v.some(x => x.ruleId === 'RULE-02')).toBe(true);
  });

  test('PASS: tolerance within coarse class limits', () => {
    const entity = {
      entityId: 'e14', entityType: 'DIMENSION', layer: 'DIMS',
      nominalValue: 80, toleranceValue: 0.70,  // coarse limit is ±0.80
    };
    const metaCoarse = { ...META, toleranceClass: 'c' };
    const v = validator.validate(entity, metaCoarse);
    expect(v.filter(x => x.ruleId === 'RULE-02')).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 3 — GD&T Symbol
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-03 — GD&T Symbol', () => {
  test('PASS: valid GD&T symbol "flatness" on TOLERANCE entity', () => {
    const entity = { entityId: 'e20', entityType: 'TOLERANCE', layer: 'GDT', gdtSymbol: 'flatness' };
    expect(noViolations(entity)).toBe(true);
  });

  test('PASS: valid GD&T symbol "true_position"', () => {
    const entity = {
      entityId: 'e21', entityType: 'TOLERANCE', layer: 'GDT',
      gdtSymbol: 'true_position', datumRef: 'A',
    };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-03')).toHaveLength(0);
  });

  test('PASS: non-TOLERANCE entity skips GD&T rule', () => {
    const entity = { entityId: 'e22', entityType: 'LINE', layer: 'DIMS', gdtSymbol: 'flatness' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-03')).toHaveLength(0);
  });

  test('FAIL: invalid GD&T symbol "runout_zone" (not in ASME Y14.5)', () => {
    const entity = { entityId: 'e23', entityType: 'TOLERANCE', layer: 'GDT', gdtSymbol: 'runout_zone' };
    const v = firstViolation(entity);
    expect(v).not.toBeNull();
    expect(v.ruleId).toBe('RULE-03');
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('runout_zone');
  });

  test('FAIL: TOLERANCE entity with no gdtSymbol', () => {
    const entity = { entityId: 'e24', entityType: 'TOLERANCE', layer: 'GDT' };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-03');
    expect(v).toBeDefined();
    expect(v.description).toContain('no GD&T symbol');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 4 — Datum Reference
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-04 — Datum Reference', () => {
  test('PASS: true_position references datum A which exists in drawing', () => {
    const entity = {
      entityId: 'e30', entityType: 'TOLERANCE', layer: 'GDT',
      gdtSymbol: 'true_position', datumRef: 'A',
    };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-04')).toHaveLength(0);
  });

  test('PASS: flatness does not require datum reference', () => {
    const entity = { entityId: 'e31', entityType: 'TOLERANCE', layer: 'GDT', gdtSymbol: 'flatness' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-04')).toHaveLength(0);
  });

  test('FAIL: perpendicularity with no datumRef', () => {
    const entity = {
      entityId: 'e32', entityType: 'TOLERANCE', layer: 'GDT',
      gdtSymbol: 'perpendicularity',
    };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-04');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('no datum reference');
  });

  test('FAIL: true_position references datum D which is not defined on drawing', () => {
    const entity = {
      entityId: 'e33', entityType: 'TOLERANCE', layer: 'GDT',
      gdtSymbol: 'true_position', datumRef: 'D',
    };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-04');
    expect(v).toBeDefined();
    expect(v.description).toContain('datum "D"');
    expect(v.description).toContain('not defined');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 5 — Dimension on Correct Layer
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-05 — Dimension on Correct Layer', () => {
  test('PASS: AlignedDimension on DIMS layer', () => {
    const entity = { entityId: 'e40', entityType: 'AlignedDimension', layer: 'DIMS' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-05')).toHaveLength(0);
  });

  test('PASS: DIMENSION on DIMS layer', () => {
    const entity = { entityId: 'e41', entityType: 'DIMENSION', layer: 'DIMS' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-05')).toHaveLength(0);
  });

  test('PASS: LINE entity is not a dimension — rule skipped', () => {
    const entity = { entityId: 'e42', entityType: 'LINE', layer: 'DIMS' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-05')).toHaveLength(0);
  });

  test('FAIL: AlignedDimension on OBJECT layer instead of DIMS', () => {
    const entity = { entityId: 'e43', entityType: 'AlignedDimension', layer: 'OBJECT' };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-05');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Major');
    expect(v.description).toContain('OBJECT');
    expect(v.description).toContain('DIMS');
  });

  test('FAIL: DIMENSION on NOTES layer', () => {
    const entity = { entityId: 'e44', entityType: 'DIMENSION', layer: 'NOTES' };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-05');
    expect(v).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 6 — Title Block Completeness
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-06 — Title Block Completeness', () => {
  test('PASS: part_number with valid format VAR-12345-01', () => {
    const entity = {
      entityId: 'e50', entityType: 'MTEXT', layer: 'TITLEBLOCK',
      fieldName: 'part_number', textContent: 'VAR-12345-01',
    };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-06')).toHaveLength(0);
  });

  test('PASS: revision field populated', () => {
    const entity = {
      entityId: 'e51', entityType: 'MTEXT', layer: 'TITLEBLOCK',
      fieldName: 'revision', textContent: 'B',
    };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-06')).toHaveLength(0);
  });

  test('FAIL: revision field is empty', () => {
    const entity = {
      entityId: 'e52', entityType: 'MTEXT', layer: 'TITLEBLOCK',
      fieldName: 'revision', textContent: '',
    };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-06');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('"revision"');
  });

  test('FAIL: part_number in wrong format "12345"', () => {
    const entity = {
      entityId: 'e53', entityType: 'MTEXT', layer: 'TITLEBLOCK',
      fieldName: 'part_number', textContent: '12345',
    };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-06');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('VAR-XXXXX-XX');
  });

  test('FAIL: approval_signature field is empty', () => {
    const entity = {
      entityId: 'e54', entityType: 'MTEXT', layer: 'TITLEBLOCK',
      fieldName: 'approval_signature', textContent: '   ',
    };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-06');
    expect(v).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 7 — Approved Block Library
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-07 — Approved Block Library', () => {
  test('PASS: INSERT using approved block VAR_DATUM_FLAG', () => {
    const entity = { entityId: 'e60', entityType: 'INSERT', layer: 'GDT', blockName: 'VAR_DATUM_FLAG' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-07')).toHaveLength(0);
  });

  test('PASS: INSERT using approved block VAR_GDT_FRAME', () => {
    const entity = { entityId: 'e61', entityType: 'INSERT', layer: 'GDT', blockName: 'VAR_GDT_FRAME' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-07')).toHaveLength(0);
  });

  test('PASS: LINE entity skips block rule', () => {
    const entity = { entityId: 'e62', entityType: 'LINE', layer: 'DIMS', blockName: 'CUSTOM_BLOCK' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-07')).toHaveLength(0);
  });

  test('FAIL: INSERT using non-approved block "MY_COMPANY_TITLE_BLOCK"', () => {
    const entity = { entityId: 'e63', entityType: 'INSERT', layer: 'BORDER', blockName: 'MY_COMPANY_TITLE_BLOCK' };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-07');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Major');
    expect(v.description).toContain('MY_COMPANY_TITLE_BLOCK');
    expect(v.suggestedFix).toContain('VAR_STD_BLOCKS_v2024');
  });

  test('FAIL: BLOCK entity with custom legacy block name', () => {
    const entity = { entityId: 'e64', entityType: 'BLOCK', layer: 'BORDER', blockName: 'LEGACY_SYMBOL_V1' };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-07');
    expect(v).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 8 — DFM Wall Thickness
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-08 — DFM Wall Thickness', () => {
  test('PASS: wall thickness 2.0mm is above minimum 1.5mm', () => {
    const entity = { entityId: 'e70', entityType: 'DIMENSION', layer: 'DIMS', wallThickness: 2.0 };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-08')).toHaveLength(0);
  });

  test('PASS: wall thickness exactly at minimum 1.5mm', () => {
    const entity = { entityId: 'e71', entityType: 'LINE', layer: 'DIMS', wallThickness: 1.5 };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-08')).toHaveLength(0);
  });

  test('PASS: entity with no wallThickness skips rule', () => {
    const entity = { entityId: 'e72', entityType: 'LINE', layer: 'DIMS' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-08')).toHaveLength(0);
  });

  test('FAIL: wall thickness 1.1mm is below minimum 1.5mm', () => {
    const entity = { entityId: 'e73', entityType: 'DIMENSION', layer: 'DIMS', wallThickness: 1.1 };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-08');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('1.1mm');
    expect(v.description).toContain('1.5mm');
    expect(v.description).toContain('0.400mm');
  });

  test('FAIL: wall thickness 0.8mm — severely under minimum', () => {
    const entity = { entityId: 'e74', entityType: 'LINE', layer: 'DIMS', wallThickness: 0.8 };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-08');
    expect(v).toBeDefined();
    expect(v.description).toContain('short shot');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 9 — DFM Draft Angle
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-09 — DFM Draft Angle', () => {
  test('PASS: draft angle 2.0° is above minimum 1.5°', () => {
    const entity = { entityId: 'e80', entityType: 'LINE', layer: 'DIMS', draftAngle: 2.0 };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-09')).toHaveLength(0);
  });

  test('PASS: draft angle at exactly 1.5°', () => {
    const entity = { entityId: 'e81', entityType: 'LINE', layer: 'DIMS', draftAngle: 1.5 };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-09')).toHaveLength(0);
  });

  test('PASS: entity with no draftAngle skips rule', () => {
    const entity = { entityId: 'e82', entityType: 'LINE', layer: 'DIMS' };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-09')).toHaveLength(0);
  });

  test('FAIL: draft angle 0.8° is below minimum 1.5°', () => {
    const entity = { entityId: 'e83', entityType: 'LINE', layer: 'DIMS', draftAngle: 0.8 };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-09');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('0.8°');
    expect(v.description).toContain('1.5°');
    expect(v.description).toContain('sticking');
  });

  test('FAIL: draft angle 0.0° — no draft', () => {
    const entity = { entityId: 'e84', entityType: 'LINE', layer: 'DIMS', draftAngle: 0.0 };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-09');
    expect(v).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 10 — Material Callout Format
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-10 — Material Callout Format', () => {
  test('PASS: correctly formatted material callout', () => {
    const entity = {
      entityId: 'e90', entityType: 'MTEXT', layer: 'NOTES',
      textContent: 'MATERIAL: AA6061-T6 TO EN 573-3',
    };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-10')).toHaveLength(0);
  });

  test('PASS: material callout with surface treatment', () => {
    const entity = {
      entityId: 'e91', entityType: 'MTEXT', layer: 'NOTES',
      textContent: 'MATERIAL: S355JR TO EN 10025-2, ZINC PHOSPHATE + EPOXY PRIMER',
    };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-10')).toHaveLength(0);
  });

  test('PASS: MTEXT on DIMS layer is not a material callout — skipped', () => {
    const entity = {
      entityId: 'e92', entityType: 'MTEXT', layer: 'DIMS',
      textContent: 'MATERIAL: AA6061-T6',
    };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-10')).toHaveLength(0);
  });

  test('FAIL: material callout missing "TO <standard>" part', () => {
    const entity = {
      entityId: 'e93', entityType: 'MTEXT', layer: 'NOTES',
      textContent: 'MATERIAL: AA6061-T6',
    };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-10');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('TO <standard>');
  });

  test('FAIL: bare material note without MATERIAL: prefix formatting', () => {
    const entity = {
      entityId: 'e94', entityType: 'MTEXT', layer: 'NOTES',
      textContent: 'MATERIAL AA6061 SEE SPEC',
    };
    const v = validator.validate(entity, META).find(x => x.ruleId === 'RULE-10');
    expect(v).toBeDefined();
    expect(v.suggestedFix).toContain('MATERIAL: <material_code> TO <standard_code>');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 11 — Approved Material Code
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-11 — Approved Material Code', () => {
  // Use validator with full KB for material code lookups
  test('PASS: AA6061-T6 is in approved materials list', () => {
    const entity = {
      entityId: 'e100', entityType: 'MTEXT', layer: 'NOTES',
      materialCode: 'AA6061-T6', textContent: 'MATERIAL: AA6061-T6 TO EN 573-3',
    };
    expect(validatorWithKb.validate(entity, META).filter(v => v.ruleId === 'RULE-11')).toHaveLength(0);
  });

  test('PASS: PP-GF30 is in approved materials list', () => {
    const entity = {
      entityId: 'e101', entityType: 'MTEXT', layer: 'NOTES',
      materialCode: 'PP-GF30', textContent: 'MATERIAL: PP-GF30 TO ISO 1043',
    };
    expect(validatorWithKb.validate(entity, META).filter(v => v.ruleId === 'RULE-11')).toHaveLength(0);
  });

  test('PASS: entity with no materialCode skips rule', () => {
    const entity = { entityId: 'e102', entityType: 'MTEXT', layer: 'NOTES', textContent: 'GENERAL NOTE' };
    expect(validatorWithKb.validate(entity, META).filter(v => v.ruleId === 'RULE-11')).toHaveLength(0);
  });

  test('FAIL: non-approved material code "A380-CUSTOM"', () => {
    const entity = {
      entityId: 'e103', entityType: 'MTEXT', layer: 'NOTES',
      materialCode: 'A380-CUSTOM', textContent: 'MATERIAL: A380-CUSTOM TO ASTM B85',
    };
    const v = validatorWithKb.validate(entity, META).find(x => x.ruleId === 'RULE-11');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('A380-CUSTOM');
    expect(v.description).toContain('approved materials list');
  });

  test('FAIL: made-up plastic code "PP-SUPER-V1" not in approved list', () => {
    const entity = {
      entityId: 'e104', entityType: 'MTEXT', layer: 'NOTES',
      materialCode: 'PP-SUPER-V1', textContent: 'MATERIAL: PP-SUPER-V1 TO IN-HOUSE-SPEC',
    };
    const v = validatorWithKb.validate(entity, META).find(x => x.ruleId === 'RULE-11');
    expect(v).toBeDefined();
    expect(v.suggestedFix).toContain('Material Approval Request');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RULE 12 — Customer Spec Check
// ═════════════════════════════════════════════════════════════════════════════
describe('RULE-12 — Customer Spec Check', () => {
  const custRules = [{
    id: 'CUST-DIM-001',
    targetDimension: 'Mounting boss diameter',
    nominalValue: 12.0,
    upperTolerance: 0.03,
    customerReference: 'HES-100 Section 4.2.1',
  }];

  const metaWithCustomer = {
    ...META,
    customerProject: 'HONDA',
    customerRules: custRules,
  };

  test('PASS: no customerProject → rule 12 skipped', () => {
    const entity = { entityId: 'e110', entityType: 'DIMENSION', layer: 'DIMS', toleranceValue: 0.1 };
    expect(validator.validate(entity, META).filter(v => v.ruleId === 'RULE-12')).toHaveLength(0);
  });

  test('PASS: tolerance ±0.02mm within customer limit ±0.03mm', () => {
    const entity = {
      entityId: 'e111', entityType: 'DIMENSION', layer: 'DIMS',
      nominalValue: 12.0, toleranceValue: 0.02,
    };
    expect(validator.validate(entity, metaWithCustomer).filter(v => v.ruleId === 'RULE-12')).toHaveLength(0);
  });

  test('FAIL: tolerance ±0.05mm exceeds customer limit ±0.03mm', () => {
    const entity = {
      entityId: 'e112', entityType: 'DIMENSION', layer: 'DIMS',
      nominalValue: 12.0, toleranceValue: 0.05,
    };
    const v = validator.validate(entity, metaWithCustomer).find(x => x.ruleId === 'RULE-12');
    expect(v).toBeDefined();
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('HONDA');
    expect(v.description).toContain('0.05mm');
    expect(v.standardCitation).toContain('CUST-DIM-001');
  });

  test('PASS: customerRules with placeholderNote are skipped', () => {
    const entity = { entityId: 'e113', entityType: 'DIMENSION', layer: 'DIMS', toleranceValue: 0.9 };
    const metaWithPlaceholder = {
      ...META,
      customerProject: 'GENERIC',
      customerRules: [{ id: 'CUST-DIM-001', placeholderNote: 'Replace this' }],
    };
    expect(validator.validate(entity, metaWithPlaceholder).filter(v => v.ruleId === 'RULE-12')).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DEMO DWG PAYLOAD — 3 intentional violations for demonstration
// ═════════════════════════════════════════════════════════════════════════════
describe('DEMO Drawing — 3 Intentional Violations for Showcase', () => {
  // This is the demo DWG payload that will be shown in the UI.
  // 8 entities total; 3 contain deliberate violations for the demo.

  const demoEntities = [
    // ── Entity 1: PASS — valid dimension on correct layer ───────────────────
    {
      entityId: 'DWG-E001', entityType: 'AlignedDimension', layer: 'DIMS',
      nominalValue: 45.0, toleranceValue: 0.2,
      parameterName: 'Flange width',
    },
    // ── Entity 2: PASS — valid GD&T flatness ───────────────────────────────
    {
      entityId: 'DWG-E002', entityType: 'TOLERANCE', layer: 'GDT',
      gdtSymbol: 'flatness',
      parameterName: 'Sealing face',
    },
    // ── Entity 3: PASS — correctly formatted material callout ───────────────
    {
      entityId: 'DWG-E003', entityType: 'MTEXT', layer: 'NOTES',
      textContent: 'MATERIAL: EN-GJL-250 TO EN 1561',
      materialCode: 'EN-GJL-250',
    },
    // ── Entity 4: PASS — valid title block part number ─────────────────────
    {
      entityId: 'DWG-E004', entityType: 'MTEXT', layer: 'TITLEBLOCK',
      fieldName: 'part_number', textContent: 'VAR-99001-03',
    },

    // ────────────────────────────────────────────────────────────────────────
    // VIOLATION 1 — AlignedDimension on wrong layer (OBJECT instead of DIMS)
    // Demonstrates: Rule 5 — Dimension on Correct Layer
    // ────────────────────────────────────────────────────────────────────────
    {
      entityId: 'DWG-E005', entityType: 'AlignedDimension', layer: 'OBJECT',
      nominalValue: 120.0,
      parameterName: 'Housing length',
      _demoNote: 'INTENTIONAL VIOLATION — Wrong layer for dimension',
    },

    // ────────────────────────────────────────────────────────────────────────
    // VIOLATION 2 — GD&T true_position with no datum reference
    // Demonstrates: Rule 4 — Datum Reference
    // ────────────────────────────────────────────────────────────────────────
    {
      entityId: 'DWG-E006', entityType: 'TOLERANCE', layer: 'GDT',
      gdtSymbol: 'true_position',
      // datumRef intentionally omitted
      parameterName: 'Mounting hole position',
      _demoNote: 'INTENTIONAL VIOLATION — Missing datum reference',
    },

    // ────────────────────────────────────────────────────────────────────────
    // VIOLATION 3 — Wall thickness below DFM minimum (1.1mm < 1.5mm)
    // Demonstrates: Rule 8 — DFM Wall Thickness
    // ────────────────────────────────────────────────────────────────────────
    {
      entityId: 'DWG-E007', entityType: 'DIMENSION', layer: 'DIMS',
      wallThickness: 1.1,
      parameterName: 'Housing rear wall',
      _demoNote: 'INTENTIONAL VIOLATION — Wall too thin for moulding',
    },

    // ── Entity 8: PASS — title block revision ─────────────────────────────
    {
      entityId: 'DWG-E008', entityType: 'MTEXT', layer: 'TITLEBLOCK',
      fieldName: 'revision', textContent: 'A',
    },
  ];

  let demoResult;

  beforeAll(() => {
    demoResult = validator.validateDrawing(demoEntities, META);
  });

  test('Demo drawing has exactly 3 violations', () => {
    expect(demoResult.violations).toHaveLength(3);
  });

  test('Violation 1 is RULE-05 — AlignedDimension on OBJECT layer', () => {
    const v = demoResult.violations.find(x => x.entityId === 'DWG-E005');
    expect(v).toBeDefined();
    expect(v.ruleId).toBe('RULE-05');
    expect(v.severity).toBe('Major');
    expect(v.description).toContain('OBJECT');
  });

  test('Violation 2 is RULE-04 — true_position missing datum reference', () => {
    const v = demoResult.violations.find(x => x.entityId === 'DWG-E006');
    expect(v).toBeDefined();
    expect(v.ruleId).toBe('RULE-04');
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('datum reference');
  });

  test('Violation 3 is RULE-08 — wall thickness 1.1mm below minimum', () => {
    const v = demoResult.violations.find(x => x.entityId === 'DWG-E007');
    expect(v).toBeDefined();
    expect(v.ruleId).toBe('RULE-08');
    expect(v.severity).toBe('Critical');
    expect(v.description).toContain('1.1mm');
  });

  test('Performance: max rule check time per entity < 100ms', () => {
    expect(demoResult.timingMs.perEntityMax).toBeLessThan(100);
  });

  test('Performance: average rule check time < 5ms per entity', () => {
    expect(demoResult.timingMs.perEntityAvg).toBeLessThan(5);
  });

  test('All violation objects have all 7 required fields', () => {
    const REQUIRED = ['entityId', 'ruleId', 'ruleName', 'severity', 'description', 'suggestedFix', 'standardCitation'];
    for (const v of demoResult.violations) {
      for (const field of REQUIRED) {
        expect(v).toHaveProperty(field);
        expect(v[field]).toBeTruthy();
      }
    }
  });

  test('All severities are valid values', () => {
    const VALID = new Set(['Critical', 'Major', 'Minor']);
    for (const v of demoResult.violations) {
      expect(VALID.has(v.severity)).toBe(true);
    }
  });
});
