export type ModelResolutionStatus = 'failed' | 'resolved';

export interface ModelAttributionExtensions {
  x_model_resolution_error?: string;
  x_model_resolution_status?: ModelResolutionStatus;
  x_requested_model?: string;
  x_resolved_model?: string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeModelResolutionStatus(value: unknown): ModelResolutionStatus | undefined {
  const normalized = text(value)?.toLowerCase();
  return normalized === 'failed' || normalized === 'resolved' ? normalized : undefined;
}

export function buildModelAttributionExtensions(input: {
  modelResolutionError?: string;
  modelResolutionStatus?: ModelResolutionStatus;
  requestedModel?: string;
  resolvedModel?: string;
}): ModelAttributionExtensions {
  const modelResolutionError = text(input.modelResolutionError);
  const modelResolutionStatus = normalizeModelResolutionStatus(input.modelResolutionStatus);
  const requestedModel = text(input.requestedModel);
  const resolvedModel = text(input.resolvedModel);
  return {
    ...(modelResolutionError === undefined ? {} : { x_model_resolution_error: modelResolutionError }),
    ...(modelResolutionStatus === undefined ? {} : { x_model_resolution_status: modelResolutionStatus }),
    ...(requestedModel === undefined ? {} : { x_requested_model: requestedModel }),
    ...(resolvedModel === undefined ? {} : { x_resolved_model: resolvedModel }),
  };
}
