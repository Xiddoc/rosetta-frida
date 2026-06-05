/**
 * Tests for the shared CLI I/O helpers (errorMessage, formatErrorLines,
 * successLine, writeNew). The CommandIo shape itself is a pure type — no
 * runtime test surface.
 */

import { describe, expect, it } from 'vitest';
import * as realFs from 'node:fs/promises';
import {
    errorMessage,
    formatErrorLines,
    successLine,
    writeNew,
    type FsLike,
} from '../../cli/commands/io.js';
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

describe('FsLike structural compatibility', () => {
    it('is satisfied by node:fs/promises with no cast', () => {
        // Compile-time contract: the real module must satisfy the narrow
        // seam directly (including BOTH writeFile overloads). If a future
        // edit drifts the seam from fs/promises, this assignment fails to
        // typecheck — the runtime assertion is just a coverage anchor.
        const fs: FsLike = realFs;
        expect(typeof fs.readFile).toBe('function');
        expect(typeof fs.writeFile).toBe('function');
        expect(typeof fs.mkdir).toBe('function');
    });
});

describe('successLine', () => {
    it('prefixes the message with the rosetta <command>: convention', () => {
        expect(successLine('extract', 'wrote out.json (single)')).toBe(
            'rosetta extract: wrote out.json (single)',
        );
    });
});

describe('writeNew', () => {
    it('creates a file that does not yet exist', async () => {
        const fake = makeFakeFs();
        await writeNew(makeFsLike(fake), 'out.json', 'data');
        expect(fake.files.get('out.json')).toBe('data');
    });

    it('creates the parent directory before writing (folded-in mkdir)', async () => {
        const fake = makeFakeFs();
        await writeNew(makeFsLike(fake), 'deep/nested/out.json', 'data');
        // The folded-in mkdir targets the parent dir of the file.
        expect(fake.dirsCreated).toContain('deep/nested');
        expect(fake.files.get('deep/nested/out.json')).toBe('data');
    });

    it('creates the parent directory on a forced overwrite too', async () => {
        const fake = makeFakeFs({ 'deep/out.json': 'old' });
        await writeNew(makeFsLike(fake), 'deep/out.json', 'new', { force: true });
        expect(fake.dirsCreated).toContain('deep');
        expect(fake.files.get('deep/out.json')).toBe('new');
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

    it('rethrows a forced-write failure unchanged (force path has no catch)', async () => {
        // The force branch is a plain overwrite with no EEXIST handling, so
        // a write error (e.g. EACCES) must propagate untouched — not be
        // swallowed or re-wrapped as the overwrite-refusal RosettaError.
        const fake = makeFakeFs({ 'out.json': 'old' });
        const boom = new Error('EACCES');
        fake.writeErrors.set('out.json', boom);
        await expect(writeNew(makeFsLike(fake), 'out.json', 'new', { force: true })).rejects.toBe(
            boom,
        );
    });
});
