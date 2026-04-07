const { z } = require('zod');

const EntitySchema = z.object({
  entityId: z.string(),
  entityType: z.string(),
  layer: z.string(),
  geometryPoints: z.array(z.any()).optional(),
  boundingBox: z.any().optional(),
  textContent: z.string().optional(),
  toleranceValue: z.string().optional(),
  blockName: z.string().optional(),
});

const DrawingSchema = z.object({
  drawingName: z.string(),
  units: z.string(),
  scale: z.string(),
  standardsProfile: z.string(),
  titleBlock: z.object({
    partNumber: z.string(),
    revision: z.string(),
    drawnBy: z.string(),
    date: z.string(),
    toleranceClass: z.string(),
  }),
  entities: z.array(EntitySchema),
});

module.exports = { DrawingSchema, EntitySchema };