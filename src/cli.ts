#!/usr/bin/env node
import { detectAll, managerLabel, npmGlobalRoot } from './detect.js';
import { updateAgents } from './update.js';
import type { DetectedAgent, UpdateResult } from './types.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = getVersion();

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(fileURLToPath(import.meta.url), '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/* ---------- tiny terminal helpers ---------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/* ---------- commands ---------- */

function cmdList(): void {
  const agents = detectAll();
  if (!agents.length) {
    console.log(c.yellow('No known AI agents found in PATH.'));
    console.log(c.dim('Known agents: ' + ['pi', 'claude', 'opencode', 'codex', 'copilot', 'cursor-agent', 'agy'].join(', ')));
    return;
  }

  console.log(c.bold(`${agents.length} agent(s) detected:\n`));
  console.log(c.dim(pad('AGENT', 22) + pad('VERSION', 14) + pad('MANAGER', 14) + 'PATH'));
  for (const a of agents) {
    const name = a.manager === 'local' ? c.yellow(`${a.def.label} (skip)`) : a.def.label;
    const ver = a.version ?? '?';
    const mgr = a.manager === 'local' ? c.yellow(managerLabel(a.manager)) : c.cyan(managerLabel(a.manager));
    const path = a.manager === 'local' ? c.dim(a.realPath) : a.realPath;
    console.log(pad(name, 22) + pad(ver, 14) + pad(mgr, 14) + path);
    if (a.manager === 'local') {
      console.log('  ' + c.yellow(`  ${a.skipReason ?? ''}`));
    }
  }
}

function cmdUpdate(targets: string[]): Promise<void> {
  let agents = detectAll();
  if (targets.length) {
    const names = new Set(targets);
    const unknown = targets.filter((t) => !agents.some((a) => a.def.name === t));
    if (unknown.length) {
      console.log(c.yellow(`not installed: ${unknown.join(', ')}`));
    }
    agents = agents.filter((a) => names.has(a.def.name));
    if (!agents.length) {
      console.log(c.yellow('Nothing to update.'));
      return Promise.resolve();
    }
  }
  console.log(c.bold(`Updating ${agents.length} agent(s) concurrently...\n`));
  return updateAgents(agents).then((results) => {
    printResults(results);
  });
}

function printResults(results: UpdateResult[]): void {
  for (const r of results) {
    const name = r.agent.def.label;
    const from = r.before ?? '?';
    const to = r.after ?? '?';
    switch (r.status) {
      case 'updated':
        console.log(c.green(`✔ ${name}  ${from} → ${to}`));
        break;
      case 'up-to-date':
        console.log(c.green(`✔ ${name}  up to date (${to})`));
        break;
      case 'skipped':
        console.log(c.yellow(`⏭ ${name}  skipped: ${r.error ?? 'no update command'}`));
        break;
      case 'failed':
        console.log(c.red(`✖ ${name}  failed: ${(r.error ?? 'unknown error').split('\n')[0]}`));
        if (r.error && r.error.includes('\n')) {
          console.log(c.dim('  ' + r.error.split('\n').slice(1, 4).join('\n  ')));
        }
        break;
    }
  }
  const failed = results.filter((r) => r.status === 'failed').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const updated = results.filter((r) => r.status === 'updated').length;
  console.log(c.bold(`\nDone: ${updated} updated, ${results.length - updated - failed - skipped} up to date, ${skipped} skipped, ${failed} failed.`));
}

function cmdHelp(): void {
  console.log(`auway v${VERSION} - update all your AI coding agents

Usage:
  auway                      update all detected agents
  auway update [agents...]   update all, or only the named agents
  auway list                 list detected agents (version, manager, path)
  auway --version            print version
  auway --help               print this help

Agents: pi, claude, opencode, codex, copilot, cursor-agent, agy

auway updates each agent via the install manager that provides it:
  npm global → npm update -g <pkg>   brew → brew upgrade <formula>
  pnpm/bun   → add -g <pkg>          native → <agent> update
Project-local node_modules installs are always skipped.`);
}

/* ---------- entry ---------- */

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    await cmdUpdate([]);
    return;
  }
  switch (args[0]) {
    case 'list':
    case 'ls':
      cmdList();
      return;
    case 'update':
    case 'up':
      await cmdUpdate(args.slice(1));
      return;
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case '--help':
    case '-h':
    case 'help':
      cmdHelp();
      return;
    default:
      console.log(c.red(`Unknown command: ${args[0]}`));
      cmdHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(c.red(`auway error: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
