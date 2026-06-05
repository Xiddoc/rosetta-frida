/**
 * Tests for `rosetta convert`.
 */

import { describe, it, expect } from 'vitest';
import { parseConvertArgs, convertFile, runConvert } from '../../cli/commands/convert.js';
import { RosettaError } from '../../src/errors.js';
import type { FsLike } from '../../cli/commands/io.js';
import { makeCaptured, makeFakeFs, makeFsLike, makeIo, type FakeFs } from './helpers.js';

const VALID_YAML = `
schema_version: 2
app: com.example.app
version: "1.0.0"
version_code: 100
classes:
  IFoo:
    obfuscated: aaaa
`;

function makeFs(initial: Record<string, string> = {}): {
    fs: FsLike;
    files: Map<string, string>;
} {
    const fake: FakeFs = makeFakeFs(initial);
    return { fs: makeFsLike(fake), files: fake.files };
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
            /unknown option/,
        );
    });

    it('errors when missing positional', () => {
        expect(() => parseConvertArgs(['-o', 'out.json'])).toThrow(/exactly one/);
    });

    it('errors when -o not provided', () => {
        expect(() => parseConvertArgs(['in.yaml'])).toThrow(/requires -o/);
    });
});

describe('convertFile', () => {
    it('converts a YAML file to canonical strict JSON', async () => {
        const { fs, files } = makeFs({ '/in.yaml': VALID_YAML });
        const out = await convertFile(['/in.yaml', '-o', 'out.json'], fs);
        expect(out).toBe('out.json');
        const written = files.get('out.json');
        expect(written).toContain('"app": "com.example.app"');
        // Strict JSON artifact — no comment header.
        expect(written?.startsWith('{')).toBe(true);
        expect(written).not.toContain('//');
    });

    it('converts a .yml file', async () => {
        const { fs, files } = makeFs({ '/in.yml': VALID_YAML });
        await convertFile(['/in.yml', '-o', 'out.json'], fs);
        expect(files.get('out.json')).toContain('"app": "com.example.app"');
    });

    it('refuses a TS/JS-module input (never imported)', async () => {
        const { fs } = makeFs();
        await expect(convertFile(['/some/fixture.mjs', '-o', 'out.json'], fs)).rejects.toThrow(
            /no longer supported/,
        );
    });

    it('refuses a .ts module input', async () => {
        const { fs } = makeFs();
        await expect(convertFile(['/some/fixture.ts', '-o', 'out.json'], fs)).rejects.toThrow(
            RosettaError,
        );
    });

    it('allows a parent-traversal output path (operator may write outside CWD)', async () => {
        const { fs, files } = makeFs({ '/in.yaml': VALID_YAML });
        await convertFile(['/in.yaml', '-o', '../escape.json'], fs);
        expect(files.get('../escape.json')).toContain('"app": "com.example.app"');
    });

    it('allows an absolute output path outside the project tree', async () => {
        const { fs, files } = makeFs({ '/in.yaml': VALID_YAML });
        await convertFile(['/in.yaml', '-o', '/tmp/out.json'], fs);
        expect(files.get('/tmp/out.json')).toContain('"app": "com.example.app"');
    });

    it('refuses a NUL byte in the input path', async () => {
        const { fs } = makeFs({ '/in.yaml': VALID_YAML });
        await expect(convertFile(['/in.yaml\0.png', '-o', 'out.json'], fs)).rejects.toThrow(/NUL/);
    });

    it('refuses a NUL byte in the output path', async () => {
        const { fs } = makeFs({ '/in.yaml': VALID_YAML });
        await expect(convertFile(['/in.yaml', '-o', 'out.json\0.png'], fs)).rejects.toThrow(/NUL/);
    });

    it('refuses to overwrite without --force', async () => {
        const { fs } = makeFs({ '/in.yaml': VALID_YAML, 'out.json': 'previous' });
        await expect(convertFile(['/in.yaml', '-o', 'out.json'], fs)).rejects.toThrow(
            /refusing to overwrite/,
        );
    });

    it('overwrites with --force', async () => {
        const { fs, files } = makeFs({ '/in.yaml': VALID_YAML, 'out.json': 'old' });
        await convertFile(['/in.yaml', '-o', 'out.json', '--force'], fs);
        expect(files.get('out.json')).toContain('"app": "com.example.app"');
    });

    it('rejects .json input as already canonical', async () => {
        const { fs } = makeFs({ '/in.json': '{}' });
        await expect(convertFile(['/in.json', '-o', 'out.json'], fs)).rejects.toThrow(
            /already in canonical/,
        );
    });

    it('rejects .jsonc input as unsupported (JSONC is no longer a format)', async () => {
        const { fs } = makeFs({ '/in.jsonc': '{}' });
        await expect(convertFile(['/in.jsonc', '-o', 'out.json'], fs)).rejects.toThrow(
            /unsupported input format/,
        );
    });

    it('rejects unknown extension', async () => {
        const { fs } = makeFs({ '/in.txt': 'whatever' });
        await expect(convertFile(['/in.txt', '-o', 'out.json'], fs)).rejects.toThrow(
            /unsupported input format/,
        );
    });

    it('rejects when underlying YAML is invalid', async () => {
        const { fs } = makeFs({ '/in.yaml': 'schema_version: 99' });
        await expect(convertFile(['/in.yaml', '-o', 'out.json'], fs)).rejects.toThrow(RosettaError);
    });
});

describe('runConvert (command wrapper)', () => {
    it('converts, reports the path to stdout, and returns 0', async () => {
        const fakeFs = makeFakeFs({ '/in.yaml': VALID_YAML });
        const captured = makeCaptured();
        const code = await runConvert(['/in.yaml', '-o', 'out.json'], makeIo(fakeFs, captured));
        expect(code).toBe(0);
        expect(fakeFs.files.has('out.json')).toBe(true);
        expect(captured.stdout[0]).toBe('wrote out.json');
    });

    it('propagates a RosettaError (router formats it) instead of catching', async () => {
        const fakeFs = makeFakeFs({ '/in.json': '{}' });
        const captured = makeCaptured();
        await expect(
            runConvert(['/in.json', '-o', 'out.json'], makeIo(fakeFs, captured)),
        ).rejects.toThrow(/already in canonical/);
    });
});
