#!/usr/bin/env node
/**
 * rosetta CLI entry point.
 *
 * Wave 1C: implements `patch`, `extract`, `inspect`.
 * Wave 1D: implements `init`, `validate`, `convert`.
 *
 * Wave 0 stub — prints usage and exits.
 */

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

function main(): number {
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
    console.error(`command '${cmd}' not yet implemented (waiting on Wave 1)`);
    return 1;
}

process.exit(main());
