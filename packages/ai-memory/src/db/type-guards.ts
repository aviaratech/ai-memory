export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function isArrayIndexToken(value: string) {
  return /^(0|[1-9]\d*)$/.test(value);
}

export function isContainerValue(value: unknown) {
  return isRecord(value) || Array.isArray(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
