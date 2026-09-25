import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  appendAiMemoryWarningsToPayload,
  appendAiMemoryWarningsToTextResult,
  collectAiMemoryWarningMessages,
  createAiMemoryWarningCollector,
  listAiMemoryWarningDetails,
  recordAiMemoryWarningDetail,
  runWithAiMemoryWarningCollector,
} from './warning-channel.js';

test('runWithAiMemoryWarningCollector captures deduped warning details', async () => {
  const collector = createAiMemoryWarningCollector();

  await runWithAiMemoryWarningCollector(collector, () =>
    Promise.resolve().then(() => {
      recordAiMemoryWarningDetail({
        code: 'test.warning',
        message: 'First warning',
      });
      recordAiMemoryWarningDetail({
        code: 'test.warning',
        message: 'First warning',
      });
      recordAiMemoryWarningDetail({
        code: 'test.warning_2',
        message: 'Second warning',
      });
    }),
  );

  assert.deepEqual(listAiMemoryWarningDetails(collector), [
    { code: 'test.warning', message: 'First warning' },
    { code: 'test.warning_2', message: 'Second warning' },
  ]);
});

test('appendAiMemoryWarningsToPayload merges warning messages and structured details', () => {
  const payload = {
    status: 'ok',
    warningDetails: [{ code: 'existing.warning', message: 'Existing warning' }],
    warnings: ['Existing warning'],
  };

  const merged = appendAiMemoryWarningsToPayload(payload, [
    { code: 'new.warning', message: 'New warning' },
    { code: 'existing.warning', message: 'Existing warning' },
  ]) as {
    warningDetails: { code: string; message: string }[];
    warnings: string[];
  };

  assert.deepEqual(merged.warnings, ['Existing warning', 'New warning']);
  assert.deepEqual(merged.warningDetails, [
    { code: 'existing.warning', message: 'Existing warning' },
    { code: 'new.warning', message: 'New warning' },
  ]);
});

test('appendAiMemoryWarningsToTextResult annotates JSON text responses', () => {
  const result = appendAiMemoryWarningsToTextResult(
    {
      content: [
        {
          text: JSON.stringify({ status: 'ok' }, null, 2),
          type: 'text' as const,
        },
      ],
    },
    [{ code: 'tool.warning', message: 'Tool warning' }],
  );

  const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
    warningDetails: { code: string; message: string }[];
    warnings: string[];
  };
  assert.deepEqual(parsed.warnings, ['Tool warning']);
  assert.deepEqual(parsed.warningDetails, [{ code: 'tool.warning', message: 'Tool warning' }]);
});

test('collectAiMemoryWarningMessages returns unique ordered messages', () => {
  assert.deepEqual(
    collectAiMemoryWarningMessages([
      { code: 'one', message: 'First warning' },
      { code: 'two', message: 'Second warning' },
      { code: 'three', message: 'First warning' },
    ]),
    ['First warning', 'Second warning'],
  );
});
