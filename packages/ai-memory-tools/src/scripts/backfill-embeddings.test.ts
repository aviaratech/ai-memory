import assert from 'node:assert/strict';
import { test } from 'vitest';

import { parseArgs } from './backfill-embeddings.js';

test('backfill embeddings parser ignores pnpm argument separator', () => {
  const options = parseArgs(['--', '--dry-run', '--skip-init']);

  assert.equal(options.dryRun, true);
  assert.equal(options.skipInit, true);
});
