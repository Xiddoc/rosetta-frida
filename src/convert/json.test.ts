/**
 * Tests for the canonical strict-JSON emitter + `convertToJson` entry point.
 */

import { describe, it, expect } from 'vitest';
import { convertToJson, renderJson, detectFormat } from './json.js';
import { MapValidationError, RosettaError } from '../errors.js';
import type { RosettaMap } from '../types/map.js';

const SAMPLE_YAML = `
schema_version: 2
app: com.example.app
version: "1.0.0"
version_code: 100
classes:
  IFoo:
    obfuscated: aaaa
    methods:
      bar:
        obfuscated: a
        signature: "()V"
`;

const SAMPLE_MAP: RosettaMap = {
    schema_version: 2,
    app: 'com.example.app',
    version: '1.0.0',
    version_code: 100,
    classes: {
        IFoo: {
            obfuscated: 'aaaa',
            methods: { bar: { obfuscated: 'a', signature: '()V' } },
        },
    },
};

describe('renderJson', () => {
    it('emits a bare JSON body with no comment header', () => {
        const out = renderJson(SAMPLE_MAP);
        expect(out.startsWith('{')).toBe(true);
        expect(out).not.toContain('//');
        expect(out).toContain('"app": "com.example.app"');
        expect(out).toContain('"version_code": 100');
        expect(out.endsWith('\n')).toBe(true);
    });

    it('round-trips through JSON.parse (strict — no comments)', () => {
        const out = renderJson(SAMPLE_MAP);
        expect(JSON.parse(out)).toEqual(SAMPLE_MAP);
    });

    it('is deterministic — same input produces byte-identical output', () => {
        const a = renderJson(SAMPLE_MAP);
        const b = renderJson(SAMPLE_MAP);
        expect(a).toBe(b);
    });

    it('uses 4-space indent', () => {
        const out = renderJson(SAMPLE_MAP);
        expect(out).toMatch(/^\{\n {4}"schema_version"/);
    });
});

describe('detectFormat', () => {
    it('returns yaml for multi-line input', () => {
        expect(detectFormat('foo: bar\nbaz: qux')).toBe('yaml');
    });

    it('refuses a .ts path (no longer imported)', () => {
        expect(() => detectFormat('/some/path.ts')).toThrow(/no longer supported/);
    });

    it('refuses a .js path', () => {
        expect(() => detectFormat('/some/path.js')).toThrow(RosettaError);
    });

    it('refuses a .mjs path', () => {
        expect(() => detectFormat('module.mjs')).toThrow(/no longer supported/);
    });

    it('refuses a .cjs path', () => {
        expect(() => detectFormat('module.cjs')).toThrow(/no longer supported/);
    });

    it('does NOT refuse module-looking text that contains a newline (it is YAML source)', () => {
        // A YAML document that happens to mention a .ts path is still YAML.
        expect(detectFormat('note: see config.ts\napp: com.example.app')).toBe('yaml');
    });

    it('returns yaml when extension is unrecognized', () => {
        expect(detectFormat('whatever.txt')).toBe('yaml');
    });

    it('returns yaml when no extension at all', () => {
        expect(detectFormat('something')).toBe('yaml');
    });
});

describe('convertToJson', () => {
    it('converts YAML source explicitly', async () => {
        const out = await convertToJson(SAMPLE_YAML, 'yaml');
        expect(out).toContain('"app": "com.example.app"');
        expect(out).toContain('"obfuscated": "aaaa"');
    });

    it('auto-detects YAML when input contains newlines', async () => {
        const out = await convertToJson(SAMPLE_YAML);
        expect(out).toContain('"app": "com.example.app"');
    });

    it('refuses a TS-module path under auto-detect (never imported)', async () => {
        await expect(convertToJson('/some/path.mjs')).rejects.toThrow(/no longer supported/);
    });

    it('is deterministic — same input → same output', async () => {
        const a = await convertToJson(SAMPLE_YAML, 'yaml');
        const b = await convertToJson(SAMPLE_YAML, 'yaml');
        expect(a).toBe(b);
    });

    it('propagates MapValidationError on bad input', async () => {
        await expect(convertToJson('schema_version: 99', 'yaml')).rejects.toThrow(
            MapValidationError,
        );
    });

    it('rejects an unsupported format string', async () => {
        // Bypass TS to test the defensive branch.
        await expect(convertToJson(SAMPLE_YAML, 'unknown' as 'yaml')).rejects.toThrow(
            /unsupported convert format/,
        );
    });

    it('emits a canonical lowercase-no-colon signer_sha256 end-to-end (maps#11)', async () => {
        const upperColon = Array.from({ length: 32 }, () => 'AB').join(':');
        const yaml = `
schema_version: 2
app: com.example.app
version: "1.0.0"
version_code: 100
signer_sha256: "${upperColon}"
classes: {}
`;
        const out = await convertToJson(yaml, 'yaml');
        expect(out).toContain(`"signer_sha256": "${'ab'.repeat(32)}"`);
        expect(out).not.toContain(':AB');
        // The emitted artifact round-trips through the strict validator.
        const reparsed = JSON.parse(out) as { signer_sha256?: string };
        expect(reparsed.signer_sha256).toMatch(/^[0-9a-f]{64}$/);
    });
});
