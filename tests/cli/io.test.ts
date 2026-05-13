/**
 * Tests for the shared CLI I/O helpers (errorMessage). The CommandIo
 * shape itself is a pure type — no runtime test surface.
 */

import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../cli/commands/io.js';

describe('errorMessage', () => {
    it('returns the message of an Error instance', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
    });

    it('coerces non-Error throwables via String()', () => {
        expect(errorMessage('string thrown')).toBe('string thrown');
        expect(errorMessage(42)).toBe('42');
        expect(errorMessage(null)).toBe('null');
        expect(errorMessage(undefined)).toBe('undefined');
    });
});
