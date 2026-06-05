/**
 * Tests for the `JavaBridge` seam — the single point that reads Frida's
 * global `Java`. Covers the global-reading default, the `javaBridgeFromUse`
 * adapter, and the canonical absence error.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultJavaBridge, javaBridgeFromUse, JAVA_UNAVAILABLE_MESSAGE } from './java-bridge.js';

interface JavaGlobal {
    Java?: unknown;
}

describe('defaultJavaBridge', () => {
    const g = globalThis as JavaGlobal;
    let saved: unknown;

    beforeEach(() => {
        saved = g.Java;
    });
    afterEach(() => {
        g.Java = saved;
    });

    it('reports unavailable and throws the canonical error when Java is absent', () => {
        delete (g as Record<string, unknown>).Java;
        expect(defaultJavaBridge.available).toBe(false);
        expect(() => defaultJavaBridge.use('whatever')).toThrow(JAVA_UNAVAILABLE_MESSAGE);
    });

    it('reports unavailable when Java exists but has no usable use()', () => {
        g.Java = {};
        expect(defaultJavaBridge.available).toBe(false);
        expect(() => defaultJavaBridge.use('x')).toThrow(JAVA_UNAVAILABLE_MESSAGE);
    });

    it('reads Java.use off the global lazily', () => {
        const seen: string[] = [];
        g.Java = {
            use(name: string) {
                seen.push(name);
                return { tag: name };
            },
        };
        expect(defaultJavaBridge.available).toBe(true);
        expect(defaultJavaBridge.use('aaaa')).toEqual({ tag: 'aaaa' });
        expect(seen).toEqual(['aaaa']);
    });
});

describe('javaBridgeFromUse', () => {
    it('adapts a defined use() and reports available', () => {
        const bridge = javaBridgeFromUse((name) => ({ name }));
        expect(bridge.available).toBe(true);
        expect(bridge.use('bbbb')).toEqual({ name: 'bbbb' });
    });

    it('reports unavailable and throws the canonical error for an undefined use()', () => {
        const bridge = javaBridgeFromUse(undefined);
        expect(bridge.available).toBe(false);
        expect(() => bridge.use('x')).toThrow(JAVA_UNAVAILABLE_MESSAGE);
    });

    it('propagates the underlying use() error on miss', () => {
        const bridge = javaBridgeFromUse(() => {
            throw new Error('boom from use');
        });
        expect(() => bridge.use('x')).toThrow('boom from use');
    });
});
