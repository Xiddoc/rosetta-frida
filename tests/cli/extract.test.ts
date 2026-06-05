/**
 * Tests for `rosetta extract` — the CLI command that pulls an embedded
 * map out of a compiled bundle.
 *
 * Coverage targets:
 *   - argv parsing: success, missing bundle, missing -o, dangling -o,
 *     unknown option, extra positional
 *   - happy paths: single-map and registry bundles
 *   - read-error, parse-error, write-error all surface as exit 1
 */

import { describe, expect, it } from 'vitest';
import { parseExtractArgs, runExtract } from '../../cli/commands/extract.js';
import { emitMarkerBlock, emitMarkerRegistry } from '../../src/marker/index.js';
import type { RosettaMap, RosettaMapRegistry } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeIo } from './helpers.js';

const minimalMap = (version = '1.2.3'): RosettaMap => ({
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version,
    classes: {},
});

const richMap = (): RosettaMap => ({
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version: '2.0.0',
    classes: { IFoo: { obfuscated: 'aaaa' } },
});

describe('parseExtractArgs', () => {
    it('accepts <bundle> -o <out>', () => {
        expect(parseExtractArgs(['bundle.js', '-o', 'out.json'])).toEqual({
            bundle: 'bundle.js',
            output: 'out.json',
        });
    });

    it('accepts <bundle> --output <out>', () => {
        expect(parseExtractArgs(['bundle.js', '--output', 'out.json'])).toEqual({
            bundle: 'bundle.js',
            output: 'out.json',
        });
    });

    it('accepts arguments in either order', () => {
        expect(parseExtractArgs(['-o', 'out.json', 'bundle.js'])).toEqual({
            bundle: 'bundle.js',
            output: 'out.json',
        });
    });

    it('throws on missing bundle', () => {
        expect(() => parseExtractArgs(['-o', 'out.json'])).toThrow(/missing required argument/);
    });

    it('throws on missing -o', () => {
        expect(() => parseExtractArgs(['bundle.js'])).toThrow(/-o <out\.json>/);
    });

    it('throws on dangling -o', () => {
        expect(() => parseExtractArgs(['bundle.js', '-o'])).toThrow(/requires a path argument/);
    });

    it('throws on unknown option', () => {
        expect(() => parseExtractArgs(['bundle.js', '--bogus'])).toThrow(/unknown option/);
    });

    it('throws on extra positional', () => {
        expect(() => parseExtractArgs(['a.js', 'b.js', '-o', 'c.json'])).toThrow(
            /unexpected positional/,
        );
    });
});

describe('runExtract', () => {
    it('extracts a single-map bundle to JSON', async () => {
        const map = richMap();
        const bundle = `// preamble\n${emitMarkerBlock(map)}\n// trailer\n`;
        const fs = makeFakeFs({ 'bundle.js': bundle });
        const captured = makeCaptured();

        const code = await runExtract(['bundle.js', '-o', 'out.json'], makeIo(fs, captured));
        expect(code).toBe(0);
        const written = fs.files.get('out.json');
        expect(written).toBeDefined();
        // Pretty-printed with 2-space indent.
        expect(written).toContain('\n  "schema_version": 2,');
        expect(JSON.parse(written!)).toEqual(map);
        // Output ends with a trailing newline.
        expect(written!.endsWith('\n')).toBe(true);
        expect(captured.stdout[0]).toMatch(/wrote out\.json.*single/);
    });

    it('extracts a registry bundle to JSON', async () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': minimalMap('1.0.0'),
            '2.0.0': minimalMap('2.0.0'),
        };
        const bundle = emitMarkerRegistry(reg);
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();

        const code = await runExtract(['b.js', '-o', 'reg.json'], makeIo(fs, captured));
        expect(code).toBe(0);
        const written = fs.files.get('reg.json');
        expect(JSON.parse(written!)).toEqual(reg);
        expect(captured.stdout[0]).toMatch(/registry/);
    });

    it('exits 1 with usage error when args are malformed', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await runExtract([], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/extract:.*missing required argument/);
    });

    it('exits 1 when bundle file cannot be read', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await runExtract(['missing.js', '-o', 'out.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/cannot read bundle/);
    });

    it('exits 1 when bundle has no marker block', async () => {
        const fs = makeFakeFs({ 'b.js': 'console.log("no marker");' });
        const captured = makeCaptured();
        const code = await runExtract(['b.js', '-o', 'out.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/no rosetta-frida marker block/);
    });

    it('exits 1 when output cannot be written', async () => {
        const map = minimalMap();
        const fs = makeFakeFs({ 'b.js': emitMarkerBlock(map) });
        fs.writeErrors.set('out.json', new Error('EACCES'));
        const captured = makeCaptured();
        const code = await runExtract(['b.js', '-o', 'out.json'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/cannot write output.*EACCES/);
    });

    it('allows -o with a parent-traversal path (operator may write outside CWD)', async () => {
        const map = minimalMap();
        const fs = makeFakeFs({ 'b.js': emitMarkerBlock(map) });
        const captured = makeCaptured();
        const code = await runExtract(['b.js', '-o', '../escape.json'], makeIo(fs, captured));
        expect(code).toBe(0);
        expect(fs.files.has('../escape.json')).toBe(true);
        expect(captured.stdout[0]).toMatch(/wrote \.\.\/escape\.json/);
    });

    it('allows -o with an absolute path outside the project tree', async () => {
        // Regression: CI smoke test uses `extract <bundle> -o /tmp/extracted.json`.
        const map = minimalMap();
        const fs = makeFakeFs({ 'b.js': emitMarkerBlock(map) });
        const captured = makeCaptured();
        const code = await runExtract(['b.js', '-o', '/tmp/extracted.json'], makeIo(fs, captured));
        expect(code).toBe(0);
        expect(fs.files.has('/tmp/extracted.json')).toBe(true);
        expect(JSON.parse(fs.files.get('/tmp/extracted.json')!)).toEqual(map);
    });

    it('exits 1 when -o contains a NUL byte', async () => {
        const fs = makeFakeFs({ 'b.js': emitMarkerBlock(minimalMap()) });
        const captured = makeCaptured();
        const code = await runExtract(['b.js', '-o', 'out.json\0.png'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/NUL/);
    });
});
