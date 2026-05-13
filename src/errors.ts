/**
 * Error hierarchy. All errors thrown by rosetta-frida extend RosettaError
 * so consumers can do `catch (e) { if (e instanceof RosettaError) ... }`.
 *
 * Each error carries structured context so failure reports are actionable
 * without parsing message strings.
 */

/** Base class for all rosetta-frida errors. */
export class RosettaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/**
 * Thrown when a real name has no entry in the loaded map (and no discovery
 * strategy resolved it — V1 has no discovery, so this is always terminal).
 */
export class ResolveError extends RosettaError {
    constructor(
        message: string,
        public readonly realName: string,
        public readonly app: string,
        public readonly version: string,
        public readonly kind: 'class' | 'method' | 'field' | 'type',
        public readonly classScope?: string,
    ) {
        super(message);
    }
}

/** Thrown when a method real-name has multiple overloads and the user didn't disambiguate. */
export class AmbiguousOverloadError extends RosettaError {
    constructor(
        message: string,
        public readonly realName: string,
        public readonly classScope: string,
        public readonly overloadCount: number,
    ) {
        super(message);
    }
}

/** Thrown when the loaded map is structurally invalid (schema check failure). */
export class MapValidationError extends RosettaError {
    constructor(
        message: string,
        public readonly issues: readonly { path: string; message: string }[],
    ) {
        super(message);
    }
}

/** Thrown when the JSONC source can't be parsed. */
export class JsoncParseError extends RosettaError {
    constructor(
        message: string,
        public readonly line: number,
        public readonly column: number,
    ) {
        super(message);
    }
}

/** Thrown when the loaded map doesn't match the running app's version/package. */
export class MapVersionMismatchError extends RosettaError {
    constructor(
        message: string,
        public readonly detectedApp: string,
        public readonly detectedVersion: string,
        public readonly mapApp: string,
        public readonly mapVersion: string,
    ) {
        super(message);
    }
}

/** Thrown when the attach-time health check fails in strict mode. */
export class HealthCheckFailedError extends RosettaError {
    constructor(
        message: string,
        public readonly rate: number,
        public readonly threshold: number,
        public readonly failedEntries: readonly string[],
    ) {
        super(message);
    }
}

/** Thrown when a marker block can't be located or parsed in a compiled bundle. */
export class MarkerBlockError extends RosettaError {
    constructor(
        message: string,
        public readonly bundlePath?: string,
    ) {
        super(message);
    }
}

/**
 * Wraps a missed lookup that was returned as a sentinel rather than thrown
 * (failurePolicy: 'warn'). The sentinel proxy throws this if a consumer
 * tries to actually use it.
 */
export class UnresolvedAccessError extends RosettaError {
    constructor(
        message: string,
        public readonly realName: string,
    ) {
        super(message);
    }
}
