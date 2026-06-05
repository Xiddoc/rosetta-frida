/**
 * Shared CLI I/O abstractions.
 *
 * Commands take their fs operations and stdout/stderr writers as
 * dependency-injected interfaces. That way:
 *   - tests construct a fake `CommandIo` with in-memory backing,
 *     never touching the real disk;
 *   - the real `process` entry point at `cli/index.ts` builds the
 *     production `CommandIo` once and threads it through.
 *
 * One error/exit-code contract (see `cli/router.ts`): a command throws a
 * `RosettaError` (or any Error) for a handled failure and the router maps
 * it to exit 1 via `formatErrorLines`. The success exit code is 0;
 * exit 2 is reserved for unexpected (programmer-bug) throws that escape
 * the router entirely.
 */

import { dirname } from 'node:path';
import { MapValidationError, RosettaError } from '../../src/errors.js';

/**
 * Subset of `node:fs/promises` the CLI commands need. Kept narrow so the
 * mock in tests stays small, but wide enough that *every* command can
 * route its filesystem access through a single injected seam:
 *   - `readFile` / `writeFile` — all commands.
 *   - `mkdir` — init/convert create the output directory.
 *
 * There is intentionally no `stat`: the overwrite guard is the atomic
 * `wx` write in {@link writeNew}, not a separate existence probe (which
 * would reintroduce a TOCTOU window).
 *
 * The signatures are structurally compatible with `node:fs/promises` so
 * the real module satisfies `FsLike` directly (no cast), and so does a
 * hand-rolled in-memory fake.
 */
export interface FsLike {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    /**
     * Plain UTF-8 write (overwrites). The second overload is the atomic
     * exclusive-create form (`flag: 'wx'`) used by {@link writeNew} to
     * close the overwrite-guard TOCTOU window — it rejects with `EEXIST`
     * when the target already exists, so the existence check and the
     * write are a single syscall.
     */
    writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
    writeFile(path: string, data: string, options: { encoding: 'utf8'; flag: 'wx' }): Promise<void>;
    mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
}

/** Stream-like writer abstraction; covers both stdout and stderr. */
export type Writer = (line: string) => void;

/** Everything a CLI command needs from the outside world. */
export interface CommandIo {
    fs: FsLike;
    stdout: Writer;
    stderr: Writer;
}

/**
 * Convert an unknown error into a human-readable message for stderr.
 * Errors thrown by rosetta-frida always have a `.message`; unknown
 * objects (`throw "string"`) get coerced via `String(...)`.
 */
export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

/**
 * Format a handled command failure as one or more stderr lines, using a
 * single uniform convention shared by every command:
 *
 *   rosetta <command>: <message>
 *
 * A {@link MapValidationError} additionally folds its structured issue
 * list in as indented follow-on lines (this is `validate`'s old bespoke
 * `FAIL: … — …` + `  at <path>: <msg>` report, now unified):
 *
 *   rosetta validate: Map failed schema validation (2 issues)
 *     at classes.IFoo.obfuscated: Required
 *     <message-without-path>
 *
 * The `command` token keys the line so output stays greppable per verb.
 */
export function formatErrorLines(command: string, err: unknown): string[] {
    const head = `rosetta ${command}: ${errorMessage(err)}`;
    if (!(err instanceof MapValidationError)) {
        return [head];
    }
    const lines = [head];
    for (const issue of err.issues) {
        lines.push(issue.path ? `  at ${issue.path}: ${issue.message}` : `  ${issue.message}`);
    }
    return lines;
}

/**
 * Format a command's success output under the same uniform convention as
 * {@link formatErrorLines}:
 *
 *   rosetta <command>: <message>
 *
 * Commands return only the message payload; the router owns the prefix
 * (and the command name it already knows), so success output stays
 * greppable per verb just like the error path — `rosetta extract:` finds
 * both the success and the failure line for that verb.
 */
export function successLine(command: string, message: string): string {
    return `rosetta ${command}: ${message}`;
}

/**
 * Write `data` to `path`, creating the parent directory first and
 * refusing to clobber an existing file unless `force` is set.
 *
 * The parent directory is always created (`mkdir -p`) before the write,
 * so callers don't need a separate `ensureDir` step — every emit site was
 * `ensureDir(dirname); writeNew(path)`, and folding the `mkdir` in here
 * collapses the two seams into one and removes the chance a caller
 * forgets it.
 *
 * Without `force` it uses an atomic exclusive create (`wx` flag) so the
 * existence check and the write are a single syscall — closing the
 * check-then-write (TOCTOU) window that init/convert previously left open
 * with a separate `stat` probe followed by an unconditional write. With
 * `force`, an ordinary overwrite is used.
 *
 * @throws RosettaError if the target exists and `force` is not set. Any
 *   other write failure is rethrown unchanged.
 */
export async function writeNew(
    fs: FsLike,
    path: string,
    data: string,
    opts: { force?: boolean } = {},
): Promise<void> {
    await fs.mkdir(dirname(path), { recursive: true });
    if (opts.force) {
        await fs.writeFile(path, data, 'utf8');
        return;
    }
    try {
        await fs.writeFile(path, data, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
        if (isExistError(err)) {
            throw new RosettaError(
                `refusing to overwrite existing file: ${path} (pass --force to overwrite)`,
            );
        }
        throw err;
    }
}

/** Whether an fs error is the "already exists" (EEXIST) failure from `wx`. */
function isExistError(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}
