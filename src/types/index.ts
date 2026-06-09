/**
 * Type re-exports. Public surface of types is rooted here.
 */

// Value export (not a type): the single source-of-truth schema version.
export { CURRENT_SCHEMA_VERSION } from './map.js';

export type {
    MapSource,
    GeneratedFrom,
    MapStatus,
    ClassKind,
    MethodEntry,
    FieldEntry,
    MethodMap,
    MethodMapInput,
    FieldMap,
    ClassEntry,
    ClassEntryInput,
    ClassMap,
    ClassMapInput,
    RosettaMap,
    RosettaMapInput,
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

export { ROSETTA_META } from './proxy.js';
export type {
    MethodHandle,
    OverloadHandle,
    FieldAccessor,
    ClassProxy,
    InstanceProxy,
    ProxyMeta,
} from './proxy.js';

export type {
    ResolveEvent,
    HealthCheckEvent,
    DetectEvent,
    MapLoadEvent,
    SignerCheckEvent,
    MapStatusEvent,
    DiagnosticEvent,
    EventListener,
} from './events.js';
