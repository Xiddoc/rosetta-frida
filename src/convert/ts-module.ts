/**
 * TS/JS-module map ingestion — REMOVED (security).
 *
 * `rosetta convert` / `validate` used to accept a contributor-supplied
 * `.ts`/`.js`/`.mjs`/`.cjs` module and `await import()` it to pull out an
 * exported `RosettaMap`. That executed arbitrary code at build/author time
 * *before* any validation ran — a build-time RCE primitive (and the URL
 * normaliser even passed `http(s)://` straight through to `import()`).
 *
 * Maps are pure data and must be authored as JSON or YAML. The dynamic
 * `import()` path is gone; this module now only provides a recognizer so
 * callers can emit a clear, actionable refusal instead of silently routing
 * a module path somewhere unexpected.
 */

import { extname } from 'node:path';
import { RosettaError } from '../errors.js';

/** Module extensions we explicitly refuse (formerly dynamically imported). */
const MODULE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);

/** Does `inputPath` carry a JS/TS-module extension? */
export function isModuleExtension(inputPath: string): boolean {
    return MODULE_EXTENSIONS.has(extname(inputPath).toLowerCase());
}

/** The single, shared refusal message for module-format inputs. */
export const MODULE_UNSUPPORTED_MESSAGE =
    'TS/JS map modules are no longer supported; author maps as JSON or YAML';

/**
 * Refuse a TS/JS-module input. This NEVER imports or executes the file —
 * it exists solely to produce a consistent, helpful error.
 *
 * @throws RosettaError always.
 */
export function refuseModuleInput(inputPath: string): never {
    throw new RosettaError(`${MODULE_UNSUPPORTED_MESSAGE} (path: ${inputPath})`);
}
