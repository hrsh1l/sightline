import { describe, expect, it } from 'vitest';
import { hasServingConstraints, servingSchema } from './servingSchema.js';
import { EXTRACTION_RESPONSE_SCHEMA } from './GeminiVision.js';
import { REGION_RESPONSE_SCHEMA } from './detailRead.js';
import { LOCATE_RESPONSE_SCHEMA } from './locate.js';
import { GUIDE_RESPONSE_SCHEMA } from './guideExtract.js';

describe('model-facing response schemas are servable (regression: live 400 "too many states")', () => {
  it.each([
    ['extraction', EXTRACTION_RESPONSE_SCHEMA],
    ['regions', REGION_RESPONSE_SCHEMA],
    ['locate', LOCATE_RESPONSE_SCHEMA],
    ['guide', GUIDE_RESPONSE_SCHEMA],
  ])('%s schema has no size/range constraint keywords', (_name, schema) => {
    expect(hasServingConstraints(schema)).toBe(false);
  });
  it('strips nested constraints but keeps enums, required and descriptions', () => {
    const s = servingSchema({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'array', maxItems: 3, description: 'd', items: { type: 'string', enum: ['x', 'maxItems'], maxLength: 4 } } },
    });
    expect(s).toEqual({ type: 'object', required: ['a'], properties: { a: { type: 'array', description: 'd', items: { type: 'string', enum: ['x', 'maxItems'] } } } });
  });
});
