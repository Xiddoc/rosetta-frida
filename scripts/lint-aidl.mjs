#!/usr/bin/env node
/**
 * lint-aidl.mjs — structural lint for the AIDL fixtures under
 * `tests/fixtures/test-app/**`.
 *
 * Why this exists: AIDL interface methods must have UNIQUE names — the
 * AIDL compiler does NOT support method overloading. A duplicate method
 * name (e.g. two `requestTicket` declarations on one interface) makes
 * `:app:compileReleaseAidl` fail, so the test-app APK never builds and
 * the whole "real APK → sigmatcher → map → validate → hook" Pipeline CI
 * is dead-on-arrival. That failure mode is invisible to `npm run verify`
 * / the main CI workflow (neither builds the APK) and to the Pipeline
 * workflow on most branches (it is path-gated to a few directories and
 * only triggers against `master`). This lint is the cheap, SDK-free
 * guard that catches the structural error everywhere `verify` runs.
 *
 * It does NOT compile AIDL or require an Android SDK — it is a
 * deliberately small, robust textual parser whose only job is to detect
 * the single illegal-but-silent shape: duplicate method names inside one
 * `interface` block. (Genuine overloading lives on plain Java classes
 * like `BlobCache.put`, which this lint does not touch.)
 *
 * Usage:
 *   node scripts/lint-aidl.mjs            # lint (CI / verify)
 *
 * Exit code: 0 if every AIDL interface has unique method names; 1 if any
 * duplicate is found.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Recursively list files under `dir` with the given extension. */
export function walkAidl(dir, out = []) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            walkAidl(full, out);
        } else if (extname(full) === '.aidl') {
            out.push(full);
        }
    }
    return out;
}

/**
 * Strip comments so they can't masquerade as declarations. Handles
 * block comments (`/​* ... *​/`), line comments (`// ...`), and string
 * literals (so a `//` or method-like token inside a string is ignored).
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
    let out = '';
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        const c2 = src[i + 1];
        if (c === '/' && c2 === '*') {
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
            i += 2;
        } else if (c === '/' && c2 === '/') {
            i += 2;
            while (i < n && src[i] !== '\n') i += 1;
        } else if (c === '"' || c === "'") {
            const quote = c;
            out += ' ';
            i += 1;
            while (i < n && src[i] !== quote) {
                if (src[i] === '\\') i += 1;
                i += 1;
            }
            i += 1;
        } else {
            out += c;
            i += 1;
        }
    }
    return out;
}

/**
 * Strip nested brace blocks from an interface body so that declarations
 * inside `parcelable`, `union`, `enum`, or nested `interface` bodies do
 * not leak into the parent's method list.
 *
 * We walk character-by-character; whenever we encounter a `{` that is
 * preceded by one of the nesting keywords (after optional whitespace /
 * an identifier), we skip everything up to the matching `}`.  Any other
 * `{` (which should not appear in a well-formed top-level interface body)
 * is left in place so the method regex continues to skip it via its
 * `[^;{}]` guard.
 *
 * @param {string} body — the raw interface body (between the outer `{}`).
 * @returns {string}
 */
function stripNestedBlocks(body) {
    // Keyword that introduces a nested brace block in AIDL.
    const nestKw = /\b(?:interface|parcelable|union|enum)\s+[A-Za-z_]\w*\s*\{/g;
    let result = '';
    let lastIndex = 0;
    let m;
    while ((m = nestKw.exec(body)) !== null) {
        // Append everything up to (but not including) the opening `{`.
        // We find the `{` by scanning backwards from the end of the match.
        const bracePos = body.lastIndexOf('{', nestKw.lastIndex - 1);
        result += body.slice(lastIndex, bracePos);
        // Skip the brace-balanced nested block.
        let depth = 1;
        let j = bracePos + 1;
        while (j < body.length && depth > 0) {
            if (body[j] === '{') depth += 1;
            else if (body[j] === '}') depth -= 1;
            j += 1;
        }
        lastIndex = j;
        nestKw.lastIndex = j;
    }
    result += body.slice(lastIndex);
    return result;
}

/**
 * Parse the AIDL `interface <Name> { ... }` blocks out of (comment-free)
 * source and return, per interface, the list of method names in
 * declaration order.
 *
 * Nested `parcelable`/`union`/`enum`/`interface` blocks are stripped
 * from the interface body before method extraction so their contents
 * cannot produce phantom or duplicate method names on the parent.
 *
 * @param {string} src — AIDL source (comments may still be present;
 *   they are stripped internally).
 * @returns {{ name: string, methods: string[] }[]}
 */
export function parseInterfaces(src) {
    const clean = stripComments(src);
    const interfaces = [];
    // Match `interface <Name> {` and capture the brace-balanced body.
    const ifaceRe = /\binterface\s+([A-Za-z_]\w*)\s*\{/g;
    let m;
    while ((m = ifaceRe.exec(clean)) !== null) {
        const name = m[1];
        // Walk forward from the opening brace to its balanced close.
        let depth = 1;
        let j = ifaceRe.lastIndex;
        const start = j;
        while (j < clean.length && depth > 0) {
            if (clean[j] === '{') depth += 1;
            else if (clean[j] === '}') depth -= 1;
            j += 1;
        }
        const rawBody = clean.slice(start, j - 1);
        // Strip nested parcelable/union/enum/interface blocks so their
        // contents don't leak into the parent's method list.
        const body = stripNestedBlocks(rawBody);
        interfaces.push({ name, methods: parseMethodNames(body) });
        ifaceRe.lastIndex = j;
    }
    return interfaces;
}

/**
 * Strip AIDL annotation tokens (`@Ident` and `@Ident(...)`) from a
 * string so they cannot be mistaken for method declarations. The
 * parenthesised argument list, if present, may contain commas, `=`,
 * and quoted strings (already collapsed to a space by `stripComments`),
 * but NOT nested parens — that is sufficient for all real AIDL
 * annotations.
 *
 * @param {string} s
 * @returns {string}
 */
function stripAnnotations(s) {
    // First remove `@Ident(...)` forms (with an argument list), then bare `@Ident`.
    return s.replace(/@[A-Za-z_]\w*\s*\([^)]*\)/g, '').replace(/@[A-Za-z_]\w*/g, '');
}

/**
 * Extract method names from one interface body. AIDL methods are
 * `[oneway] <returnType> <name>( ... );` — we match the identifier that
 * immediately precedes a `(`.
 *
 * Annotations (e.g. `@Backing(type="int")` or `@JavaPassthrough(x="1")`)
 * are stripped first so their name cannot be mistaken for a method name,
 * whether they appear on their own line or inline on the same statement.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function parseMethodNames(body) {
    const clean = stripAnnotations(body);
    const names = [];
    const methodRe = /([A-Za-z_]\w*)\s*\([^;{}]*\)\s*;/g;
    let m;
    while ((m = methodRe.exec(clean)) !== null) {
        names.push(m[1]);
    }
    return names;
}

/**
 * Find duplicate method names across all interfaces in one AIDL source.
 *
 * @param {string} src
 * @returns {{ interface: string, method: string, count: number }[]}
 */
export function findDuplicateAidlMethods(src) {
    const dups = [];
    for (const iface of parseInterfaces(src)) {
        const counts = new Map();
        for (const name of iface.methods) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        for (const [method, count] of counts) {
            if (count > 1) {
                dups.push({ interface: iface.name, method, count });
            }
        }
    }
    return dups;
}

function main() {
    const aidlDir = join(repoRoot, 'tests/fixtures/test-app');
    const files = walkAidl(aidlDir);

    if (files.length === 0) {
        console.error(`lint-aidl: no .aidl files found under ${aidlDir}`);
        return 1;
    }

    const failures = [];
    for (const file of files) {
        const src = readFileSync(file, 'utf8');
        for (const dup of findDuplicateAidlMethods(src)) {
            failures.push({ file, ...dup });
        }
    }

    if (failures.length === 0) {
        console.log(`lint-aidl: OK — ${files.length} AIDL file(s), no duplicate method names.`);
        return 0;
    }

    console.error(
        'lint-aidl: AIDL forbids method overloading, but found duplicate method name(s):',
    );
    for (const f of failures) {
        const rel = f.file.startsWith(repoRoot) ? f.file.slice(repoRoot.length + 1) : f.file;
        console.error(
            `  ${rel}: interface ${f.interface} declares ${f.method}() ${f.count}× ` +
                `(AIDL does not support overloading — give each method a unique name).`,
        );
    }
    return 1;
}

// Run as a CLI only when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    process.exit(main());
}
