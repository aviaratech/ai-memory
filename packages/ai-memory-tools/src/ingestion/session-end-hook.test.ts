import assert from 'node:assert/strict';
import { test } from 'vitest';

import { isGrokSessionEndHook } from './session-end-hook.js';

test('Grok SessionEnd detection requires both the supported hook event and environment marker', () => {
  assert.equal(
    isGrokSessionEndHook(
      { hookEventName: 'SessionEnd', sessionId: 'grok-session-fixture' },
      { GROK_HOOK_EVENT: 'SessionEnd' },
    ),
    true,
  );
  assert.equal(
    isGrokSessionEndHook(
      { hookEventName: 'SessionEnd', sessionId: 'grok-session-fixture' },
      { GROK_HOOK_EVENT: 'PreToolUse' },
    ),
    false,
  );
  assert.equal(
    isGrokSessionEndHook(
      { hookEventName: 'Stop', sessionId: 'codex-session-fixture' },
      { GROK_HOOK_EVENT: 'SessionEnd' },
    ),
    false,
  );
});
