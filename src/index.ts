/**
 * Main entry point. Re-exports the public API.
 *
 * Wave 1 (landed): parse/load, validate/schema, resolver, diagnostics, marker, convert.
 * Wave 2 (landed): session lifecycle, proxy/use, tier-1 hook/proceed/field, tier-3 map/events.
 */

export * from './errors.js';
export * from './types/index.js';

// Typed configuration (parse-limit hardening, future knobs).
export {
    resolveConfig,
    configSchema,
    DEFAULT_CONFIG,
    DEFAULT_MAX_INPUT_BYTES,
    DEFAULT_MAX_NESTING_DEPTH,
} from './config.js';
export type { RosettaConfig, RosettaConfigInput, ParseLimits } from './config.js';

// Java bridge — the single seam onto Frida's global `Java`.
export {
    defaultJavaBridge,
    javaBridgeFromUse,
    JAVA_UNAVAILABLE_MESSAGE,
    type JavaBridge,
} from './java-bridge.js';

// Diagnostics
export { EventBus, formatEvent, createSilentBus } from './diagnostics/index.js';

// Parse + validate
export { parseJson, loadMap, looksLikeJsonSource } from './parse/index.js';
export { validateMap, rosettaMapSchema } from './validate/index.js';

// Resolver
export { createResolver, ResolverImpl, makeSentinel, isSentinel } from './resolver/index.js';
export type { CreateResolverOptions } from './resolver/index.js';
export {
    DEFAULT_DENY_PREFIXES,
    DEFAULT_APP_NAMESPACE_LABELS,
    appPrefixOf,
    isTargetAllowed,
    assertTargetAllowed,
} from './resolver/index.js';

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
export { yamlToMap, convertToJson, renderJson } from './convert/index.js';
export type { ConvertFormat } from './convert/index.js';

// Session + auto-detect + health-check (Wave 2G)
export {
    RosettaSession,
    createSession,
    detectAppAndVersion,
    detectSigners,
    checkSigner,
    normalizeSignerHash,
    pickMapForVersion,
    runHealthCheck,
    DEFAULT_HEALTH_CHECK_THRESHOLD,
} from './session/index.js';

// Proxy layer (Wave 2E)
export {
    makeClassProxy,
    makeMethodHandle,
    makeFieldAccessor,
    makeInstanceProxy,
} from './proxy/index.js';

// User-facing API: tier 1 / tier 2 / tier 3 (Wave 2 E/F/G)
export {
    use,
    type,
    hook,
    proceed,
    field,
    setField,
    createMapApi,
    createEventsApi,
} from './api/index.js';

// The canonical user-facing namespace — composes tier 1 / 2 / 3 with
// an ambient session set via `rosetta.session(...)`.
export { rosetta } from './api/rosetta.js';
export type {
    UseOptions,
    TypeOptions,
    HookHandle,
    HookTarget,
    HookImpl,
    HookOptions,
    FieldOptions,
    MapApi,
    EventsApi,
} from './api/index.js';
