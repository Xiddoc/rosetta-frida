/**
 * End-to-end test for the sample-hook example.
 *
 * Exercises the same patterns the example demonstrates against the
 * Frida mock + the canonical sample map. This is what would run under
 * Frida if you bundled the hook with `frida-compile` and attached to
 * `com.example.app`.
 *
 * Also confirms the marker-block round-trip works on a bundle that
 * embeds the sample map.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    emitMarkerBlock,
    parseMarkerBlock,
    patchMarkerBlock,
    rosetta,
    type RosettaMap,
} from '../../src/index.js';
import { _resetCurrentSession } from '../../src/api/rosetta.js';
import { MockFrida, installFridaMock, resetFridaMock } from '../../tests/mocks/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_MAP_PATH = join(HERE, '..', '..', 'maps', 'com.example.app', '30405.json');

function loadSampleMap(): RosettaMap {
    // The on-disk artifact is strict JSON — parse it directly.
    const raw = readFileSync(SAMPLE_MAP_PATH, 'utf8');
    return JSON.parse(raw) as RosettaMap;
}

describe('sample-hook example', () => {
    let map: RosettaMap;

    beforeEach(() => {
        installFridaMock();
        _resetCurrentSession();
        map = loadSampleMap();
    });

    afterEach(() => {
        _resetCurrentSession();
        resetFridaMock();
    });

    describe('session can attach against the sample map', () => {
        it('constructs without errors when target classes are registered', () => {
            // Register a handful of mock classes — the health check
            // tolerates a partial registry as long as 80% of mapped
            // classes resolve (default threshold).
            for (const obfName of [
                'aaaa', // IRemoteService$Stub
                'bbbb', // IServiceCallback
                'cccc', // IDialogCallback
                'dddd', // RemoteServiceClient
                'eeee', // AbstractServiceClient (best-effort guess)
                'ffff',
                'gggg',
                'hhhh',
                'iiii',
                'jjjj',
                'kkkk',
                'llll',
                'mmmm',
                'nnnn',
                'oooo',
            ]) {
                MockFrida.registerClass(obfName, {});
            }

            const session = rosetta.session({
                map,
                app: 'com.example.app',
                version: '3.4.5',
                enforceSigner: false,
                skipHealthCheck: true,
            });
            expect(session.app).toBe('com.example.app');
            expect(session.healthy).toBe(true);
        });
    });

    describe('tier 1 patterns', () => {
        it('object-form hook with overload-args disambiguation installs', () => {
            // Set up the mock class with two overloads of `c` (the obf
            // method name) — matching what the sample map says about
            // IRemoteService$Stub.requestTicket.
            const cache = new Map<string, ReturnType<typeof Java.use>>();
            const originalUse = Java.use.bind(Java);
            vi.spyOn(Java, 'use').mockImplementation((name: string) => {
                const cached = cache.get(name);
                if (cached) return cached;
                const w = originalUse(name);
                cache.set(name, w);
                return w;
            });

            MockFrida.registerClass('aaaa', {
                methods: {
                    c: [
                        {
                            argumentTypes: [
                                { className: 'android.os.Bundle' },
                                { className: 'bbbb' },
                            ],
                            returnType: { className: 'void' },
                        },
                    ],
                    d: [
                        {
                            argumentTypes: [
                                { className: 'android.os.Bundle' },
                                { className: 'java.lang.String' },
                                { className: 'bbbb' },
                            ],
                            returnType: { className: 'void' },
                        },
                    ],
                },
            });
            MockFrida.registerClass('bbbb', {});

            rosetta.session({
                map,
                app: 'com.example.app',
                version: '3.4.5',
                enforceSigner: false,
                skipHealthCheck: true,
            });

            const handle = rosetta.hook(
                {
                    class: 'com.example.app.IRemoteService$Stub',
                    method: 'requestTicket',
                    args: ['android.os.Bundle', 'com.example.app.IServiceCallback'],
                },
                () => 'patched',
            );
            expect(handle.detached).toBe(false);
            handle.detach();
            expect(handle.detached).toBe(true);
        });

        it('rosetta.field reads instance fields by real name', () => {
            MockFrida.registerClass('dddd', {
                fields: {
                    a: { type: 'Ljava/lang/String;', initial: 'abc-123' },
                },
            });
            rosetta.session({
                map,
                app: 'com.example.app',
                version: '3.4.5',
                enforceSigner: false,
                skipHealthCheck: true,
            });

            const Client = Java.use('dddd'); // RemoteServiceClient
            const inst = Client.$new();
            expect(rosetta.field(inst, 'sessionId')).toBe('abc-123');
        });
    });

    describe('tier 2 patterns', () => {
        it('rosetta.use returns a class proxy with $realName / $obfName', () => {
            MockFrida.registerClass('aaaa', {});
            rosetta.session({
                map,
                app: 'com.example.app',
                version: '3.4.5',
                enforceSigner: false,
                skipHealthCheck: true,
            });
            const Stub = rosetta.use('com.example.app.IRemoteService$Stub');
            expect(Stub.$realName).toBe('com.example.app.IRemoteService$Stub');
            expect(Stub.$obfName).toBe('aaaa');
        });
    });

    describe('tier 3 patterns', () => {
        it('rosetta.map.resolveClass returns the expected obf name', () => {
            rosetta.session({
                map,
                app: 'com.example.app',
                version: '3.4.5',
                enforceSigner: false,
                skipHealthCheck: true,
            });
            const blobCache = rosetta.map.resolveClass('com.example.app.BlobCache');
            expect(blobCache.realName).toBe('com.example.app.BlobCache');
            expect(blobCache.obfName).toBeTruthy();
        });

        it('rosetta.events.onType receives resolve events', () => {
            rosetta.session({
                map,
                app: 'com.example.app',
                version: '3.4.5',
                enforceSigner: false,
                skipHealthCheck: true,
            });
            const names: string[] = [];
            rosetta.events.onType('resolve', (e) => names.push(e.name));
            rosetta.map.resolveClass('com.example.app.BlobCache');
            expect(names).toContain('com.example.app.BlobCache');
        });
    });

    describe('marker block round-trip on a bundle embedding the sample map', () => {
        it('emit + parse round-trips losslessly', () => {
            const block = emitMarkerBlock(map);
            const parsed = parseMarkerBlock(block);
            expect(parsed.kind).toBe('single');
            if (parsed.kind === 'single') {
                expect(parsed.map.app).toBe('com.example.app');
                expect(parsed.map.version).toBe('3.4.5');
                expect(Object.keys(parsed.map.classes).length).toBe(
                    Object.keys(map.classes).length,
                );
            }
        });

        it('patch replaces the map in a bundle without touching other content', () => {
            const beforeContent = '// some user code before\n';
            const afterContent = '\n// some user code after\n';
            const bundle = beforeContent + emitMarkerBlock(map) + afterContent;

            // Patch with a tweaked map (version bumped + extra class).
            const newMap: RosettaMap = {
                ...map,
                version: '3.5.0',
                classes: {
                    ...map.classes,
                    'com.example.app.NewClass': { obfuscated: 'zzzz' },
                },
            };
            const patched = patchMarkerBlock(bundle, newMap);
            expect(patched).toContain(beforeContent);
            expect(patched).toContain(afterContent);

            const reparsed = parseMarkerBlock(patched);
            expect(reparsed.kind).toBe('single');
            if (reparsed.kind === 'single') {
                expect(reparsed.map.version).toBe('3.5.0');
                expect(reparsed.map.classes['com.example.app.NewClass']).toBeDefined();
            }
        });
    });
});
