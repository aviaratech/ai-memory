import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { bootstrapAiMemoryCliRuntimeEnv, parseSimpleEnvFile } from './runtimeEnv.js';

export function loadPluginRuntimeEnv(input: { env?: NodeJS.ProcessEnv; home?: string } = {}): {
  env: NodeJS.ProcessEnv;
  filePath: string;
  fileState: 'missing' | 'protected';
  runtime: ReturnType<typeof bootstrapAiMemoryCliRuntimeEnv>;
} {
  const env = { ...(input.env ?? process.env) };
  const filePath = resolve(input.home ?? homedir(), '.config/ai-memory/plugin.env');
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { env, filePath, fileState: 'missing', runtime: bootstrapAiMemoryCliRuntimeEnv({ env }) };
    }
    throw new Error('Use a regular protected plugin.env file with owner-only permissions (0600).');
  }
  try {
    const file = fstatSync(fd);
    const directory = statSync(dirname(filePath));
    const uid = process.getuid?.();
    if (
      uid === undefined ||
      !file.isFile() ||
      file.uid !== uid ||
      (file.mode & 0o077) !== 0 ||
      !directory.isDirectory() ||
      directory.uid !== uid ||
      (directory.mode & 0o022) !== 0 ||
      file.size > 64 * 1024
    ) {
      throw new Error('Use an owner-owned regular protected plugin.env file (0600) in a protected directory (0700).');
    }
    const globalEnv = parseSimpleEnvFile(readFileSync(fd, 'utf8'));
    const runtime = bootstrapAiMemoryCliRuntimeEnv({ env, globalEnv });
    return { env, filePath, fileState: 'protected', runtime };
  } finally {
    closeSync(fd);
  }
}
