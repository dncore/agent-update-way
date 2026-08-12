import type { AgentDef } from './types.js';

/**
 * Registry of known AI coding agents.
 *
 * - `nativeUpdate`: used only for native (official installer / standalone) installs.
 * - `npmPackage` / `brewFormula`: used for install-manager-aware updates
 *   (`npm update -g <pkg>`, `brew upgrade <formula>`). This is the key difference
 *   from naive tools: we update via whatever manager actually provides the binary,
 *   never blindly via the self-update command.
 */
export const KNOWN_AGENTS: AgentDef[] = [
  {
    name: 'claude',
    label: 'Claude Code',
    nativeUpdate: ['claude', 'update'],
    versionCmd: ['claude', '--version'],
    npmPackage: '@anthropic-ai/claude-code',
  },
  {
    name: 'pi',
    label: 'Pi Coding Agent',
    nativeUpdate: ['pi', 'update', 'pi'],
    versionCmd: ['pi', '--version'],
    npmPackage: '@earendil-works/pi-coding-agent',
  },
  {
    name: 'omp',
    label: 'Oh My Pi',
    nativeUpdate: ['omp', 'update'],
    versionCmd: ['omp', '--version'],
    npmPackage: '@oh-my-pi/pi-coding-agent',
  },
  {
    name: 'opencode',
    label: 'OpenCode',
    nativeUpdate: ['opencode', 'upgrade'],
    versionCmd: ['opencode', '--version'],
    npmPackage: 'opencode-ai',
    brewFormula: 'opencode',
  },
  {
    name: 'codex',
    label: 'OpenAI Codex',
    nativeUpdate: ['codex', 'update'],
    versionCmd: ['codex', '--version'],
    npmPackage: '@openai/codex',
    brewFormula: 'codex',
  },
  {
    name: 'copilot',
    label: 'GitHub Copilot CLI',
    nativeUpdate: ['copilot', 'update'],
    versionCmd: ['copilot', '--version'],
    npmPackage: '@github/copilot-cli',
    brewFormula: 'copilot',
  },
  {
    name: 'cursor-agent',
    label: 'Cursor Agent',
    nativeUpdate: ['cursor-agent', 'update'],
    versionCmd: ['cursor-agent', '--version'],
    npmPackage: '@cursorai/cli',
  },
  {
    name: 'agy',
    label: 'Antigravity CLI',
    nativeUpdate: ['agy', 'update'],
    versionCmd: ['agy', 'version'],
  },
];

export function findAgent(name: string): AgentDef | undefined {
  return KNOWN_AGENTS.find((a) => a.name === name);
}

export const AGENT_NAMES = KNOWN_AGENTS.map((a) => a.name);
