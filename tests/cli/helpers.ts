/**
 * Test-only helpers for CLI commands. Building blocks for a fake
 * `CommandIo`: an in-memory filesystem and string buffers for stdout/
 * stderr.
 *
 * Lives in `tests/` rather than `cli/` so it's outside the coverage
 * include path — the helpers themselves don't need to be instrumented.
 */

import type { CommandIo, FsLike } from '../../cli/commands/io.js';

/** A fake filesystem with explicit file contents. */
export interface FakeFs {
    /** Snapshot of the post-run file contents (writes accumulate). */
    files: Map<string, string>;
    /** Directories passed to `mkdir` (recursive), in call order. */
    dirsCreated: string[];
    /**
     * Optional read-error injection: if a path is in this map, the
     * read for that path will reject with the given Error.
     */
    readErrors: Map<string, Error>;
    /**
     * Optional write-error injection: if a path is in this map, the
     * write for that path will reject with the given Error.
     */
    writeErrors: Map<string, Error>;
}

/** Construct a fresh FakeFs preloaded with `seed` files. */
export function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
    return {
        files: new Map(Object.entries(seed)),
        dirsCreated: [],
        readErrors: new Map(),
        writeErrors: new Map(),
    };
}

/** Captured stdout/stderr lines. */
export interface Captured {
    stdout: string[];
    stderr: string[];
}

/** Construct a fresh Captured. */
export function makeCaptured(): Captured {
    return { stdout: [], stderr: [] };
}

/**
 * Build a fully-typed `FsLike` backed by a FakeFs. Implements the whole
 * narrow seam (readFile/writeFile/mkdir/stat) so every command — both
 * the CommandIo-pattern (patch/extract/inspect) and the map-authoring
 * commands (init/validate/convert) — can share one in-memory fake with
 * no `as unknown as` casts.
 */
export function makeFsLike(fs: FakeFs): FsLike {
    return {
        readFile: (path) => {
            const err = fs.readErrors.get(path);
            if (err) return Promise.reject(err);
            const content = fs.files.get(path);
            if (content === undefined) {
                return Promise.reject(new Error(`ENOENT: ${path}`));
            }
            return Promise.resolve(content);
        },
        writeFile: (path, data) => {
            const err = fs.writeErrors.get(path);
            if (err) return Promise.reject(err);
            fs.files.set(path, data);
            return Promise.resolve();
        },
        mkdir: (path) => {
            fs.dirsCreated.push(path);
            return Promise.resolve(undefined);
        },
        stat: (path) => {
            return fs.files.has(path)
                ? Promise.resolve({ isFile: () => true })
                : Promise.reject(new Error(`ENOENT: ${path}`));
        },
    };
}

/** Construct a CommandIo bound to a FakeFs + Captured. */
export function makeIo(fs: FakeFs, captured: Captured): CommandIo {
    return {
        fs: makeFsLike(fs),
        stdout: (line) => captured.stdout.push(line),
        stderr: (line) => captured.stderr.push(line),
    };
}
