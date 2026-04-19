export const LOGGING_PACKAGE_NAME = "@sitepilot/logging";

export { createLogger } from "./logger.js";
export type { CreateLoggerOptions } from "./logger.js";
export { isSensitiveKey, redactStructuredData } from "./redaction.js";
export type { LogLevel, LogRecord, LogSink, Logger } from "./types.js";
