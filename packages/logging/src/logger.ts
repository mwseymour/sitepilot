import { redactStructuredData } from "./redaction.js";
import type { LogLevel, LogRecord, LogSink, Logger } from "./types.js";

function defaultSink(record: LogRecord): void {
  const line = JSON.stringify(record);
  if (record.level === "debug") {
    console.debug(line);
    return;
  }
  if (record.level === "info") {
    console.info(line);
    return;
  }
  if (record.level === "warn") {
    console.warn(line);
    return;
  }
  console.error(line);
}

function mergeContext(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!base && !extra) {
    return undefined;
  }
  return { ...(base ?? {}), ...(extra ?? {}) };
}

function redactContext(
  context: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!context) {
    return undefined;
  }
  return redactStructuredData(context) as Record<string, unknown>;
}

export type CreateLoggerOptions = {
  sink?: LogSink;
  /** Bound context merged into every record (redacted on emit). */
  bindings?: Record<string, unknown>;
};

export function createLogger(
  namespace: string,
  options: CreateLoggerOptions = {}
): Logger {
  const sink = options.sink ?? defaultSink;
  const bindings = options.bindings;

  function emit(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): void {
    const merged = mergeContext(bindings, context);
    const record: LogRecord = {
      level,
      namespace,
      message,
      time: new Date().toISOString(),
      context: redactContext(merged)
    };
    if (error) {
      record.error = {
        name: error.name,
        message: error.message,
        stack: error.stack
      };
    }
    sink(record);
  }

  return {
    debug(message, context) {
      emit("debug", message, context);
    },
    info(message, context) {
      emit("info", message, context);
    },
    warn(message, context) {
      emit("warn", message, context);
    },
    error(message, context, error) {
      emit("error", message, context, error);
    },
    child(extraBindings) {
      return createLogger(namespace, {
        sink,
        bindings: mergeContext(bindings, extraBindings)
      });
    }
  };
}
