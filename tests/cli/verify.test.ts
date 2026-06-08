/**
 * Tests for `rosetta verify`.
 */

import { describe, it, expect } from 'vitest';
import { parseVerifyArgs, verifyMap, runVerify } from '../../cli/commands/verify.js';
import { MapValidationError } from '../../src/errors.js';
import type { RosettaMap } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeIo } from './helpers.js';

function baseMap(overrides: Partial<RosettaMap> = {}): RosettaMap {
    return {
        schema_version: 2,
        app: 'com.example.app',
        version: '1.0.0',
        version_code: 100,
        classes: {},
        ...overrides,
    };
}

describe('parseVerifyArgs', () => {
    it('parses one positional', () => {
        expect(parseVerifyArgs(['m.json']).inputPath).toBe('m.json');
    });

    it('errors on zero positionals', () => {
        expect(() => parseVerifyArgs([])).toThrow(/exactly one/);
    });

    it('errors on two positionals', () => {
        expect(() => parseVerifyArgs(['a.json', 'b.json'])).toThrow(/exactly one/);
    });
});

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

    it('flags a dangling app-namespace extends', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Child': { obfuscated: 'b', extends: 'com.example.app.Missing' },
            },
        });
        const issues = verifyMap(m);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.path).toBe('classes.com.example.app.Child.extends');
        expect(issues[0]?.message).toMatch(/not a key in classes/);
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

    it('does not flag an extends that IS a key', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Base': { obfuscated: 'a' },
                'com.example.app.Child': { obfuscated: 'b', extends: 'com.example.app.Base' },
            },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('flags duplicate obfuscated names within the same dex', () => {
        const m = baseMap({
            classes: {
                'com.example.app.A': { obfuscated: 'x', dex: 'classes1.dex' },
                'com.example.app.B': { obfuscated: 'x', dex: 'classes1.dex' },
            },
        });
        const issues = verifyMap(m);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.message).toMatch(/collides with class 'com\.example\.app\.A'/);
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

    it('flags an un-translated app real-name arg type in a signature', () => {
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

    it('flags an unparseable signature', () => {
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
    });

    it('flags an aidl_txn collision on one class', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Stub': {
                    obfuscated: 'a',
                    methods: {
                        first: [{ obfuscated: 'c', signature: '()V', aidl_txn: 2 }],
                        second: [{ obfuscated: 'e', signature: '()V', aidl_txn: 2 }],
                    },
                },
            },
        });
        const issues = verifyMap(m);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.path).toBe('classes.com.example.app.Stub.methods.second.aidl_txn');
        expect(issues[0]?.message).toMatch(/collides with method 'first'/);
    });

    it('does not flag distinct aidl_txn codes or absent ones', () => {
        const m = baseMap({
            classes: {
                'com.example.app.Stub': {
                    obfuscated: 'a',
                    methods: {
                        first: [{ obfuscated: 'c', signature: '()V', aidl_txn: 2 }],
                        second: [{ obfuscated: 'e', signature: '()V', aidl_txn: 3 }],
                        third: [{ obfuscated: 'f', signature: '()V' }],
                    },
                },
            },
        });
        expect(verifyMap(m)).toEqual([]);
    });

    it('handles classes with no methods', () => {
        const m = baseMap({ classes: { 'com.example.app.Foo': { obfuscated: 'a' } } });
        expect(verifyMap(m)).toEqual([]);
    });
});

describe('runVerify (command wrapper)', () => {
    it('returns an OK summary for a consistent map', async () => {
        const map = baseMap({ classes: { 'com.example.app.Foo': { obfuscated: 'a' } } });
        const fake = makeFakeFs({ '/m.json': JSON.stringify(map) });
        const msg = await runVerify(['/m.json'], makeIo(fake, makeCaptured()));
        expect(msg).toMatch(/OK: \/m\.json — 1 class\(es\) consistent/);
    });

    it('throws a MapValidationError carrying the findings (singular)', async () => {
        const map = baseMap({
            classes: {
                'com.example.app.A': { obfuscated: 'x' },
                'com.example.app.B': { obfuscated: 'x' },
            },
        });
        const fake = makeFakeFs({ '/m.json': JSON.stringify(map) });
        await expect(runVerify(['/m.json'], makeIo(fake, makeCaptured()))).rejects.toThrow(
            /1 issue\)/,
        );
    });

    it('reports a plural issue count', async () => {
        const map = baseMap({
            classes: {
                'com.example.app.A': { obfuscated: 'x' },
                'com.example.app.B': { obfuscated: 'x' },
                'com.example.app.C': { obfuscated: 'y', extends: 'com.example.app.Missing' },
            },
        });
        const fake = makeFakeFs({ '/m.json': JSON.stringify(map) });
        await expect(runVerify(['/m.json'], makeIo(fake, makeCaptured()))).rejects.toThrow(
            MapValidationError,
        );
        await expect(runVerify(['/m.json'], makeIo(fake, makeCaptured()))).rejects.toThrow(
            /2 issues\)/,
        );
    });

    it('propagates a schema load failure before semantic checks', async () => {
        const fake = makeFakeFs({ '/m.json': '{ "schema_version": 1 }' });
        await expect(runVerify(['/m.json'], makeIo(fake, makeCaptured()))).rejects.toThrow();
    });
});
