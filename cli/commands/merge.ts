/**
 * `rosetta merge <a> <b> [...] -o <out.json>` — combine several partial
 * maps for the SAME `(app, version_code)` into one canonical map.
 *
 * The motivating workflow (AGENTS.md "Form factor"): a single version's
 * map is assembled from several sources — a sigmatcher run, hand-authored
 * entries, and rosetta-runtime-discovered names — each emitted as its own
 * partial map. `merge` folds them into one artifact, unioning the
 * `sources[]` provenance and the per-class method/field entries.
 *
 * ## Conflict policy (deterministic)
 *
 * Inputs are merged LEFT-TO-RIGHT; for any key that appears in more than
 * one input, **last-wins** — a later input on the command line overrides an
 * earlier one. This makes the order an explicit, documented precedence
 * (put your highest-trust source last). The fold is recursive:
 *   - top-level scalar identity (`app`, `version`, `version_code`, ...) —
 *     last-wins;
 *   - `sources[]` — concatenated in order (provenance is additive, never
 *     dropped);
 *   - `classes[realName]` — merged entry-by-entry: a class present in both
 *     has its `methods` / `fields` unioned (last-wins per real name) and
 *     its scalar fields (`obfuscated`, `extends`, ...) last-wins.
 *
 * `--strict` turns a *conflicting* obfuscated name into a hard error: if
 * two inputs map the same real name to DIFFERENT obfuscated names (a class,
 * method overload, or field), merge fails closed rather than silently
 * picking the last. Identical values never conflict. This is the
 * "fail hard by default" posture (Decision 3) made opt-in for merges,
 * where overlaying a refined source on a coarse one is a legitimate
 * override.
 *
 * The merged result is validated through the canonical schema before it is
 * written, so a fold that produced an invalid shape fails loudly.
 *
 * `merge-bundle` is the same fold reachable under a second verb name for
 * discoverability; it shares this implementation.
 */

import { RosettaError } from '../../src/errors.js';
import { validateStructure } from '../../src/convert/index.js';
import { renderJson } from '../../src/convert/json.js';
import type { ClassEntry, FieldEntry, MethodEntry, RosettaMap } from '../../src/types/map.js';
import type { CommandIo, FsLike } from './io.js';
import { writeNew } from './io.js';
import { loadMap } from './validate.js';
import { parseArgs, type ArgSpec } from './args.js';

/** Parsed argument shape for `merge`. */
export interface MergeOptions {
    /** The input map paths, in precedence order (last-wins). */
    inputPaths: string[];
    /** Where to write the merged JSON. */
    outputPath: string;
    /** Overwrite an existing output file. */
    force: boolean;
    /** Fail on conflicting obfuscated names rather than last-wins. */
    strict: boolean;
}

/** Option grammar for `merge`: N positionals + `-o`, `--force`, `--strict`. */
const MERGE_SPEC: ArgSpec = {
    options: [
        { name: 'output', aliases: ['-o', '--output'], takesValue: true },
        { name: 'force', aliases: ['--force', '-f'], takesValue: false },
        { name: 'strict', aliases: ['--strict'], takesValue: false },
    ],
};

/** Parse argv → MergeOptions. */
export function parseMergeArgs(argv: readonly string[]): MergeOptions {
    const { positionals, values, flags } = parseArgs(argv, MERGE_SPEC);
    if (positionals.length < 2) {
        throw new RosettaError(
            `merge requires at least two input maps (got ${positionals.length})`,
        );
    }
    if (values.output === undefined) {
        throw new RosettaError('merge requires -o <out.json>');
    }
    return {
        inputPaths: positionals,
        outputPath: values.output,
        force: flags.force ?? false,
        strict: flags.strict ?? false,
    };
}

/** Raised when `--strict` finds two inputs disagreeing on an obfuscated name. */
function conflict(kind: string, realName: string, a: string, b: string): RosettaError {
    return new RosettaError(
        `conflicting obfuscated name for ${kind} '${realName}': '${a}' vs '${b}' ` +
            `(pass without --strict to take the last input's value)`,
    );
}

/** Merge two method-overload arrays for one real name (last-wins by signature). */
function mergeOverloads(
    realName: string,
    base: readonly MethodEntry[],
    next: readonly MethodEntry[],
    strict: boolean,
): MethodEntry[] {
    const out = [...base];
    for (const entry of next) {
        const idx = out.findIndex((e) => e.signature === entry.signature);
        if (idx < 0) {
            out.push(entry);
            continue;
        }
        const existing = out[idx] as MethodEntry;
        if (strict && existing.obfuscated !== entry.obfuscated) {
            throw conflict('method', realName, existing.obfuscated, entry.obfuscated);
        }
        out[idx] = entry; // last-wins
    }
    return out;
}

/** Merge two method maps (keyed by real name). */
function mergeMethods(
    base: ClassEntry['methods'],
    next: ClassEntry['methods'],
    strict: boolean,
): ClassEntry['methods'] {
    if (!next) return base;
    if (!base) return next;
    const out: NonNullable<ClassEntry['methods']> = { ...base };
    for (const [name, overloads] of Object.entries(next)) {
        const existing = out[name];
        out[name] = existing ? mergeOverloads(name, existing, overloads, strict) : overloads;
    }
    return out;
}

/** Merge two field maps (keyed by real name, last-wins). */
function mergeFields(
    base: ClassEntry['fields'],
    next: ClassEntry['fields'],
    strict: boolean,
): ClassEntry['fields'] {
    if (!next) return base;
    if (!base) return next;
    const out: Record<string, FieldEntry> = { ...base };
    for (const [name, entry] of Object.entries(next)) {
        const existing = out[name];
        if (existing && strict && existing.obfuscated !== entry.obfuscated) {
            throw conflict('field', name, existing.obfuscated, entry.obfuscated);
        }
        out[name] = entry;
    }
    return out;
}

/** Merge two class entries for the same real name. */
function mergeClassEntry(
    realName: string,
    base: ClassEntry,
    next: ClassEntry,
    strict: boolean,
): ClassEntry {
    if (strict && base.obfuscated !== next.obfuscated) {
        throw conflict('class', realName, base.obfuscated, next.obfuscated);
    }
    return {
        ...base,
        ...next, // scalar fields last-wins; methods/fields re-merged below
        methods: mergeMethods(base.methods, next.methods, strict),
        fields: mergeFields(base.fields, next.fields, strict),
    };
}

/** Fold `next` onto `base`, returning the combined map. */
function mergeOne(base: RosettaMap, next: RosettaMap, strict: boolean): RosettaMap {
    const classes: Record<string, ClassEntry> = { ...base.classes };
    for (const [name, entry] of Object.entries(next.classes)) {
        const existing = classes[name];
        classes[name] = existing ? mergeClassEntry(name, existing, entry, strict) : entry;
    }
    const sources = [...(base.sources ?? []), ...(next.sources ?? [])];
    return {
        ...base,
        ...scalarIdentity(next),
        sources: sources.length > 0 ? sources : undefined,
        classes,
    };
}

/**
 * The last-wins top-level scalar identity carried from a later input
 * (everything except `sources` and `classes`, which are merged specially).
 * Pulled out so `mergeOne`'s spread reads cleanly and undefined optionals
 * on `next` don't clobber a value the base set.
 */
function scalarIdentity(next: RosettaMap): Partial<RosettaMap> {
    const { sources: _sources, classes: _classes, ...identity } = next;
    void _sources;
    void _classes;
    // Drop undefined optionals so `next` never erases a base value with a hole.
    return Object.fromEntries(Object.entries(identity).filter(([, v]) => v !== undefined));
}

/** Fold an ordered list of maps left-to-right (last-wins). */
export function mergeMaps(maps: readonly RosettaMap[], strict: boolean): RosettaMap {
    // Callers guarantee at least two; the reduce seed is the first input.
    const [first, ...rest] = maps;
    let acc = first as RosettaMap;
    for (const m of rest) {
        if (m.app !== acc.app) {
            throw new RosettaError(`cannot merge maps for different apps: ${acc.app} vs ${m.app}`);
        }
        if (m.version_code !== acc.version_code) {
            throw new RosettaError(
                `cannot merge maps for different version_code: ` +
                    `${acc.version_code} vs ${m.version_code}`,
            );
        }
        acc = mergeOne(acc, m, strict);
    }
    return acc;
}

/**
 * Core of `rosetta merge`: load all inputs, fold them, re-validate the
 * result, and write the canonical JSON. Returns the output path. Separated
 * from the printing wrapper so it stays unit-testable by return value.
 */
export async function mergeFiles(argv: readonly string[], fs: FsLike): Promise<string> {
    const opts = parseMergeArgs(argv);
    const maps: RosettaMap[] = [];
    for (const p of opts.inputPaths) {
        maps.push(await loadMap(p, fs));
    }
    const merged = mergeMaps(maps, opts.strict);
    // Re-validate the fold result so a merge that produced an invalid shape
    // (e.g. an overload set that overflowed MAX_METHOD_OVERLOADS) fails loudly
    // before it is written. `validateStructure` throws a `MapValidationError`
    // the router renders with its indented issue list — same as `validate`.
    const validated = validateStructure(merged);
    await writeNew(fs, opts.outputPath, renderJson(validated), { force: opts.force });
    return opts.outputPath;
}

/**
 * Execute `rosetta merge` (and the `merge-bundle` alias) under the shared
 * command contract: fold the inputs and return the success message.
 */
export async function runMerge(argv: readonly string[], io: CommandIo): Promise<string> {
    const out = await mergeFiles(argv, io.fs);
    return `wrote ${out}`;
}
