/**
 * Tests for the shared CLI I/O helpers (errorMessage, formatErrorLines,
 * writeNew, ensureDir). The CommandIo shape itself is a pure type — no
 * runtime test surface.
 */

import { describe, expect, it } from 'vitest';
import { errorMessage, ensureDir, formatErrorLines, writeNew } from '../../cli/commands/io.js';
import { MapValidationError, RosettaError } from '../../src/errors.js';
import { makeFakeFs, makeFsLike } from './helpers.js';

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

describe('formatErrorLines', () => {
    it('renders a single prefixed line for a plain error', () => {
        expect(formatErrorLines('patch', new Error('boom'))).toEqual(['rosetta patch: boom']);
    });

    it('folds a MapValidationError issue list, with and without paths', () => {
        const err = new MapValidationError('2 issues', [
            { path: 'classes.IFoo.obfuscated', message: 'Required' },
            { path: '', message: 'document is null or empty' },
        ]);
        expect(formatErrorLines('validate', err)).toEqual([
            'rosetta validate: 2 issues',
            '  at classes.IFoo.obfuscated: Required',
            '  document is null or empty',
        ]);
    });
});

describe('ensureDir', () => {
    it('records the recursive mkdir call', async () => {
        const fake = makeFakeFs();
        await ensureDir(makeFsLike(fake), 'a/b/c');
        expect(fake.dirsCreated).toContain('a/b/c');
    });
});

describe('writeNew', () => {
    it('creates a file that does not yet exist', async () => {
        const fake = makeFakeFs();
        await writeNew(makeFsLike(fake), 'out.json', 'data');
        expect(fake.files.get('out.json')).toBe('data');
    });

    it('refuses to overwrite an existing file (atomic wx → EEXIST → RosettaError)', async () => {
        const fake = makeFakeFs({ 'out.json': 'old' });
        await expect(writeNew(makeFsLike(fake), 'out.json', 'new')).rejects.toThrow(RosettaError);
        // Original content preserved.
        expect(fake.files.get('out.json')).toBe('old');
    });

    it('overwrites with { force: true }', async () => {
        const fake = makeFakeFs({ 'out.json': 'old' });
        await writeNew(makeFsLike(fake), 'out.json', 'new', { force: true });
        expect(fake.files.get('out.json')).toBe('new');
    });

    it('rethrows a non-EEXIST write failure unchanged', async () => {
        const fake = makeFakeFs();
        const boom = new Error('EACCES');
        fake.writeErrors.set('out.json', boom);
        await expect(writeNew(makeFsLike(fake), 'out.json', 'data')).rejects.toBe(boom);
    });
});
