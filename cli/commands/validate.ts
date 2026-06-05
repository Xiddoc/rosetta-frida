/**
 * `rosetta validate <map.{json,yaml,yml}>`
 *
 * Loads a map via the appropriate path (auto-detected by extension),
 * runs structural validation, and prints either "OK" or a structured
 * error report. Exit code is 0 on success, 1 on failure.
 *
 * Only JSON and YAML are accepted — maps are pure data. TS/JS-module
 * inputs are refused (importing a module to validate it was a
 * build-time RCE), never imported.
 */

import * as path from 'node:path';
import { RosettaError } from '../../src/errors.js';
import { yamlToMap, refuseModuleInput, validateStructure } from '../../src/convert/index.js';
import { parseJson } from '../../src/parse/json.js';
import { assertNoNul } from '../../src/parse/index.js';
import type { RosettaMap } from '../../src/types/map.js';
import type { CommandIo, FsLike } from './io.js';

export interface ValidateOptions {
    inputPath: string;
}

/** Parse argv → ValidateOptions. */
export function parseValidateArgs(argv: readonly string[]): ValidateOptions {
    const positional: string[] = [];
    for (const arg of argv) {
        if (arg.startsWith('-')) {
            throw new RosettaError(`unknown flag: ${arg}`);
        }
        positional.push(arg);
    }
    if (positional.length !== 1) {
        throw new RosettaError(
            `validate requires exactly one positional arg: <map> (got ${positional.length})`,
        );
    }
    return { inputPath: positional[0] as string };
}

/**
 * Load a map from the filesystem, auto-detecting format from the path's
 * extension.
 */
export async function loadMap(inputPath: string, fs: FsLike): Promise<RosettaMap> {
    assertNoNul(inputPath);
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === '.json') {
        const raw = await fs.readFile(inputPath, 'utf8');
        let parsed: unknown;
        try {
            parsed = parseJson(raw);
        } catch (e) {
            throw new RosettaError(`JSON parse error in ${inputPath}: ${(e as Error).message}`);
        }
        return validateStructure(parsed);
    }
    if (ext === '.yaml' || ext === '.yml') {
        const raw = await fs.readFile(inputPath, 'utf8');
        return yamlToMap(raw);
    }
    if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        // Maps are pure data — never import a contributor-supplied module.
        refuseModuleInput(inputPath);
    }
    throw new RosettaError(`unsupported map extension: ${ext} (path: ${inputPath})`);
}

/**
 * Run `rosetta validate` under the shared command contract: load +
 * validate the map, print a one-line `OK` summary to stdout, and return
 * exit code 0.
 *
 * A load/validation failure is *thrown* (not returned): the router's
 * `formatErrorLines` renders it under the uniform `rosetta validate: …`
 * prefix and folds a `MapValidationError`'s issue list into indented
 * follow-on lines — the old bespoke `FAIL: … — …` report, unified.
 */
export async function runValidate(argv: readonly string[], io: CommandIo): Promise<number> {
    const opts = parseValidateArgs(argv);
    const map = await loadMap(opts.inputPath, io.fs);
    io.stdout(
        `OK: ${opts.inputPath} — ${map.app}@${map.version}, ` +
            `${Object.keys(map.classes).length} class(es), schema_version=${map.schema_version}`,
    );
    return 0;
}
