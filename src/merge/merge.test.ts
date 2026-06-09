/**
 * Tests for the pure merge engine (`src/merge/`). The CLI-contract tests
 * (arg-parse / IO / write / stderr notice) live in `tests/cli/merge.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { mergeMaps, type ObfOverride } from './merge.js';
import type { RosettaMap } from '../types/map.js';

function baseMap(overrides: Partial<RosettaMap> = {}): RosettaMap {
    return {
        schema_version: 3,
        app: 'com.example.app',
        version: '1.0.0',
        version_code: 100,
        classes: {},
        ...overrides,
    };
}

describe('mergeMaps', () => {
    it('returns the sole input unchanged for a single-element list', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        expect(mergeMaps([a])).toEqual(a);
    });

    it('unions classes from two maps', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        const b = baseMap({ classes: { 'com.x.B': { obfuscated: 'b' } } });
        const m = mergeMaps([a, b]);
        expect(Object.keys(m.classes).sort()).toEqual(['com.x.A', 'com.x.B']);
    });

    it('concatenates sources from all inputs', () => {
        const a = baseMap({ sources: [{ tool: 'sigmatcher' }] });
        const b = baseMap({ sources: [{ tool: 'hand-authored' }] });
        const m = mergeMaps([a, b]);
        expect(m.sources).toEqual([{ tool: 'sigmatcher' }, { tool: 'hand-authored' }]);
    });

    it('omits sources entirely when no input has any', () => {
        const m = mergeMaps([baseMap(), baseMap()]);
        expect(m.sources).toBeUndefined();
    });

    it('last-wins for a class scalar field', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a', dex: 'classes1.dex' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'a', dex: 'classes2.dex' } } });
        const m = mergeMaps([a, b]);
        expect(m.classes['com.x.A']?.dex).toBe('classes2.dex');
    });

    it('does not let an undefined class-scalar on a later input erase a base value', () => {
        // The later input re-states the class WITHOUT `extends` (an explicit
        // hole); the base value must survive — the class-level mirror of the
        // top-level undefined-stripping. Pins the mergeClassEntry fix.
        const a = baseMap({
            classes: { 'com.x.A': { obfuscated: 'a', extends: 'com.x.Base' } },
        });
        const b = baseMap({
            classes: { 'com.x.A': { obfuscated: 'a', extends: undefined } },
        });
        const m = mergeMaps([a, b]);
        expect(m.classes['com.x.A']?.extends).toBe('com.x.Base');
    });

    it('last-wins a defined class-scalar over a base value', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a', extends: 'com.x.Old' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'a', extends: 'com.x.New' } } });
        expect(mergeMaps([a, b]).classes['com.x.A']?.extends).toBe('com.x.New');
    });

    it('last-wins for a conflicting obfuscated class name (non-strict)', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'bbbb' } } });
        const m = mergeMaps([a, b]);
        expect(m.classes['com.x.A']?.obfuscated).toBe('bbbb');
    });

    it('reports each non-strict obfuscated-name override via onOverride', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'bbbb' } } });
        const onOverride = vi.fn<(o: ObfOverride) => void>();
        mergeMaps([a, b], { onOverride });
        expect(onOverride).toHaveBeenCalledWith({
            kind: 'class',
            name: 'com.x.A',
            from: 'aaaa',
            to: 'bbbb',
        });
    });

    it('does not call onOverride when the obfuscated name is identical', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa', dex: 'd' } } });
        const onOverride = vi.fn();
        mergeMaps([a, b], { onOverride });
        expect(onOverride).not.toHaveBeenCalled();
    });

    it('strict mode throws on a conflicting obfuscated class name', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'bbbb' } } });
        expect(() => mergeMaps([a, b], { strict: true })).toThrow(
            /conflicting obfuscated name for class/,
        );
    });

    it('strict mode allows an identical obfuscated class name', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'aaaa', dex: 'd' } } });
        const m = mergeMaps([a, b], { strict: true });
        expect(m.classes['com.x.A']?.dex).toBe('d');
    });

    it('merges method overloads, adding a new signature and last-winning a shared one', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: {
                        m: [
                            { obfuscated: 'e', signature: '()V' }, // same sig → last-wins
                            { obfuscated: 'f', signature: '(I)V' }, // new sig → added
                        ],
                    },
                },
            },
        });
        const m = mergeMaps([a, b]);
        const overloads = m.classes['com.x.A']?.methods?.m;
        expect(overloads).toEqual([
            { obfuscated: 'e', signature: '()V' },
            { obfuscated: 'f', signature: '(I)V' },
        ]);
    });

    it('reports a method-overload override via onOverride (non-strict)', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'e', signature: '()V' }] },
                },
            },
        });
        const onOverride = vi.fn<(o: ObfOverride) => void>();
        mergeMaps([a, b], { onOverride });
        expect(onOverride).toHaveBeenCalledWith({
            kind: 'method',
            name: 'm',
            from: 'c',
            to: 'e',
        });
    });

    it('strict mode throws on a conflicting overload obfuscated name', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'e', signature: '()V' }] },
                },
            },
        });
        expect(() => mergeMaps([a, b], { strict: true })).toThrow(
            /conflicting obfuscated name for method/,
        );
    });

    it('takes the base methods when the next entry has none', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        const m = mergeMaps([a, b]);
        expect(m.classes['com.x.A']?.methods?.m).toHaveLength(1);
    });

    it('takes the next methods when the base entry has none', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const m = mergeMaps([a, b]);
        expect(m.classes['com.x.A']?.methods?.m).toHaveLength(1);
    });

    it('adds a brand-new method real name on merge', () => {
        const a = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    methods: { n: [{ obfuscated: 'd', signature: '()V' }] },
                },
            },
        });
        const m = mergeMaps([a, b]);
        expect(Object.keys(m.classes['com.x.A']?.methods ?? {}).sort()).toEqual(['m', 'n']);
    });

    it('merges fields last-wins and adds new ones', () => {
        const a = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'p', type: 'I' } } },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': {
                    obfuscated: 'a',
                    fields: {
                        f: { obfuscated: 'q', type: 'I' },
                        g: { obfuscated: 'r', type: 'I' },
                    },
                },
            },
        });
        const m = mergeMaps([a, b]);
        expect(m.classes['com.x.A']?.fields?.f?.obfuscated).toBe('q');
        expect(m.classes['com.x.A']?.fields?.g?.obfuscated).toBe('r');
    });

    it('reports a field override via onOverride (non-strict)', () => {
        const a = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'p', type: 'I' } } },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'q', type: 'I' } } },
            },
        });
        const onOverride = vi.fn<(o: ObfOverride) => void>();
        mergeMaps([a, b], { onOverride });
        expect(onOverride).toHaveBeenCalledWith({
            kind: 'field',
            name: 'f',
            from: 'p',
            to: 'q',
        });
    });

    it('strict mode throws on a conflicting field obfuscated name', () => {
        const a = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'p', type: 'I' } } },
            },
        });
        const b = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'q', type: 'I' } } },
            },
        });
        expect(() => mergeMaps([a, b], { strict: true })).toThrow(
            /conflicting obfuscated name for field/,
        );
    });

    it('takes base fields when next has none and vice versa', () => {
        const withF = baseMap({
            classes: {
                'com.x.A': { obfuscated: 'a', fields: { f: { obfuscated: 'p', type: 'I' } } },
            },
        });
        const without = baseMap({ classes: { 'com.x.A': { obfuscated: 'a' } } });
        expect(mergeMaps([withF, without]).classes['com.x.A']?.fields?.f).toBeDefined();
        expect(mergeMaps([without, withF]).classes['com.x.A']?.fields?.f).toBeDefined();
    });

    it('does not let an undefined optional on a later input erase an earlier value', () => {
        const a = baseMap({ captured_at: '2026-01-01' });
        const b = baseMap(); // captured_at undefined
        const m = mergeMaps([a, b]);
        expect(m.captured_at).toBe('2026-01-01');
    });

    it('last-wins a defined top-level optional', () => {
        const a = baseMap({ version: '1.0.0' });
        const b = baseMap({ version: '1.0.1' });
        expect(mergeMaps([a, b]).version).toBe('1.0.1');
    });

    it('folds three inputs left-to-right with last-wins precedence', () => {
        const a = baseMap({ classes: { 'com.x.A': { obfuscated: 'a1' } } });
        const b = baseMap({ classes: { 'com.x.A': { obfuscated: 'a2' } } });
        const c = baseMap({ classes: { 'com.x.A': { obfuscated: 'a3' } } });
        const m = mergeMaps([a, b, c]);
        expect(m.classes['com.x.A']?.obfuscated).toBe('a3');
    });

    it('rejects merging different apps', () => {
        const a = baseMap();
        const b = baseMap({ app: 'com.other.app' });
        expect(() => mergeMaps([a, b])).toThrow(/different apps/);
    });

    it('rejects merging different version_code', () => {
        const a = baseMap({ version_code: 100 });
        const b = baseMap({ version_code: 101 });
        expect(() => mergeMaps([a, b])).toThrow(/different version_code/);
    });
});
