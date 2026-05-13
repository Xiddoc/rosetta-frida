/**
 * Test-only helpers for CLI commands. Building blocks for a fake
 * `CommandIo`: an in-memory filesystem and string buffers for stdout/
 * stderr.
 *
 * Lives in `tests/` rather than `cli/` so it's outside the coverage
 * include path — the helpers themselves don't need to be instrumented.
 */

import type { CommandIo } from '../../cli/commands/io.js';

/** A fake filesystem with explicit file contents. */
export interface FakeFs {
    /** Snapshot of the post-run file contents (writes accumulate). */
    files: Map<string, string>;
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

/** Construct a CommandIo bound to a FakeFs + Captured. */
export function makeIo(fs: FakeFs, captured: Captured): CommandIo {
    return {
        fs: {
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
        },
        stdout: (line) => captured.stdout.push(line),
        stderr: (line) => captured.stderr.push(line),
    };
}
