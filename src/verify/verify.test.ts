/**
 * Tests for the pure semantic-verify engine (`src/verify/`). The
 * CLI-contract tests for `validate --deep` live in `tests/cli/validate.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { verifyMap } from './verify.js';
import type { RosettaMap } from '../types/map.js';

function baseMap(overrides: Partial<RosettaMap> = {}): RosettaMap {
    return {
        schema_version: 5,
        app: 'com.example.app',
        version: '1.0.0',
        version_code: 100,
        classes: {},
        ...overrides,
    };
}

describe('verifyMap', () => {
    it('returns no issues for a consistent map', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Base': { obfuscated: 'a' },
                'com.example.app.Child': { obfuscated: 'b', extends: 'com.example.app.Base' },
            },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('flags a dangling app-namespace extends as a WARNING', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Child': { obfuscated: 'b', extends: 'com.example.app.Missing' },
            },
        });
        const issues = verifyMap(m);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.path).toBe('classes.com.example.app.Child.extends');
        expect(issues[0]?.message).toMatch(/not a key in classes/);
        expect(issues[0]?.severity).toBe('warning');
    });

    it('does not flag a framework (non-app) extends', () => {
        const m = baseMap({
            classes: { 'com.example.app.Child': { obfuscated: 'b', extends: 'java.lang.Object' } },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('does not flag an obfuscated (no-dot) extends', () => {
        const m = baseMap({
            classes: { 'com.example.app.Child': { obfuscated: 'b', extends: 'zzzz' } },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('matches the FULL app prefix: a sibling-namespace extends is NOT app-owned', () => {
        // app `com.example.app`; `com.example.other.Base` shares only the first
        // two segments. Under the old 2-segment heuristic this false-positived;
        // matched against the full app prefix it is correctly skipped.
        const m = baseMap({
            classes: {
                'com.example.app.Child': { obfuscated: 'b', extends: 'com.example.other.Base' },
            },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('does NOT hard-fail a real vendor app referencing legit library namespaces', () => {
        // The MAJOR E false-positive case: a Google-family app that legitimately
        // references gms / material library classes it never maps. With the
        // full-prefix match those sibling namespaces are not app-owned, so there
        // are no findings at all — and even a same-prefix dangling ref would only
        // be a (non-fatal) warning, never a hard error.
        const m = baseMap({
            app: 'com.google.android.apps.foo',
            classes: {
                'com.google.android.apps.foo.Main': {
                    obfuscated: 'a',
                    extends: 'com.google.android.gms.common.api.GoogleApiClient',
                    methods: {
                        m: [
                            {
                                obfuscated: 'c',
                                signature: '(Lcom/google/android/material/snackbar/Snackbar;)V',
                            },
                        ],
                    },
                },
            },
        });
        const issues = verifyMap(m);
        expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
        expect(issues).toEqual([]);
    });

    it('flags duplicate obfuscated names within the same dex as a HARD error', () => {
        const m = baseMap({
            classes: {
                'com.example.app.A': { obfuscated: 'x', dex: 'classes1.dex' },
                'com.example.app.B': { obfuscated: 'x', dex: 'classes1.dex' },
            },
        });
        const issues = verifyMap(m);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.message).toMatch(/collides with class 'com\.example\.app\.A'/);
        expect(issues[0]?.severity).toBe('error');
    });

    it('allows the same obfuscated name in different dex shards', () => {
        const m = baseMap({
            classes: {
                'com.example.app.A': { obfuscated: 'x', dex: 'classes1.dex' },
                'com.example.app.B': { obfuscated: 'x', dex: 'classes2.dex' },
            },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('treats dex-less entries as one group (and flags collisions there)', () => {
        const m = baseMap({
            classes: {
                'com.example.app.A': { obfuscated: 'x' },
                'com.example.app.B': { obfuscated: 'x' },
            },
        });
        expect(verifyMap(m)).toHaveLength(1);
    });

    it('flags an un-translated app real-name arg type in a signature as a WARNING', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Foo': {
                    obfuscated: 'a',
                    methods: {
                        m: [{ obfuscated: 'c', signature: '(Lcom/example/app/Gone;)V' }],
                    },
                },
            },
        });
        const issues = verifyMap(m);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.path).toBe('classes.com.example.app.Foo.methods.m.signature');
        expect(issues[0]?.message).toMatch(/un-translated/);
        expect(issues[0]?.severity).toBe('warning');
    });

    it('does not flag a framework arg type, an obfuscated arg type, or a primitive', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Foo': {
                    obfuscated: 'a',
                    methods: {
                        m: [{ obfuscated: 'c', signature: '(Landroid/os/Bundle;Lbbbb;I[I)V' }],
                    },
                },
            },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('does not flag an app arg type that IS a key', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '(Lcom/example/app/Bar;)V' }] },
                },
                'com.example.app.Bar': { obfuscated: 'd' },
            },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('flags an unparseable signature as a HARD error', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: 'no-parens' }] },
                },
            },
        });
        const issues = verifyMap(m);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.message).toMatch(/unparseable signature/);
        expect(issues[0]?.severity).toBe('error');
    });

    it('handles classes with no methods', () => {
        const m = baseMap({ classes: { 'com.example.app.Foo': { obfuscated: 'a' } } });
        expect(verifyMap(m)).toEqual([]);
    });
});
