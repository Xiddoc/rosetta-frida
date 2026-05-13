/**
 * Shared CLI I/O abstractions.
 *
 * Commands take their fs operations and stdout/stderr writers as
 * dependency-injected interfaces. That way:
 *   - tests construct a fake `CommandIo` with in-memory backing,
 *     never touching the real disk;
 *   - the real `process` entry point at `cli/index.ts` builds the
 *     production `CommandIo` once and threads it through.
 */

/**
 * Subset of `node:fs/promises` we need. Kept narrow so the mock in
 * tests stays small.
 */
export interface FsLike {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
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
