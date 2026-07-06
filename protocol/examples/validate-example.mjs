// ============================================================
// DATAGLOW Protocol — standalone validation example
// ============================================================
// Demonstrates that a DATAGLOW-exported JSON object can be validated against the
// published protocol schemas WITHOUT the DATAGLOW browser app and WITHOUT any
// third-party dependency. It uses only:
//   - Node's built-in fs
//   - protocol/validator.mjs (the zero-dependency validator DATAGLOW ships)
//
// This is the "any device" proof: any client that can read JSON can consume the
// DATAGLOW protocol.
//
// USAGE:
//   node protocol/examples/validate-example.mjs                 # bundled sample
//   node protocol/examples/validate-example.mjs my-export.json  # your own export
//
// Exit code 0 = valid; non-zero = invalid or error.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validate, buildRegistry } from '../validator.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, '..', 'schema');

// Load every protocol schema and index it by $id so cross-file $refs resolve.
const schemas = readdirSync(schemaDir)
  .filter(f => f.endsWith('.schema.json'))
  .map(f => JSON.parse(readFileSync(join(schemaDir, f), 'utf8')));
const registry = buildRegistry(schemas);

// Pick the right schema for a payload. For DATAGLOW objects we can discriminate
// on well-known fields; here we detect a ProvenanceAttestation by its "kind".
function schemaFor(payload) {
  if (payload && payload.kind === 'dataglow-provenance-attestation') {
    return schemas.find(s => s.$id.endsWith('provenance-attestation.schema.json'));
  }
  if (payload && payload.integrity && payload.plausibility) {
    return schemas.find(s => s.$id.endsWith('grade-result.schema.json'));
  }
  if (payload && payload.layers) {
    return schemas.find(s => s.$id.endsWith('validation-run.schema.json'));
  }
  if (payload && typeof payload.text === 'string' && payload.source) {
    return schemas.find(s => s.$id.endsWith('story-output.schema.json'));
  }
  return null;
}

const path = process.argv[2] || join(here, 'sample-attestation.json');
const payload = JSON.parse(readFileSync(path, 'utf8'));

const schema = schemaFor(payload);
if (!schema) {
  console.error(`Could not determine a protocol schema for ${path}.`);
  process.exit(2);
}

const { valid, errors } = validate(payload, schema, registry);

console.log(`Validating ${path}`);
console.log(`  against ${schema.title} (${schema.$id})`);
if (valid) {
  console.log('  ✓ VALID — payload conforms to the DATAGLOW protocol.');
  process.exit(0);
} else {
  console.log('  ✗ INVALID:');
  for (const e of errors) console.log(`    • ${e}`);
  process.exit(1);
}
