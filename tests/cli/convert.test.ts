/**
 * Tests for `rosetta convert`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type * as fsMod from 'node:fs/promises';
import * as fsReal from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseConvertArgs, runConvert } from '../../cli/commands/convert.js';
import { RosettaError } from '../../src/errors.js';

const VALID_YAML = `
schema_version: 2
app: com.example.app
version: "1.0.0"
version_code: 100
classes:
  IFoo:
    obfuscated: aaaa
`;

const TS_MODULE_SRC = `
export default {
    schema_version: 2, version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        IFoo: { obfuscated: 'aaaa' },
    },
};
`;

let tsFixture: string;
let fixturesDir: string;

beforeAll(async () => {
    fixturesDir = await fsReal.mkdtemp(path.join(os.tmpdir(), 'rosetta-convert-'));
    tsFixture = path.join(fixturesDir, 'fixture.mjs');
    await fsReal.writeFile(tsFixture, TS_MODULE_SRC, 'utf8');
});

afterAll(async () => {
    await fsReal.rm(fixturesDir, { recursive: true, force: true });
});

function enoent(p: string): NodeJS.ErrnoException {
    const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    return err;
}

function makeFs(initial: Record<string, string> = {}): {
    fs: typeof fsMod;
    files: Map<string, string>;
} {
    const files = new Map<string, string>(Object.entries(initial));
    const fs = {
        readFile(p: string) {
            const v = files.get(p);
            return v === undefined ? Promise.reject(enoent(p)) : Promise.resolve(v);
        },
        writeFile(p: string, content: string) {
            files.set(p, content);
            return Promise.resolve();
        },
        mkdir() {
            return Promise.resolve(undefined);
        },
        stat(p: string) {
            return files.has(p)
                ? Promise.resolve({ isFile: () => true } as fsMod.Stats)
                : Promise.reject(enoent(p));
        },
    } as unknown as typeof fsMod;
    return { fs, files };
}

describe('parseConvertArgs', () => {
    it('parses positional + -o', () => {
        const o = parseConvertArgs(['in.yaml', '-o', 'out.json']);
        expect(o.inputPath).toBe('in.yaml');
        expect(o.outputPath).toBe('out.json');
        expect(o.force).toBe(false);
    });

    it('accepts --output', () => {
        const o = parseConvertArgs(['in.yaml', '--output', 'out.json']);
        expect(o.outputPath).toBe('out.json');
    });

    it('accepts --force / -f', () => {
        expect(parseConvertArgs(['x.yaml', '-o', 'y.json', '--force']).force).toBe(true);
        expect(parseConvertArgs(['x.yaml', '-o', 'y.json', '-f']).force).toBe(true);
    });

    it('errors when -o has no value', () => {
        expect(() => parseConvertArgs(['x.yaml', '-o'])).toThrow(/requires a value/);
    });

    it('errors on unknown flag', () => {
        expect(() => parseConvertArgs(['x.yaml', '-o', 'y.json', '--bogus'])).toThrow(
            /unknown flag/,
        );
    });

    it('errors when missing positional', () => {
        expect(() => parseConvertArgs(['-o', 'out.json'])).toThrow(/exactly one/);
    });

    it('errors when -o not provided', () => {
        expect(() => parseConvertArgs(['in.yaml'])).toThrow(/requires -o/);
    });
});

describe('runConvert', () => {
    it('converts a YAML file to canonical strict JSON', async () => {
        const { fs, files } = makeFs({ '/in.yaml': VALID_YAML });
        const out = await runConvert(['/in.yaml', '-o', '/out.json'], fs);
        expect(out).toBe('/out.json');
        const written = files.get('/out.json');
        expect(written).toContain('"app": "com.example.app"');
        // Strict JSON artifact — no comment header.
        expect(written?.startsWith('{')).toBe(true);
        expect(written).not.toContain('//');
    });

    it('converts a .yml file', async () => {
        const { fs, files } = makeFs({ '/in.yml': VALID_YAML });
        await runConvert(['/in.yml', '-o', '/out.json'], fs);
        expect(files.get('/out.json')).toContain('"app": "com.example.app"');
    });

    it('converts a TS module file', async () => {
        // The ts-module converter reads via dynamic import, so we don't
        // need to mock readFile for it. Use the empty-files mock for the
        // write side.
        const { fs, files } = makeFs();
        await runConvert([tsFixture, '-o', '/tmp/out.json'], fs);
        expect(files.get('/tmp/out.json')).toContain('"app": "com.example.app"');
    });

    it('refuses to overwrite without --force', async () => {
        const { fs } = makeFs({ '/in.yaml': VALID_YAML, '/out.json': 'previous' });
        await expect(runConvert(['/in.yaml', '-o', '/out.json'], fs)).rejects.toThrow(
            /refusing to overwrite/,
        );
    });

    it('overwrites with --force', async () => {
        const { fs, files } = makeFs({ '/in.yaml': VALID_YAML, '/out.json': 'old' });
        await runConvert(['/in.yaml', '-o', '/out.json', '--force'], fs);
        expect(files.get('/out.json')).toContain('"app": "com.example.app"');
    });

    it('rejects .json input as already canonical', async () => {
        const { fs } = makeFs({ '/in.json': '{}' });
        await expect(runConvert(['/in.json', '-o', '/out.json'], fs)).rejects.toThrow(
            /already in canonical/,
        );
    });

    it('rejects .jsonc input as unsupported (JSONC is no longer a format)', async () => {
        const { fs } = makeFs({ '/in.jsonc': '{}' });
        await expect(runConvert(['/in.jsonc', '-o', '/out.json'], fs)).rejects.toThrow(
            /unsupported input format/,
        );
    });

    it('rejects unknown extension', async () => {
        const { fs } = makeFs({ '/in.txt': 'whatever' });
        await expect(runConvert(['/in.txt', '-o', '/out.json'], fs)).rejects.toThrow(
            /unsupported input format/,
        );
    });

    it('rejects when underlying YAML is invalid', async () => {
        const { fs } = makeFs({ '/in.yaml': 'schema_version: 99' });
        await expect(runConvert(['/in.yaml', '-o', '/out.json'], fs)).rejects.toThrow(RosettaError);
    });
});
