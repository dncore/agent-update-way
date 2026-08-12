/** How a detected agent binary is installed on the machine. */
export type InstallManager =
  | 'npm' // global npm install (incl. fnm/nvm node roots)
  | 'pnpm' // pnpm global store
  | 'bun' // bun global
  | 'brew' // Homebrew formula
  | 'user' // user-level install under ~/node_modules (npm --prefix ~)
  | 'native' // official installer / standalone binary (claude native, opencode binary, ...)
  | 'local'; // project-local dependency (node_modules/.bin) - never touch these

/** A known AI coding agent that we can detect and update. */
export interface AgentDef {
  /** Binary name used for PATH detection, e.g. "claude". */
  name: string;
  /** Display name, e.g. "Claude Code". */
  label: string;
  /** Official self-update command for native installations. */
  nativeUpdate: string[];
  /** Version command. */
  versionCmd: string[];
  /** npm package name used when installed via npm/pnpm/bun (e.g. "@earendil-works/pi-coding-agent"). */
  npmPackage?: string;
  /** Homebrew formula name (e.g. "codex"). */
  brewFormula?: string;
  /** Whether `npm update -g <pkg>` is a reliable path (true if npmPackage is set). */
}

/** Everything we know about one detected installation. */
export interface DetectedAgent {
  def: AgentDef;
  /** PATH entry that resolves to the binary. */
  binPath: string;
  /** Real path after symlink resolution. */
  realPath: string;
  manager: InstallManager;
  /** For npm/pnpm/bun: the global package name; for brew: the formula name. */
  managerTarget?: string;
  /** For npm: the node installation root that owns the package (e.g. .../fnm/node-versions/v24/installation). */
  nodeRoot?: string;
  /** For brew: installed via `brew install --cask` (path under Caskroom). */
  brewCask?: boolean;
  /** Parsed version, may be null if unknown. */
  version: string | null;
  /** Human-readable reason when manager is 'local' (skipped). */
  skipReason?: string;
}

/** Result of running one agent's update. */
export interface UpdateResult {
  agent: DetectedAgent;
  status: 'updated' | 'up-to-date' | 'skipped' | 'failed';
  before: string | null;
  after: string | null;
  error?: string;
}

/** Progress event emitted as each agent's update progresses. */
export interface TaskUpdate {
  state: 'running' | 'success' | 'failed' | 'skipped';
  before?: string | null;
  after?: string | null;
  error?: string;
}
