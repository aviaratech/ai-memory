import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { parsePluginArguments } from './pluginCli.js';

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
