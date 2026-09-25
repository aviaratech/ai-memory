import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = resolve(root, 'src/eval/fixtures');
const destination = resolve(root, 'dist/eval/fixtures');
mkdirSync(dirname(destination), { recursive: true });
cpSync(fixtures, destination, { recursive: true });
for (const name of ['search-eval-fixtures.json']) {
  cpSync(resolve(root, 'src/eval', name), resolve(root, 'dist/eval', name));
}
