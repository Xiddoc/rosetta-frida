/**
 * Command router — the single, testable place that maps an argv vector to
 * a command, runs it, and enforces the one shared exit-code contract.
 *
 * The contract (see also `cli/commands/io.ts`):
 *   - A command returns its success *message*; the router emits it under
 *     the uniform `rosetta <command>: <message>` prefix (via
 *     {@link successLine}) to `io.stdout` and returns 0. Success output is
 *     greppable per verb, mirroring the error path.
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
 *
 * Every command is described by ONE table ({@link COMMANDS}): each
 * entry carries the command's `run` function and a structured `usage`
 * (an `invocation` column + a `summary` column). The command-name union,
 * the usage block, and dispatch are all derived from that table, so
 * adding a command means editing one place and the help text can never go
 * stale. {@link printUsage} pads the invocation column so the summaries
 * stay aligned regardless of invocation length.
 */

import { runExtract } from './commands/extract.js';
import { runInspect } from './commands/inspect.js';
import { runPatch } from './commands/patch.js';
import { runInit } from './commands/init.js';
import { runValidate } from './commands/validate.js';
import { runConvert } from './commands/convert.js';
import { runFreshness } from './commands/freshness.js';
import { runPull, defaultPullConfig } from './commands/pull.js';
import { runDiff } from './commands/diff.js';
import { runMerge } from './commands/merge.js';
import { runTypes } from './commands/types.js';
import { DiffDriftError, formatErrorLines, successLine, type CommandIo } from './commands/io.js';

/** A command's run function: argv tail + io → its success message. */
type CommandRun = (args: readonly string[], io: CommandIo) => Promise<string>;

/** One command's behaviour and help text — the single source of truth. */
interface CommandEntry {
    run: CommandRun;
    /**
     * The command + its arguments, e.g. `init <app> <version> [options]`.
     * {@link printUsage} pads this column so all summaries line up.
     */
    invocation: string;
    /** One-line description shown in the right-hand column of the help block. */
    summary: string;
}

/**
 * The command table. The key order is the help-listing order. Every
 * command appears exactly once; the usage row lives next to the function
 * it documents so the two can't drift. Options are folded into an
 * `[options]` placeholder so the invocation column stays short and the
 * summaries stay aligned (full option grammar lives in `docs/cli/`).
 */
const COMMANDS = {
    init: {
        run: runInit,
        invocation: 'init <app> <version> [options]',
        summary: 'Scaffold a new map skeleton (--version-code required)',
    },
    pull: {
        // runPull takes a third `config` arg; bind the production default so
        // the router table stays uniform (all entries are CommandRun).
        run: (args, io) => runPull(args, io, defaultPullConfig()),
        invocation: 'pull <app>@<version_code> [options]',
        summary: 'Fetch + verify map from rosetta-maps repo (--require-sidecar)',
    },
    validate: {
        run: runValidate,
        invocation: 'validate <map> [--deep]',
        summary: 'Schema check (+ --deep semantic checks; --json)',
    },
    convert: {
        run: runConvert,
        invocation: 'convert <in> -o <out>',
        summary: 'Convert YAML map to canonical JSON',
    },
    patch: {
        run: runPatch,
        invocation: 'patch <bundle.js> --map <new.json>',
        summary: 'Replace embedded map in bundle',
    },
    extract: {
        run: runExtract,
        invocation: 'extract <bundle.js> -o <out.json>',
        summary: 'Pull embedded map out of bundle',
    },
    inspect: {
        run: runInspect,
        invocation: 'inspect <bundle.js>',
        summary: 'One-line summary of embedded map',
    },
    diff: {
        run: runDiff,
        invocation: 'diff <from> <to> [--json] [--exit-code]',
        summary: 'Structural diff between two maps (what rotated)',
    },
    merge: {
        run: runMerge,
        invocation: 'merge <a> <b> [...] -o <out> [--strict]',
        summary: 'Combine partial maps for one (app, version_code)',
    },
    types: {
        run: runTypes,
        invocation: 'types <map> -o <out.d.ts>',
        summary: 'Emit .d.ts real-name stubs for autocompletion',
    },
    freshness: {
        run: runFreshness,
        invocation: 'freshness <map...> --signatures <sigs.yaml>',
        summary: 'Flag vendored maps stale vs current signatures (advisory)',
    },
} satisfies Record<string, CommandEntry>;

type Command = keyof typeof COMMANDS;

function isCommand(s: string | undefined): s is Command {
    return s !== undefined && s in COMMANDS;
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
    // Pad every invocation to the widest one so the summary column aligns,
    // regardless of how long any single command's invocation is.
    const width = Math.max(...Object.values(COMMANDS).map((e) => e.invocation.length));
    for (const entry of Object.values(COMMANDS)) {
        write(`  ${entry.invocation.padEnd(width)}  ${entry.summary}`);
    }
}

/** Dispatch a known command, applying the shared success/error contract. */
async function dispatch(cmd: Command, args: readonly string[], io: CommandIo): Promise<number> {
    try {
        const entry = COMMANDS[cmd];
        const message = await entry.run(args, io);
        io.stdout(successLine(cmd, message));
        return EXIT_OK;
    } catch (err) {
        // `diff --exit-code` on a non-empty diff is not a failure: the report
        // is the requested output. Print it to stdout (no error prefix) and
        // exit 1 so CI can gate on map drift.
        if (err instanceof DiffDriftError) {
            io.stdout(successLine(cmd, err.report));
            return EXIT_FAILURE;
        }
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
