import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const script = new URL('./ci-package-archives.mjs', import.meta.url);
const fixture = action => {
  const directory = mkdtempSync(join(tmpdir(), 'memory-ci-archives-'));
  try {
    for (const [label, name] of [
      ['core', '@aviaratech/ai-memory'],
      ['plugin', '@aviaratech/ai-memory-plugin'],
    ]) {
      const record = {
        name,
        version: '0.3.2',
        filename: name.slice(1).replace('/', '-') + '-0.3.2.tgz',
        files: [{ path: 'package.json' }],
      };
      for (const kind of ['dry-run', 'pack'])
        writeFileSync(join(directory, `${label}-${kind}.json`), JSON.stringify([record]));
      writeFileSync(join(directory, record.filename), label);
    }
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const run = (directory, commit = 'a'.repeat(40)) =>
  spawnSync(process.execPath, [script.pathname, directory, commit, 'b'.repeat(40), 'c'.repeat(40), '123', '2'], {
    encoding: 'utf8',
    env: {},
  });

test('retains only both existing archives with digest and actual checkout/source identities', () =>
  fixture(directory => {
    const result = run(directory);
    assert.equal(result.status, 0);
    const manifest = JSON.parse(readFileSync(join(directory, 'source-digests.json'), 'utf8'));
    assert.deepEqual(manifest, {
      checkoutCommit: 'a'.repeat(40),
      checkoutTree: 'b'.repeat(40),
      pullRequestSourceHead: 'c'.repeat(40),
      runId: '123',
      runAttempt: '2',
      archives: [
        {
          basename: 'aviaratech-ai-memory-0.3.2.tgz',
          size: 4,
          sha256: '0d45f5fd462b8c70bffb10021ac1bcff3f58f29b1faf7568595095427d42812c',
        },
        {
          basename: 'aviaratech-ai-memory-plugin-0.3.2.tgz',
          size: 6,
          sha256: '5e689e2b01672bf33996e75d5e372ff60c536ce1599a1458e867cd8f4bef5160',
        },
      ],
    });
    assert.equal(readFileSync(join(directory, manifest.archives[0].basename), 'utf8'), 'core');
  }));

test('missing, extra or linked archives cannot produce a digest sidecar', () => {
  for (const change of [
    directory => rmSync(join(directory, 'aviaratech-ai-memory-0.3.2.tgz')),
    directory => writeFileSync(join(directory, 'unexpected.tgz'), 'extra'),
    directory => {
      const file = join(directory, 'aviaratech-ai-memory-0.3.2.tgz');
      rmSync(file);
      symlinkSync('core-pack.json', file);
    },
  ])
    fixture(directory => {
      change(directory);
      assert.notEqual(run(directory).status, 0);
      assert.throws(() => readFileSync(join(directory, 'source-digests.json')));
    });
});

test('inventory mismatch and invalid source metadata fail before retention', () => {
  fixture(directory => {
    const path = join(directory, 'core-dry-run.json'),
      records = JSON.parse(readFileSync(path, 'utf8'));
    records[0].files.push({ path: 'unexpected' });
    writeFileSync(path, JSON.stringify(records));
    assert.notEqual(run(directory).status, 0);
    assert.throws(() => readFileSync(join(directory, 'source-digests.json')));
  });
  fixture(directory => {
    assert.notEqual(run(directory, 'invalid').status, 0);
    assert.throws(() => readFileSync(join(directory, 'source-digests.json')));
  });
});
