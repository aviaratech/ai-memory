import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'ai-memory-stage-assets-'));
after(() => rmSync(root, { recursive: true, force: true }));
for (const directory of ['scripts', 'src/tools/eval/fixtures', 'dist/tools']) mkdirSync(join(root, directory), { recursive: true });
copyFileSync(new URL('../packages/ai-memory/scripts/stage-assets.mjs', import.meta.url), join(root, 'scripts/stage-assets.mjs'));
writeFileSync(join(root, 'src/tools/eval/fixtures/sample.json'), '{}');
writeFileSync(join(root, 'src/tools/eval/search-eval-fixtures.json'), '{}');
writeFileSync(join(root, 'dist/tools/server.js'), 'export {};\n');
const declaration = (field, values) => `${field}: z.ZodOptional<z.ZodEnum<{\n${values.map(value => `    ${value}: "${value}";`).join('\n')}\n}>>;\n`;
const unaffected = declaration('memoryType', ['episodic', 'semantic', 'procedural', 'reflective']).repeat(2) +
  declaration('sensitivity', ['confidential', 'internal', 'public', 'restricted']) + declaration('memoryDetail', ['compact', 'full']);
const canonical = unaffected +
  declaration('status', ['contested', 'active', 'archived', 'expired', 'superseded']) +
  declaration('strategy_confidence', ['high', 'medium', 'low']).repeat(2);

test('stages identical declarations for different TypeScript enum emission orders', () => {
  const orders = [
    [['active', 'contested', 'superseded', 'expired', 'archived'], ['low', 'medium', 'high']],
    [['superseded', 'archived', 'expired', 'active', 'contested'], ['medium', 'high', 'low']],
  ];
  for (const [status, confidence] of orders) {
    const path = join(root, 'dist/tools/server.d.ts');
    writeFileSync(path, unaffected + declaration('status', status) + declaration('strategy_confidence', confidence).repeat(2));
    const result = spawnSync(process.execPath, [join(root, 'scripts/stage-assets.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(path, 'utf8'), canonical);
  }
});

test('fails closed when a normalized enum gains an unknown value', () => {
  const path = join(root, 'dist/tools/server.d.ts');
  writeFileSync(path, canonical.replace('    active: "active";', '    active: "active";\n    unknown: "unknown";'));
  const result = spawnSync(process.execPath, [join(root, 'scripts/stage-assets.mjs')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AssertionError/);
});
