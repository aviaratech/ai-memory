/**
 * Bounded logging for repeated not_quiet_yet skip events.
 *
 * Emits on the first skip for a given session file, then every
 * NOT_QUIET_EMIT_INTERVAL skips thereafter. Suppressed events are
 * counted and reported when the next emission occurs.
 */

export const NOT_QUIET_EMIT_INTERVAL = 5;

export interface NotQuietYetDecision {
  shouldEmit: boolean;
  suppressedCount: number;
  tracking: NotQuietYetTracking;
}

export interface NotQuietYetTracking {
  consecutiveSkips: number;
  lastEmittedAtSkip: number;
  sessionFile: string;
}

export function decideNotQuietYetEmission(
  previous: NotQuietYetTracking | undefined,
  sessionFile: string,
): NotQuietYetDecision {
  const tracking = updateTracking(previous, sessionFile);
  const shouldEmit =
    tracking.consecutiveSkips === 1 ||
    tracking.consecutiveSkips - tracking.lastEmittedAtSkip >= NOT_QUIET_EMIT_INTERVAL;
  const suppressedCount = tracking.consecutiveSkips - tracking.lastEmittedAtSkip - 1;

  if (shouldEmit) {
    tracking.lastEmittedAtSkip = tracking.consecutiveSkips;
  }

  return { shouldEmit, suppressedCount, tracking };
}

function updateTracking(previous: NotQuietYetTracking | undefined, sessionFile: string): NotQuietYetTracking {
  if (previous?.sessionFile === sessionFile) {
    return {
      consecutiveSkips: previous.consecutiveSkips + 1,
      lastEmittedAtSkip: previous.lastEmittedAtSkip,
      sessionFile,
    };
  }

  return {
    consecutiveSkips: 1,
    lastEmittedAtSkip: 0,
    sessionFile,
  };
}
