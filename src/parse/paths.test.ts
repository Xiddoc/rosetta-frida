/**
 * Tests for the CLI path/identity hardening primitives.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
    assertValidApp,
    assertValidVersion,
    assertNoNul,
    assertContained,
    defaultMapPath,
} from './paths.js';
import { RosettaError } from '../errors.js';

describe('assertValidApp', () => {
    it.each(['com.example.app', 'a.b', 'com.example.app_v2', 'A1.b2.c3', 'x.y.z.w'])(
        'accepts valid package name: %s',
        (app) => {
            expect(() => assertValidApp(app)).not.toThrow();
        },
    );

    it.each([
        'noseparator', // single segment — not a package
        '1com.example', // starts with a digit
        '.com.example', // leading dot
        'com.example.', // trailing dot
        'com..example', // empty segment (also '..'-like)
        'com.exa mple', // space
        'com.example-app', // hyphen not allowed in package
    ])('rejects malformed package name: %s', (app) => {
        expect(() => assertValidApp(app)).toThrow(RosettaError);
    });

    it.each([
        '../../etc',
        'com/example/app',
        'com\\example\\app',
        'com.example..app',
        '/abs/pkg',
        'a.b\0c',
    ])('rejects traversal/absolute/NUL package name: %s', (app) => {
        expect(() => assertValidApp(app)).toThrow(RosettaError);
    });
});

describe('assertValidVersion', () => {
    it.each(['3.4.5', '1.2.3-rc1', '1.0', '2024.05.11', 'v1_2', '1'])(
        'accepts valid version: %s',
        (v) => {
            expect(() => assertValidVersion(v)).not.toThrow();
        },
    );

    it.each(['../1.0', '1.0/2.0', '1.0\\2.0', '..', '/1.0.0', '1.0\0', '1 0', '1.0+meta'])(
        'rejects invalid version: %s',
        (v) => {
            expect(() => assertValidVersion(v)).toThrow(RosettaError);
        },
    );
});

describe('assertNoNul', () => {
    it('accepts a clean path', () => {
        expect(() => assertNoNul('maps/x.json')).not.toThrow();
    });

    it('rejects a NUL byte', () => {
        expect(() => assertNoNul('maps/x.json\0.png')).toThrow(/NUL/);
    });
});

describe('assertContained', () => {
    const base = path.resolve(process.cwd());

    it('accepts a path inside the project tree', () => {
        expect(assertContained('maps/com.example.app/100.json')).toBe(
            path.join(base, 'maps/com.example.app/100.json'),
        );
    });

    it('accepts the base directory itself', () => {
        expect(assertContained('.')).toBe(base);
    });

    it('accepts a deeply nested relative path', () => {
        expect(assertContained('a/b/c/d.json')).toBe(path.join(base, 'a/b/c/d.json'));
    });

    it('rejects a parent-traversal escape', () => {
        expect(() => assertContained('../escape.json')).toThrow(/outside the project tree/);
    });

    it('rejects a deep traversal that climbs out', () => {
        expect(() => assertContained('maps/../../escape.json')).toThrow(/outside the project tree/);
    });

    it('rejects an absolute path outside the tree', () => {
        expect(() => assertContained('/etc/passwd')).toThrow(/outside the project tree/);
    });

    it('rejects a sibling-prefix path that is not actually nested', () => {
        // `<base>foo` shares the base string prefix but is NOT under `<base>/`.
        expect(() => assertContained(base + 'sibling.json')).toThrow(/outside the project tree/);
    });

    it('rejects a NUL byte in the path', () => {
        expect(() => assertContained('maps/x.json\0')).toThrow(/NUL/);
    });

    it('accepts an absolute path that is inside the tree', () => {
        const inside = path.join(base, 'maps', 'x.json');
        expect(assertContained(inside)).toBe(inside);
    });
});

describe('defaultMapPath', () => {
    it('builds maps/<app>/<version_code>.json', () => {
        expect(defaultMapPath('com.example.app', 30405)).toBe(
            path.join('maps', 'com.example.app', '30405.json'),
        );
    });

    it('uses the version_code (not a versionName) as the basename', () => {
        expect(defaultMapPath('com.example.app', 1)).toMatch(/[\\/]1\.json$/);
    });
});
