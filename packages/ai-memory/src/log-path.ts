import { resolve } from 'node:path';

const DEFAULT_LOG_FILE = 'ai-memory.log';

export interface ResolvedLogPath {
  path: string;
  source: 'env_override_dir' | 'env_override_file' | 'repo_root';
}

export function resolveLogFilePath(): ResolvedLogPath {
  const explicitLogFile = readEnvText('AI_MEMORY_LOG_FILE');
  if (explicitLogFile !== undefined) {
    return {
      path: resolve(process.cwd(), explicitLogFile),
      source: 'env_override_file',
    };
  }

  const explicitLogDir = readEnvText('AI_MEMORY_LOG_DIR');
  if (explicitLogDir !== undefined) {
    return {
      path: resolve(explicitLogDir, DEFAULT_LOG_FILE),
      source: 'env_override_dir',
    };
  }

  return { path: resolve(process.cwd(), '.logs', DEFAULT_LOG_FILE), source: 'repo_root' };
}

function readEnvText(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
