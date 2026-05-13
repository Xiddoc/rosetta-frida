/**
 * Replace the marker block embedded in a compiled bundle.
 *
 * Used by `rosetta patch` to swap one app-version's map for another's
 * without re-running `frida-compile`. The replacement is purely
 * textual: locate the existing block, splice in a freshly emitted
 * block, return the new bundle text. Surrounding bundle content is
 * preserved byte-for-byte.
 *
 * The shape of the new payload (single vs registry) does NOT have to
 * match the shape of the existing block. Callers can promote a
 * single-map bundle to a registry bundle via this same function —
 * `merge-bundle` (V1.5) is just a convenience wrapper around the
 * registry-form of `patchMarkerBlock`.
 */

import { emitMarkerBlock, emitMarkerRegistry } from './emit.js';
import { parseMarkerBlock } from './parse.js';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';

/**
 * Distinguish a single map from a registry. We can't rely on
 * `instanceof` (both are plain objects); a `schema_version` field at
 * the top level reliably signals a single map. A registry's values
 * have `schema_version`, but the registry root does not.
 */
function isSingleMap(value: RosettaMap | RosettaMapRegistry): value is RosettaMap {
    return (
        typeof value === 'object' &&
        value !== null &&
        'schema_version' in value &&
        typeof (value as { schema_version?: unknown }).schema_version === 'number'
    );
}

/**
 * Patch the marker block in `bundleText` with a fresh emission of
 * `newPayload`. Preserves all surrounding content.
 *
 * @throws MarkerBlockError (from `parseMarkerBlock`) if the existing
 *   block is missing or malformed.
 */
export function patchMarkerBlock(
    bundleText: string,
    newPayload: RosettaMap | RosettaMapRegistry,
): string {
    const existing = parseMarkerBlock(bundleText);
    const [start, end] = existing.range;
    const replacement = isSingleMap(newPayload)
        ? emitMarkerBlock(newPayload)
        : emitMarkerRegistry(newPayload);
    return bundleText.slice(0, start) + replacement + bundleText.slice(end);
}
