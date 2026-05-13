/**
 * Main entry point. Re-exports the public API.
 *
 * Wave 1 (landed): parse/load, validate/schema, resolver, diagnostics, marker, convert.
 * Wave 2 (pending): session lifecycle, proxy/use, hook, map, events surfaces.
 */

export * from './errors.js';
export * from './types/index.js';

// Diagnostics
export { EventBus, formatEvent, createSilentBus } from './diagnostics/index.js';

// Parse + validate
export {
    parseJsonc,
    stripCommentsAndTrailingCommas,
    loadMap,
    looksLikeJsoncSource,
} from './parse/index.js';
export { validateMap, rosettaMapSchema } from './validate/index.js';

// Resolver
export { createResolver, ResolverImpl, makeSentinel, isSentinel } from './resolver/index.js';
export type { CreateResolverOptions } from './resolver/index.js';

// Marker block
export {
    BEGIN_MARKER,
    BEGIN_REGISTRY,
    END_MARKER,
    END_REGISTRY,
    MARKER_REGEX,
    emitMarkerBlock,
    emitMarkerRegistry,
    parseMarkerBlock,
    patchMarkerBlock,
} from './marker/index.js';
export type { ParsedMarker, ParsedSingle, ParsedRegistry } from './marker/index.js';

// Converters
export { yamlToMap, tsModuleToMap, convertToJsonc, renderJsonc } from './convert/index.js';
export type { ConvertFormat } from './convert/index.js';
