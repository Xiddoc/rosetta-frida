/**
 * Diagnostic event types.
 *
 * LOCKED contract. All subsystems emit through the diagnostics EventBus
 * (src/diagnostics/event-bus.ts); consumers subscribe via rosetta.events.on(...).
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

/**
 * How the loaded map was selected from the input (issue #22). `'exact'` is a
 * `version_code` / label match (and the kind for a single-map input);
 * `'nearest'` is the legacy closest-label fallback; `'code-range'` /
 * `'label-range'` are the opt-in range fallbacks. Mirrors
 * `PickedMap.fuzzyKind` so a subscriber can tell a deliberate (possibly far)
 * range pick apart from a nearest-label guess.
 */
export type MapSelectionKind = 'exact' | 'nearest' | 'code-range' | 'label-range';

/** Event emitted on map load. */
export interface MapLoadEvent {
    type: 'map-load';
    app: string;
    version: string;
    classCount: number;
    schemaVersion: number;
    /**
     * Which selection tier produced this map. Distinguishes the five tiers
     * rather than collapsing them to a single fuzzy boolean.
     */
    selectionKind: MapSelectionKind;
}

/**
 * Event emitted by the attach-time signer-certificate authenticity check.
 *
 * Only emitted when the loaded map carries a `signer_sha256` (the check is
 * skipped, and no event is emitted, when the field is absent).
 */
export interface SignerCheckEvent {
    type: 'signer-check';
    /** True if a live signer matched the map's expected hash. */
    passed: boolean;
    /** Detected app package name. */
    app: string;
    /** The map's expected signer hash (normalized). */
    expected: string;
    /** Every live signing-certificate hash observed (normalized). */
    actual: readonly string[];
    /** Which PackageManager flag yielded the signers. */
    source: 'signingInfo' | 'signatures';
}

/**
 * Event emitted when the loaded map carries a non-`active` lifecycle
 * `status` (#40). A `'superseded'` map emits this as a WARNING and still
 * loads; a `'retracted'` map emits it immediately before the session throws
 * `MapRetractedError` (so a subscriber sees the reason even though load
 * fails). An `'active'` (or absent) status emits no event.
 */
export interface MapStatusEvent {
    type: 'map-status';
    /** The lifecycle status that triggered the event. */
    status: 'superseded' | 'retracted';
    /** The map's app package. */
    app: string;
    /** The map's version label. */
    version: string;
    /** The `version_code` of the replacement map, if the map named one. */
    supersededBy?: number;
}

/** Union of all diagnostic events. */
export type DiagnosticEvent =
    | ResolveEvent
    | HealthCheckEvent
    | DetectEvent
    | MapLoadEvent
    | SignerCheckEvent
    | MapStatusEvent;

/** Subscriber type. */
export type EventListener<E extends DiagnosticEvent = DiagnosticEvent> = (event: E) => void;
