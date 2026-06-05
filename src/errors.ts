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

/** Thrown when the JSON source can't be parsed. */
export class JsonParseError extends RosettaError {
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

/**
 * Thrown when the loaded map carries a `signer_sha256` but none of the
 * running app's signing certificates match it.
 *
 * This is a fail-closed authenticity guard (RFC 0001 Decision 3): a map
 * cannot be silently applied to a repackaged or spoofed build that merely
 * shares the same `version_code`. Carries the expected hash and every
 * live signer hash that was observed so reports are actionable.
 *
 * One of three signer error types mirroring the Kotlin taxonomy
 * (`SignerMismatchException`); see {@link MalformedSignerError} (the map's
 * own hash is ill-formed) and {@link MissingSignerError} (the live app
 * exposes no readable signer).
 */
export class SignerMismatchError extends RosettaError {
    constructor(
        message: string,
        public readonly app: string,
        public readonly expected: string,
        public readonly actual: readonly string[],
    ) {
        super(message);
    }
}

/**
 * Thrown when the loaded map's `signer_sha256` is not well-formed: after
 * normalization (trim surrounding whitespace, strip `:`, lowercase) it is
 * not exactly 64 lowercase hex characters (`^[0-9a-f]{64}$`).
 *
 * This is an **author error** in the map artifact, not a spoof — treating
 * it as a mismatch would mask a bad map as an attacker. Mirrors the Kotlin
 * `MalformedSignerException`; the canonical maps schema also pins
 * `signer_sha256` to `^[0-9a-f]{64}$`, so a conformant map can never trip
 * this at runtime.
 */
export class MalformedSignerError extends RosettaError {
    constructor(
        /** The offending hash value, as supplied (before/around normalization). */
        public readonly value: string,
        /** Why it was rejected (e.g. "expected 64 hex chars, got 8"). */
        public readonly reason: string,
    ) {
        super(`rosetta-frida: malformed signer_sha256 "${value}": ${reason}`);
    }
}

/**
 * Thrown when the loaded map carries a valid `signer_sha256` but the live
 * app exposes no readable signing certificate, so the authenticity guard
 * cannot be satisfied.
 *
 * Fail-closed: a map that *demands* a signer must not silently pass against
 * an app that presents none. Mirrors the Kotlin `MissingSignerException`.
 */
export class MissingSignerError extends RosettaError {
    constructor(
        message: string,
        /** The normalized signer hash the map demands but could not verify. */
        public readonly expected: string,
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
