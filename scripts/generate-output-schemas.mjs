#!/usr/bin/env node
// Writes src/generated/output-schemas.json from the public API spec: one JSON
// Schema per component, plus a map from "METHOD /path" to the component that
// endpoint returns. Tools that pass an API response through declare it as their
// outputSchema (src/tools/outputs.ts), so the schema an agent sees is the API
// contract itself rather than a hand-written copy of it.
//
// The SDK validates every structuredContent against the declared outputSchema
// and turns a mismatch into a tool ERROR, so a schema stricter than what the API
// actually sends breaks a working tool, and keeps breaking it on every installed
// version. The spec is strict in exactly those ways, so each schema is loosened:
//   - additionalProperties: false (on all 65 components) is dropped, or a field
//     the API adds later would fail every older MCP version;
//   - required is dropped and every type also admits null, so an omitted or
//     null field never fails;
//   - enum and format are dropped (enum values move into the description), so
//     a new enum value or an unusual timestamp never fails.
// What stays is every field, its type and its description.
//
// OpenAPI 3.0's `nullable` is folded into the type, and component refs point at
// $defs. Run through `npm run generate:api`; CI fails if the output drifts.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = resolve(pkgDir, '../../apps/management-api/public-v1-openapi.json');
const outPath = join(pkgDir, 'src/generated/output-schemas.json');

const DROPPED = new Set(['required', 'nullable', 'format', 'example', 'enum', 'readOnly', 'writeOnly', 'deprecated']);
const COMPONENT = '#/components/schemas/';

function loosen(schema) {
  if (Array.isArray(schema)) return schema.map(loosen);
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    return { anyOf: [{ $ref: `#/$defs/${schema.$ref.slice(COMPONENT.length)}` }, { type: 'null' }] };
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED.has(key)) continue;
    if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value).map(([name, s]) => [name, loosen(s)]));
    } else if (key === 'additionalProperties') {
      if (value !== false) out.additionalProperties = loosen(value);
    } else if (key === 'items' || key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
      out[key] = loosen(value);
    } else {
      out[key] = value;
    }
  }
  if (typeof out.type === 'string') out.type = [out.type, 'null'];
  if (Array.isArray(schema.enum)) {
    const listed = schema.enum.every((v) => (out.description ?? '').includes(String(v)));
    if (!listed) out.description = [out.description, `One of: ${schema.enum.join(', ')}.`].filter(Boolean).join(' ');
  }
  return out;
}

const spec = JSON.parse(await readFile(specPath, 'utf8'));

const endpoints = {};
for (const [path, operations] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(operations)) {
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      const ref = response.content?.['application/json']?.schema?.$ref;
      if (status.startsWith('2') && ref) endpoints[`${method.toUpperCase()} ${path}`] = ref.slice(COMPONENT.length);
    }
  }
}

const $defs = Object.fromEntries(
  Object.entries(spec.components.schemas).map(([name, schema]) => [name, loosen(schema)]),
);

await writeFile(outPath, `${JSON.stringify({ endpoints, $defs }, null, 2)}\n`);
console.log(`[generate-output-schemas] ${Object.keys(endpoints).length} endpoints, ${Object.keys($defs).length} schemas`);
