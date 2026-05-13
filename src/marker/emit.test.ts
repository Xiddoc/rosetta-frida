/**
 * Tests for emitMarkerBlock / emitMarkerRegistry.
 *
 * Properties under test:
 *   - the output contains the canonical BEGIN/END markers
 *   - the header metadata line accurately reflects the payload
 *   - the payload is pretty-printed JSON (4-space indent)
 *   - the payload is parseable as JSON (round-trip equal)
 *   - the wrapping comments are `/*! ... *\/` ("important" form)
 */

import { describe, expect, it } from 'vitest';
import type { RosettaMap, RosettaMapRegistry } from '../types/map.js';
import { emitMarkerBlock, emitMarkerRegistry } from './emit.js';
import { BEGIN_MARKER, BEGIN_REGISTRY, END_MARKER, END_REGISTRY } from './format.js';

/** A minimal well-formed map. */
function minimalMap(): RosettaMap {
    return {
        schema_version: 1,
        app: 'com.example.app',
        version: '1.2.3',
        classes: {},
    };
}

/** A richly-populated map covering optional fields and multiple classes. */
function richMap(): RosettaMap {
    return {
        schema_version: 1,
        app: 'com.example.app',
        version: '3.4.5',
        captured_at: '2026-05-11',
        apk_sha256: 'a'.repeat(64),
        frida_min_version: '16.0.0',
        frida_max_version: '17.99.0',
        sources: [
            { tool: 'sigmatcher', classes: 2, confidence: 'high' },
            { tool: 'hand-authored', classes: 1, notes: 'verified' },
        ],
        classes: {
            'com.example.app.IRemoteService$Stub': {
                obfuscated: 'aaaa',
                extends: 'zzzz',
                kind: 'aidl_stub',
                dex: 'classes6.dex',
                aidl_descriptor: 'com.example.app.IRemoteService',
                anchors: ['unique-marker'],
                methods: {
                    requestTicket: {
                        obfuscated: 'c',
                        signature: '(Landroid/os/Bundle;Lbbbb;)V',
                        aidl_txn: 2,
                    },
                    overloaded: [
                        { obfuscated: 'd', signature: '()V' },
                        { obfuscated: 'e', signature: '(I)V', synthetic: true },
                    ],
                },
                fields: {
                    sessionId: { obfuscated: 'a', type: 'Ljava/lang/String;', static: false },
                },
                source: 'sigmatcher',
                confidence: 'high',
            },
            IServiceCallback: {
                obfuscated: 'bbbb',
                kind: 'aidl_callback',
            },
            EnumKlass: {
                obfuscated: 'cccc',
                kind: 'enum',
            },
        },
    };
}

describe('emitMarkerBlock', () => {
    it('wraps a minimal map in canonical BEGIN/END markers', () => {
        const out = emitMarkerBlock(minimalMap());
        expect(out).toContain(`/*! ${BEGIN_MARKER} */`);
        expect(out).toContain(`/*! ${END_MARKER} */`);
        expect(out).toContain('const __rosetta_map =');
    });

    it('embeds an accurate header metadata line', () => {
        const out = emitMarkerBlock(richMap());
        // header order: app | version | schema | classes
        expect(out).toMatch(
            /\/\*! app: com\.example\.app \| version: 3\.4\.5 \| schema: 1 \| classes: 3 \*\//,
        );
    });

    it('payload is parseable JSON and round-trips deep-equal', () => {
        const map = richMap();
        const out = emitMarkerBlock(map);
        const match = /const __rosetta_map = ([\s\S]+?);\n\/\*! /.exec(out);
        expect(match).not.toBeNull();
        const parsed = JSON.parse(match![1]!) as RosettaMap;
        expect(parsed).toEqual(map);
    });

    it('uses 4-space indent in the embedded JSON', () => {
        const out = emitMarkerBlock(richMap());
        // The first indented line should start with exactly 4 spaces.
        expect(out).toMatch(/\n {4}"schema_version": 1,/);
        // A doubly-nested key should start with 8 spaces.
        expect(out).toMatch(/\n {8}"com\.example\.app\.IRemoteService\$Stub": \{/);
    });

    it('header reports a 0 class count for an empty map', () => {
        const out = emitMarkerBlock(minimalMap());
        expect(out).toContain('classes: 0');
    });
});

describe('emitMarkerRegistry', () => {
    it('wraps a single-version registry in canonical registry markers', () => {
        const reg: RosettaMapRegistry = { '1.2.3': minimalMap() };
        const out = emitMarkerRegistry(reg);
        expect(out).toContain(`/*! ${BEGIN_REGISTRY} */`);
        expect(out).toContain(`/*! ${END_REGISTRY} */`);
        expect(out).toContain('const __rosetta_maps =');
    });

    it('header for a single-app registry reports the shared app name', () => {
        const reg: RosettaMapRegistry = {
            '1.2.3': { ...minimalMap(), version: '1.2.3' },
            '1.2.4': { ...minimalMap(), version: '1.2.4' },
        };
        const out = emitMarkerRegistry(reg);
        expect(out).toContain('app: com.example.app');
        expect(out).toContain('versions: 2');
        expect(out).toContain('classes: 0');
    });

    it('header for a multi-app registry reports "mixed"', () => {
        const a = { ...minimalMap(), app: 'com.example.a' };
        const b = { ...minimalMap(), app: 'com.example.b' };
        const reg: RosettaMapRegistry = { '1.0.0': a, '2.0.0': b };
        const out = emitMarkerRegistry(reg);
        expect(out).toContain('app: mixed');
        expect(out).toContain('versions: 2');
    });

    it('header sums classes across versions', () => {
        const reg: RosettaMapRegistry = {
            '3.4.5': richMap(),
            '3.4.6': richMap(),
        };
        const out = emitMarkerRegistry(reg);
        // Two copies of rich (3 classes each) → 6 total.
        expect(out).toContain('classes: 6');
    });

    it('payload round-trips deep-equal', () => {
        const reg: RosettaMapRegistry = {
            '3.4.5': richMap(),
            '3.4.6': { ...minimalMap(), version: '3.4.6' },
        };
        const out = emitMarkerRegistry(reg);
        const match = /const __rosetta_maps = ([\s\S]+?);\n\/\*! /.exec(out);
        expect(match).not.toBeNull();
        const parsed = JSON.parse(match![1]!) as RosettaMapRegistry;
        expect(parsed).toEqual(reg);
    });

    it('header for an empty registry reports zero versions and mixed app', () => {
        const out = emitMarkerRegistry({});
        // No versions → apps Set is empty → "mixed". Acceptable degenerate case.
        expect(out).toContain('versions: 0');
        expect(out).toContain('classes: 0');
    });

    it('skips undefined entries when summarizing the header', () => {
        // Defensive branch: an entry whose value is undefined (could
        // occur if callers built a registry through delete) must not
        // throw and must not be counted.
        const reg = { '1.0.0': minimalMap(), broken: undefined } as unknown as RosettaMapRegistry;
        const out = emitMarkerRegistry(reg);
        // Two keys → versions:2; only one valid → classes:0; one valid
        // map carrying com.example.app → app label is the single app.
        expect(out).toContain('versions: 2');
        expect(out).toContain('app: com.example.app');
    });
});
