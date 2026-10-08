import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'ai-memory-stage-assets-'));
after(() => rmSync(root, { recursive: true, force: true }));
for (const directory of ['scripts', 'src/tools/eval/fixtures', 'dist/tools'])
  mkdirSync(join(root, directory), { recursive: true });
copyFileSync(
  new URL('../packages/ai-memory/scripts/stage-assets.mjs', import.meta.url),
  join(root, 'scripts/stage-assets.mjs'),
);
writeFileSync(join(root, 'src/tools/eval/fixtures/sample.json'), '{}');
writeFileSync(join(root, 'src/tools/eval/search-eval-fixtures.json'), '{}');
writeFileSync(join(root, 'dist/tools/server.js'), 'export {};\n');
const declaration = (field, values) =>
  `${field}: z.ZodOptional<z.ZodEnum<{\n${values.map(value => `    ${value}: "${value}";`).join('\n')}\n}>>;\n`;
const unaffected =
  declaration('memoryType', ['episodic', 'semantic', 'procedural', 'reflective']).repeat(2) +
  declaration('sensitivity', ['confidential', 'internal', 'public', 'restricted']) +
  declaration('memoryDetail', ['compact', 'full']);
const canonical =
  unaffected +
  declaration('status', ['contested', 'active', 'archived', 'expired', 'superseded']) +
  declaration('strategy_confidence', ['high', 'medium', 'low']).repeat(2);

test('stages identical declarations for different TypeScript enum emission orders', () => {
  const orders = [
    [
      ['active', 'contested', 'superseded', 'expired', 'archived'],
      ['low', 'medium', 'high'],
    ],
    [
      ['superseded', 'archived', 'expired', 'active', 'contested'],
      ['medium', 'high', 'low'],
    ],
  ];
  for (const [status, confidence] of orders) {
    const path = join(root, 'dist/tools/server.d.ts');
    writeFileSync(
      path,
      unaffected + declaration('status', status) + declaration('strategy_confidence', confidence).repeat(2),
    );
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

test('ships the same self-contained plugin bytes inside the runtime package', () => {
  const repository = new URL('../', import.meta.url);
  const core = JSON.parse(readFileSync(new URL('packages/ai-memory/package.json', repository), 'utf8'));
  const plugin = JSON.parse(readFileSync(new URL('plugins/ai-memory/package.json', repository), 'utf8'));
  assert.ok(core.files.includes('plugins'));
  assert.ok(core.bin['ai-memory']);
  const portable = JSON.parse(readFileSync(new URL('plugins/ai-memory/plugin.json', repository), 'utf8'));
  const claude = JSON.parse(readFileSync(new URL('plugins/ai-memory/.claude-plugin/plugin.json', repository), 'utf8'));
  assert.equal(portable.name, 'ai-memory');
  assert.equal(portable.version, core.version);
  assert.equal(claude.version, core.version);
  assert.equal(plugin.version, core.version);
  for (const name of [
    'LICENSE',
    'plugin.json',
    'mcp.json',
    '.mcp.json',
    '.claude-plugin/plugin.json',
    'dist/mcp-launcher.js',
    'dist/mcp-server.bundle.js',
    'hooks/hooks.json',
    'skills/memory-lifecycle/SKILL.md',
    'skills/memory-ops/SKILL.md',
  ]) {
    assert.deepEqual(
      readFileSync(new URL(`packages/ai-memory/plugins/ai-memory/${name}`, repository)),
      readFileSync(new URL(`plugins/ai-memory/${name}`, repository)),
      name,
    );
  }
  const migrations = new URL('packages/ai-memory/migrations/', repository);
  for (const name of readdirSync(migrations)) {
    assert.deepEqual(
      readFileSync(new URL(`plugins/ai-memory/migrations/${name}`, repository)),
      readFileSync(new URL(name, migrations)),
      name,
    );
    assert.deepEqual(
      readFileSync(new URL(`packages/ai-memory/plugins/ai-memory/migrations/${name}`, repository)),
      readFileSync(new URL(name, migrations)),
      name,
    );
  }
});

test('the installed npm bin symlink executes the selected package version', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/ai-memory/package.json', import.meta.url), 'utf8'));
  const executable = join(root, 'ai-memory-bin');
  symlinkSync(fileURLToPath(new URL('../packages/ai-memory/dist/tools/pluginCli.js', import.meta.url)), executable);
  const result = spawnSync(process.execPath, [executable, '--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), manifest.version);
});
