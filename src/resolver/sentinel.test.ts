/**
 * Tests for the deferred-error sentinel returned under failurePolicy='warn'.
 */

import { describe, it, expect } from 'vitest';
import { UnresolvedAccessError } from '../errors.js';
import { isSentinel, makeSentinel, SENTINEL_REAL_NAME } from './sentinel.js';

describe('makeSentinel', () => {
    it('exposes the unresolved real name through the named symbol', () => {
        const s = makeSentinel('IFoo', 'class');
        expect(s[SENTINEL_REAL_NAME]).toBe('IFoo');
    });

    it('throws UnresolvedAccessError on any property access', () => {
        const s = makeSentinel('IFoo', 'class');
        expect(() => (s as { someMember: unknown }).someMember).toThrow(UnresolvedAccessError);
    });

    it('preserves the real name on the thrown error', () => {
        const s = makeSentinel('IRemoteService$Stub', 'class');
        try {
            void (s as { x: unknown }).x;
            expect.fail('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(UnresolvedAccessError);
            expect((e as UnresolvedAccessError).realName).toBe('IRemoteService$Stub');
        }
    });

    it('includes the kind in the error message', () => {
        const s = makeSentinel('myField', 'field');
        try {
            void (s as { x: unknown }).x;
            expect.fail('expected throw');
        } catch (e) {
            expect((e as Error).message).toMatch(/field 'myField'/);
        }
    });

    it('throws on invocation (call)', () => {
        const s = makeSentinel('IFoo', 'class') as unknown as () => unknown;
        expect(() => s()).toThrow(UnresolvedAccessError);
    });

    it('throws on property write', () => {
        const s = makeSentinel('IFoo', 'class');
        expect(() => {
            (s as { x: number }).x = 1;
        }).toThrow(UnresolvedAccessError);
    });

    it('throws on `in` membership tests', () => {
        const s = makeSentinel('IFoo', 'class');
        expect(() => 'x' in (s as object)).toThrow(UnresolvedAccessError);
    });

    it('covers all four kind labels in the message', () => {
        for (const kind of ['class', 'method', 'field', 'type'] as const) {
            const s = makeSentinel('X', kind);
            try {
                void (s as { y: unknown }).y;
                expect.fail('expected throw');
            } catch (e) {
                expect((e as Error).message).toMatch(new RegExp(`${kind} 'X'`));
            }
        }
    });
});

describe('isSentinel', () => {
    it('detects a sentinel', () => {
        const s = makeSentinel('IFoo', 'class');
        expect(isSentinel(s)).toBe(true);
    });

    it('returns false for plain objects', () => {
        expect(isSentinel({})).toBe(false);
        expect(isSentinel({ key: 'value' })).toBe(false);
    });

    it('returns false for primitives', () => {
        expect(isSentinel(null)).toBe(false);
        expect(isSentinel(undefined)).toBe(false);
        expect(isSentinel(42)).toBe(false);
        expect(isSentinel('foo')).toBe(false);
        expect(isSentinel(true)).toBe(false);
    });

    it('returns false for plain functions', () => {
        expect(isSentinel(() => 0)).toBe(false);
    });

    it('returns false if reading the marker throws (defensive)', () => {
        const evil = new Proxy(
            {},
            {
                get() {
                    throw new Error('boom');
                },
            },
        );
        expect(isSentinel(evil)).toBe(false);
    });
});
