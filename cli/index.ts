#!/usr/bin/env node
/**
 * rosetta CLI entry point.
 *
 * Wave 1C: implements `patch`, `extract`, `inspect`.
 * Wave 1D: implements `init`, `validate`, `convert`.
 *
 * Command bodies live in `cli/commands/<name>.ts` so they can be unit-
 * tested by directly invoking the exported `run*` functions with a
 * mock `CommandIo`. This file is the thin glue between `process.argv`
 * and those functions. It is excluded from coverage (`vitest.config.ts`)
 * because exercising it would require subprocess-spawning tests, and
 * the parsing/dispatch logic here is intentionally trivial.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { runExtract } from './commands/extract.js';
import { runInspect } from './commands/inspect.js';
import { runPatch } from './commands/patch.js';
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
    stderr('  validate <map.json>                  Schema + sanity check');
    stderr('  convert <in> -o <out>                Convert YAML/TS module to JSONC');
    stderr('  patch <bundle.js> --map <new.json>   Replace embedded map in bundle');
    stderr('  extract <bundle.js> -o <out.json>    Pull embedded map out of bundle');
    stderr('  inspect <bundle.js>                  One-line summary of embedded map');
}

async function main(): Promise<number> {
    const io: CommandIo = {
        fs: { readFile, writeFile },
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

    const rest = process.argv.slice(3);
    switch (cmd) {
        case 'patch':
            return runPatch(rest, io);
        case 'extract':
            return runExtract(rest, io);
        case 'inspect':
            return runInspect(rest, io);
        case 'init':
        case 'validate':
        case 'convert':
            io.stderr(`command '${cmd}' not yet implemented (waiting on Wave 1D)`);
            return 1;
    }
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
