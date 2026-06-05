/**
 * One small, spec-driven argv parser shared by the CLI commands.
 *
 * Before this, every command hand-rolled the same loop: walk argv,
 * recognise `-o <value>` / `--map <value>` style value-flags and
 * `--force` style booleans, collect positionals, and throw on a dangling
 * value or unknown option. The loops drifted (some threw
 * `unknown option`, others `unknown flag`; some `requires a value`,
 * others `requires a path argument`). This helper centralises the loop
 * and the error wording, throwing a uniform {@link RosettaError} the
 * router formats.
 *
 * It deliberately stays tiny: GNU-style `--flag=value`, `-abc` clustering,
 * and `--` end-of-options are NOT supported — the rosetta CLI doesn't use
 * them, and sigmatcher-cli's named-flag-map parser opts out entirely.
 */

import { RosettaError } from '../../src/errors.js';

/** One declared option. `takesValue` distinguishes `-o x` from `--force`. */
export interface OptionSpec {
    /** Canonical name the parsed result is keyed by (e.g. `'output'`). */
    name: string;
    /** Every spelling that selects this option, e.g. `['-o', '--output']`. */
    aliases: readonly string[];
    /** Whether the option consumes the following argv token as its value. */
    takesValue: boolean;
}

/** The grammar for one command: its set of recognised options. */
export interface ArgSpec {
    options: readonly OptionSpec[];
}

/** Parsed argv: positionals plus canonical value/boolean option maps. */
export interface ParsedArgs {
    /** Bare arguments, in order. */
    positionals: string[];
    /** Value options, keyed by canonical name. Absent options are omitted. */
    values: Record<string, string>;
    /** Boolean options that were present, keyed by canonical name. */
    flags: Record<string, boolean>;
}

/**
 * Parse `argv` against `spec`.
 *
 * @throws RosettaError on an unknown option or a value-option with no
 *   following value. Positional-count and required-option checks are left
 *   to the caller (they vary per command and produce command-specific
 *   messages).
 */
export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
    const byAlias = new Map<string, OptionSpec>();
    for (const opt of spec.options) {
        for (const alias of opt.aliases) byAlias.set(alias, opt);
    }

    const positionals: string[] = [];
    const values: Record<string, string> = {};
    const flags: Record<string, boolean> = {};

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i] as string;
        const opt = byAlias.get(a);
        if (opt) {
            if (opt.takesValue) {
                const next = argv[i + 1];
                if (next === undefined) {
                    throw new RosettaError(`${a} requires a value`);
                }
                values[opt.name] = next;
                i++;
            } else {
                flags[opt.name] = true;
            }
        } else if (a.startsWith('-')) {
            throw new RosettaError(`unknown option: ${a}`);
        } else {
            positionals.push(a);
        }
    }

    return { positionals, values, flags };
}
