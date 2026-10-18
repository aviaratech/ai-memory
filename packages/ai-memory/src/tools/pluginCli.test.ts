import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

import { parsePluginArguments } from './pluginCli.js';
import { parseConsolidateArguments } from './consolidate.js';

describe('explicit fragment consolidation command', () => {
  it('defaults to one exact read-only project unit and requires independent reviewed bytes for apply', () => {
    assert.deepEqual(parseConsolidateArguments(['--project', 'demo-workshop/widget']), {
      mode: 'dry-run',
      selectors: { project: 'demo-workshop/widget', orgId: null, sensitivity: 'internal', limit: 50 },
    });
    assert.deepEqual(
      parseConsolidateArguments([
        '--apply',
        '--plan-file',
        'reviewed.json',
        '--expect-plan',
        `sha256:${'a'.repeat(64)}`,
        '--out',
        'receipt.json',
      ]),
      {
        mode: 'apply',
        planFile: 'reviewed.json',
        expectedDigest: 'a'.repeat(64),
        output: 'receipt.json',
      },
    );
  });
  it('refuses unknown, duplicate, unbounded, ambiguous or overridden apply selectors', () => {
    for (const args of [
      [],
      ['--project', 'widget'],
      ['--project', 'demo-workshop/widget', '--limit', '51'],
      ['--project', 'demo-workshop/widget', '--limit', '0'],
      ['--project', 'demo-workshop/widget', '--limit', '2.5'],
      ['--project', 'demo-workshop/widget', '--force'],
      ['--project', 'demo-workshop/widget', '--project', 'foreign/widget'],
      ['--apply'],
      ['--apply', '--dry-run'],
      ['--apply', '--plan-file', 'x', '--expect-plan', `sha256:${'a'.repeat(64)}`, '--project', 'demo-workshop/widget'],
      ['--project', 'demo-workshop/widget', '--plan-file', 'x'],
      ['--project', 'demo-workshop/widget', '--sensitivity', 'secret'],
    ])
      assert.throws(() => parseConsolidateArguments(args));
  });
  it('explains reviewed-plan consolidation without a database or host configuration', () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../dist/tools/pluginCli.js', import.meta.url)), 'consolidate', '--help'],
      { encoding: 'utf8', env: { PATH: process.env.PATH }, maxBuffer: 64 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--project/u);
    assert.match(result.stdout, /--expect-plan sha256:/u);
    assert.match(result.stdout, /--dry-run/u);
  });
});

describe('standalone plugin command contract', () => {
  it('requires explicit host, scope and exact install/update version', () => {
    for (const operation of ['install', 'update']) {
      assert.throws(
        () => parsePluginArguments(['plugin', operation, '--host', 'codex', '--scope', 'user']),
        /version/u,
      );
      assert.throws(
        () => parsePluginArguments(['plugin', operation, '--scope', 'user', '--version', '1.2.3']),
        /host/u,
      );
      assert.throws(
        () => parsePluginArguments(['plugin', operation, '--host', 'codex', '--version', '1.2.3']),
        /scope/u,
      );
      for (const version of ['latest', '^1.2.3', '../escape', '1.2']) {
        assert.throws(
          () => parsePluginArguments(['plugin', operation, '--host', 'codex', '--scope', 'user', '--version', version]),
          /version/u,
        );
      }
    }
  });

  it('uses the same five operations and flags for both native hosts', () => {
    for (const host of ['codex', 'claude-code']) {
      for (const operation of ['install', 'doctor', 'update', 'rollback', 'remove']) {
        const args = ['plugin', operation, '--host', host, '--scope', 'user', '--dry-run', '--json'];
        if (operation === 'install' || operation === 'update') args.push('--version', '1.2.3');
        const result = parsePluginArguments(args);
        assert.equal(result.host, host);
        assert.equal(result.operation, operation);
        assert.equal(result.scope, 'user');
        assert.equal(result.dryRun, true);
        assert.equal(result.json, true);
      }
    }
  });

  it('rejects unknown, duplicate or incomplete options before touching a host', () => {
    const base = ['plugin', 'doctor', '--host', 'codex', '--scope', 'user'];
    for (const tail of [['--repair'], ['--host', 'codex'], ['--version'], ['--scope', 'user']]) {
      assert.throws(() => parsePluginArguments([...base, ...tail]));
    }
    assert.throws(() => parsePluginArguments(['plugin', 'bootstrap', '--host', 'codex', '--scope', 'user']));
  });
});
