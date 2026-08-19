# auway

One command to **detect and update all your AI coding agents** — with install-manager awareness.

```bash
npx auway
```

> The npm package is `auway`; this repository is named `agent-update-way`.

| Agent | Install detected via | Update via |
|---|---|---|
| Claude Code | `claude` | `claude update` (native) |
| Pi Coding Agent | `pi` | `npm update -g --prefix <node-root> @earendil-works/pi-coding-agent` |
| Oh My Pi | `omp` | `omp update` (native) / `bun add -g @oh-my-pi/pi-coding-agent` (bun) |
| OpenCode | `opencode` | `opencode upgrade` (native) / `brew upgrade opencode` |
| OpenAI Codex | `codex` | `brew upgrade --cask codex` (brew cask) |
| GitHub Copilot CLI | `copilot` | `brew upgrade --cask copilot-cli` (brew cask) |
| Cursor Agent | `cursor-agent` | `cursor-agent update` |
| Antigravity CLI | `agy` | `agy update` |
| Pi Extensions | `~/.pi/agent/settings.json` | `pi update --extensions` (native) |

## Pi Extensions

When pi is installed, auway also **detects and updates pi's extension/skill
packages on every run — even if pi itself is up to date** (pinned npm versions
are skipped, git refs are reconciled):

- **Detection** is read-only: it reads the `packages` list from
  `~/.pi/agent/settings.json` (and project `.pi/settings.json`), reads each
  installed version from disk, and compares against the npm registry
  (`npm view <pkg> version`, parallel). Git packages are reported by HEAD rev.
- **Update** is delegated to pi's native `pi update --extensions`, which
  manages npm + git packages exactly as pi does (separate module roots,
  production installs, pinned-version skips, git ref reconciliation).
- In the update panel extensions appear as a single aggregate task;
  `auway list` shows each package with its installed/latest version.
- Scoped updates that exclude pi (`auway update claude`) leave pi extensions
  untouched.

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
user-level  →  precise isolated update of ~/node_modules/<pkg> only
              (npm view → npm pack → atomic swap → nested deps)
project-local node_modules  →  never touched (skipped with a warning)
```

> User-level installs (created via `npm install --prefix ~`, e.g. an agent
> linked from `~/.bun/bin`) are updated **precisely**: auway downloads the
> exact package tarball from the registry, atomically swaps it into
> `~/node_modules/<pkg>` and installs its dependencies nested inside the
> package dir. The rest of your `~/node_modules` tree is never touched — a
> plain `npm install --prefix ~` or `bun add -g` would re-resolve and churn
> the whole user-level tree (measured: 100+ unrelated packages).

## Install

```bash
npm install -g auway
```

Or run without installing:

```bash
npx --yes auway@latest
```

> Note: `npx` caches whatever version it downloaded once and will not re-check
> for `latest` until the cache entry is stale. Use the explicit `@latest` tag
> (or clear `~/.npm/_npx/*/node_modules/auway`) to pick up new
> releases.

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

Pi Extensions (8 packages, 1 update available):
  pi-subagents            0.50.0 → 0.51.0    update
  @feniix/pi-notion       3.0.2              ok
  ...

$ auway
Updating 6 item(s) concurrently...
[█████████████████████████] 100% (6/6)  done
✔ Claude Code  up to date (2.1.228)
✔ Pi Coding Agent  up to date (0.84.1)
✔ Pi Extensions  8 packages · 1 outdated → 8 packages
✔ OpenCode  up to date (1.18.16)
✔ OpenAI Codex  up to date (0.147.0)
✔ GitHub Copilot CLI  up to date (1.0.79)

Done: 1 updated, 5 up to date, 0 skipped, 0 failed.
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

Pi extension support lives in `src/pi-extensions.ts` (settings parsing, npm
latest checks, `pi update --extensions` delegation).

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
