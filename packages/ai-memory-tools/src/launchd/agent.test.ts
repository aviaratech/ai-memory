import assert from 'node:assert/strict';
import { test } from 'vitest';

interface LaunchdPlistConfig {
  doctypePublicId?: string | undefined;
  environmentVariables: Record<string, string>;
  keepAlive?: boolean | undefined;
  label: string;
  programArguments: readonly string[];
  runAtLoad: boolean;
  standardErrorPath: string;
  standardOutPath: string;
  startCalendarInterval?: undefined | { hour: number; minute: number };
  startIntervalSeconds?: number | undefined;
  watchPaths?: readonly string[] | undefined;
  workingDirectory?: string | undefined;
}

type RenderPlist = (config: LaunchdPlistConfig) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadRenderPlist(): Promise<RenderPlist> {
  const moduleRecord: unknown = await import(new URL('./agent.js', import.meta.url).href);
  assert.ok(isRecord(moduleRecord), 'expected launchd agent helper module to load');

  const renderPlist = moduleRecord.renderPlist;
  assert.equal(typeof renderPlist, 'function', 'expected renderPlist export');
  return renderPlist as RenderPlist;
}

test('renderPlist renders the codex ingest launchd plist shape', async () => {
  const renderPlist = await loadRenderPlist();

  assert.equal(
    renderPlist({
      environmentVariables: {
        AI_MEMORY_AUTO_DURABLE_PROMOTION: '1',
        AI_MEMORY_DATABASE_URL: 'postgresql://test:test@localhost:5432/ai_memory',
        AI_MEMORY_LOG_STDERR: '0',
      },
      label: 'com.aviaratech.ai-memory.codex-ingest',
      programArguments: [
        '/opt/homebrew/bin/node',
        '--import',
        '/repo/node_modules/tsx/dist/loader.mjs',
        '/repo/packages/ai-memory-tools/src/ingestion/ingest-codex-launchd.ts',
        '--quiet-seconds',
        '120',
        '--state-file',
        '/Users/example/.local/state/ai-memory/codex-launchd-state.json',
        '--root',
        '/Users/example/.codex/sessions',
      ],
      runAtLoad: true,
      standardErrorPath: '/repo/.logs/ai-memory-codex-launchd.err.log',
      standardOutPath: '/repo/.logs/ai-memory-codex-launchd.out.log',
      startIntervalSeconds: 120,
      watchPaths: ['/Users/example/.codex/sessions'],
      workingDirectory: '/repo',
    }),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.aviaratech.ai-memory.codex-ingest</string>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>--import</string>
      <string>/repo/node_modules/tsx/dist/loader.mjs</string>
      <string>/repo/packages/ai-memory-tools/src/ingestion/ingest-codex-launchd.ts</string>
      <string>--quiet-seconds</string>
      <string>120</string>
      <string>--state-file</string>
      <string>/Users/example/.local/state/ai-memory/codex-launchd-state.json</string>
      <string>--root</string>
      <string>/Users/example/.codex/sessions</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>120</integer>
    <key>WatchPaths</key>
    <array>
      <string>/Users/example/.codex/sessions</string>
    </array>
    <key>StandardOutPath</key>
    <string>/repo/.logs/ai-memory-codex-launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>/repo/.logs/ai-memory-codex-launchd.err.log</string>
    <key>WorkingDirectory</key>
    <string>/repo</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AI_MEMORY_AUTO_DURABLE_PROMOTION</key>
      <string>1</string>
      <key>AI_MEMORY_DATABASE_URL</key>
      <string>postgresql://test:test@localhost:5432/ai_memory</string>
      <key>AI_MEMORY_LOG_STDERR</key>
      <string>0</string>
    </dict>
  </dict>
</plist>`,
  );
});

test('renderPlist renders the codex HTTP launchd plist shape', async () => {
  const renderPlist = await loadRenderPlist();

  assert.equal(
    renderPlist({
      environmentVariables: {
        AI_MEMORY_DATABASE_URL: 'postgresql://test:test@localhost:5432/ai_memory',
        AI_MEMORY_MCP_HTTP_HOST: '127.0.0.1',
        AI_MEMORY_MCP_HTTP_PORT: '8765',
      },
      keepAlive: true,
      label: 'com.aviaratech.ai-memory.mcp-http',
      programArguments: [
        '/opt/homebrew/bin/node',
        '--import',
        '/repo/node_modules/tsx/dist/loader.mjs',
        '/repo/packages/ai-memory-tools/src/server.ts',
      ],
      runAtLoad: true,
      standardErrorPath: '/repo/.logs/ai-memory-mcp-http.err.log',
      standardOutPath: '/repo/.logs/ai-memory-mcp-http.out.log',
      workingDirectory: '/repo',
    }),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.aviaratech.ai-memory.mcp-http</string>
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/node</string>
      <string>--import</string>
      <string>/repo/node_modules/tsx/dist/loader.mjs</string>
      <string>/repo/packages/ai-memory-tools/src/server.ts</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/repo/.logs/ai-memory-mcp-http.out.log</string>
    <key>StandardErrorPath</key>
    <string>/repo/.logs/ai-memory-mcp-http.err.log</string>
    <key>WorkingDirectory</key>
    <string>/repo</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AI_MEMORY_DATABASE_URL</key>
      <string>postgresql://test:test@localhost:5432/ai_memory</string>
      <key>AI_MEMORY_MCP_HTTP_HOST</key>
      <string>127.0.0.1</string>
      <key>AI_MEMORY_MCP_HTTP_PORT</key>
      <string>8765</string>
    </dict>
  </dict>
</plist>`,
  );
});

test('renderPlist renders the backup launchd plist shape', async () => {
  const renderPlist = await loadRenderPlist();

  assert.equal(
    renderPlist({
      doctypePublicId: '-/Apple/DTD PLIST 1.0/EN',
      environmentVariables: {
        AI_MEMORY_DATABASE_URL: 'postgresql://test:test@localhost:5432/ai_memory',
      },
      label: 'com.aviaratech.ai-memory.backup',
      programArguments: ['/bin/bash', '/repo/packages/ai-memory-tools/scripts/backup-db.sh'],
      runAtLoad: false,
      standardErrorPath: '/repo/.logs/ai-memory-backup.err.log',
      standardOutPath: '/repo/.logs/ai-memory-backup.out.log',
      startCalendarInterval: { hour: 3, minute: 0 },
    }),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-/Apple/DTD PLIST 1.0/EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.aviaratech.ai-memory.backup</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>/repo/packages/ai-memory-tools/scripts/backup-db.sh</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>3</integer>
      <key>Minute</key>
      <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/repo/.logs/ai-memory-backup.out.log</string>
    <key>StandardErrorPath</key>
    <string>/repo/.logs/ai-memory-backup.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>AI_MEMORY_DATABASE_URL</key>
      <string>postgresql://test:test@localhost:5432/ai_memory</string>
    </dict>
  </dict>
</plist>`,
  );
});
