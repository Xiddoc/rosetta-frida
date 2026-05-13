/**
 * PEM-style marker block format constants and regex patterns.
 *
 * The compiled `.js` bundle wraps the embedded map in a PEM-style marker
 * block. This file is the single source of truth for the marker tokens,
 * the internal const-variable names, and the extraction regex.
 *
 * Two forms are recognized:
 *   - Single map: `-----BEGIN ROSETTA MAP-----` ... `-----END ROSETTA MAP-----`
 *   - Registry:   `-----BEGIN ROSETTA MAP REGISTRY-----` ... `-----END ROSETTA MAP REGISTRY-----`
 *
 * The V2+ placeholder form (a `let __rosetta_map = null;` slot to be
 * populated by `rosetta.injectMap(...)`) is not implemented here — it
 * would reuse the single-map markers with a different payload shape.
 *
 * The `/*!` (important-comment) leading char on the surrounding block
 * comments is what convinces aggressive minifiers (terser etc.) to keep
 * the markers in the output. See design §5.5.
 */

/** Opening marker for a single-map bundle. */
export const BEGIN_MARKER = '-----BEGIN ROSETTA MAP-----';

/** Closing marker for a single-map bundle. */
export const END_MARKER = '-----END ROSETTA MAP-----';

/** Opening marker for a multi-version registry bundle. */
export const BEGIN_REGISTRY = '-----BEGIN ROSETTA MAP REGISTRY-----';

/** Closing marker for a multi-version registry bundle. */
export const END_REGISTRY = '-----END ROSETTA MAP REGISTRY-----';

/**
 * Internal const variable holding the single-map payload inside the
 * compiled bundle. Picked to be unlikely to collide with user identifiers
 * (the double-underscore convention reserves it for our use).
 */
export const SINGLE_VAR_NAME = '__rosetta_map';

/**
 * Internal const variable holding the registry payload (a record keyed
 * by version string) inside the compiled bundle.
 */
export const REGISTRY_VAR_NAME = '__rosetta_maps';

/**
 * Canonical extraction regex.
 *
 * Matches both single-map and registry forms. The label after `MAP` is
 * an optional ` REGISTRY` (or any uppercase/space tail to be future-proof
 * against new suffixes like ` PLACEHOLDER`). The middle is non-greedy
 * so two adjacent blocks in one bundle don't get coalesced.
 *
 * Capture groups:
 *   1: the trailing label after `MAP` in the BEGIN marker
 *      ('' for single, ' REGISTRY' for registry; whitespace-trimmed
 *      via the `[A-Z ]*` class)
 *   2: the payload body (everything between BEGIN and END)
 *
 * Per design §5.5 the published regex is:
 *   /-----BEGIN ROSETTA MAP[A-Z ]*-----[\s\S]*?-----END ROSETTA MAP[A-Z ]*-----/
 * We add capture groups and the global flag so callers can find blocks
 * at known offsets.
 */
export const MARKER_REGEX =
    /-----BEGIN ROSETTA MAP([A-Z ]*)-----([\s\S]*?)-----END ROSETTA MAP[A-Z ]*-----/g;
