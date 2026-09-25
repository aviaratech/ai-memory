import { build } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(plugin, '..', '..');
const dist = resolve(plugin, 'dist');
mkdirSync(dist, { recursive: true });
await build({
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  bundle: true,
  entryPoints: [resolve(root, 'packages/ai-memory-tools/dist/server.js')],
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
writeFileSync(
  resolve(dist, 'mcp-launcher.js'),
  "import { spawn } from 'node:child_process';\nimport { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst root = dirname(fileURLToPath(import.meta.url));\nconst child = spawn(process.execPath, [resolve(root, 'mcp-server.bundle.js'), ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });\nchild.on('exit', code => { process.exitCode = code ?? 1; });\n",
);
