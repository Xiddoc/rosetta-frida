/**
 * Tests for `detectAppAndVersion`. The chain is dependency-injected so
 * these are pure-function tests — no Frida mock required.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { javaBridgeFromUse } from '../java-bridge.js';
import {
    detectAppAndVersion,
    type AutoDetectJavaApi,
    type AutoDetectActivityThreadClass,
    type AutoDetectPackageInfo,
} from './auto-detect.js';

/** Optional version-code shapes the fake PackageInfo can expose. */
interface CodeShape {
    /** Provide a `getLongVersionCode()` method (API 28+). */
    longVersionCode?: number | (() => number);
    /** Provide a legacy int `versionCode` field. */
    versionCode?: number;
}

/** Build a fake Java API that returns canned (app, version[, code]). */
function buildJavaApi(app: string, version: string, code: CodeShape = {}): AutoDetectJavaApi {
    const klass: AutoDetectActivityThreadClass = {
        currentApplication: () => ({
            getApplicationContext: () => ({
                getPackageManager: () => ({
                    getPackageInfo: (pkg: string, flags: number) => {
                        // Sanity: arguments propagate correctly through the chain.
                        expect(pkg).toBe(app);
                        expect(flags).toBe(0);
                        const info: AutoDetectPackageInfo = { versionName: { value: version } };
                        if (code.longVersionCode !== undefined) {
                            const lv = code.longVersionCode;
                            info.getLongVersionCode = typeof lv === 'function' ? lv : () => lv;
                        }
                        if (code.versionCode !== undefined) {
                            info.versionCode = { value: code.versionCode };
                        }
                        return info;
                    },
                }),
            }),
            getPackageName: () => app,
        }),
    };
    return {
        use: (name: string) => {
            expect(name).toBe('android.app.ActivityThread');
            return klass;
        },
    };
}

describe('detectAppAndVersion', () => {
    afterEach(() => {
        delete (globalThis as { Java?: unknown }).Java;
    });

    it('walks the in-process chain via an injected Java API', () => {
        const result = detectAppAndVersion(buildJavaApi('com.example.app', '1.2.3'));
        expect(result).toEqual({ app: 'com.example.app', version: '1.2.3' });
    });

    it('defaults to the global Java when no api is passed', () => {
        (globalThis as { Java?: AutoDetectJavaApi }).Java = buildJavaApi(
            'com.example.app',
            '9.9.9',
        );
        const result = detectAppAndVersion();
        expect(result).toEqual({ app: 'com.example.app', version: '9.9.9' });
    });

    it('throws a clear error when Java is unavailable globally', () => {
        delete (globalThis as { Java?: unknown }).Java;
        expect(() => detectAppAndVersion()).toThrow(/cannot auto-detect/);
    });

    it('falls back to an injected JavaBridge when no api is passed', () => {
        delete (globalThis as { Java?: unknown }).Java;
        const inner = buildJavaApi('com.example.app', '4.5.6');
        const bridge = javaBridgeFromUse((name) => inner.use(name));
        const result = detectAppAndVersion(undefined, bridge);
        expect(result).toEqual({ app: 'com.example.app', version: '4.5.6' });
    });

    it('throws a clear error when the injected bridge is unavailable', () => {
        delete (globalThis as { Java?: unknown }).Java;
        expect(() => detectAppAndVersion(undefined, javaBridgeFromUse(undefined))).toThrow(
            /cannot auto-detect/,
        );
    });

    it('propagates errors thrown by the chain', () => {
        const broken: AutoDetectJavaApi = {
            use: () => {
                throw new Error('class not loaded');
            },
        };
        expect(() => detectAppAndVersion(broken)).toThrow(/class not loaded/);
    });

    it('reads version_code from getLongVersionCode() when present (API 28+)', () => {
        const result = detectAppAndVersion(
            buildJavaApi('com.example.app', '1.2.3', { longVersionCode: 10203 }),
        );
        expect(result).toEqual({ app: 'com.example.app', version: '1.2.3', versionCode: 10203 });
    });

    it('falls back to the int versionCode field when getLongVersionCode throws', () => {
        const result = detectAppAndVersion(
            buildJavaApi('com.example.app', '1.2.3', {
                longVersionCode: () => {
                    throw new Error('no such method on API < 28');
                },
                versionCode: 42,
            }),
        );
        expect(result.versionCode).toBe(42);
    });

    it('reads the int versionCode field when getLongVersionCode is absent', () => {
        const result = detectAppAndVersion(
            buildJavaApi('com.example.app', '1.2.3', { versionCode: 7 }),
        );
        expect(result.versionCode).toBe(7);
    });

    it('treats a non-finite version code as undetected', () => {
        const result = detectAppAndVersion(
            buildJavaApi('com.example.app', '1.2.3', { longVersionCode: Number.NaN }),
        );
        expect(result.versionCode).toBeUndefined();
        expect(result).toEqual({ app: 'com.example.app', version: '1.2.3' });
    });

    it.each([
        ['2^31 − 1 (legacy int32 max)', 2_147_483_647],
        ['2^31 (just past int32)', 2_147_483_648],
        ['2^32 (versionCodeMajor = 1)', 4_294_967_296],
        ['2^53 − 1 (Number.MAX_SAFE_INTEGER)', Number.MAX_SAFE_INTEGER],
    ])('reads a full 64-bit longVersionCode without masking: %s', (_label, code) => {
        const result = detectAppAndVersion(
            buildJavaApi('com.example.app', '1.2.3', { longVersionCode: code }),
        );
        // No low-32 mask: the full value survives intact.
        expect(result.versionCode).toBe(code);
    });

    it('throws loudly when longVersionCode exceeds Number.MAX_SAFE_INTEGER', () => {
        expect(() =>
            detectAppAndVersion(
                buildJavaApi('com.example.app', '1.2.3', {
                    longVersionCode: Number.MAX_SAFE_INTEGER + 1,
                }),
            ),
        ).toThrow(/exceeds Number\.MAX_SAFE_INTEGER/);
    });
});
