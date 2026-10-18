import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import {
  parseProjectScopeBackfillArguments,
  readProjectScopePlanFile,
  writeProjectScopeResult,
} from './backfill-project-scope.js';

const dry = ['--project', 'demo-workshop/widget', '--legacy-project', 'widget'];
test('source maintenance defaults to bounded dry-run and requires an explicit reviewed apply plan', () => {
  assert.deepEqual(parseProjectScopeBackfillArguments(dry), {
    mode: 'dry-run',
    selectors: { legacyProject: 'widget', limit: 200, project: 'demo-workshop/widget' },
  });
  assert.deepEqual(parseProjectScopeBackfillArguments(['--help']), { mode: 'help' });
  assert.deepEqual(
    parseProjectScopeBackfillArguments([
      '--apply',
      '--plan-file',
      'reviewed.json',
      '--expect-plan',
      `sha256:${'a'.repeat(64)}`,
    ]),
    {
      expectedDigest: 'a'.repeat(64),
      mode: 'apply',
      planFile: 'reviewed.json',
    },
  );
  for (const args of [
    [],
    ['--apply'],
    [...dry, '--apply'],
    [...dry, '--dry-run', '--apply'],
    [...dry, '--limit', '0'],
    [...dry, '--limit', '5001'],
    [...dry, '--limit', '1.5'],
    [...dry, '--limit', '2junk'],
    [...dry, '--legacy-project', 'widget'],
    [...dry, '--project', 'other/widget'],
    [...dry, '--force'],
    [...dry, '--skip-init'],
    [...dry, '--out'],
    ['--help', '--apply'],
    [...dry, '--expect-plan', 'bad'],
  ])
    assert.throws(() => parseProjectScopeBackfillArguments(args));
});

test('plan input is bounded, regular and non-symlink and output never overwrites evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scope-cli-'));
  try {
    const plan = join(root, 'plan.json');
    const link = join(root, 'alias.json');
    await writeFile(plan, '{"version":1}');
    await symlink(plan, link);
    assert.deepEqual(await readProjectScopePlanFile(plan), { version: 1 });
    await assert.rejects(() => readProjectScopePlanFile(link));
    await assert.rejects(() => readProjectScopePlanFile(root));
    await writeFile(plan, 'x'.repeat(32 * 1024 * 1024 + 1));
    await assert.rejects(() => readProjectScopePlanFile(plan), /oversized_plan/u);
    const output = join(root, 'result.json');
    await writeProjectScopeResult(output, { status: 'ready' });
    const original = await readFile(output, 'utf8');
    await assert.rejects(() => writeProjectScopeResult(output, { status: 'changed' }));
    assert.equal(await readFile(output, 'utf8'), original);
    await assert.rejects(() => writeProjectScopeResult(link, { status: 'changed' }));
    assert.equal((await readFile(plan)).length, 32 * 1024 * 1024 + 1);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
