/**
 * Tests for the marker-block format constants and regex.
 *
 * The regex is the most load-bearing piece — third-party tools rely on
 * the published shape from design §5.5. These tests pin that shape so
 * a change is caught before it ships.
 */

import { describe, expect, it } from 'vitest';
import {
    BEGIN_MARKER,
    BEGIN_REGISTRY,
    END_MARKER,
    END_REGISTRY,
    MARKER_REGEX,
    REGISTRY_VAR_NAME,
    SINGLE_VAR_NAME,
} from './format.js';

describe('marker format constants', () => {
    it('exposes the documented marker text', () => {
        expect(BEGIN_MARKER).toBe('-----BEGIN ROSETTA MAP-----');
        expect(END_MARKER).toBe('-----END ROSETTA MAP-----');
        expect(BEGIN_REGISTRY).toBe('-----BEGIN ROSETTA MAP REGISTRY-----');
        expect(END_REGISTRY).toBe('-----END ROSETTA MAP REGISTRY-----');
    });

    it('exposes the internal variable names', () => {
        expect(SINGLE_VAR_NAME).toBe('__rosetta_map');
        expect(REGISTRY_VAR_NAME).toBe('__rosetta_maps');
    });
});

/**
 * Helper: collect every match of MARKER_REGEX against a string. We
 * make a fresh copy of the regex per call so the global-flag lastIndex
 * doesn't bleed across tests.
 */
function findAll(source: string): RegExpExecArray[] {
    const rx = new RegExp(MARKER_REGEX.source, MARKER_REGEX.flags);
    const out: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = rx.exec(source)) !== null) {
        out.push(m);
    }
    return out;
}

describe('MARKER_REGEX', () => {
    it('matches a single-map block', () => {
        const text = `header\n/*! -----BEGIN ROSETTA MAP----- */\nconst __rosetta_map = {};\n/*! -----END ROSETTA MAP----- */\ntrailer`;
        const matches = findAll(text);
        expect(matches).toHaveLength(1);
        // Capture group 1 is the trailing label after `MAP`. Empty for single.
        expect(matches[0]?.[1]).toBe('');
        // The payload body contains the var declaration.
        expect(matches[0]?.[2]).toContain('__rosetta_map');
    });

    it('matches a registry block', () => {
        const text = `/*! -----BEGIN ROSETTA MAP REGISTRY----- */\nconst __rosetta_maps = {};\n/*! -----END ROSETTA MAP REGISTRY----- */`;
        const matches = findAll(text);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.[1]).toBe(' REGISTRY');
        expect(matches[0]?.[2]).toContain('__rosetta_maps');
    });

    it('matches both blocks when both appear in one bundle', () => {
        const text = [
            '/*! -----BEGIN ROSETTA MAP----- */',
            'const __rosetta_map = {};',
            '/*! -----END ROSETTA MAP----- */',
            'console.log("between");',
            '/*! -----BEGIN ROSETTA MAP REGISTRY----- */',
            'const __rosetta_maps = {};',
            '/*! -----END ROSETTA MAP REGISTRY----- */',
        ].join('\n');
        const matches = findAll(text);
        expect(matches).toHaveLength(2);
        expect(matches[0]?.[1]).toBe('');
        expect(matches[1]?.[1]).toBe(' REGISTRY');
    });

    it('is non-greedy across adjacent blocks (does not coalesce)', () => {
        const text = [
            '/*! -----BEGIN ROSETTA MAP----- */',
            'const __rosetta_map = {"a":1};',
            '/*! -----END ROSETTA MAP----- */',
            '/*! -----BEGIN ROSETTA MAP----- */',
            'const __rosetta_map = {"a":2};',
            '/*! -----END ROSETTA MAP----- */',
        ].join('\n');
        const matches = findAll(text);
        expect(matches).toHaveLength(2);
        // Each block's payload should contain only its own var-decl.
        expect(matches[0]?.[2]).toContain('"a":1');
        expect(matches[0]?.[2]).not.toContain('"a":2');
    });

    it('does not match unrelated text', () => {
        const text = 'function foo() { return -----BEGIN BOGUS-----; }';
        expect(findAll(text)).toHaveLength(0);
    });
});
