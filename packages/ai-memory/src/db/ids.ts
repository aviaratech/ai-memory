export function createDeltaEventId(deltaId: string, index: number) {
  return `${deltaId}#event-${String(index + 1).padStart(4, '0')}`;
}
