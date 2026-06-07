/**
 * Tests for the structural validator (the Zod-backed schema check).
 */

import { describe, it, expect } from 'vitest';
import { validateStructure } from './validate.js';
import { MapValidationError } from '../errors.js';

const MINIMAL = {
    schema_version: 2,
    version_code: 1,
    app: 'com.example.app',
    version: '1.0.0',
    classes: {
        IFoo: { obfuscated: 'aaaa' },
    },
};

describe('validateStructure', () => {
    it('accepts a minimal map', () => {
        const map = validateStructure(MINIMAL);
        expect(map.app).toBe('com.example.app');
    });

    it('accepts every optional metadata field', () => {
        const full = {
            ...MINIMAL,
            captured_at: '2026-05-13',
            signer_sha256: 'a'.repeat(64),
            client_hints: {
                frida_min_version: '16.0.0',
                frida_max_version: '17.99.99',
            },
            sources: [
                {
                    tool: 'sigmatcher',
                    config: 'sig.json',
                    classes: 1,
                    notes: 'ok',
                    confidence: 'high' as const,
                },
            ],
        };
        const map = validateStructure(full);
        expect(map.signer_sha256?.length).toBe(64);
        expect(map.sources?.[0]?.confidence).toBe('high');
    });

    it('accepts a class with all optional fields', () => {
        const full = {
            ...MINIMAL,
            classes: {
                IFoo: {
                    obfuscated: 'aaaa',
                    extends: 'java.lang.Object',
                    kind: 'aidl_stub',
                    dex: 'classes.dex',
                    aidl_descriptor: 'com.example.app.IFoo',
                    anchors: ['anchor-string'],
                    source: 'sigmatcher',
                    confidence: 'high',
                    methods: {
                        bar: { obfuscated: 'a', signature: '()V' },
                        baz: [
                            {
                                obfuscated: 'b',
                                signature: '()V',
                                aidl_txn: 1,
                                static: false,
                                synthetic: false,
                                is_constructor: false,
                            },
                            { obfuscated: 'c', signature: '(I)V' },
                        ],
                    },
                    fields: {
                        x: { obfuscated: 'a', type: 'I', static: true },
                    },
                },
            },
        };
        const map = validateStructure(full);
        expect(map.classes.IFoo?.kind).toBe('aidl_stub');
    });

    it('throws MapValidationError with issues on a bad map', () => {
        try {
            validateStructure({ schema_version: 2, version_code: 1, app: 'x' });
            throw new Error('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            expect(err.issues.length).toBeGreaterThan(0);
        }
    });

    it('formats a single-issue error count correctly', () => {
        try {
            validateStructure({
                schema_version: 2,
                version_code: 1,
                app: 'x',
                version: '1.0',
                classes: { IFoo: {} },
            });
        } catch (e) {
            expect(e).toBeInstanceOf(MapValidationError);
            const err = e as MapValidationError;
            // One issue → "1 issue" (singular).
            if (err.issues.length === 1) {
                expect(err.message).toContain('1 issue');
                expect(err.message).not.toContain('1 issues');
            }
        }
    });

    it('rejects an empty method overloads array', () => {
        const bad = {
            ...MINIMAL,
            classes: {
                IFoo: {
                    obfuscated: 'aaaa',
                    methods: {
                        bar: [],
                    },
                },
            },
        };
        expect(() => validateStructure(bad)).toThrow(MapValidationError);
    });
});
