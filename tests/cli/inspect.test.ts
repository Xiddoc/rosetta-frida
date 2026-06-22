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
    schema_version: 5,
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
    // run* returns the success message; the router owns the prefix +
    // stdout, so command-level tests assert on the return value.
    it('returns a single-map summary message', async () => {
        const m = map('1.2.3');
        // Two classes in the map.
        m.classes = { IFoo: { obfuscated: 'aaaa' }, IBar: { obfuscated: 'bbbb' } };
        const bundle = emitMarkerBlock(m);
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const msg = await runInspect(['b.js'], makeIo(fs, captured));
        expect(msg).toBe('com.example.app@1.2.3, schema_version 5, 2 classes');
    });

    it('returns a registry summary message for a single-app registry', async () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': map('1.0.0'),
            '2.0.0': map('2.0.0'),
        };
        const bundle = emitMarkerRegistry(reg);
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const msg = await runInspect(['b.js'], makeIo(fs, captured));
        // app appears once (single-app), versions list shown, total = 2
        expect(msg).toBe('registry: com.example.app, versions=[1.0.0, 2.0.0], 2 classes total');
    });

    it('marks app as "mixed" for a multi-app registry', async () => {
        const reg: RosettaMapRegistry = {
            '1.0.0': map('1.0.0', 'com.example.a'),
            '2.0.0': map('2.0.0', 'com.example.b'),
        };
        const bundle = emitMarkerRegistry(reg);
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const msg = await runInspect(['b.js'], makeIo(fs, captured));
        expect(msg).toMatch(/^registry: mixed,/);
    });

    it('labels app "(unknown)" when no registry entry carries a usable app', async () => {
        // Every entry is null/non-object, so `apps` stays empty. The
        // label must be "(unknown)", NOT "mixed" (which falsely implies
        // more than one app was seen). Covers the apps.size === 0 arm.
        const payload = JSON.stringify({ broken1: null, broken2: 7 }, null, 4);
        const bundle =
            '/*! -----BEGIN ROSETTA MAP REGISTRY----- */\n' +
            `const __rosetta_maps = ${payload};\n` +
            '/*! -----END ROSETTA MAP REGISTRY----- */';
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const msg = await runInspect(['b.js'], makeIo(fs, captured));
        expect(msg).toBe('registry: (unknown), versions=[broken1, broken2], 0 classes total');
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
        const msg = await runInspect(['b.js'], makeIo(fs, captured));
        // The one valid map's app, one class. `broken` still appears in
        // the versions list (Object.keys includes it) but contributes
        // zero classes and no app entry.
        expect(msg).toBe('registry: com.example.app, versions=[1.0.0, broken], 1 classes total');
    });

    // Failure paths now THROW (handled by the router → exit 1); the
    // command no longer prints its own prefixed stderr. Router-level
    // exit-code + prefix coverage lives in router.test.ts.
    it('throws a usage error when args are malformed', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        await expect(runInspect([], makeIo(fs, captured))).rejects.toThrow(
            /missing required argument/,
        );
    });

    it('throws when bundle file cannot be read', async () => {
        const fs = makeFakeFs();
        const captured = makeCaptured();
        await expect(runInspect(['missing.js'], makeIo(fs, captured))).rejects.toThrow(
            /cannot read bundle/,
        );
    });

    it('throws when bundle has no marker block', async () => {
        const fs = makeFakeFs({ 'b.js': '// nothing here' });
        const captured = makeCaptured();
        await expect(runInspect(['b.js'], makeIo(fs, captured))).rejects.toThrow(
            /no rosetta-frida marker block/,
        );
    });

    it('tolerates a malformed-but-parseable single-map payload (best-effort, no Zod)', async () => {
        // Hand-built single-map block whose payload is valid JSON but is
        // NOT a valid RosettaMap (no `classes`, no `schema_version`).
        // inspect is deliberately best-effort: it does NOT run the heavy
        // Zod validateMap (that's `validate`'s job), so a missing `classes`
        // counts as zero classes and absent metadata renders as `undefined`
        // rather than crashing with a TypeError (→ exit 2) or rejecting.
        const bundle =
            '/*! -----BEGIN ROSETTA MAP----- */\n' +
            'const __rosetta_map = {"app": "com.example.app"};\n' +
            '/*! -----END ROSETTA MAP----- */';
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        const msg = await runInspect(['b.js'], makeIo(fs, captured));
        expect(msg).toBe('com.example.app@undefined, schema_version undefined, 0 classes');
    });

    it('throws when a single-map payload is not an object (e.g. JSON null)', async () => {
        // The root guard rejects a non-object single payload as a clean
        // exit-1 RosettaError rather than letting field reads throw a
        // TypeError → exit 2.
        const bundle =
            '/*! -----BEGIN ROSETTA MAP----- */\n' +
            'const __rosetta_map = null;\n' +
            '/*! -----END ROSETTA MAP----- */';
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        await expect(runInspect(['b.js'], makeIo(fs, captured))).rejects.toThrow(
            /map payload is not an object/,
        );
    });

    it('throws when a registry payload is not an object (e.g. JSON null)', async () => {
        const bundle =
            '/*! -----BEGIN ROSETTA MAP REGISTRY----- */\n' +
            'const __rosetta_maps = null;\n' +
            '/*! -----END ROSETTA MAP REGISTRY----- */';
        const fs = makeFakeFs({ 'b.js': bundle });
        const captured = makeCaptured();
        await expect(runInspect(['b.js'], makeIo(fs, captured))).rejects.toThrow(
            /registry payload is not an object/,
        );
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
        const msg = await runInspect(['b.js'], makeIo(fs, captured));
        expect(msg).toBe('registry: com.example.app, versions=[1.0.0, partial], 1 classes total');
    });
});
