import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(plugin, '..', '..');
const dist = resolve(plugin, 'dist');
mkdirSync(dist, { recursive: true });
await build({
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  bundle: true,
  entryPoints: [resolve(root, 'packages/ai-memory/dist/tools/server.js')],
  external: ['node:*'],
  format: 'esm',
  ignoreAnnotations: true,
  minify: false,
  outfile: resolve(dist, 'mcp-server.bundle.js'),
  platform: 'node',
  sourcemap: false,
  target: 'node24',
});
cpSync(resolve(root, 'packages/ai-memory/migrations'), resolve(plugin, 'migrations'), { recursive: true });
await build({
  bundle: true,
  entryPoints: [resolve(plugin, 'scripts/launcher.mjs')],
  external: ['node:*'],
  format: 'esm',
  outfile: resolve(dist, 'mcp-launcher.js'),
  platform: 'node',
  target: 'node24',
});

// Keep npm's embedded plugin and the existing GitHub plugin archive identical.
// This runs after the canonical runtime/bundle build; installation never builds.
const manifest = /** @type {{files: string[]}} */ (JSON.parse(readFileSync(resolve(plugin, 'package.json'), 'utf8')));
const stagedPlugin = resolve(root, 'packages/ai-memory/plugins/ai-memory');
rmSync(stagedPlugin, { recursive: true, force: true });
mkdirSync(stagedPlugin, { recursive: true });
for (const name of ['package.json', ...manifest.files]) {
  cpSync(resolve(plugin, name), resolve(stagedPlugin, name), { recursive: true });
}
