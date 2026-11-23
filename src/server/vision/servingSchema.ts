/**
 * Gemini structured output rejects schemas whose constraint automaton is too large ("The specified schema produces
 * a constraint that has too many states for serving" — observed live on 2026-11-23 with nested maxItems).
 * Model-facing schemas therefore carry only types, enums, required fields and descriptions; every size/range limit
 * is enforced on the server after parsing (zod + clamping). This helper strips those keywords recursively.
 */
const CONSTRAINT_KEYS = new Set(['maxItems', 'minItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'maxLength', 'minLength', 'pattern', 'format']);

export function servingSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((s) => servingSchema(s)) as T;
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (CONSTRAINT_KEYS.has(k)) continue;
      out[k] = k === 'enum' || k === 'required' ? v : servingSchema(v);
    }
    return out as T;
  }
  return schema;
}

/** True if the schema (recursively) still contains a size/range constraint keyword. */
export function hasServingConstraints(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(hasServingConstraints);
  if (schema && typeof schema === 'object') {
    return Object.entries(schema as Record<string, unknown>).some(([k, v]) => CONSTRAINT_KEYS.has(k) || (k !== 'enum' && hasServingConstraints(v)));
  }
  return false;
}
