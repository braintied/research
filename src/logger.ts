/**
 * Minimal structured logger for @swishh/research.
 *
 * Decoupled replacement for cortex-worker's pino logger. Every harvested
 * module imports `{ logger }` and calls it with either a single message
 * string `logger.info('msg')` or a structured-object + message pair
 * `logger.info({ key: value }, 'msg')` — matching pino's call signature.
 *
 * The default implementation is console-backed. Consumers that want their
 * own logging can pass a `Logger` into `runDeepResearch({ logger })`.
 */

export interface Logger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
  debug(obj: Record<string, unknown> | string, msg?: string): void;
}

type ConsoleMethod = (...args: unknown[]) => void;

function emit(method: ConsoleMethod, obj: Record<string, unknown> | string, msg?: string): void {
  if (typeof obj === 'string') {
    method(obj);
    return;
  }
  if (msg !== undefined) {
    method(msg, obj);
    return;
  }
  method(obj);
}

/**
 * Console-backed logger used by default. Mirrors pino's `(obj, msg)` /
 * `(msg)` overloads so harvested call sites need no changes.
 */
export const logger: Logger = {
  info(obj, msg) {
    emit(console.info.bind(console), obj, msg);
  },
  warn(obj, msg) {
    emit(console.warn.bind(console), obj, msg);
  },
  error(obj, msg) {
    emit(console.error.bind(console), obj, msg);
  },
  debug(obj, msg) {
    emit(console.debug.bind(console), obj, msg);
  },
};
