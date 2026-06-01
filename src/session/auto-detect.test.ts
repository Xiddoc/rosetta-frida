/**
 * Tests for `detectAppAndVersion`. The chain is dependency-injected so
 * these are pure-function tests — no Frida mock required.
 */

import { describe, it, expect, afterEach } from 'vitest';
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
});
