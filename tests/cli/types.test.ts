/**
 * CLI-contract tests for `rosetta types` — arg-parse, IO, write/overwrite.
 * The pure `.d.ts` renderer is tested in `src/types-emit/`.
 */

import { describe, it, expect } from 'vitest';
import { parseTypesArgs, typesFile, runTypes } from '../../cli/commands/types.js';
import type { RosettaMap } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeFsLike, makeIo } from './helpers.js';

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

describe('parseTypesArgs', () => {
    it('parses positional + -o', () => {
        const o = parseTypesArgs(['m.json', '-o', 'out.d.ts']);
        expect(o.inputPath).toBe('m.json');
        expect(o.outputPath).toBe('out.d.ts');
        expect(o.force).toBe(false);
    });

    it('accepts --force', () => {
        expect(parseTypesArgs(['m.json', '-o', 'out.d.ts', '-f']).force).toBe(true);
    });

    it('errors on wrong positional count', () => {
        expect(() => parseTypesArgs(['-o', 'out.d.ts'])).toThrow(/exactly one/);
    });

    it('errors when -o is missing', () => {
        expect(() => parseTypesArgs(['m.json'])).toThrow(/requires -o/);
    });
});

describe('typesFile', () => {
    const MAP = JSON.stringify(
        baseMap({
            classes: {
                'com.x.Foo': {
                    obfuscated: 'a',
                    methods: { m: [{ obfuscated: 'c', signature: '()V' }] },
                },
            },
        }),
    );

    it('writes the .d.ts and returns the path', async () => {
        const fake = makeFakeFs({ '/m.json': MAP });
        const out = await typesFile(['/m.json', '-o', '/out.d.ts'], makeFsLike(fake));
        expect(out).toBe('/out.d.ts');
        expect(fake.files.get('/out.d.ts')).toContain('RosettaClassName');
    });

    it('refuses to overwrite without --force', async () => {
        const fake = makeFakeFs({ '/m.json': MAP, '/out.d.ts': 'old' });
        await expect(typesFile(['/m.json', '-o', '/out.d.ts'], makeFsLike(fake))).rejects.toThrow(
            /refusing to overwrite/,
        );
    });

    it('overwrites with --force', async () => {
        const fake = makeFakeFs({ '/m.json': MAP, '/out.d.ts': 'old' });
        await typesFile(['/m.json', '-o', '/out.d.ts', '--force'], makeFsLike(fake));
        expect(fake.files.get('/out.d.ts')).toContain('RosettaClassName');
    });
});

describe('runTypes (command wrapper)', () => {
    it('returns the success message', async () => {
        const fake = makeFakeFs({
            '/m.json': JSON.stringify(baseMap({ classes: { 'com.x.Foo': { obfuscated: 'a' } } })),
        });
        const msg = await runTypes(['/m.json', '-o', '/out.d.ts'], makeIo(fake, makeCaptured()));
        expect(msg).toBe('wrote /out.d.ts');
    });

    it('propagates a load error', async () => {
        const fake = makeFakeFs({});
        await expect(
            runTypes(['/missing.json', '-o', '/out.d.ts'], makeIo(fake, makeCaptured())),
        ).rejects.toThrow();
    });
});
