/**
 * `rosetta convert <in> -o <out.json>`
 *
 * Auto-detects the input format by extension and writes canonical
 * strict JSON to the output path.
 *
 * Recognized inputs:
 *   - `.yaml` / `.yml`         → YAML source.
 *
 * JSON input (`.json`) is rejected here: it's already in the canonical
 * format, so there's nothing to convert. TS/JS-module inputs
 * (`.ts`/`.js`/`.mjs`/`.cjs`) are refused — maps are pure data and must
 * be authored as JSON or YAML (module ingestion was a build-time RCE).
 *
 * The output path is contained to the project tree (CWD); a traversal
 * or absolute `-o` is refused.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RosettaError } from '../../src/errors.js';
import { convertToJson, yamlToMap, refuseModuleInput } from '../../src/convert/index.js';
import { assertContained, assertNoNul } from '../../src/parse/index.js';

export interface ConvertOptions {
    inputPath: string;
    outputPath: string;
    /** Overwrite existing output. */
    force?: boolean;
}

/** Parse argv → ConvertOptions. */
export function parseConvertArgs(argv: readonly string[]): ConvertOptions {
    const positional: string[] = [];
    let output: string | undefined;
    let force = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-o' || arg === '--output') {
            const next = argv[i + 1];
            if (next === undefined) {
                throw new RosettaError(`${arg} requires a value`);
            }
            output = next;
            i++;
        } else if (arg === '--force' || arg === '-f') {
            force = true;
        } else if (arg !== undefined && arg.startsWith('-')) {
            throw new RosettaError(`unknown flag: ${arg}`);
        } else if (arg !== undefined) {
            positional.push(arg);
        }
    }
    if (positional.length !== 1) {
        throw new RosettaError(
            `convert requires exactly one positional arg: <in> (got ${positional.length})`,
        );
    }
    if (output === undefined) {
        throw new RosettaError('convert requires -o <out.json>');
    }
    return { inputPath: positional[0] as string, outputPath: output, force };
}

/** Run `rosetta convert`. Returns the absolute output path on success. */
export async function runConvert(argv: readonly string[], fsImpl: typeof fs = fs): Promise<string> {
    const opts = parseConvertArgs(argv);
    assertNoNul(opts.inputPath);
    // Contain the output path to the project tree before any IO.
    assertContained(opts.outputPath);
    const ext = path.extname(opts.inputPath).toLowerCase();

    if (!opts.force && (await fileExists(opts.outputPath, fsImpl))) {
        throw new RosettaError(
            `refusing to overwrite existing file: ${opts.outputPath} (pass --force to overwrite)`,
        );
    }

    let json: string;
    if (ext === '.yaml' || ext === '.yml') {
        const raw = await fsImpl.readFile(opts.inputPath, 'utf8');
        json = await convertToJson(raw, 'yaml');
    } else if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        // Maps are pure data — never import a contributor-supplied module.
        refuseModuleInput(opts.inputPath);
    } else if (ext === '.json') {
        throw new RosettaError(`input is already in canonical format (${ext}); nothing to convert`);
    } else {
        throw new RosettaError(`unsupported input format: ${ext} (path: ${opts.inputPath})`);
    }

    await fsImpl.mkdir(path.dirname(opts.outputPath), { recursive: true });
    await fsImpl.writeFile(opts.outputPath, json, 'utf8');
    return opts.outputPath;
}

async function fileExists(p: string, fsImpl: typeof fs): Promise<boolean> {
    try {
        await fsImpl.stat(p);
        return true;
    } catch {
        return false;
    }
}

// Re-export for tests that want to round-trip through the same entry that the
// CLI itself goes through.
export { yamlToMap };
