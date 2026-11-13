// Pure parts of the connector error log (T-196): scrubbing, the sink, export encoders. Safe to import from the web app (no vault,
// no lane router). The store over the lane router is wired in quickbooks/index.ts.
export { GENERIC_MESSAGE, safeFixedMessage, scrubApiError, templateEndpoint, type ScrubbedApiError } from "./scrub";
export { createApiErrorSink, isProviderApiError, loggerTransport, type ApiErrorEvent, type ApiErrorSink, type ApiErrorSinkDeps, type ApiErrorStore, type ApiErrorTransport } from "./sink";
export {
  csvCell, ERROR_COLUMNS, EXPORT_DATASETS, EXPORT_FORMATS, EXPORT_MAX_DAYS, flattenRun, parseExportRange, pick, RUN_COLUMNS, toCsv,
  type ExportDataset, type ExportFormat, type ExportRange, type RangeResult,
} from "./export";
