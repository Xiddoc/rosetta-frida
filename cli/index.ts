#!/usr/bin/env node
/**
 * rosetta CLI entry point.
 *
 * Wave 1C: implements `patch`, `extract`, `inspect`.
 * Wave 1D: implements `init`, `validate`, `convert`.
 *
 * Command bodies live in `cli/commands/<name>.ts`. Two patterns coexist:
 *   - Bundle-manipulation commands (patch/extract/inspect) take a
 *     `CommandIo` for dependency-injected fs + stdout/stderr.
 *   - Map-authoring commands (init/validate/convert) take an optional
 *     `fsImpl` parameter and return their result value; the dispatch
 *     layer here adapts that into an exit code + stdout/stderr writes.
 *
 * Both patterns are unit-tested via their own files; this dispatcher is
 * excluded from coverage (vitest.config.ts) because exercising it would
 * require subprocess-spawning tests and the logic here is intentionally
 * trivial routing.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';

import { RosettaError } from '../src/errors.js';
import { runExtract } from './commands/extract.js';
import { runInspect } from './commands/inspect.js';
import { runPatch } from './commands/patch.js';
import { runInit } from './commands/init.js';
import { runValidate } from './commands/validate.js';
import { runConvert } from './commands/convert.js';
import type { CommandIo } from './commands/io.js';

const COMMANDS = ['init', 'validate', 'convert', 'patch', 'extract', 'inspect'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(s: string | undefined): s is Command {
    return COMMANDS.includes(s as Command);
}

function printUsage(stderr: (line: string) => void): void {
    stderr('Usage: rosetta <command> [options]');
    stderr('');
    stderr('Commands:');
    stderr('  init <app> <version>                 Scaffold a new map skeleton');
    stderr('  validate <map>                       Schema + sanity check (auto-detect format)');
    stderr('  convert <in> -o <out>                Convert YAML map to canonical JSON');
    stderr('  patch <bundle.js> --map <new.json>   Replace embedded map in bundle');
    stderr('  extract <bundle.js> -o <out.json>    Pull embedded map out of bundle');
    stderr('  inspect <bundle.js>                  One-line summary of embedded map');
}

async function dispatch(cmd: Command, args: readonly string[], io: CommandIo): Promise<number> {
    // CommandIo pattern (Wave 1C): bundle-manipulation commands.
    switch (cmd) {
        case 'patch':
            return runPatch(args, io);
        case 'extract':
            return runExtract(args, io);
        case 'inspect':
            return runInspect(args, io);
        default:
            break;
    }

    // Map-authoring pattern (Wave 1D): commands return values; we adapt.
    try {
        switch (cmd) {
            case 'init': {
                const out = await runInit(args, io.fs);
                io.stdout(`wrote ${out}`);
                return 0;
            }
            case 'validate': {
                const result = await runValidate(args, io.fs);
                const write = result.ok ? io.stdout : io.stderr;
                for (const line of result.output) write(line);
                return result.ok ? 0 : 1;
            }
            case 'convert': {
                const out = await runConvert(args, io.fs);
                io.stdout(`wrote ${out}`);
                return 0;
            }
        }
    } catch (e) {
        if (e instanceof RosettaError) {
            io.stderr(`error: ${e.message}`);
        } else {
            io.stderr(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
        return 1;
    }
}

async function main(): Promise<number> {
    const io: CommandIo = {
        fs: { readFile, writeFile, mkdir, stat },
        stdout: (line) => process.stdout.write(line + '\n'),
        stderr: (line) => process.stderr.write(line + '\n'),
    };

    const cmd = process.argv[2];
    if (!cmd || cmd === '--help' || cmd === '-h') {
        printUsage(io.stderr);
        return cmd ? 0 : 1;
    }
    if (!isCommand(cmd)) {
        io.stderr(`unknown command: ${cmd}`);
        printUsage(io.stderr);
        return 1;
    }
    return dispatch(cmd, process.argv.slice(3), io);
}

main().then(
    (code) => process.exit(code),
    (err: unknown) => {
        process.stderr.write(
            `rosetta: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(2);
    },
);
