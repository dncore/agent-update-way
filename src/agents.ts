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
    // `codex update` bootstraps install.sh from chatgpt.com and the script
    // probes releases.openai.com — both unreachable on some networks. Worse,
    // `curl … | sh` exits 0 when curl fails (empty pipe → fake success). The
    // fallback runs the same installer from GitHub with the documented
    // CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false (GitHub Releases only);
    // the $(…) && [ -n "$s" ] form makes a blocked fetch exit non-zero.
    githubReleaseRepo: 'openai/codex',
    nativeUpdateFallback: {
      unix: [
        'sh',
        '-c',
        's=$(curl -fsSL https://raw.githubusercontent.com/openai/codex/main/scripts/install/install.sh) && [ -n "$s" ] && printf "%s" "$s" | CODEX_NON_INTERACTIVE=1 CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false sh',
      ],
      windows: [
        'powershell',
        '-ExecutionPolicy',
        'Bypass',
        '-c',
        "$env:CODEX_NON_INTERACTIVE='1'; $env:CODEX_INSTALLER_USE_RELEASES_OPENAI_COM='false'; $s = irm https://raw.githubusercontent.com/openai/codex/main/scripts/install/install.ps1 -UseBasicParsing; if (-not $s) { exit 1 }; iex $s",
      ],
    },
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
    // `agy version` is not a subcommand — agy reads bare positional args as
    // prompts and exits non-zero, so version detection always came back null
    // and updates were always reported as "up-to-date".
    versionCmd: ['agy', '--version'],
  },
  {
    name: 'grok',
    label: 'Grok Build',
    nativeUpdate: ['grok', 'update'],
    versionCmd: ['grok', '--version'],
    npmPackage: '@xai-official/grok',
    brewFormula: 'grok-build',
  },
];

export function findAgent(name: string): AgentDef | undefined {
  return KNOWN_AGENTS.find((a) => a.name === name);
}

export const AGENT_NAMES = KNOWN_AGENTS.map((a) => a.name);
