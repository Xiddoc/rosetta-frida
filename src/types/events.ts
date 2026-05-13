/**
 * Diagnostic event types.
 *
 * LOCKED contract. All subsystems emit through src/log.ts; consumers
 * subscribe via rosetta.events.on(...).
 */

/** Event emitted when a name is resolved. */
export interface ResolveEvent {
    type: 'resolve';
    /** Real name being resolved. */
    name: string;
    /** Obfuscated name (if resolved). */
    obfName?: string;
    /** Where this resolution came from. */
    source: 'cache' | 'map' | 'override';
    /** True if this lookup failed. */
    miss?: boolean;
    /**
     * For method/field events, the class scope (real name).
     * Undefined for class-level events.
     */
    classScope?: string;
    /** For method events, which overload was selected (signature). */
    overloadSignature?: string;
}

/** Event emitted by the attach-time health check. */
export interface HealthCheckEvent {
    type: 'health-check';
    /** True if the check passed. */
    passed: boolean;
    /** Fraction of mapped classes that resolved successfully. */
    rate: number;
    /** Real names of entries that failed to resolve. */
    failedEntries: readonly string[];
    /** Configured threshold. */
    threshold: number;
}

/** Event emitted when the session detects app/version. */
export interface DetectEvent {
    type: 'detect';
    /** Detected app package name. */
    app: string;
    /** Detected app version. */
    version: string;
    /** Source of the detection. */
    source: 'auto' | 'override';
}

/** Event emitted on map load. */
export interface MapLoadEvent {
    type: 'map-load';
    app: string;
    version: string;
    classCount: number;
    schemaVersion: number;
}

/** Union of all diagnostic events. */
export type DiagnosticEvent = ResolveEvent | HealthCheckEvent | DetectEvent | MapLoadEvent;

/** Subscriber type. */
export type EventListener<E extends DiagnosticEvent = DiagnosticEvent> = (event: E) => void;
