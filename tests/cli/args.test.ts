/**
 * Tests for the shared spec-driven argv parser.
 *
 * The per-command parsers (init/validate/convert/patch/extract/inspect)
 * are thin maps over this helper; their own tests cover the command-level
 * shaping. Here we exercise the generic mechanics directly.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs, type ArgSpec } from '../../cli/commands/args.js';
import { RosettaError } from '../../src/errors.js';

const SPEC: ArgSpec = {
    options: [
        { name: 'output', aliases: ['-o', '--output'], takesValue: true },
        { name: 'force', aliases: ['--force', '-f'], takesValue: false },
    ],
};

describe('parseArgs', () => {
    it('collects positionals in order', () => {
        const r = parseArgs(['a', 'b', 'c'], { options: [] });
        expect(r.positionals).toEqual(['a', 'b', 'c']);
        expect(r.values).toEqual({});
        expect(r.flags).toEqual({});
    });

    it('parses a value option by either alias', () => {
        expect(parseArgs(['-o', 'x'], SPEC).values.output).toBe('x');
        expect(parseArgs(['--output', 'y'], SPEC).values.output).toBe('y');
    });

    it('parses a boolean flag by either alias', () => {
        expect(parseArgs(['--force'], SPEC).flags.force).toBe(true);
        expect(parseArgs(['-f'], SPEC).flags.force).toBe(true);
    });

    it('mixes positionals, values, and flags', () => {
        const r = parseArgs(['in.yaml', '-o', 'out.json', '--force'], SPEC);
        expect(r.positionals).toEqual(['in.yaml']);
        expect(r.values.output).toBe('out.json');
        expect(r.flags.force).toBe(true);
    });

    it('throws RosettaError on an unknown option', () => {
        expect(() => parseArgs(['--bogus'], SPEC)).toThrow(RosettaError);
        expect(() => parseArgs(['--bogus'], SPEC)).toThrow(/unknown option: --bogus/);
    });

    it('throws on any flag against an empty spec', () => {
        // Self-contained coverage of the "no options declared" grammar:
        // an empty spec still rejects a dash-led token as unknown.
        expect(() => parseArgs(['--flag'], { options: [] })).toThrow(/unknown option: --flag/);
    });

    it('throws RosettaError when a value option has no value', () => {
        expect(() => parseArgs(['-o'], SPEC)).toThrow(/-o requires a value/);
    });

    it('treats a later value-option occurrence as overriding the earlier', () => {
        expect(parseArgs(['-o', 'a', '-o', 'b'], SPEC).values.output).toBe('b');
    });
});
