/**
 * Tests for the canonical JSONC emitter + `convertToJsonc` entry point.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertToJsonc, renderJsonc, detectFormat } from './jsonc.js';
import { MapValidationError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';

const SAMPLE_YAML = `
schema_version: 1
app: com.example.app
version: "1.0.0"
classes:
  IFoo:
    obfuscated: aaaa
    methods:
      bar:
        obfuscated: a
        signature: "()V"
`;

const SAMPLE_MAP: RosettaMap = {
    schema_version: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        IFoo: {
            obfuscated: 'aaaa',
            methods: { bar: { obfuscated: 'a', signature: '()V' } },
        },
    },
};

const TS_MODULE_SRC = `
export default {
    schema_version: 1,
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
    fixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rosetta-jsonc-'));
    tsFixture = path.join(fixturesDir, 'fixture.mjs');
    await fs.writeFile(tsFixture, TS_MODULE_SRC, 'utf8');
});

afterAll(async () => {
    await fs.rm(fixturesDir, { recursive: true, force: true });
});

describe('renderJsonc', () => {
    it('emits the canonical header followed by the JSON body', () => {
        const out = renderJsonc(SAMPLE_MAP);
        expect(out.startsWith('// rosetta-frida map')).toBe(true);
        expect(out).toContain('"app": "com.example.app"');
        expect(out.endsWith('\n')).toBe(true);
    });

    it('is deterministic — same input produces byte-identical output', () => {
        const a = renderJsonc(SAMPLE_MAP);
        const b = renderJsonc(SAMPLE_MAP);
        expect(a).toBe(b);
    });

    it('uses 4-space indent', () => {
        const out = renderJsonc(SAMPLE_MAP);
        // The first indented line in the body should start with 4 spaces.
        expect(out).toMatch(/\n {4}"schema_version"/);
    });
});

describe('detectFormat', () => {
    it('returns yaml for multi-line input', () => {
        expect(detectFormat('foo: bar\nbaz: qux')).toBe('yaml');
    });

    it('returns ts for .ts path', () => {
        expect(detectFormat('/some/path.ts')).toBe('ts');
    });

    it('returns ts for .js path', () => {
        expect(detectFormat('/some/path.js')).toBe('ts');
    });

    it('returns ts for .mjs path', () => {
        expect(detectFormat('module.mjs')).toBe('ts');
    });

    it('returns ts for .cjs path', () => {
        expect(detectFormat('module.cjs')).toBe('ts');
    });

    it('returns yaml when extension is unrecognized', () => {
        expect(detectFormat('whatever.txt')).toBe('yaml');
    });

    it('returns yaml when no extension at all', () => {
        expect(detectFormat('something')).toBe('yaml');
    });
});

describe('convertToJsonc', () => {
    it('converts YAML source explicitly', async () => {
        const out = await convertToJsonc(SAMPLE_YAML, 'yaml');
        expect(out).toContain('"app": "com.example.app"');
        expect(out).toContain('"obfuscated": "aaaa"');
    });

    it('auto-detects YAML when input contains newlines', async () => {
        const out = await convertToJsonc(SAMPLE_YAML);
        expect(out).toContain('"app": "com.example.app"');
    });

    it('converts a TS-module fixture explicitly', async () => {
        const out = await convertToJsonc(tsFixture, 'ts');
        expect(out).toContain('"app": "com.example.app"');
        expect(out).toContain('"obfuscated": "aaaa"');
    });

    it('auto-detects TS module by .mjs extension', async () => {
        const out = await convertToJsonc(tsFixture);
        expect(out).toContain('"app": "com.example.app"');
    });

    it('is deterministic — same input → same output', async () => {
        const a = await convertToJsonc(SAMPLE_YAML, 'yaml');
        const b = await convertToJsonc(SAMPLE_YAML, 'yaml');
        expect(a).toBe(b);
    });

    it('propagates MapValidationError on bad input', async () => {
        await expect(convertToJsonc('schema_version: 99', 'yaml')).rejects.toThrow(
            MapValidationError,
        );
    });

    it('rejects an unsupported format string', async () => {
        // Bypass TS to test the defensive branch.
        await expect(convertToJsonc(SAMPLE_YAML, 'unknown' as 'yaml')).rejects.toThrow(
            /unsupported convert format/,
        );
    });
});
