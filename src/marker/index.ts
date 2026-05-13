/**
 * Marker-block subsystem — locate, parse, emit, and patch the PEM-style
 * marker block that embeds map data inside a compiled bundle.
 *
 * See design §5.5 for the format. Roughly:
 *   /\*! -----BEGIN ROSETTA MAP----- *\/
 *   const __rosetta_map = { ... JSON payload ... };
 *   /\*! -----END ROSETTA MAP----- *\/
 *
 * Public surface re-exported here:
 *   - format constants (BEGIN_MARKER, END_MARKER, ...)
 *   - extraction regex (MARKER_REGEX)
 *   - emit functions (emitMarkerBlock, emitMarkerRegistry)
 *   - parse function (parseMarkerBlock) and result types
 *   - patch function (patchMarkerBlock)
 */

export {
    BEGIN_MARKER,
    BEGIN_REGISTRY,
    END_MARKER,
    END_REGISTRY,
    MARKER_REGEX,
    REGISTRY_VAR_NAME,
    SINGLE_VAR_NAME,
} from './format.js';

export { emitMarkerBlock, emitMarkerRegistry } from './emit.js';
export { parseMarkerBlock } from './parse.js';
export type { ParsedMarker, ParsedSingle, ParsedRegistry } from './parse.js';
export { patchMarkerBlock } from './patch.js';
