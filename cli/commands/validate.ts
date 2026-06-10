/**
 * `rosetta validate <map.{json,yaml,yml}> [--deep] [--json]`
 *
 * Loads a map via the appropriate path (auto-detected by extension), runs
 * structural validation, and prints either "OK" or a structured error report.
 * Exit code is 0 on success, 1 on failure.
 *
 * With `--deep` (alias `--semantic`) it additionally runs the SEMANTIC checks
 * from `src/verify/` — cross-entry relationships the schema cannot express
 * (the old standalone `verify` verb, folded in here because it took the same
 * input, same output shape, and same exit codes as `validate` and differed
 * only by check depth). Semantic findings are classified by severity:
 *   - HARD errors (duplicate obfuscated names per dex, unparseable
 *     signatures) fail the build (exit 1).
 *   - WARNINGS (heuristic cross-references: dangling `extends`, un-translated
 *     arg types) are reported but never fail the build.
 * `--json` emits the structured `VerifyIssue[]` for CI consumption.
 *
 * Only JSON and YAML are accepted — maps are pure data. TS/JS-module inputs
 * are refused (importing a module to validate it was a build-time RCE).
 */

import * as path from 'node:path';
import { MapValidationError, RosettaError } from '../../src/errors.js';
import { yamlToMap, refuseModuleInput, validateStructure } from '../../src/convert/index.js';
import { parseJson } from '../../src/parse/json.js';
import { assertNoNul } from '../../src/parse/index.js';
import { verifyMap, type VerifyIssue } from '../../src/verify/index.js';
import type { RosettaMap } from '../../src/types/map.js';
import type { CommandIo, FsLike } from './io.js';
import { errorMessage } from './io.js';
import { parseArgs, type ArgSpec } from './args.js';

/**
 * Read a map file, wrapping a read failure (e.g. ENOENT) into the uniform
 * `cannot read <file>: …` message used by the other file-reading commands
 * (patch/extract/inspect), so a missing file reads the same across verbs.
 */
async function readMapFile(inputPath: string, fs: FsLike): Promise<string> {
    try {
        return await fs.readFile(inputPath, 'utf8');
    } catch (err) {
        throw new RosettaError(`cannot read ${inputPath}: ${errorMessage(err)}`);
    }
}

export interface ValidateOptions {
    inputPath: string;
    /** Run the deep semantic checks (`--deep` / `--semantic`). */
    deep: boolean;
    /** Emit the structured semantic findings as JSON (only with `--deep`). */
    json: boolean;
}

/** Option grammar for `validate`: one positional + `--deep`/`--semantic` + `--json`. */
const VALIDATE_SPEC: ArgSpec = {
    options: [
        { name: 'deep', aliases: ['--deep', '--semantic'], takesValue: false },
        { name: 'json', aliases: ['--json'], takesValue: false },
    ],
};

/** Parse argv → ValidateOptions. */
export function parseValidateArgs(argv: readonly string[]): ValidateOptions {
    const { positionals, flags } = parseArgs(argv, VALIDATE_SPEC);
    if (positionals.length !== 1) {
        throw new RosettaError(
            `validate requires exactly one positional arg: <map> (got ${positionals.length})`,
        );
    }
    return {
        inputPath: positionals[0] as string,
        deep: flags.deep ?? false,
        json: flags.json ?? false,
    };
}

/**
 * Load a map from the filesystem, auto-detecting format from the path's
 * extension.
 */
export async function loadMap(inputPath: string, fs: FsLike): Promise<RosettaMap> {
    assertNoNul(inputPath);
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.json') {
        const raw = await readMapFile(inputPath, fs);
        let parsed: unknown;
        try {
            parsed = parseJson(raw);
        } catch (e) {
            throw new RosettaError(`JSON parse error in ${inputPath}: ${(e as Error).message}`);
        }
        return validateStructure(parsed);
    }
    if (ext === '.yaml' || ext === '.yml') {
        const raw = await readMapFile(inputPath, fs);
        return yamlToMap(raw);
    }
    if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        // Maps are pure data — never import a contributor-supplied module.
        refuseModuleInput(inputPath);
    }
    throw new RosettaError(`unsupported map extension: ${ext} (path: ${inputPath})`);
}

/** Pluralize an issue count for the report summary. */
function countLabel(n: number, noun: string): string {
    return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

/**
 * Run the deep semantic pass and return the message. HARD errors throw a
 * {@link MapValidationError} (exit 1, issue list folded into stderr like the
 * schema report). WARNINGS never fail the build: they are folded into the
 * returned success message as indented `warning:` lines. `--json` emits the
 * full structured `VerifyIssue[]` (errors AND warnings) instead.
 */
function runDeep(map: RosettaMap, opts: ValidateOptions): string {
    const issues = verifyMap(map);
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    // A hard error always fails the build (exit 1) regardless of --json, so
    // the exit code stays honest. The throw carries only the ERROR-severity
    // findings — warnings never gate the build.
    if (errors.length > 0) {
        throw new MapValidationError(
            `Map failed semantic verification (${countLabel(errors.length, 'error')})`,
            errors,
        );
    }
    // No hard errors: --json emits the full structured findings (warnings
    // included) for CI; otherwise warnings fold into the success message.
    if (opts.json) return JSON.stringify(issues, null, 2);
    const head =
        `OK: ${opts.inputPath} — ${map.app}@${map.version}, ` +
        `${Object.keys(map.classes).length} class(es), schema_version=${map.schema_version}` +
        (warnings.length > 0 ? ` (${countLabel(warnings.length, 'warning')})` : ', consistent');
    if (warnings.length === 0) return head;
    return [head, ...warnings.map((w) => warningLine(w))].join('\n');
}

/**
 * Render one warning as an indented follow-on line in the success message.
 * Every {@link VerifyIssue} from `verifyMap` carries a `path`, so the `at
 * <path>` form is unconditional here.
 */
function warningLine(w: VerifyIssue): string {
    return `  warning at ${w.path}: ${w.message}`;
}

/**
 * Run `rosetta validate` under the shared command contract: load + validate
 * the map and return a one-line `OK` summary (the router prints it under the
 * uniform `rosetta validate:` prefix). With `--deep`, also run the semantic
 * checks (see {@link runDeep}).
 *
 * A load/validation failure is *thrown* (not returned): the router's
 * `formatErrorLines` renders it under the uniform `rosetta validate: …` prefix
 * and folds a `MapValidationError`'s issue list into indented follow-on lines.
 */
export async function runValidate(argv: readonly string[], io: CommandIo): Promise<string> {
    const opts = parseValidateArgs(argv);
    const map = await loadMap(opts.inputPath, io.fs);
    if (opts.deep) return runDeep(map, opts);
    return (
        `OK: ${opts.inputPath} — ${map.app}@${map.version}, ` +
        `${Object.keys(map.classes).length} class(es), schema_version=${map.schema_version}`
    );
}
