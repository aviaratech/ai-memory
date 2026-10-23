import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { bootstrapAiMemoryCliRuntimeEnv, parseSimpleEnvFile } from './runtimeEnv.js';

function protectedDirectory(path: string, create: boolean) {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('configuration_conflict');
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('configuration_conflict');
    if (!create) return undefined;
    mkdirSync(path, { mode: 0o700 });
    info = lstatSync(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) !== 0)
    throw new Error('configuration_conflict');
  return info;
}

export function loadPluginRuntimeEnv(input: { env?: NodeJS.ProcessEnv; home?: string } = {}): {
  env: NodeJS.ProcessEnv;
  filePath: string;
  fileState: 'missing' | 'protected';
  runtime: ReturnType<typeof bootstrapAiMemoryCliRuntimeEnv>;
} {
  const env = { ...(input.env ?? process.env) };
  const home = input.home ?? homedir();
  const filePath = resolve(home, '.config/ai-memory/plugin.env');
  for (const path of [resolve(home), resolve(home, '.config'), dirname(filePath)]) protectedDirectory(path, false);
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
    for (const key of ['AI_MEMORY_ROLE', 'AI_MEMORY_BRIEF_CACHE_DIR']) {
      if (env[key] === undefined && globalEnv[key] !== undefined) env[key] = globalEnv[key];
    }
    const runtime = bootstrapAiMemoryCliRuntimeEnv({ env, globalEnv });
    return { env, filePath, fileState: 'protected', runtime };
  } finally {
    closeSync(fd);
  }
}

// This publisher only creates an absent file or verifies an exact preimage.
// Existing configuration is never rewritten, including unrelated settings.
export function preparePluginDatabaseConfig(input: { home: string; databaseUrl: string }): { commit: () => void } {
  const validation = bootstrapAiMemoryCliRuntimeEnv({ env: { AI_MEMORY_DATABASE_URL: input.databaseUrl } });
  if (validation.status !== 'ok') throw new Error('configuration_conflict');
  const directories = [resolve(input.home), resolve(input.home, '.config'), resolve(input.home, '.config/ai-memory')];
  const file = join(directories[2]!, 'plugin.env');
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('configuration_conflict');
  const directoryPreimages = directories.map(path => protectedDirectory(path, false));
  let retainedLink: { path: string; dev: number; ino: number } | undefined;
  const read = (): string | undefined => {
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('configuration_conflict');
    }
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o077) !== 0 || info.size > 64 * 1024)
        throw new Error('configuration_conflict');
      retainedLink = undefined;
      if (info.nlink !== 1) {
        if (info.nlink !== 2) throw new Error('configuration_conflict');
        const matches = readdirSync(dirname(file))
          .filter(name =>
            /^plugin\.env\.setup-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(name),
          )
          .map(name => join(dirname(file), name))
          .filter(path => {
            const candidate = lstatSync(path);
            return candidate.isFile() && candidate.dev === info.dev && candidate.ino === info.ino;
          });
        if (matches.length !== 1) throw new Error('configuration_conflict');
        retainedLink = { path: matches[0]!, dev: info.dev, ino: info.ino };
      }
      const bytes = readFileSync(fd);
      const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw new Error('configuration_conflict');
      return text;
    } finally {
      closeSync(fd);
    }
  };
  const before = read();
  if (before !== undefined && parseSimpleEnvFile(before).AI_MEMORY_DATABASE_URL !== input.databaseUrl)
    throw new Error('configuration_conflict');
  return {
    commit() {
      for (const [index, path] of directories.entries()) {
        const beforeDirectory = directoryPreimages[index],
          now = protectedDirectory(path, false);
        if (
          (beforeDirectory === undefined) !== (now === undefined) ||
          (beforeDirectory !== undefined &&
            now !== undefined &&
            (beforeDirectory.dev !== now.dev || beforeDirectory.ino !== now.ino))
        )
          throw new Error('configuration_conflict');
        protectedDirectory(path, true);
      }
      if (read() !== before) throw new Error('configuration_conflict');
      if (before !== undefined) {
        // Only the exact private publisher alias sharing this final inode may
        // remain after interruption between link publication and unlink.
        if (retainedLink !== undefined) {
          for (const path of [file, retainedLink.path]) {
            const info = lstatSync(path);
            if (
              !info.isFile() ||
              info.uid !== uid ||
              info.nlink !== 2 ||
              info.dev !== retainedLink.dev ||
              info.ino !== retainedLink.ino ||
              (info.mode & 0o077) !== 0
            )
              throw new Error('configuration_conflict');
          }
          unlinkSync(retainedLink.path);
          if (lstatSync(file).nlink !== 1) throw new Error('configuration_conflict');
        }
        return;
      }
      const temporary = `${file}.setup-${randomUUID()}`;
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, `AI_MEMORY_DATABASE_URL=${input.databaseUrl}\n`);
        fsyncSync(fd);
        try {
          linkSync(temporary, file);
        } catch {
          throw new Error('configuration_conflict');
        }
      } finally {
        closeSync(fd);
        unlinkSync(temporary);
      }
    },
  };
}
