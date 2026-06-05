/**
 * Command router — the single, testable place that maps an argv vector to
 * a command, runs it, and enforces the one shared exit-code contract.
 *
 * The contract (see also `cli/commands/io.ts`):
 *   - A command does its own success output via `io.stdout` and returns 0.
 *   - A command signals a *handled* failure by throwing a `RosettaError`
 *     (or any `Error`); the router catches it, prints `formatErrorLines`
 *     to `io.stderr`, and returns exit code 1.
 *   - `--help` / `-h` and a bare invocation (no command) print usage to
 *     *stdout* and return 0 — asking for help is success.
 *   - An unknown command prints an error + usage to *stderr* and returns
 *     2 (misuse), distinguishing "you typed it wrong" from a command that
 *     ran and failed (1).
 *
 * `cli/index.ts` is a thin shell that builds the production `CommandIo`,
 * calls `route`, and exits with the returned code. All routing logic
 * lives here so it is unit-testable with an in-memory `CommandIo`.
 */

import { runExtract } from './commands/extract.js';
import { runInspect } from './commands/inspect.js';
import { runPatch } from './commands/patch.js';
import { runInit } from './commands/init.js';
import { runValidate } from './commands/validate.js';
import { runConvert } from './commands/convert.js';
import { formatErrorLines, type CommandIo } from './commands/io.js';

const COMMANDS = ['init', 'validate', 'convert', 'patch', 'extract', 'inspect'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(s: string | undefined): s is Command {
    return COMMANDS.includes(s as Command);
}

/** Exit codes are a small fixed contract; named for readability. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_MISUSE = 2;

/** The usage text, emitted line-by-line through the given writer. */
export function printUsage(write: (line: string) => void): void {
    write('Usage: rosetta <command> [options]');
    write('');
    write('Commands:');
    write('  init <app> <version>                 Scaffold a new map skeleton');
    write('  validate <map>                       Schema + sanity check (auto-detect format)');
    write('  convert <in> -o <out>                Convert YAML map to canonical JSON');
    write('  patch <bundle.js> --map <new.json>   Replace embedded map in bundle');
    write('  extract <bundle.js> -o <out.json>    Pull embedded map out of bundle');
    write('  inspect <bundle.js>                  One-line summary of embedded map');
}

/** Dispatch a known command, applying the shared error/exit contract. */
async function dispatch(cmd: Command, args: readonly string[], io: CommandIo): Promise<number> {
    try {
        switch (cmd) {
            case 'patch':
                return await runPatch(args, io);
            case 'extract':
                return await runExtract(args, io);
            case 'inspect':
                return await runInspect(args, io);
            case 'init':
                return await runInit(args, io);
            case 'validate':
                return await runValidate(args, io);
            case 'convert':
                return await runConvert(args, io);
        }
    } catch (err) {
        for (const line of formatErrorLines(cmd, err)) io.stderr(line);
        return EXIT_FAILURE;
    }
}

/**
 * Route a full argv tail (everything after `node script`) to a command.
 *
 * @param argv `process.argv.slice(2)` — the command plus its options.
 */
export async function route(argv: readonly string[], io: CommandIo): Promise<number> {
    const cmd = argv[0];
    if (cmd === undefined || cmd === '--help' || cmd === '-h') {
        // Asking for help (or running bare) is success: usage to stdout.
        printUsage(io.stdout);
        return EXIT_OK;
    }
    if (!isCommand(cmd)) {
        io.stderr(`rosetta: unknown command: ${cmd}`);
        printUsage(io.stderr);
        return EXIT_MISUSE;
    }
    return dispatch(cmd, argv.slice(1), io);
}
