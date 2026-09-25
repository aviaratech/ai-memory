import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  computeTextSimilarity,
  createMemoryDedupeHash,
  DEFAULT_SIMILARITY_THRESHOLD,
  SIMILARITY_CATEGORIES,
} from './hashing.js';

describe('createMemoryDedupeHash', () => {
  test('is stable across whitespace/case/tag-order differences', () => {
    const left = createMemoryDedupeHash({
      category: 'Decision',
      content: '  Keep   shared settings handlers wired to runtime screens.  ',
      orgId: 'ORG-1',
      project: 'Example/Catalog',
      repoId: 'Repo-1',
      repoSlug: 'Example/Catalog',
      sensitivity: 'Internal',
      tags: ['Onboarding', 'Settings'],
    });

    const right = createMemoryDedupeHash({
      category: 'decision',
      content: 'keep shared settings handlers wired to runtime screens.',
      orgId: 'org-1',
      project: 'example/catalog',
      repoId: 'repo-1',
      repoSlug: 'example/catalog',
      sensitivity: 'internal',
      tags: ['settings', 'onboarding'],
    });

    assert.equal(left, right);
  });

  test('changes when memory identity changes', () => {
    const first = createMemoryDedupeHash({
      category: 'decision',
      content: 'Keep this memory content stable and sufficiently long.',
      project: 'example/catalog',
    });

    const second = createMemoryDedupeHash({
      category: 'decision',
      content: 'Keep this memory content stable and sufficiently long with a new suffix.',
      project: 'example/catalog',
    });

    assert.notEqual(first, second);
  });
});

describe('computeTextSimilarity', () => {
  test('returns 1 for identical text', () => {
    const score = computeTextSimilarity(
      'Run npm checks before starting implementation work on any issue branch.',
      'Run npm checks before starting implementation work on any issue branch.',
    );
    assert.equal(score, 1);
  });

  test('returns 1 for both empty strings', () => {
    assert.equal(computeTextSimilarity('', ''), 1);
  });

  test('returns 0 for one empty string', () => {
    assert.equal(computeTextSimilarity('some content here', ''), 0);
    assert.equal(computeTextSimilarity('', 'some content here'), 0);
  });

  test('detects paraphrased near-duplicates above threshold', () => {
    const original = 'Run pnpm run checks:branch:fix before starting implementation work on any issue branch.';
    const paraphrase =
      'Always run pnpm run checks:branch:fix before starting any implementation work on issue branches.';

    const score = computeTextSimilarity(original, paraphrase);
    assert.ok(
      score >= DEFAULT_SIMILARITY_THRESHOLD,
      `Expected score >= ${String(DEFAULT_SIMILARITY_THRESHOLD)}, got ${String(score)}`,
    );
  });

  test('detects reworded convention memory as near-duplicate', () => {
    const original =
      'For DB-backed relevance eval harnesses, treat run isolation as mandatory: clear eval-scope rows before seeding.';
    const reworded =
      'When running DB-backed relevance eval harnesses, run isolation is mandatory. Clear eval-scope rows before seeding.';

    const score = computeTextSimilarity(original, reworded);
    assert.ok(
      score >= DEFAULT_SIMILARITY_THRESHOLD,
      `Expected score >= ${String(DEFAULT_SIMILARITY_THRESHOLD)}, got ${String(score)}`,
    );
  });

  test('scores unrelated content below threshold', () => {
    const textA = 'Run pnpm run checks:branch:fix before starting implementation work on any issue branch.';
    const textB = 'The document processor uses checksum validation to catch duplicate fragment imports.';

    const score = computeTextSimilarity(textA, textB);
    assert.ok(
      score < DEFAULT_SIMILARITY_THRESHOLD,
      `Expected score < ${String(DEFAULT_SIMILARITY_THRESHOLD)}, got ${String(score)}`,
    );
  });

  test('is case-insensitive', () => {
    const lower = 'always validate feature flags before deployment to production environments';
    const mixed = 'Always Validate Feature Flags Before Deployment To Production Environments';

    const score = computeTextSimilarity(lower, mixed);
    assert.equal(score, 1);
  });

  test('is resilient to punctuation differences', () => {
    const withPunctuation = 'Run checks:branch:fix. Validate staged files. Publish the PR.';
    const withoutPunctuation = 'Run checks branch fix Validate staged files Publish the PR';

    const score = computeTextSimilarity(withPunctuation, withoutPunctuation);
    assert.ok(score >= 0.9, `Expected score >= 0.9, got ${String(score)}`);
  });

  test('does not treat unrelated CJK texts as identical', () => {
    const chinese = '\u8FD0\u884C\u68C0\u67E5\u5728\u5F00\u59CB\u5B9E\u65BD\u4E4B\u524D';
    const japanese =
      '\u5B9F\u88C5\u4F5C\u696D\u3092\u958B\u59CB\u3059\u308B\u524D\u306B\u30C1\u30A7\u30C3\u30AF\u3092\u5B9F\u884C';

    const score = computeTextSimilarity(chinese, japanese);
    assert.ok(
      score < DEFAULT_SIMILARITY_THRESHOLD,
      `Expected CJK score < ${String(DEFAULT_SIMILARITY_THRESHOLD)}, got ${String(score)}`,
    );
  });

  test('does not treat unrelated Cyrillic texts as identical', () => {
    const russian =
      '\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043F\u0435\u0440\u0435\u0434 \u043D\u0430\u0447\u0430\u043B\u043E\u043C \u0440\u0430\u0431\u043E\u0442\u044B';
    const ukrainian =
      '\u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0438\u0442\u0438 \u0437\u0430\u043B\u0435\u0436\u043D\u043E\u0441\u0442\u0456 \u043F\u0435\u0440\u0435\u0434 \u0440\u043E\u0437\u0433\u043E\u0440\u0442\u0430\u043D\u043D\u044F\u043C';

    const score = computeTextSimilarity(russian, ukrainian);
    assert.ok(score < 1, `Expected Cyrillic score < 1, got ${String(score)}`);
  });

  test('returns 0 when non-empty text tokenizes to empty arrays', () => {
    const singleChar = 'x';
    const otherChar = 'y';

    const score = computeTextSimilarity(singleChar, otherChar);
    assert.equal(score, 0);
  });
});

describe('SIMILARITY_CATEGORIES', () => {
  test('includes all actionable categories', () => {
    assert.ok(SIMILARITY_CATEGORIES.has('architecture'));
    assert.ok(SIMILARITY_CATEGORIES.has('bugfix'));
    assert.ok(SIMILARITY_CATEGORIES.has('convention'));
    assert.ok(SIMILARITY_CATEGORIES.has('decision'));
    assert.ok(SIMILARITY_CATEGORIES.has('preference'));
    assert.ok(SIMILARITY_CATEGORIES.has('root-cause'));
  });

  test('excludes non-actionable categories', () => {
    assert.ok(!SIMILARITY_CATEGORIES.has('session-summary'));
    assert.ok(!SIMILARITY_CATEGORIES.has('checkpoint'));
    assert.ok(!SIMILARITY_CATEGORIES.has('audit-log'));
    assert.ok(!SIMILARITY_CATEGORIES.has('implementation-note'));
  });
});
