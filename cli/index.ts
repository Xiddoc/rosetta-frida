#!/usr/bin/env node
/**
 * rosetta CLI entry point — a thin process shell.
 *
 * All routing, the help/usage behaviour, and the one shared exit-code
 * contract live in `cli/router.ts` (unit-tested with an in-memory
 * `CommandIo`). This file only builds the production `CommandIo` (real
 * fs + process stdout/stderr), hands argv to `route`, and exits with the
 * returned code. It is intentionally excluded from coverage
 * (vitest.config.ts) because it is a trivial syscall adapter.
 *
 * Exit codes: 0 success / help, 1 handled failure, 2 misuse (unknown
 * command) or an unexpected throw that escaped the router.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';

import { route } from './router.js';
import type { CommandIo } from './commands/io.js';

async function main(): Promise<number> {
    const io: CommandIo = {
        fs: { readFile, writeFile, mkdir, stat },
        stdout: (line) => process.stdout.write(line + '\n'),
        stderr: (line) => process.stderr.write(line + '\n'),
    };
    return route(process.argv.slice(2), io);
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
