#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getPackageVersion } from '../version.js';

export interface PluginOptions {
  operation: 'install' | 'doctor' | 'update' | 'rollback' | 'remove';
  host: 'codex' | 'claude-code';
  scope: 'user' | 'project' | 'local';
  version?: string;
  dryRun: boolean;
  json: boolean;
}

const USAGE = `ai-memory plugin install|doctor|update|rollback|remove --host codex|claude-code --scope user|project|local [--version X.Y.Z] [--dry-run] [--json]
Install/update require the exact version of this released runtime package.
Codex supports user scope; unsupported scopes are reported without mutation.
Doctor is read-only. Installation never initializes PostgreSQL or trusts hooks.
See the installation guide for protected configuration and required host restart/trust.`;

export function parsePluginArguments(args: string[]): PluginOptions {
  const [command, operation, ...flags] = args;
  if (command !== 'plugin' || !['install', 'doctor', 'update', 'rollback', 'remove'].includes(operation ?? '')) {
    throw new Error(USAGE);
  }
  const values = new Map<string, string | boolean>();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === undefined || values.has(flag)) throw new Error('Duplicate plugin option.');
    if (flag === '--dry-run' || flag === '--json') values.set(flag, true);
    else if (flag === '--host' || flag === '--scope' || flag === '--version') {
      const value = flags[++index];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing ${flag} value.`);
      values.set(flag, value);
    } else throw new Error(`Unsupported plugin option: ${flag}.`);
  }
  const host = values.get('--host');
  const scope = values.get('--scope');
  const version = values.get('--version');
  if (host !== 'codex' && host !== 'claude-code') throw new Error('Select --host codex|claude-code.');
  if (scope !== 'user' && scope !== 'project' && scope !== 'local')
    throw new Error('Select --scope user|project|local.');
  if (version !== undefined && (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version))) {
    throw new Error('Select an exact released --version X.Y.Z.');
  }
  if ((operation === 'install' || operation === 'update') && version === undefined) {
    throw new Error('Install/update require an explicit --version X.Y.Z.');
  }
  if ((operation === 'rollback' || operation === 'remove') && version !== undefined) {
    throw new Error('Rollback/remove use the owned installation receipt; omit --version.');
  }
  return {
    operation: operation as PluginOptions['operation'],
    host,
    scope,
    ...(typeof version === 'string' ? { version } : {}),
    dryRun: values.get('--dry-run') === true,
    json: values.get('--json') === true,
  };
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write(`${getPackageVersion()}\n`);
    return;
  }
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const options = parsePluginArguments(args);
  const { runPluginOperation } = await import('./pluginInstallation.js');
  const result = await runPluginOperation(options);
  process.stdout.write(
    options.json ? `${JSON.stringify(result)}\n` : `${result.state}: ${result.message}\n${result.actions.join('\n')}\n`,
  );
  process.exitCode = result.ok ? 0 : 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  void main(process.argv.slice(2)).catch(() => {
    const json = process.argv.includes('--json');
    const result = {
      ok: false,
      state: 'failed',
      message:
        'Plugin operation failed. Check options and run plugin doctor; recover an interrupted replacement with plugin rollback.',
    };
    process.stderr.write(json ? `${JSON.stringify(result)}\n` : `${result.message}\n${USAGE}\n`);
    process.exitCode = 2;
  });
}
