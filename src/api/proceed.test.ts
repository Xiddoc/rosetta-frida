/**
 * Tests for `proceed(...)` and the proceed-context stack.
 *
 * Targets full line/branch/function/statement coverage of proceed.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RosettaError } from '../errors.js';
import { proceed, pushProceedFrame, _resetProceedStack } from './proceed.js';

describe('proceed', () => {
    beforeEach(() => {
        _resetProceedStack();
    });

    it('throws when called outside any hook context', () => {
        expect(() => proceed()).toThrow(RosettaError);
        expect(() => proceed()).toThrow(/outside a hook implementation/);
    });

    it('throws when called outside any hook context (with args)', () => {
        expect(() => proceed(1, 2, 3)).toThrow(/outside a hook implementation/);
    });

    it('delegates to the top frame and returns its result', () => {
        const pop = pushProceedFrame({
            thisRef: { tag: 'self' },
            next: (args) => `seen-${args.join(',')}`,
        });
        try {
            expect(proceed('a', 'b')).toBe('seen-a,b');
        } finally {
            pop();
        }
    });

    it('propagates args through to `next` in order', () => {
        let received: unknown[] = [];
        const pop = pushProceedFrame({
            thisRef: null,
            next: (args) => {
                received = args;
                return undefined;
            },
        });
        try {
            proceed(1, 'two', { three: 3 });
        } finally {
            pop();
        }
        expect(received).toEqual([1, 'two', { three: 3 }]);
    });

    it('LIFO discipline — nested frames are read top-down', () => {
        const outerPop = pushProceedFrame({
            thisRef: 'outer',
            next: (args) => `outer:${args.join('|')}`,
        });
        try {
            const innerPop = pushProceedFrame({
                thisRef: 'inner',
                next: (args) => `inner:${args.join('|')}`,
            });
            try {
                expect(proceed('x')).toBe('inner:x');
            } finally {
                innerPop();
            }
            // After inner pops, outer is on top again.
            expect(proceed('y')).toBe('outer:y');
        } finally {
            outerPop();
        }

        // After both popped, calling proceed throws.
        expect(() => proceed()).toThrow(/outside a hook implementation/);
    });

    it('pop is idempotent', () => {
        const pop = pushProceedFrame({ thisRef: null, next: () => 'ok' });
        pop();
        // A second call must not re-pop another frame.
        const pop2 = pushProceedFrame({ thisRef: null, next: () => 'next' });
        pop(); // no-op
        expect(proceed()).toBe('next');
        pop2();
    });

    it('pop tolerates a stack mutated out from under it', () => {
        // Push frame A; push frame B; pop A first (out-of-order). Both
        // must still be safe — the pop closure deletes only its own slot.
        const frameA = pushProceedFrame({ thisRef: 'A', next: () => 'A-result' });
        const frameB = pushProceedFrame({ thisRef: 'B', next: () => 'B-result' });
        frameA(); // removes A while B sits below... actually B was pushed on top
        // After frameA-pop runs, only B should remain.
        expect(proceed()).toBe('B-result');
        frameB();
        expect(() => proceed()).toThrow(/outside a hook implementation/);
    });

    it('pop silently no-ops if its frame is already gone', () => {
        const pop = pushProceedFrame({ thisRef: null, next: () => 'x' });
        _resetProceedStack(); // wipe the stack out from under it
        expect(() => pop()).not.toThrow();
    });

    it('_resetProceedStack clears all frames', () => {
        pushProceedFrame({ thisRef: 1, next: () => 1 });
        pushProceedFrame({ thisRef: 2, next: () => 2 });
        _resetProceedStack();
        expect(() => proceed()).toThrow(/outside a hook implementation/);
    });
});
