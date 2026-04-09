/**
 * Logging framework adapters.
 *
 * Re-exports the adapter interface and all built-in adapter implementations.
 */

export type { LoggingAdapter } from "./base.js";
export { WinstonAdapter } from "./winston.js";
export type { WinstonAdapterConfig } from "./winston.js";
export { PinoAdapter } from "./pino.js";
export type { PinoAdapterConfig } from "./pino.js";
