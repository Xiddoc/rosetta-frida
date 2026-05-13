#!/usr/bin/env node
/**
 * rosetta CLI entry point.
 *
 * Wave 1C: implements `patch`, `extract`, `inspect`.
 * Wave 1D: implements `init`, `validate`, `convert`.
 */

import { RosettaError } from '../src/errors.js';
import { runInit } from './commands/init.js';
import { runValidate } from './commands/validate.js';
import { runConvert } from './commands/convert.js';

const COMMANDS = ['init', 'validate', 'convert', 'patch', 'extract', 'inspect'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(s: string | undefined): s is Command {
    return COMMANDS.includes(s as Command);
}

function printUsage(): void {
    console.error('Usage: rosetta <command> [options]');
    console.error('');
    console.error('Commands:');
    console.error('  init <app> <version>   Scaffold a new map skeleton');
    console.error('  validate <map.json>    Schema + sanity check');
    console.error('  convert <in> -o <out>  Convert YAML / TS module to canonical JSONC');
    console.error('  patch <bundle.js> --map <new.json>  Replace embedded map in bundle');
    console.error('  extract <bundle.js> -o <out.json>   Pull embedded map out of bundle');
    console.error('  inspect <bundle.js>    One-line summary of embedded map');
}

async function dispatch(cmd: Command, args: readonly string[]): Promise<number> {
    switch (cmd) {
        case 'init': {
            const out = await runInit(args);
            console.log(`wrote ${out}`);
            return 0;
        }
        case 'validate': {
            const result = await runValidate(args);
            for (const line of result.output) {
                if (result.ok) console.log(line);
                else console.error(line);
            }
            return result.ok ? 0 : 1;
        }
        case 'convert': {
            const out = await runConvert(args);
            console.log(`wrote ${out}`);
            return 0;
        }
        case 'patch':
        case 'extract':
        case 'inspect':
            // Wave 1C implements these.
            console.error(`command '${cmd}' not yet implemented (waiting on Wave 1C)`);
            return 1;
    }
}

async function main(): Promise<number> {
    const cmd = process.argv[2];
    if (!cmd || cmd === '--help' || cmd === '-h') {
        printUsage();
        return cmd ? 0 : 1;
    }
    if (!isCommand(cmd)) {
        console.error(`unknown command: ${cmd}`);
        printUsage();
        return 1;
    }
    try {
        return await dispatch(cmd, process.argv.slice(3));
    } catch (e) {
        if (e instanceof RosettaError) {
            console.error(`error: ${e.message}`);
        } else {
            console.error(`error: ${(e as Error).message}`);
        }
        return 1;
    }
}

void main().then((code) => {
    process.exit(code);
});
