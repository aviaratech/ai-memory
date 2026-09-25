import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = resolve(root, 'src/eval/fixtures');
const destination = resolve(root, 'dist/eval/fixtures');
mkdirSync(dirname(destination), { recursive: true });
cpSync(fixtures, destination, { recursive: true });
for (const name of ['search-eval-fixtures.json']) {
  const staged = resolve(root, 'dist/eval', name);
  cpSync(resolve(root, 'src/eval', name), staged);
  chmodSync(staged, 0o644);
}

// TypeScript/Zod can emit these enum properties in a different order across
// platforms. Keep the declarations and the executable bit stable for npm pack.
const declarationPath = resolve(root, 'dist/server.d.ts');
let declaration = readFileSync(declarationPath, 'utf8');
/** @type {Array<[string, string[], number]>} */
const enumOrders = [
  ['memoryType', ['episodic', 'semantic', 'procedural', 'reflective'], 2],
  ['sensitivity', ['confidential', 'internal', 'public', 'restricted'], 1],
  ['memoryDetail', ['compact', 'full'], 1],
];
for (const [field, order, expectedCount] of enumOrders) {
  let count = 0;
  const expression = new RegExp(`(^\\s*${field}: z\\.ZodOptional<z\\.ZodEnum<\\{\\n)([\\s\\S]*?)(^\\s*\\}>>;)`, 'gm');
  /** @type {(_match: string, head: string, body: string, tail: string) => string} */
  const reorder = (_match, head, body, tail) => {
    count += 1;
    const lines = body.trimEnd().split('\n');
    const byKey = new Map(
      lines.map(line => {
        const match = line.match(/^\s+([A-Za-z]+): "([A-Za-z]+)";$/);
        assert.ok(match, `Unexpected declaration line for ${field}`);
        assert.equal(match[1], match[2]);
        return [match[1], line];
      }),
    );
    assert.deepEqual([...byKey.keys()].sort(), [...order].sort());
    return `${head}${order.map(key => byKey.get(key)).join('\n')}\n${tail}`;
  };
  declaration = declaration.replace(expression, reorder);
  assert.equal(count, expectedCount, `Unexpected ${field} declaration count`);
}
writeFileSync(declarationPath, declaration);
chmodSync(resolve(root, 'dist/server.js'), 0o755);
