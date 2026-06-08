/**
 * Pure structural-diff engine over two loaded {@link RosettaMap}s.
 *
 * Computes the diff over REAL names (the stable identity across versions)
 * and reports how each real name's obfuscated spelling moved. Overloads are
 * paired by SIGNATURE first (a pure rename) and the leftovers positionally
 * (a re-sign). All output is sorted so the diff is deterministic.
 */

import type { ClassEntry, MethodEntry, RosettaMap } from '../types/map.js';

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
    /** `version` (versionName) label of the "from" map, if present. */
    fromVersion?: string;
    /** `version` (versionName) label of the "to" map, if present. */
    toVersion?: string;
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

/**
 * Compute the structural diff of two loaded maps.
 *
 * **Precondition:** both maps describe the same app. `diffMaps` asserts
 * `from.app === to.app` and throws if they differ, so a direct programmatic
 * caller cannot silently produce a mislabelled diff (the `MapDiff.app` field
 * would otherwise reflect only `to`). The CLI verb enforces the same thing
 * before calling, with a friendlier message.
 *
 * @throws Error if `from.app !== to.app`.
 */
export function diffMaps(from: RosettaMap, to: RosettaMap): MapDiff {
    if (from.app !== to.app) {
        throw new Error(`cannot diff maps for different apps: ${from.app} vs ${to.app}`);
    }
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
        fromVersion: from.version,
        toVersion: to.version,
        classesAdded: added(fromClasses, toClasses),
        classesRemoved: added(toClasses, fromClasses),
        classesChanged: changed,
    };
}

/** Whether the diff found no changes at all. */
export function isNoChange(d: MapDiff): boolean {
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

/**
 * Compose the `<code> (<version>)` label for one side of the header, folding
 * in the human `version` label when the map carried one.
 */
function versionLabel(code: number, version: string | undefined): string {
    return version !== undefined && version !== '' ? `${code} (${version})` : `${code}`;
}

/** Render the diff as the multi-line human report (joined with newlines). */
export function renderHumanDiff(d: MapDiff): string {
    const lines: string[] = [];
    const from = versionLabel(d.fromVersionCode, d.fromVersion);
    const to = versionLabel(d.toVersionCode, d.toVersion);
    lines.push(`${d.app}: ${from} -> ${to}`);
    if (isNoChange(d)) {
        lines.push('  no structural changes');
        return lines.join('\n');
    }
    for (const name of d.classesAdded) lines.push(`  + class ${name}`);
    for (const name of d.classesRemoved) lines.push(`  - class ${name}`);
    for (const delta of d.classesChanged) renderClassDelta(delta, (l) => lines.push(l));
    return lines.join('\n');
}
