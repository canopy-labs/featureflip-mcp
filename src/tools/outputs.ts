import { fromJsonSchema } from '@modelcontextprotocol/server';
import generated from '../generated/output-schemas.json' with { type: 'json' };

// outputSchema for every tool. A tool that passes an API response through takes
// its endpoint's schema from the public spec (scripts/generate-output-schemas.mjs
// explains why those are loosened); a tool that builds its own result describes
// it here. Every schema is an object at the root, as MCP requires.
//
// The SDK checks structuredContent against these and turns a mismatch into a tool
// error, so nothing here may be stricter than what the tool actually returns:
// extra fields are always allowed, and `required` only names fields the tool sets
// on every success path.

type JsonSchema = Record<string, unknown>;

const defs = generated.$defs as Record<string, JsonSchema>;
const endpoints = generated.endpoints as Record<string, string>;

export const nullable = (type: string): JsonSchema => ({ type: [type, 'null'] });

/** A reference to a public API schema, by its component name in the spec. */
export function ref(name: string): JsonSchema {
  if (!defs[name]) throw new Error(`no API schema named ${name}`);
  return { $ref: `#/$defs/${name}` };
}

/** What `METHOD /api/v1/...` returns, exactly as the spec's paths spell it. */
export function endpoint(route: string): JsonSchema {
  const name = endpoints[route];
  if (!name) throw new Error(`the public API spec has no JSON response for ${route}`);
  return ref(name);
}

// Only the definitions a schema actually reaches, so tools/list doesn't carry all 65 per tool.
function reachable(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) reachable(item, found);
  } else if (schema && typeof schema === 'object') {
    for (const [key, value] of Object.entries(schema)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
        const name = value.slice('#/$defs/'.length);
        if (!found.has(name)) {
          found.add(name);
          reachable(defs[name], found);
        }
      } else {
        reachable(value, found);
      }
    }
  }
  return found;
}

function build(root: JsonSchema) {
  const names = [...reachable(root)].sort();
  const schema: JsonSchema = { ...root, type: 'object' };
  if (names.length) schema.$defs = Object.fromEntries(names.map((n) => [n, defs[n]]));
  return fromJsonSchema(schema);
}

/** A tool that returns an API response unchanged. */
export function apiOutput(route: string) {
  const name = endpoints[route];
  if (!name) throw new Error(`the public API spec has no JSON response for ${route}`);
  return build({ ...defs[name], type: 'object' });
}

/** A tool that returns an API response with fields of its own added. */
export function apiOutputWith(route: string, properties: Record<string, JsonSchema>) {
  const name = endpoints[route];
  if (!name) throw new Error(`the public API spec has no JSON response for ${route}`);
  const base = defs[name];
  return build({ ...base, properties: { ...(base.properties as object), ...properties } });
}

/** A tool that builds its own object. */
export function objectOutput(properties: Record<string, JsonSchema>, required: string[] = [], description?: string) {
  return build({ properties, ...(required.length ? { required } : {}), ...(description ? { description } : {}) });
}

/** A tool whose result depends on its `action`: any one of these shapes. */
export function oneOfOutputs(...shapes: JsonSchema[]) {
  return build({ anyOf: shapes });
}

/** The object shape objectOutput builds, for use inside oneOfOutputs. */
export function shape(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}
