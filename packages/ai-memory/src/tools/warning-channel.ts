/**
 * Re-export of the shared warning channel from `@aviaratech/ai-memory`.
 *
 * The collector lives in the core package so DB-layer code (embedding fetch,
 * bounded queries, flush sub-phases) can record phase-attributed degradation
 * directly.
 */
export {
  type AiMemoryWarningCollector,
  type AiMemoryWarningDetail,
  appendAiMemoryWarningsToPayload,
  appendAiMemoryWarningsToTextResult,
  collectAiMemoryWarningMessages,
  createAiMemoryWarningCollector,
  listAiMemoryWarningDetails,
  recordAiMemoryWarningDetail,
  runWithAiMemoryWarningCollector,
} from '@aviaratech/ai-memory/internal';
