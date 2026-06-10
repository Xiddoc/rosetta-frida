import { describe, it, expect } from 'vitest';
import { parseAppVersionTarget } from './target.js';
import { RosettaError } from '../errors.js';

describe('parseAppVersionTarget', () => {
    it('parses a valid <app>@<version_code>', () => {
        expect(parseAppVersionTarget('com.example.app@30405', 'pull')).toEqual({
            app: 'com.example.app',
            version_code: 30405,
        });
    });

    it('prefixes the error message with the supplied verb', () => {
        // The only per-verb difference is the leading literal in the message;
        // a second arbitrary verb proves the prefix is threaded, not hard-coded.
        expect(() => parseAppVersionTarget('com.example.app', 'pull')).toThrow(
            /^pull target must be/,
        );
        expect(() => parseAppVersionTarget('com.example.app', 'fetch')).toThrow(
            /^fetch target must be/,
        );
    });

    it('rejects a target with zero @ (exactly one required)', () => {
        expect(() => parseAppVersionTarget('com.example.app', 'pull')).toThrow(/exactly one/);
    });

    it('rejects a target with more than one @', () => {
        expect(() => parseAppVersionTarget('a.b@1@2', 'pull')).toThrow(/exactly one/);
    });

    it('rejects an empty app before @', () => {
        expect(() => parseAppVersionTarget('@30405', 'pull')).toThrow(
            /the app name before '@' is empty/,
        );
    });

    it('rejects scientific notation (digits only)', () => {
        expect(() => parseAppVersionTarget('a.b@1e3', 'pull')).toThrow(/decimal digits only/);
    });

    it('rejects a zero version_code (must be positive)', () => {
        expect(() => parseAppVersionTarget('a.b@0', 'pull')).toThrow(/positive integer/);
    });

    it('throws RosettaError (not a bare Error)', () => {
        expect(() => parseAppVersionTarget('bad', 'pull')).toThrow(RosettaError);
    });
});
