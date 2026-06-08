/**
 * `rosetta diff <a> <b>` — structural diff between two maps.
 *
 * Reports what *rotated* between two `schema_version: 2` maps: classes,
 * methods, and fields that were added, removed, or whose obfuscated name
 * (or method signature) changed. This is the canonical "what changed in
 * this release" report — the obfuscation-rotation pain this whole project
 * exists to absorb (see AGENTS.md "Why this project exists").
 *
 * Both inputs are loaded through the same {@link loadMap} path `validate`
 * uses (format auto-detected by extension), so a malformed input fails
 * loudly with the uniform validation report rather than producing a bogus
 * diff. The diff is computed over REAL names (the map keys) — the stable
 * identity across versions — and reports how each real name's *obfuscated*
 * spelling moved.
 *
 * Output:
 *   - Human-readable by default: grouped, greppable lines.
 *   - `--json`: a machine-readable {@link MapDiff} object on stdout.
 *
 * This is read-only and never writes a file: it is a reporting verb, not
 * a deobfuscator (anti-scope) — it only compares maps it is handed.
 */

import { RosettaError } from '../../src/errors.js';
import type { ClassEntry, MethodEntry, RosettaMap } from '../../src/types/map.js';
import type { CommandIo, FsLike } from './io.js';
import { loadMap } from './validate.js';
import { parseArgs, type ArgSpec } from './args.js';

/** Parsed argument shape for `diff`. */
export interface DiffOptions {
    /** The "from" (old / left) map path. */
    fromPath: string;
    /** The "to" (new / right) map path. */
    toPath: string;
    /** Emit machine-readable JSON instead of the human report. */
    json: boolean;
}

/** Option grammar for `diff`: two positionals + `--json`. */
const DIFF_SPEC: ArgSpec = {
    options: [{ name: 'json', aliases: ['--json'], takesValue: false }],
};

/** Parse argv → DiffOptions. */
export function parseDiffArgs(argv: readonly string[]): DiffOptions {
    const { positionals, flags } = parseArgs(argv, DIFF_SPEC);
    if (positionals.length !== 2) {
        throw new RosettaError(
            `diff requires exactly two positional args: <from> <to> (got ${positionals.length})`,
        );
    }
    return {
        fromPath: positionals[0] as string,
        toPath: positionals[1] as string,
        json: flags.json ?? false,
    };
}

/** A member (method overload or field) that changed obfuscated spelling. */
export interface ObfChange {
    /** Real name of the member. */
    name: string;
    /** Obfuscated name in the "from" map. */
    from: string;
    /** Obfuscated name in the "to" map. */
    to: string;
}

/** A method overload whose signature (not just name) rotated. */
export interface SignatureChange {
    /** Real method name. */
    name: string;
    /** Signature in the "from" map. */
    from: string;
    /** Signature in the "to" map. */
    to: string;
}

/** The per-class delta for a class present in BOTH maps. */
export interface ClassDelta {
    /** Real fully-qualified class name. */
    name: string;
    /** Obfuscated-name change on the class itself, if any. */
    obfuscated?: ObfChange;
    /** Real method names present in `to` but not `from`. */
    methodsAdded: string[];
    /** Real method names present in `from` but not `to`. */
    methodsRemoved: string[];
    /** Methods whose obfuscated name rotated (matched by signature). */
    methodsRenamed: ObfChange[];
    /** Methods whose signature rotated (matched by obfuscated name). */
    methodsResigned: SignatureChange[];
    /** Real field names present in `to` but not `from`. */
    fieldsAdded: string[];
    /** Real field names present in `from` but not `to`. */
    fieldsRemoved: string[];
    /** Fields whose obfuscated name rotated. */
    fieldsRenamed: ObfChange[];
}

/** The full structural diff between two maps. */
export interface MapDiff {
    /** App package (must match between the two maps). */
    app: string;
    /** `version_code` of the "from" map. */
    fromVersionCode: number;
    /** `version_code` of the "to" map. */
    toVersionCode: number;
    /** Real class names present in `to` but not `from`. */
    classesAdded: string[];
    /** Real class names present in `from` but not `to`. */
    classesRemoved: string[];
    /** Per-class deltas for classes present in both (only non-empty ones). */
    classesChanged: ClassDelta[];
}

/** Sorted keys of a record (stable, deterministic output). */
function sortedKeys(record: Record<string, unknown> | undefined): string[] {
    return record ? Object.keys(record).sort() : [];
}

/** Keys present in `b` but not `a`, sorted. */
function added(a: readonly string[], b: readonly string[]): string[] {
    const aSet = new Set(a);
    return b.filter((k) => !aSet.has(k)).sort();
}

/**
 * Diff one real class's methods. Methods are keyed by real name; each real
 * name owns an array of overloads. We pair overloads across the two maps by
 * SIGNATURE first (the stable identity of an overload) to detect a pure
 * obfuscated-name rotation; the leftover overloads are paired positionally
 * to detect a signature rotation. This mirrors the real pain: the method
 * *name* (`c`/`f`) often stays while the class rotates, but signatures also
 * shift as arg-type classes rotate.
 */
function diffMethods(
    from: ClassEntry['methods'],
    to: ClassEntry['methods'],
): Pick<ClassDelta, 'methodsAdded' | 'methodsRemoved' | 'methodsRenamed' | 'methodsResigned'> {
    const fromKeys = sortedKeys(from);
    const toKeys = sortedKeys(to);
    const renamed: ObfChange[] = [];
    const resigned: SignatureChange[] = [];
    const shared = toKeys.filter((k) => fromKeys.includes(k));
    for (const name of shared) {
        const fromOverloads = (from as Record<string, MethodEntry[]>)[name] as MethodEntry[];
        const toOverloads = (to as Record<string, MethodEntry[]>)[name] as MethodEntry[];
        diffOverloads(name, fromOverloads, toOverloads, renamed, resigned);
    }
    return {
        methodsAdded: added(fromKeys, toKeys),
        methodsRemoved: added(toKeys, fromKeys),
        methodsRenamed: renamed,
        methodsResigned: resigned,
    };
}

/**
 * Pair the overloads of one real method name across two maps and classify
 * the changes. An overload matched by identical SIGNATURE but a different
 * obfuscated name is a rename; an overload left unmatched on both sides
 * (same count) is paired positionally and, if its signature differs, is a
 * re-sign. This is best-effort — overload-set churn is inherently
 * heuristic — but covers the dominant single-overload case exactly.
 */
function diffOverloads(
    name: string,
    fromOverloads: readonly MethodEntry[],
    toOverloads: readonly MethodEntry[],
    renamed: ObfChange[],
    resigned: SignatureChange[],
): void {
    const toRemaining = [...toOverloads];
    const fromUnmatched: MethodEntry[] = [];
    for (const f of fromOverloads) {
        const idx = toRemaining.findIndex((t) => t.signature === f.signature);
        if (idx >= 0) {
            const t = toRemaining.splice(idx, 1)[0] as MethodEntry;
            if (t.obfuscated !== f.obfuscated) {
                renamed.push({ name, from: f.obfuscated, to: t.obfuscated });
            }
        } else {
            fromUnmatched.push(f);
        }
    }
    // Pair the leftovers positionally; a differing signature is a re-sign,
    // and a differing obfuscated name on that same pairing is also a rename.
    const pairs = Math.min(fromUnmatched.length, toRemaining.length);
    for (let i = 0; i < pairs; i++) {
        const f = fromUnmatched[i] as MethodEntry;
        const t = toRemaining[i] as MethodEntry;
        if (f.signature !== t.signature) {
            resigned.push({ name, from: f.signature, to: t.signature });
        }
        if (f.obfuscated !== t.obfuscated) {
            renamed.push({ name, from: f.obfuscated, to: t.obfuscated });
        }
    }
}

/** Diff one real class's fields by real name. */
function diffFields(
    from: ClassEntry['fields'],
    to: ClassEntry['fields'],
): Pick<ClassDelta, 'fieldsAdded' | 'fieldsRemoved' | 'fieldsRenamed'> {
    const fromKeys = sortedKeys(from);
    const toKeys = sortedKeys(to);
    const renamed: ObfChange[] = [];
    for (const name of toKeys.filter((k) => fromKeys.includes(k))) {
        const f = (from as NonNullable<ClassEntry['fields']>)[name];
        const t = (to as NonNullable<ClassEntry['fields']>)[name];
        if (f && t && f.obfuscated !== t.obfuscated) {
            renamed.push({ name, from: f.obfuscated, to: t.obfuscated });
        }
    }
    return {
        fieldsAdded: added(fromKeys, toKeys),
        fieldsRemoved: added(toKeys, fromKeys),
        fieldsRenamed: renamed,
    };
}

/** Whether a class delta carries any actual change (used to prune output). */
function isEmptyDelta(d: ClassDelta): boolean {
    return (
        d.obfuscated === undefined &&
        d.methodsAdded.length === 0 &&
        d.methodsRemoved.length === 0 &&
        d.methodsRenamed.length === 0 &&
        d.methodsResigned.length === 0 &&
        d.fieldsAdded.length === 0 &&
        d.fieldsRemoved.length === 0 &&
        d.fieldsRenamed.length === 0
    );
}

/** Compute the structural diff of two loaded maps. */
export function diffMaps(from: RosettaMap, to: RosettaMap): MapDiff {
    const fromClasses = Object.keys(from.classes).sort();
    const toClasses = Object.keys(to.classes).sort();
    const changed: ClassDelta[] = [];
    for (const name of toClasses.filter((k) => fromClasses.includes(k))) {
        const fc = from.classes[name] as ClassEntry;
        const tc = to.classes[name] as ClassEntry;
        const delta: ClassDelta = {
            name,
            obfuscated:
                fc.obfuscated !== tc.obfuscated
                    ? { name, from: fc.obfuscated, to: tc.obfuscated }
                    : undefined,
            ...diffMethods(fc.methods, tc.methods),
            ...diffFields(fc.fields, tc.fields),
        };
        if (!isEmptyDelta(delta)) changed.push(delta);
    }
    return {
        app: to.app,
        fromVersionCode: from.version_code,
        toVersionCode: to.version_code,
        classesAdded: added(fromClasses, toClasses),
        classesRemoved: added(toClasses, fromClasses),
        classesChanged: changed,
    };
}

/** Whether the diff found no changes at all. */
function isNoChange(d: MapDiff): boolean {
    return (
        d.classesAdded.length === 0 &&
        d.classesRemoved.length === 0 &&
        d.classesChanged.length === 0
    );
}

/** Render one class delta as indented human-readable lines. */
function renderClassDelta(d: ClassDelta, push: (line: string) => void): void {
    const header = d.obfuscated
        ? `  ~ ${d.name} (obfuscated ${d.obfuscated.from} -> ${d.obfuscated.to})`
        : `  ~ ${d.name}`;
    push(header);
    for (const m of d.methodsRenamed) {
        push(`      method ${m.name}: obfuscated ${m.from} -> ${m.to}`);
    }
    for (const m of d.methodsResigned) {
        push(`      method ${m.name}: signature ${m.from} -> ${m.to}`);
    }
    for (const name of d.methodsAdded) push(`      + method ${name}`);
    for (const name of d.methodsRemoved) push(`      - method ${name}`);
    for (const f of d.fieldsRenamed) {
        push(`      field ${f.name}: obfuscated ${f.from} -> ${f.to}`);
    }
    for (const name of d.fieldsAdded) push(`      + field ${name}`);
    for (const name of d.fieldsRemoved) push(`      - field ${name}`);
}

/** Render the diff as the multi-line human report (joined with newlines). */
export function renderHumanDiff(d: MapDiff): string {
    const lines: string[] = [];
    lines.push(`${d.app}: ${d.fromVersionCode} -> ${d.toVersionCode}`);
    if (isNoChange(d)) {
        lines.push('  no structural changes');
        return lines.join('\n');
    }
    for (const name of d.classesAdded) lines.push(`  + class ${name}`);
    for (const name of d.classesRemoved) lines.push(`  - class ${name}`);
    for (const delta of d.classesChanged) renderClassDelta(delta, (l) => lines.push(l));
    return lines.join('\n');
}

/**
 * Execute `rosetta diff` under the shared command contract: load both
 * maps, compute the diff, and return the report (human or `--json`). The
 * router prints it under the uniform `rosetta diff:` prefix.
 */
export async function runDiff(argv: readonly string[], io: CommandIo): Promise<string> {
    const opts = parseDiffArgs(argv);
    const fs: FsLike = io.fs;
    const from = await loadMap(opts.fromPath, fs);
    const to = await loadMap(opts.toPath, fs);
    if (from.app !== to.app) {
        throw new RosettaError(`cannot diff maps for different apps: ${from.app} vs ${to.app}`);
    }
    const diff = diffMaps(from, to);
    return opts.json ? JSON.stringify(diff, null, 2) : renderHumanDiff(diff);
}
