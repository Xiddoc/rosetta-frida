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
 * Subset of `node:fs/promises` the CLI commands need. Kept narrow so the
 * mock in tests stays small, but wide enough that *every* command can
 * route its filesystem access through a single injected seam:
 *   - `readFile` / `writeFile` — all commands.
 *   - `mkdir` — init/convert create the output directory.
 *   - `stat` — init/convert probe for an existing file (overwrite guard).
 *
 * The signatures are structurally compatible with `node:fs/promises` so
 * the real module satisfies `FsLike` directly (no cast), and so does a
 * hand-rolled in-memory fake.
 */
export interface FsLike {
    readFile(path: string, encoding: 'utf8'): Promise<string>;
    writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
    mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
    stat(path: string): Promise<unknown>;
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
 * Return whether a file exists at `path`. A failing `stat` (ENOENT or
 * otherwise) is treated as "absent" — the only use is an
 * overwrite/probe guard, where any unreadable path is safe to treat as
 * not-yet-present.
 */
export async function fileExists(fs: FsLike, path: string): Promise<boolean> {
    try {
        await fs.stat(path);
        return true;
    } catch {
        return false;
    }
}

/** Create the parent directory of `filePath` (recursive; no-op if present). */
export async function ensureDir(fs: FsLike, dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}
