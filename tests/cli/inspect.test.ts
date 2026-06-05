/**
 * Tests for `rosetta inspect` — the CLI command that prints a one-line
 * summary of an embedded map.
 *
 * Coverage targets:
 *   - argv parsing
 *   - single-map summary format
 *   - registry summary format (single-app vs mixed-app)
 *   - file-read failure
 *   - parse failure
 */

import { describe, expect, it } from 'vitest';
import { parseInspectArgs, runInspect } from '../../cli/commands/inspect.js';
import { emitMarkerBlock, emitMarkerRegistry } from '../../src/marker/index.js';
import type { RosettaMap, RosettaMapRegistry } from '../../src/types/map.js';
import { makeCaptured, makeFakeFs, makeIo } from './helpers.js';

const map = (version = '1.2.3', app = 'com.example.app'): RosettaMap => ({
    schema_version: 2,
    version_code: 1,
    app,
    version,
    classes: { IFoo: { obfuscated: 'aaaa' } },
});

describe('parseInspectArgs', () => {
    it('accepts a single positional bundle', () => {
        expect(parseInspectArgs(['bundle.js'])).toEqual({ bundle: 'bundle.js' });
    });

    it('throws on missing bundle', () => {
        expect(() => parseInspectArgs([])).toThrow(/missing required argument/);
    });

    it('throws on unknown option', () => {
        expect(() => parseInspectArgs(['--bogus', 'bundle.js'])).toThrow(/unknown option/);
    });

    it('throws on extra positional', () => {
        expect(() => parseInspectArgs(['a.js', 'b.js'])).toThrow(/unexpected positional/);
    });
});

describe('runInspect', () => {
    it('prints a single-map summary', async () => {
        const m = map('1.2.3');
        // Two classes in the map.
        m.classes = { IFoo: { obfuscated: 'aaaa' }, IBar: { obfuscated: 'bbbb' } };
        const bundle = emitMarkerBlock(m);
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const code = await runInspect(['b.js'], makeIo(fs, captured));
        expect(code).toBe(0);
        expect(captured.stdout[0]).toBe('com.example.app@1.2.3, schema_version 2, 2 classes');
    });

    it('prints a registry summary for a single-app registry', async () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': map('1.0.0'),
            '2.0.0': map('2.0.0'),
        };
        const bundle = emitMarkerRegistry(reg);
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const code = await runInspect(['b.js'], makeIo(fs, captured));
        expect(code).toBe(0);
        // app appears once (single-app), versions list shown, total = 2
        expect(captured.stdout[0]).toBe(
            'registry: com.example.app, versions=[1.0.0, 2.0.0], 2 classes total',
        );
    });

    it('prints a registry summary marking app as "mixed" for multi-app', async () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': map('1.0.0', 'com.example.a'),
            '2.0.0': map('2.0.0', 'com.example.b'),
        };
        const bundle = emitMarkerRegistry(reg);
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const code = await runInspect(['b.js'], makeIo(fs, captured));
        expect(code).toBe(0);
        expect(captured.stdout[0]).toMatch(/^registry: mixed,/);
    });

    it('tolerates a registry with a null entry (defensive `if (!m) continue` branch)', async () => {
        // Hand-construct a registry bundle whose payload has a literal
        // `null` for one version. `JSON.parse` returns null (not
        // undefined), so `summarizeRegistry`'s `if (!m) continue` branch
        // fires on a real-world malformed input (rather than just being
        // a theoretical guard).
        const validMap = map('1.0.0');
        const payload = JSON.stringify({ '1.0.0': validMap, broken: null }, null, 4);
        const bundle =
            '/*! -----BEGIN ROSETTA MAP REGISTRY----- */\n' +
            `const __rosetta_maps = ${payload};\n` +
            '/*! -----END ROSETTA MAP REGISTRY----- */';
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const code = await runInspect(['b.js'], makeIo(fs, captured));
        expect(code).toBe(0);
        // The one valid map's app, one class. `broken` still appears in
        // the versions list (Object.keys includes it) but contributes
        // zero classes and no app entry.
        expect(captured.stdout[0]).toBe(
            'registry: com.example.app, versions=[1.0.0, broken], 1 classes total',
        );
    });

    it('exits 1 with usage error when args are malformed', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await runInspect([], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/inspect:.*missing required argument/);
    });

    it('exits 1 when bundle file cannot be read', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        const code = await runInspect(['missing.js'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/cannot read bundle/);
    });

    it('exits 1 when bundle has no marker block', async () => {
        const fs = makeFakeFs({ 'b.js': '// nothing here' });
        const captured = makeCaptured();
        const code = await runInspect(['b.js'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/no rosetta-frida marker block/);
    });

    it('exits 1 (not 2) on a malformed-but-parseable single-map payload', async () => {
        // Hand-built single-map block whose payload is valid JSON but is
        // NOT a valid RosettaMap (no `classes`, no `schema_version`).
        // Previously `Object.keys(map.classes)` threw a TypeError outside
        // the try/catch → exit 2; now `validateMap` makes it a clean exit 1.
        const bundle =
            '/*! -----BEGIN ROSETTA MAP----- */\n' +
            'const __rosetta_map = {"app": "com.example.app"};\n' +
            '/*! -----END ROSETTA MAP----- */';
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const code = await runInspect(['b.js'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/inspect:.*schema validation/i);
    });

    it('exits 1 when a registry payload is not an object (e.g. JSON null)', async () => {
        const bundle =
            '/*! -----BEGIN ROSETTA MAP REGISTRY----- */\n' +
            'const __rosetta_maps = null;\n' +
            '/*! -----END ROSETTA MAP REGISTRY----- */';
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const code = await runInspect(['b.js'], makeIo(fs, captured));
        expect(code).toBe(1);
        expect(captured.stderr[0]).toMatch(/inspect:.*registry payload is not an object/);
    });

    it('tolerates a registry entry that is an object but lacks `classes`', async () => {
        // Object-but-malformed entry: counted as zero classes, no app added,
        // rather than throwing a TypeError from Object.keys(undefined).
        const validMap = map('1.0.0');
        const payload = JSON.stringify({ '1.0.0': validMap, partial: { version: '9' } }, null, 4);
        const bundle =
            '/*! -----BEGIN ROSETTA MAP REGISTRY----- */\n' +
            `const __rosetta_maps = ${payload};\n` +
            '/*! -----END ROSETTA MAP REGISTRY----- */';
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const code = await runInspect(['b.js'], makeIo(fs, captured));
        expect(code).toBe(0);
        expect(captured.stdout[0]).toBe(
            'registry: com.example.app, versions=[1.0.0, partial], 1 classes total',
        );
    });
});
