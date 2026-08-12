#!/usr/bin/env node
import { detectAll, managerLabel } from './detect.js';
import { updateAgents } from './update.js';
import { createRenderer, color } from './render.js';
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

const isTTY = process.stdout.isTTY && !process.env.CI;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/* ---------- commands ---------- */

function cmdList(): void {
  const agents = detectAll();
  if (!agents.length) {
    console.log(color.yellow('No known AI agents found in PATH.'));
    console.log(
      color.dim(
        'Known agents: ' + ['pi', 'claude', 'opencode', 'codex', 'copilot', 'cursor-agent', 'agy'].join(', '),
      ),
    );
    return;
  }

  console.log(color.bold(`${agents.length} agent(s) detected:\n`));
  console.log(color.dim(pad('AGENT', 22) + pad('VERSION', 14) + pad('MANAGER', 14) + 'PATH'));
  for (const a of agents) {
    const name = a.manager === 'local' ? color.yellow(`${a.def.label} (skip)`) : a.def.label;
    const ver = a.version ?? '?';
    const mgr =
      a.manager === 'local' ? color.yellow(managerLabel(a.manager)) : color.cyan(managerLabel(a.manager));
    const path = a.manager === 'local' ? color.dim(a.realPath) : a.realPath;
    console.log(pad(name, 22) + pad(ver, 14) + pad(mgr, 14) + path);
    if (a.manager === 'local') {
      console.log('  ' + color.yellow(`  ${a.skipReason ?? ''}`));
    }
  }
}

async function cmdUpdate(targets: string[]): Promise<void> {
  let agents = detectAll();
  if (targets.length) {
    const names = new Set(targets);
    const unknown = targets.filter((t) => !agents.some((a) => a.def.name === t));
    if (unknown.length) {
      console.log(color.yellow(`not installed: ${unknown.join(', ')}`));
    }
    agents = agents.filter((a) => names.has(a.def.name));
    if (!agents.length) {
      console.log(color.yellow('Nothing to update.'));
      return;
    }
  }

  console.log(color.bold(`Updating ${agents.length} agent(s) concurrently...\n`));
  const renderer = createRenderer({ tty: isTTY });
  agents.forEach((a) => renderer.add(a.def.label));

  await updateAgents(agents, {
    onProgress: (index, update) => renderer.update(index, update),
  });

  const summary = renderer.stop();
  console.log('\n' + summary);
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
      console.log(color.red(`Unknown command: ${args[0]}`));
      cmdHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(color.red(`auway error: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
