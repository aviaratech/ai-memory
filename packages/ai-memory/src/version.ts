import { readFileSync } from 'node:fs';

export function getPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    !['@aviaratech/ai-memory', '@aviaratech/ai-memory-plugin'].includes(String(manifest.name)) ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.version)
  ) {
    throw new Error('Restore the matching released ai-memory package manifest.');
  }
  return manifest.version;
}
