export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  level: LogLevel;
  namespace: string;
  message: string;
  time: string;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
};

export type LogSink = (record: LogRecord) => void;

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): void;
  child(bindings: Record<string, unknown>): Logger;
}
