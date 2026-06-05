/**
 * Regression test for the AIDL structural lint (`scripts/lint-aidl.mjs`).
 *
 * Locks two things:
 *   1. The real test-app AIDL fixtures have unique interface method
 *      names (the root-cause fix for the duplicate-`requestTicket` bug
 *      that left Pipeline CI dead-on-arrival).
 *   2. The linter actually detects a duplicate (so the guard can't rot
 *      into a no-op), and does not false-positive on comments, strings,
 *      or legitimately distinct method names.
 *
 * The script is a `.mjs` outside the coverage `include` globs
 * (src/cli/tools), so importing it here does not affect the 100% gate.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
// @ts-expect-error — plain JS guard script, no type declarations.
import { findDuplicateAidlMethods, parseInterfaces } from '../scripts/lint-aidl.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const aidlDir = join(repoRoot, 'tests/fixtures/test-app');

function listAidlFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) listAidlFiles(full, out);
        else if (extname(full) === '.aidl') out.push(full);
    }
    return out;
}

describe('lint-aidl: real fixtures', () => {
    it('finds at least one AIDL fixture to lint', () => {
        expect(listAidlFiles(aidlDir).length).toBeGreaterThan(0);
    });

    it('every test-app AIDL interface has unique method names', () => {
        for (const file of listAidlFiles(aidlDir)) {
            const src = readFileSync(file, 'utf8');
            expect(findDuplicateAidlMethods(src), `duplicate method in ${file}`).toEqual([]);
        }
    });

    it('IRemoteService exposes exactly requestTicket + requestPrompt (single each)', () => {
        const src = readFileSync(
            join(aidlDir, 'app/src/main/aidl/com/example/testapp/IRemoteService.aidl'),
            'utf8',
        );
        const [iface] = parseInterfaces(src) as { name: string; methods: string[] }[];
        expect(iface.name).toBe('IRemoteService');
        expect(iface.methods).toEqual(['requestTicket', 'requestPrompt']);
    });
});

describe('lint-aidl: detection', () => {
    it('flags a duplicate method name on an interface', () => {
        const src = `
            interface IFoo {
                void requestTicket(in Bundle params);
                void requestTicket(in Bundle params, String tag);
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([
            { interface: 'IFoo', method: 'requestTicket', count: 2 },
        ]);
    });

    it('passes distinct method names', () => {
        const src = `
            interface IFoo {
                void requestTicket(in Bundle params);
                String requestPrompt(in Bundle params);
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([]);
    });

    it('does not false-positive on a method name appearing in a comment', () => {
        const src = `
            interface IFoo {
                // a second requestTicket(...) would be illegal here
                /* requestTicket(in Bundle b); is just prose */
                void requestTicket(in Bundle params);
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([]);
    });

    it('does not false-positive on a method-like token inside a string', () => {
        const src = `
            interface IFoo {
                const String NOTE = "requestTicket(stuff);";
                void requestTicket(in Bundle params);
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([]);
    });

    it('handles multiple interfaces in one file independently', () => {
        const src = `
            interface IFoo {
                void a(int x);
                void a(int x, int y);
            }
            interface IBar {
                void b();
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([
            { interface: 'IFoo', method: 'a', count: 2 },
        ]);
    });

    // --- inline-annotation defect guards ---

    it('does not false-positive on a method with an inline parameterized annotation', () => {
        // @Backing(type="int") is an inline annotation on the same statement.
        // Before the fix, the regex captured "Backing" as a phantom method name.
        const src = `
            interface IFoo {
                @Backing(type="int") void a(int x);
                void b(int y);
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([]);
    });

    it('detects a real duplicate behind inline parameterized annotations (false-negative guard)', () => {
        // Both `a` declarations are preceded by an inline @JavaPassthrough annotation.
        // Before the fix the annotation name was captured instead of `a`, masking the
        // genuine duplicate and returning [] — a false negative.
        const src = `
            interface IFoo {
                @JavaPassthrough(x="1") void a(int x);
                @JavaPassthrough(x="2") void a(int x, int y);
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([
            { interface: 'IFoo', method: 'a', count: 2 },
        ]);
    });

    // --- nested-declaration flattening defect guards ---

    it('does not false-positive when a nested parcelable block contains a method-shaped token', () => {
        // Before the fix, `foo()` inside the nested parcelable leaked into
        // IFoo's method list; if a top-level method is also named `foo` that
        // produces a spurious duplicate.
        const src = `
            interface IFoo {
                void foo(int x);
                parcelable Inner {
                    void foo(String s);
                }
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([]);
    });

    it('does not false-positive when a nested union block shares a token name with the parent interface', () => {
        const src = `
            interface IFoo {
                void bar();
                union Options {
                    void bar();
                }
            }
        `;
        expect(findDuplicateAidlMethods(src)).toEqual([]);
    });
});
