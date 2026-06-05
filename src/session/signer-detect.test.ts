/**
 * Tests for the in-process signer-certificate reader + comparison helper.
 *
 * The Java chain is dependency-injected (mirroring `auto-detect.test.ts`)
 * so these are pure-function tests — no Frida mock required. The fake
 * `MessageDigest` computes a real SHA-256 via Node's `crypto` so the
 * hex-encoding / normalization paths are exercised against true hashes.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import {
    detectSigners,
    checkSigner,
    normalizeSignerHash,
    GET_SIGNING_CERTIFICATES,
    GET_SIGNATURES,
    type SignerJavaApi,
    type SignerSignature,
    type SignerByteArray,
} from './signer-detect.js';

/** Compute the expected normalized SHA-256 hex of some cert bytes. */
function sha256Hex(bytes: number[]): string {
    return createHash('sha256')
        .update(Buffer.from(bytes.map((b) => b & 0xff)))
        .digest('hex');
}

/** A fake Frida `byte[]` — array-like with signed-byte semantics. */
function byteArray(bytes: number[]): SignerByteArray {
    // Simulate Java's signed bytes: values may be negative.
    return bytes;
}

/** Build a fake Signature whose certificate bytes are `bytes`. */
function fakeSignature(bytes: number[]): SignerSignature {
    return { toByteArray: () => byteArray(bytes) };
}

interface ApiShape {
    /** Cert byte arrays returned via API 28+ signingInfo. */
    signingInfoCerts?: number[][];
    /** signingInfo present but getApkContentsSigners returns empty. */
    emptySigningInfo?: boolean;
    /** signingInfo field absent entirely (pre-28 runtime). */
    noSigningInfo?: boolean;
    /** Cert byte arrays returned via legacy signatures field. */
    signaturesCerts?: number[][];
    /** Record which flags getPackageInfo was called with. */
    flagLog?: number[];
    app?: string;
}

/**
 * Build a fake Java API exposing ActivityThread + MessageDigest. The
 * MessageDigest computes a real SHA-256 (one-shot) via Node crypto.
 */
function buildSignerApi(shape: ApiShape): SignerJavaApi {
    const app = shape.app ?? 'com.example.app';

    const activityThread = {
        currentApplication: () => ({
            getApplicationContext: () => ({
                getPackageManager: () => ({
                    getPackageInfo: (pkg: string, flags: number) => {
                        expect(pkg).toBe(app);
                        shape.flagLog?.push(flags);
                        if (flags === GET_SIGNING_CERTIFICATES) {
                            if (shape.noSigningInfo) {
                                return {};
                            }
                            if (shape.emptySigningInfo) {
                                return {
                                    signingInfo: {
                                        value: { getApkContentsSigners: () => [] },
                                    },
                                };
                            }
                            const certs = shape.signingInfoCerts ?? [];
                            return {
                                signingInfo: {
                                    value: {
                                        getApkContentsSigners: () => certs.map(fakeSignature),
                                    },
                                },
                            };
                        }
                        // GET_SIGNATURES fallback path.
                        const legacy = shape.signaturesCerts ?? null;
                        return {
                            signatures: {
                                value: legacy === null ? null : legacy.map(fakeSignature),
                            },
                        };
                    },
                }),
            }),
            getPackageName: () => app,
        }),
    };

    const messageDigestClass = {
        getInstance: (algo: string) => {
            expect(algo).toBe('SHA-256');
            return {
                digest: (input: SignerByteArray): SignerByteArray => {
                    const arr: number[] = [];
                    for (let i = 0; i < input.length; i += 1) arr.push(input[i] ?? 0);
                    const hex = sha256Hex(arr);
                    const out: number[] = [];
                    for (let i = 0; i < hex.length; i += 2) {
                        out.push(parseInt(hex.slice(i, i + 2), 16));
                    }
                    return out;
                },
            };
        },
    };

    return {
        use: ((name: string) => {
            if (name === 'android.app.ActivityThread') return activityThread;
            if (name === 'java.security.MessageDigest') return messageDigestClass;
            throw new Error(`unexpected use(${name})`);
        }) as SignerJavaApi['use'],
    };
}

describe('normalizeSignerHash', () => {
    it('strips colons, whitespace, and lowercases', () => {
        expect(normalizeSignerHash('AB:CD:EF')).toBe('abcdef');
        expect(normalizeSignerHash('  Ab Cd\nEf ')).toBe('abcdef');
    });
});

describe('detectSigners', () => {
    afterEach(() => {
        delete (globalThis as { Java?: unknown }).Java;
    });

    it('reads signers via API 28+ signingInfo.apkContentsSigners', () => {
        const certs = [[1, 2, 3, 4]];
        const result = detectSigners(buildSignerApi({ signingInfoCerts: certs }));
        expect(result.source).toBe('signingInfo');
        expect(result.hashes).toEqual([sha256Hex(certs[0])]);
    });

    it('hex-encodes signed Java bytes correctly (high-bit set)', () => {
        // -1 (Java signed) masks to 0xff; -128 → 0x80.
        const certs = [[-1, -128, 0, 127]];
        const result = detectSigners(buildSignerApi({ signingInfoCerts: certs }));
        expect(result.hashes).toEqual([sha256Hex(certs[0])]);
    });

    it('returns a hash per signer when the app has multiple signers', () => {
        const certs = [
            [1, 1, 1],
            [2, 2, 2],
        ];
        const result = detectSigners(buildSignerApi({ signingInfoCerts: certs }));
        expect(result.hashes).toEqual([sha256Hex(certs[0]), sha256Hex(certs[1])]);
    });

    it('falls back to GET_SIGNATURES when signingInfo is absent (pre-28)', () => {
        const flagLog: number[] = [];
        const certs = [[9, 8, 7]];
        const result = detectSigners(
            buildSignerApi({ noSigningInfo: true, signaturesCerts: certs, flagLog }),
        );
        expect(result.source).toBe('signatures');
        expect(result.hashes).toEqual([sha256Hex(certs[0])]);
        // Tried modern flag first, then the legacy flag.
        expect(flagLog).toEqual([GET_SIGNING_CERTIFICATES, GET_SIGNATURES]);
    });

    it('falls back to GET_SIGNATURES when signingInfo yields no signers', () => {
        const certs = [[5, 5]];
        const result = detectSigners(
            buildSignerApi({ emptySigningInfo: true, signaturesCerts: certs }),
        );
        expect(result.source).toBe('signatures');
        expect(result.hashes).toEqual([sha256Hex(certs[0])]);
    });

    it('throws (fail closed) when no signer can be read at all', () => {
        expect(() =>
            detectSigners(buildSignerApi({ noSigningInfo: true, signaturesCerts: [] })),
        ).toThrow(/could not read any signing certificate/);
    });

    it('treats a null signatures field as no signer', () => {
        // signaturesCerts omitted → value is null on the fallback path.
        expect(() => detectSigners(buildSignerApi({ noSigningInfo: true }))).toThrow(
            /could not read any signing certificate/,
        );
    });

    it('defaults to the global Java when no api is passed', () => {
        const certs = [[3, 1, 4, 1, 5]];
        (globalThis as { Java?: SignerJavaApi }).Java = buildSignerApi({ signingInfoCerts: certs });
        const result = detectSigners();
        expect(result.hashes).toEqual([sha256Hex(certs[0])]);
    });

    it('throws a clear error when Java is unavailable globally', () => {
        delete (globalThis as { Java?: unknown }).Java;
        expect(() => detectSigners()).toThrow(/global Java is unavailable/);
    });
});

describe('checkSigner', () => {
    it('passes when a live signer matches the expected hash', () => {
        const certs = [[1, 2, 3, 4]];
        const expected = sha256Hex(certs[0]);
        const result = checkSigner(expected, buildSignerApi({ signingInfoCerts: certs }));
        expect(result.passed).toBe(true);
        expect(result.expected).toBe(expected);
        expect(result.actual).toEqual([expected]);
        expect(result.source).toBe('signingInfo');
    });

    it('matches if ANY of several signers matches', () => {
        const certs = [
            [1, 1, 1],
            [2, 2, 2],
        ];
        const expected = sha256Hex(certs[1]);
        const result = checkSigner(expected, buildSignerApi({ signingInfoCerts: certs }));
        expect(result.passed).toBe(true);
    });

    it('normalizes the expected hash before comparing (uppercase + colons)', () => {
        const certs = [[7, 7, 7]];
        const plain = sha256Hex(certs[0]);
        // Re-spell the same hash as uppercase, colon-separated.
        const colonised = (plain.match(/../g) ?? []).join(':').toUpperCase();
        const result = checkSigner(colonised, buildSignerApi({ signingInfoCerts: certs }));
        expect(result.passed).toBe(true);
        expect(result.expected).toBe(plain);
    });

    it('fails (does not throw) on a mismatch', () => {
        const certs = [[1, 2, 3]];
        const result = checkSigner('f'.repeat(64), buildSignerApi({ signingInfoCerts: certs }));
        expect(result.passed).toBe(false);
        expect(result.actual).toEqual([sha256Hex(certs[0])]);
    });
});
