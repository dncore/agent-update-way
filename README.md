# auway (agent-update-way)

One command to **detect and update all your AI coding agents** — with install-manager awareness.

```bash
npx agent-update-way        # or: auway
```

| Agent | Install detected via | Update via |
|---|---|---|
| Claude Code | `claude` | `claude update` (native) |
| Pi Coding Agent | `pi` | `npm update -g --prefix <node-root> @earendil-works/pi-coding-agent` |
| OpenCode | `opencode` | `opencode upgrade` (native) / `brew upgrade opencode` |
| OpenAI Codex | `codex` | `brew upgrade --cask codex` (brew cask) |
| GitHub Copilot CLI | `copilot` | `brew upgrade --cask copilot-cli` (brew cask) |
| Cursor Agent | `cursor-agent` | `cursor-agent update` |
| Antigravity CLI | `agy` | `agy update` |

## Why not just call `pi update` / `claude update` for everything?

Naive updaters call each agent's self-update command. That breaks in the real world:

- `pi update pi` **fails** when `pi` is a global npm install — pi refuses to self-update
  non-global installations, and `npx` prepends the current project's `node_modules/.bin`
  to `PATH`, so detection can hit a *project-local* copy of `pi` instead of the global one.
- `codex` / `copilot` installed via Homebrew should be updated with `brew upgrade`,
  not their internal self-updater.

**auway** resolves the real path of each binary (`readlink`), classifies its install
manager (npm global / pnpm / bun / brew formula / brew cask / native / project-local),
and updates via the manager that actually provides it:

```
npm global  →  npm update -g --prefix <node-root> <pkg>   (works with fnm/nvm multi-version)
brew cask   →  brew upgrade --cask <formula>
brew        →  brew upgrade <formula>
native      →  <agent> update
project-local node_modules  →  never touched (skipped with a warning)
```

## Install

```bash
npm install -g agent-update-way
```

Or run without installing:

```bash
npx --yes agent-update-way
```

## Usage

```
auway                      update all detected agents (concurrently)
auway update [agents...]   update all, or only the named agents
auway list                 list detected agents (version, manager, real path)
auway --version            print version
auway --help               print help
```

### Example

```console
$ auway list
5 agent(s) detected:

AGENT                 VERSION       MANAGER       PATH
Claude Code           2.1.228       native        /Users/me/.local/share/claude/versions/2.1.228
Pi Coding Agent       0.84.1        npm global    /Users/me/.local/share/fnm/node-versions/v24.13.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
OpenCode              1.18.16       native        /Users/me/.opencode/bin/opencode
OpenAI Codex          0.147.0       homebrew      /opt/homebrew/Caskroom/codex/0.147.0/bin/codex
GitHub Copilot CLI    1.0.79        homebrew      /opt/homebrew/Caskroom/copilot-cli/1.0.43/copilot

$ auway
Updating 5 agent(s) concurrently...

✔ Claude Code  up to date (2.1.228)
✔ Pi Coding Agent  up to date (0.84.1)
✔ OpenCode  up to date (1.18.16)
✔ OpenAI Codex  up to date (0.147.0)
✔ GitHub Copilot CLI  up to date (1.0.79)

Done: 0 updated, 5 up to date, 0 skipped, 0 failed.
```

## Design

- **Zero runtime dependencies** — pure Node built-ins (`child_process`, `fs`, `os`).
  Nothing to audit; no supply-chain surface beyond the CLI itself.
- **Install-manager-aware updates** — the key difference from naive updaters (see above).
- **fnm/nvm multi-version safe** — a package installed under node v24's global root is
  updated via `npm update -g --prefix <that node root>`, not whatever node happens to be
  first in `PATH`.
- **Concurrent updates** — failures in one agent never block the others.
- **Project-local installs are never touched.**

## Adding an agent

Edit `src/agents.ts` (`KNOWN_AGENTS`) — one entry with the binary name, native update
command, npm package and/or brew formula. Detection and manager classification are generic.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/cli.js
node dist/cli.js list
```

## License

MIT
