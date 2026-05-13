/**
 * Tests for `detectAppAndVersion`. The chain is dependency-injected so
 * these are pure-function tests — no Frida mock required.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
    detectAppAndVersion,
    type AutoDetectJavaApi,
    type AutoDetectActivityThreadClass,
} from './auto-detect.js';

/** Build a fake Java API that returns canned (app, version). */
function buildJavaApi(app: string, version: string): AutoDetectJavaApi {
    const klass: AutoDetectActivityThreadClass = {
        currentApplication: () => ({
            getApplicationContext: () => ({
                getPackageManager: () => ({
                    getPackageInfo: (pkg: string, flags: number) => {
                        // Sanity: arguments propagate correctly through the chain.
                        expect(pkg).toBe(app);
                        expect(flags).toBe(0);
                        return { versionName: { value: version } };
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
});
