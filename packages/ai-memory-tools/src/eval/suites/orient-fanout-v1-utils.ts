import { formatError, isRecord } from '@aviaratech/ai-memory/internal';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export { formatError };

export interface OrientFanoutV1Fixture {
  expectedTaskRelevantIds: number[];
  memories: OrientFanoutV1FixtureMemory[];
  name: string;
  task: string;
}

export interface OrientFanoutV1FixtureMemory {
  category?: string;
  confidence?: number;
  content: string;
  id: number;
  memoryKey?: string;
  status?: string;
  supersedesId?: number;
  tags?: string[];
}

export function parseOrientFanoutV1Fixture(raw: string): OrientFanoutV1Fixture {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('fixture must be a JSON object');
  if (typeof parsed.name !== 'string' || parsed.name.trim().length === 0) {
    throw new Error('fixture.name must be a non-empty string');
  }
  if (typeof parsed.task !== 'string' || parsed.task.trim().length === 0) {
    throw new Error('fixture.task must be a non-empty string');
  }
  if (!Array.isArray(parsed.memories) || parsed.memories.length === 0) {
    throw new Error('fixture.memories must be a non-empty array');
  }
  if (!Array.isArray(parsed.expectedTaskRelevantIds)) {
    throw new Error('fixture.expectedTaskRelevantIds must be an array');
  }
  return parsed as unknown as OrientFanoutV1Fixture;
}

export function readFixtureFiles(fixtureDirectory: string): string[] {
  if (!existsSync(fixtureDirectory)) {
    return [];
  }
  return readdirSync(fixtureDirectory)
    .filter(fileName => fileName.endsWith('.json'))
    .map(fileName => resolve(fixtureDirectory, fileName))
    .sort((left, right) => left.localeCompare(right));
}
