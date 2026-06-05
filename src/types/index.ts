/**
 * Type re-exports. Public surface of types is rooted here.
 */

// Value export (not a type): the single source-of-truth schema version.
export { CURRENT_SCHEMA_VERSION } from './map.js';

export type {
    MapSource,
    Confidence,
    ClassKind,
    MethodEntry,
    FieldEntry,
    MethodMap,
    FieldMap,
    ClassEntry,
    ClassMap,
    RosettaMap,
    RosettaMapRegistry,
} from './map.js';

export type {
    FailurePolicy,
    VersionMatch,
    TargetPolicy,
    SessionOptions,
    Session,
} from './session.js';

export type { ResolvedClass, ResolvedMethod, ResolvedField, Resolver } from './resolver.js';

export type {
    MethodHandle,
    OverloadHandle,
    FieldAccessor,
    ClassProxy,
    InstanceProxy,
} from './proxy.js';

export type {
    ResolveEvent,
    HealthCheckEvent,
    DetectEvent,
    MapLoadEvent,
    DiagnosticEvent,
    EventListener,
} from './events.js';
