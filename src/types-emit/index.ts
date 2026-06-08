/**
 * Real-name `.d.ts` emit core — the framework-neutral, pure-function engine
 * behind `rosetta types`.
 *
 * Turns a map's REAL (unobfuscated) names into a TypeScript declaration of
 * string-literal unions so an editor can offer autocompletion and a build can
 * flag a stale name. Library-first: the CLI verb (`cli/commands/types.ts`) is
 * a thin arg-parse + IO wrapper, and these are re-exported from the package
 * root for programmatic use (parity with `convert`).
 */

export { renderTypes, collectNames, type ClassNames } from './emit.js';
