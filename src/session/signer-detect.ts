/**
 * In-process signing-certificate detection.
 *
 * The authenticity half of "right map for the right app". RFC 0001
 * Decision 3 carries an optional `signer_sha256` (the hex SHA-256 of the
 * APK *signing certificate*, not the APK bytes) on every map. This module
 * reads the **live** app's signing certificate(s) from inside the target
 * process — pure Frida JS, no ADB — so the session can compare them to the
 * map's expected hash and refuse to apply a map to a repackaged or spoofed
 * build that merely happens to share the same `version_code`.
 *
 * The chain mirrors `auto-detect.ts` (same ActivityThread → Context →
 * PackageManager walk) but asks for signing info instead of versions:
 *
 *   const ActivityThread = Java.use('android.app.ActivityThread');
 *   const app = ActivityThread.currentApplication();
 *   const ctx = app.getApplicationContext();
 *   const pkg = app.getPackageName();
 *   // API 28+: signingInfo.apkContentsSigners
 *   const info = ctx.getPackageManager()
 *       .getPackageInfo(pkg, GET_SIGNING_CERTIFICATES);
 *   const signers = info.signingInfo.getApkContentsSigners();
 *   // pre-28 fallback: info.signatures
 *   for (const sig of signers) sha256(sig.toByteArray());
 *
 * SHA-256 is computed via `java.security.MessageDigest` — also reached
 * through the injected Java runtime — so the whole module stays a pure
 * function that is unit-testable against a fake Java API with no MockFrida
 * ceremony.
 *
 * **Multiple signers.** An APK may be signed by more than one certificate
 * (e.g. a signing-key rotation lineage, or a multi-signer build). We hash
 * *every* signer and report them all; the session treats it as a match if
 * **any** live signer hash equals the map's `signer_sha256`. Requiring all
 * signers to match would reject legitimate key-rotation builds, and the
 * guard's job is "this map belongs to a build signed by the expected
 * party", which a single-signer match already establishes.
 */

import { MalformedSignerError } from '../errors.js';
import { defaultJavaBridge, type JavaBridge } from '../java-bridge.js';

/**
 * `PackageManager.GET_SIGNING_CERTIFICATES` (API 28+). Returns the v2/v3
 * signing block info via `PackageInfo.signingInfo`.
 */
export const GET_SIGNING_CERTIFICATES = 0x08000000;

/**
 * `PackageManager.GET_SIGNATURES` (pre-28 / fallback). Returns the legacy
 * `PackageInfo.signatures` array. Deprecated on modern Android but the
 * only option below API 28.
 */
export const GET_SIGNATURES = 0x00000040;

/** A Frida-wrapped `android.content.pm.Signature`. */
export interface SignerSignature {
    /** Returns the raw DER-encoded certificate bytes (a Java `byte[]`). */
    toByteArray(): SignerByteArray;
}

/**
 * A Frida-wrapped Java `byte[]`. Frida exposes it as an array-like with a
 * numeric `length`; element access yields signed bytes. We only ever pass
 * it back into `MessageDigest.digest(...)`, so the opaque shape is fine.
 */
export type SignerByteArray = ArrayLike<number>;

/** A Frida-wrapped `android.content.pm.SigningInfo` (API 28+). */
export interface SignerSigningInfo {
    /** All certificates used to sign the current APK. */
    getApkContentsSigners(): readonly SignerSignature[];
}

/**
 * Frida-wrapped `android.content.pm.PackageInfo`, signing view. Both
 * `signingInfo` (API 28+) and `signatures` (legacy) are Frida field
 * accessors (`.value`); either may be absent/null depending on which flag
 * was honoured.
 */
export interface SignerPackageInfo {
    /** API 28+ — present when queried with GET_SIGNING_CERTIFICATES. */
    signingInfo?: { value: SignerSigningInfo | null };
    /** Pre-28 / fallback — present when queried with GET_SIGNATURES. */
    signatures?: { value: readonly SignerSignature[] | null };
}

/** PackageManager — looks up a (signing-flavoured) PackageInfo. */
export interface SignerPackageManager {
    getPackageInfo(packageName: string, flags: number): SignerPackageInfo;
}

/** Context — gives us a PackageManager. */
export interface SignerContext {
    getPackageManager(): SignerPackageManager;
}

/** Application instance — exposes the methods we walk. */
export interface SignerApplication {
    getApplicationContext(): SignerContext;
    getPackageName(): string;
}

/** The class wrapper Frida hands back for `android.app.ActivityThread`. */
export interface SignerActivityThreadClass {
    currentApplication(): SignerApplication;
}

/** Frida-wrapped `java.security.MessageDigest`. */
export interface SignerMessageDigest {
    /** One-shot digest of the supplied bytes; returns a Java `byte[]`. */
    digest(input: SignerByteArray): SignerByteArray;
}

/** Frida-wrapped `java.security.MessageDigest` *class* (static side). */
export interface SignerMessageDigestClass {
    getInstance(algorithm: string): SignerMessageDigest;
}

/**
 * Minimal Frida-shaped Java API surface the signer walk depends on. We
 * keep it narrow (mirroring `AutoDetectJavaApi`) so the contract is
 * visible in one place and easy to fake in tests.
 */
export interface SignerJavaApi {
    use(className: 'android.app.ActivityThread'): SignerActivityThreadClass;
    use(className: 'java.security.MessageDigest'): SignerMessageDigestClass;
    use(className: string): SignerActivityThreadClass | SignerMessageDigestClass;
}

/**
 * Internal marker thrown by {@link detectSigners} when the live app exposes
 * no readable signing certificate at all. Not part of the public error
 * taxonomy: the session guard catches it and rethrows the public
 * `MissingSignerError` (which carries the map's expected hash, context this
 * reader doesn't have). Kept distinct from a generic `Error` so the session
 * can tell "no signer present" apart from "Java runtime unavailable".
 */
export class NoSignerReadableError extends Error {
    constructor(
        message: string,
        /** The package whose signer could not be read. */
        public readonly app: string,
    ) {
        super(message);
        this.name = 'NoSignerReadableError';
    }
}

/** Result of a successful signer read. */
export interface DetectedSigners {
    /**
     * Normalized (lowercase hex, no separators) SHA-256 of every signing
     * certificate found on the live app. Order is not significant.
     */
    hashes: readonly string[];
    /** Which PackageManager flag actually yielded the signers. */
    source: 'signingInfo' | 'signatures';
}

/**
 * The well-formed shape of a normalized signer hash: exactly 64 lowercase
 * hex characters. Mirrors the canonical maps schema's `signer_sha256`
 * pattern and the Kotlin `SignerGuard.HEX_64` regex.
 */
export const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Normalize a SHA-256 hex string for comparison: trim *surrounding*
 * whitespace, strip the colon separators some tools emit (e.g.
 * `AB:CD:...`), then lowercase.
 *
 * Interior whitespace is deliberately NOT stripped, so it survives into
 * the {@link HEX_64} well-formedness check and is rejected as malformed —
 * matching the Kotlin `SignerGuard.normalize` contract so garbage is
 * rejected identically on both clients.
 *
 * Exported so the session compares the map's `signer_sha256` through the
 * exact same normalization it applies to the live hashes.
 */
export function normalizeSignerHash(hash: string): string {
    return hash.trim().replace(/:/g, '').toLowerCase();
}

/**
 * Render a map's expected `signer_sha256` (a single hash or a match-any array)
 * as a stable, human-readable label: each hash normalized via
 * {@link normalizeSignerHash}, sorted, and comma-joined. Shared by
 * {@link checkSigner} (the `expected` field of its result) and the
 * `MissingSignerError` branch in `build-session.ts`, so the two cannot drift
 * to different orderings or normalizations of the same set.
 */
export function formatExpectedHashes(expected: string | readonly string[]): string {
    const list = Array.isArray(expected) ? expected : [expected as string];
    return list.map(normalizeSignerHash).sort().join(', ');
}

/**
 * Hex-encode a Frida-wrapped Java `byte[]`. Java bytes are signed
 * (`-128..127`); mask to a byte before formatting. Produces lowercase hex
 * with no separators (already normalized).
 */
function bytesToHex(bytes: SignerByteArray): string {
    // Copy into a real number[] so iteration yields `number` (not the
    // `number | undefined` that index access under noUncheckedIndexedAccess
    // would force, and the defensive branch that goes with it).
    const arr = Array.prototype.slice.call(bytes) as number[];
    let out = '';
    for (const raw of arr) {
        const b = raw & 0xff;
        out += b.toString(16).padStart(2, '0');
    }
    return out;
}

/**
 * Pull the signing certificates out of a PackageInfo, preferring the
 * modern `signingInfo.getApkContentsSigners()` (API 28+) and falling back
 * to the deprecated `signatures` array (pre-28). Returns the signatures
 * plus which source produced them, or `null` if neither is populated.
 */
function readSignatures(
    info: SignerPackageInfo,
): { signatures: readonly SignerSignature[]; source: 'signingInfo' | 'signatures' } | null {
    const signingInfo = info.signingInfo?.value ?? null;
    if (signingInfo) {
        const signers = signingInfo.getApkContentsSigners();
        if (signers && signers.length > 0) {
            return { signatures: signers, source: 'signingInfo' };
        }
    }
    const legacy = info.signatures?.value ?? null;
    if (legacy && legacy.length > 0) {
        return { signatures: legacy, source: 'signatures' };
    }
    return null;
}

/**
 * Read the live app's signing-certificate SHA-256 hash(es) in-process.
 *
 * Queries PackageManager with `GET_SIGNING_CERTIFICATES` first (API 28+,
 * `signingInfo.apkContentsSigners`) and, if that yields nothing, retries
 * with `GET_SIGNATURES` (the pre-28 `signatures` array). Each certificate
 * is SHA-256'd via `java.security.MessageDigest` and hex-encoded
 * (normalized: lowercase, no separators).
 *
 * @param javaApi Frida's `Java` namespace. Defaults to deriving one from
 *   `bridge`. Tests pass a fake that returns canned classes.
 * @param bridge The {@link JavaBridge} used when `javaApi` is omitted.
 *   Defaults to {@link defaultJavaBridge}. Lets tests drive the
 *   global-fallback path without mutating `globalThis`.
 * @throws Error if the Java runtime is unavailable.
 * @throws NoSignerReadableError if no signing certificate could be read (an
 *   authenticity check that can't read the signer must fail closed — the
 *   session guard surfaces this as the public `MissingSignerError`).
 */
export function detectSigners(
    javaApi?: SignerJavaApi,
    bridge: JavaBridge = defaultJavaBridge,
): DetectedSigners {
    if (javaApi === undefined && !bridge.available) {
        throw new Error(
            'rosetta-frida: cannot read the app signer — global Java is unavailable. ' +
                'Attach via Frida, or disable signer enforcement (enforceSigner: false) ' +
                'if you cannot supply a Java runtime.',
        );
    }
    const api: SignerJavaApi =
        javaApi ?? ({ use: (className) => bridge.use(className) } as SignerJavaApi);

    const ActivityThread = api.use('android.app.ActivityThread');
    const application = ActivityThread.currentApplication();
    const context = application.getApplicationContext();
    const pkg = application.getPackageName();
    const packageManager = context.getPackageManager();

    // Prefer the modern flag; fall back to the legacy one only if the
    // first query produced no usable signatures (covers both pre-28
    // runtimes and modern runtimes that returned an empty signingInfo).
    let found = readSignatures(packageManager.getPackageInfo(pkg, GET_SIGNING_CERTIFICATES));
    if (!found) {
        found = readSignatures(packageManager.getPackageInfo(pkg, GET_SIGNATURES));
    }
    if (!found) {
        throw new NoSignerReadableError(
            `rosetta-frida: could not read any signing certificate for ${pkg}. ` +
                'The signer authenticity check cannot proceed.',
            pkg,
        );
    }

    const MessageDigest = api.use('java.security.MessageDigest');
    const hashes = found.signatures.map((sig) => {
        const digest = MessageDigest.getInstance('SHA-256');
        return bytesToHex(digest.digest(sig.toByteArray()));
    });

    return { hashes, source: found.source };
}

/** Structured result of comparing the live signers against a map hash. */
export interface SignerCheckResult {
    /** True iff any live signer hash equals any (normalized) expected hash. */
    passed: boolean;
    /**
     * The map's expected signer hash(es), normalized and sorted for the
     * comparison. A schema-3 map may pin a SINGLE hash or a non-empty ARRAY
     * (match-any, #38); either is normalized to this sorted list. The
     * comma-joined rendering is what events/error reports display.
     */
    expected: string;
    /** The expected hash(es), normalized and sorted (the match-any set). */
    expectedHashes: readonly string[];
    /**
     * Every live signer hash observed, normalized and sorted. Sorted so a
     * mismatch report is deterministic and matches the Kotlin client's
     * sorted-set rendering.
     */
    actual: readonly string[];
    /** Which PackageManager flag yielded the signers. */
    source: 'signingInfo' | 'signatures';
}

/**
 * Read the live signers and compare them to the map's expected
 * `signer_sha256`. Pure orchestration over {@link detectSigners}; never
 * throws on a *mismatch* (it returns `passed: false`) — the session owns
 * the fail-closed decision.
 *
 * The map's expected value may be a SINGLE hash or a non-empty ARRAY of
 * hashes (schema 3, #38); both are accepted and a live signer matching ANY
 * one of them passes. Each expected hash is normalized via
 * {@link normalizeSignerHash} (so a map authored with `AB:CD:...` /
 * uppercase compares equal to the live bytes) and then checked for
 * well-formedness: it must be exactly 64 lowercase hex characters
 * ({@link HEX_64}). A map hash that fails this is an author error in the
 * artifact, not a spoof, so it throws {@link MalformedSignerError} rather
 * than reporting a (misleading) mismatch — mirroring the Kotlin
 * `SignerGuard.verify` contract. The well-formedness check runs *before*
 * reading the live signers, so a bad map hash is reported even when the app
 * exposes no readable signer.
 *
 * If the live app exposes no readable signing certificate, the underlying
 * read error propagates (an authenticity check that cannot read the signer
 * must fail closed); the session surfaces it as {@link MissingSignerError}.
 */
export function checkSigner(
    expectedSignerSha256: string | readonly string[],
    javaApi?: SignerJavaApi,
): SignerCheckResult {
    const rawExpected = Array.isArray(expectedSignerSha256)
        ? expectedSignerSha256
        : [expectedSignerSha256 as string];
    // A match-any array that pins NO signer is meaningless (the schema rejects
    // an empty array, but `checkSigner` is also called on hand-built values in
    // tests / programmatic use). Treat it as a malformed map hash and fail
    // loudly rather than silently returning `passed: false` with an empty
    // expected label, which would read as "the app is signed wrong".
    if (rawExpected.length === 0) {
        throw new MalformedSignerError(
            '[]',
            'map signer_sha256 array is empty; it must pin at least one signer hash',
        );
    }
    const expectedHashes = rawExpected
        .map((raw) => {
            const normalized = normalizeSignerHash(raw);
            if (!HEX_64.test(normalized)) {
                throw new MalformedSignerError(
                    raw,
                    `map signer_sha256 must be 64 hex chars after normalization, got ${normalized.length}`,
                );
            }
            return normalized;
        })
        .sort();
    const detected = detectSigners(javaApi);
    // Sort the observed hashes so reports are deterministic and align with
    // the Kotlin client's sorted-set rendering.
    const actual = [...detected.hashes].sort();
    const expectedSet = new Set(expectedHashes);
    const passed = actual.some((hash) => expectedSet.has(hash));
    return {
        passed,
        expected: expectedHashes.join(', '),
        expectedHashes,
        actual,
        source: detected.source,
    };
}
