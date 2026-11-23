# auway

One command to **detect and update all your AI coding agents** — with install-manager awareness.

```bash
npx auway
```

> The npm package is `auway`; this repository is named `agent-update-way`.

| Agent | Install detected via | Update via |
|---|---|---|
| Claude Code | `claude` | `claude update` (native) |
| Pi Coding Agent | `pi` | `pi update pi` (managed install) / `npm install -g --prefix <node-root> @earendil-works/pi-coding-agent@latest` (legacy npm) |
| Oh My Pi | `omp` | `omp update` (native) / `bun add -g @oh-my-pi/pi-coding-agent` (bun) |
| OpenCode | `opencode` | `opencode upgrade` (native) / `brew upgrade opencode` |
| OpenAI Codex | `codex` | `brew upgrade --cask codex` (brew) / `codex update` (native, with GitHub Releases fallback) |
| GitHub Copilot CLI | `copilot` | `brew upgrade --cask copilot-cli` (brew cask) |
| Cursor Agent | `cursor-agent` | `cursor-agent update` |
| Antigravity CLI | `agy` | `agy update` |
| Grok Build | `grok` | `grok update` (native) / `npm install -g @xai-official/grok@latest` / `brew upgrade --cask grok-build` |
| Pi Extensions | `~/.pi/agent/settings.json` | `pi update --extensions` (native) |
| Claude Plugins | `claude plugin list` | `claude plugin marketplace update` + `claude plugin update <id> -y` |
| Codex Plugins | `codex plugin list` | `codex plugin marketplace upgrade` + `codex plugin add <id>` |
| Grok Plugins | `grok plugin list` | `grok plugin update` (all) |
| Local Skills | `~/.claude/skills` / `~/.agents/skills` | `git pull --ff-only` (git-backed only) |

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
- The extensions task is **serialized after pi's own update**: `npm install -g`
  deletes and re-creates the bin/pi symlink, so spawning `pi` concurrently can
  hit `spawn pi ENOENT`. auway holds the extensions task until pi's update
  settles (its terminal event fires only after the post-update `pi --version`
  re-check), and additionally retries `pi update --extensions` on ENOENT as a
  safety net against third-party reinstall races.
- Scoped updates that exclude pi (`auway update claude`) leave pi extensions
  untouched.

## Pi: npm install vs managed install

The pi.dev installer builds a **managed install** (staged, version-verified and
atomically activated since pi 0.84.3). Since 1.0.1 `pi update` recommends
migrating to it on every npm self-update, and npm installs no longer ship
`npm-shrinkwrap.json`, so their transitive deps are unpinned:

```
~/.pi/agent/install/managed-install.json   {"kind":"pi-managed-install","schemaVersion":1,"layout":"releases-v1"}
~/.pi/agent/install/current-version        the release the launcher runs
~/.pi/agent/install/releases/<version>/    node_modules/.bin/pi
~/.pi/agent/bin/pi                         launcher script (usually symlinked into ~/.local/bin)
```

auway recognizes this layout by validating the same marker fields pi validates
(not by directory name), for both the launcher and a PATH entry pointing
straight into `releases/<v>/node_modules/.bin/pi` — the latter lives under
`node_modules/` and would otherwise be misread as a project-local dependency
and skipped. It reports the manager as `managed` and hands updates to
`pi update pi`, which stages the new release, runs `npm ci` against the
lockfile served by `pi.dev`, smoke-tests `--version`, atomically flips
`current-version` and prunes old releases. auway never writes into that tree.

Two consequences are handled explicitly:

- `pi update` **exits 1 when `pi.dev/api/latest-version` is unreachable**, even
  if nothing needed updating. auway cross-checks the npm registry (pi's second
  publication channel) and reports *up to date* when the installed version is
  already current, instead of a bare failure.
- A legacy npm install is still updated through npm (that is the manager that
  owns it), and auway prints the migration hint afterwards. If npm itself
  refuses — classically `EUNSUPPORTEDPROTOCOL`, because some *unrelated*
  globally installed package carries a `link:` or `workspace:` dependency that
  poisons every reify of the global tree — auway retries in isolation: pack the
  tarball, swap it into `lib/node_modules/<pkg>` and install only that
  package's dependencies nested inside its own directory. The global tree is
  never read. `auway migrate pi`
  hands the terminal to the official installer, which uninstalls the npm
  package and builds the managed tree; the command is interactive on purpose
  (the installer's menu reads `/dev/tty`), then re-detects and reports the new
  layout. Managed installs are macOS/Linux only, so the command refuses on
  Windows where `pi update` over npm works fine.

## Plugins & Skills

The same "detect read-only, update via the official mechanism" pattern covers
the plugin ecosystems of Claude Code, Codex and Grok, plus local skills. Each
appears as one aggregate task in the update panel and runs **behind its host
agent's settle gate** (the host's own update may be swapping its binary —
spawning it inside that window fails with ENOENT).

An agent with **no plugins installed** (or pi with no extensions) produces no
row at all and is not counted as "skipped" — an absent category is not a
result worth printing.

- **Claude Plugins** — detected via `claude plugin list --json`; updated by
  refreshing every marketplace (`claude plugin marketplace update`) and then
  `claude plugin update <id> -y` per plugin, serially. `-y` is Claude Code's
  official flag for non-interactive runs (it accepts the marketplace-declared
  install command); auway always passes it because it runs with piped stdio.
- **Codex Plugins** — detected via `codex plugin list --json`. Codex has **no
  per-plugin update command**, so auway runs the official
  `codex plugin marketplace upgrade` (refreshes configured Git marketplaces)
  and then re-installs each plugin with `codex plugin add <id>`, which pulls
  the marketplace's current version into Codex's versioned plugin cache
  (idempotent, config untouched).
- **Grok Plugins** — detected via `grok plugin list --json`; updated with the
  official bulk command `grok plugin update`.
- **Local Skills** — skills live in `~/.claude/skills` (often symlinks into
  the cross-agent `~/.agents/skills` tree). There is no official updater and
  no install provenance, so auway is honest about it: a skill that **is a git
  clone** is updated with `git pull --ff-only` (exactly how it was installed);
  a plain copied directory is reported as *no update source* and skipped —
  auway never guesses where a directory might have come from.

Scoped updates follow the pi precedent: `auway update claude` also updates
Claude plugins; `auway update codex` also updates Codex plugins. Skills run on
full updates only.

## Why not just call `pi update` / `claude update` for everything?

Naive updaters call each agent's self-update command. That breaks in the real world:

- `pi update pi` **fails** for *non-global* installations (npx / project-local copies), and
  `npx` prepends the current project's `node_modules/.bin` to `PATH`, so detection can hit
  a project-local copy of `pi` instead of the real one.
- `codex` / `copilot` installed via Homebrew should be updated with `brew upgrade`,
  not their internal self-updater.

**auway** resolves the real path of each binary (`readlink`), classifies its install
manager (npm global / pnpm / bun / brew formula / brew cask / native / managed /
project-local), and updates via the manager that actually provides it:

```
npm global  →  npm install -g --prefix <node-root> <pkg>@latest   (works with fnm/nvm multi-version)
               └─ if npm rejects the global tree (EUNSUPPORTEDPROTOCOL from an
                  unrelated global package's link:/workspace: spec), the package
                  is installed in isolation: pack → swap → nested deps
brew cask   →  brew upgrade --cask <formula>
brew        →  brew upgrade <formula>
native      →  <agent> update
managed     →  <agent> update   (vendor-owned release store: pi)
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

> **Native Codex on blocked networks** — `codex update` bootstraps its
> installer from `chatgpt.com` and the installer probes `releases.openai.com`;
> where those domains are unreachable the update either fails or (worse)
> *fake-succeeds*: `curl … \| sh` exits 0 when curl delivers nothing. auway
> therefore checks the latest release via the GitHub API first, and when
> `codex update` fails or silently no-ops, retries with the same official
> installer fetched from `raw.githubusercontent.com` and
> `CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false` — script *and* binary
> entirely from GitHub Releases. An update that exits 0 without reaching the
> latest version is reported as failed, never as "up to date".

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
6 agent(s) detected:

AGENT                 VERSION       MANAGER       PATH
Claude Code           2.1.228       native        /Users/me/.local/share/claude/versions/2.1.228
Pi Coding Agent       0.84.1        npm global    /Users/me/.local/share/fnm/node-versions/v24.13.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
OpenCode              1.18.16       native        /Users/me/.opencode/bin/opencode
OpenAI Codex          0.147.0       homebrew      /opt/homebrew/Caskroom/codex/0.147.0/bin/codex
GitHub Copilot CLI    1.0.79        homebrew      /opt/homebrew/Caskroom/copilot-cli/1.0.43/copilot
Grok Build            1.0.13        homebrew      /opt/homebrew/Caskroom/grok-build/1.0.13/grok-1.0.13-macos-aarch64

Pi Extensions (8 packages, 1 update available):
  pi-subagents            0.50.0 → 0.51.0    update
  @feniix/pi-notion       3.0.2              ok
  ...

Claude Plugins (19):
  agent-sdk-dev@claude-plugins-official       1.0.0
  superpowers@claude-plugins-official         6.3.0
  ...

Skills (52 skills (0 git, 52 no update source)):
  (no git-backed skills; plain copies have no update source)

$ auway
Updating 12 item(s) concurrently...
[█████████████████████████] 100% (12/12)  done
✔ Claude Code  up to date (2.1.228)
✔ Pi Coding Agent  up to date (0.84.1)
✔ Pi Extensions  8 packages · 1 outdated → 8 packages
✔ Claude Plugins  19 plugins → 19 plugins · 1 updated
✔ Codex Plugins  5 plugins
✔ OpenCode  up to date (1.18.16)
✔ OpenAI Codex  up to date (0.147.0)
✔ GitHub Copilot CLI  up to date (1.0.79)
✔ Grok Build  1.0.13 → 1.0.24
✔ Grok Plugins  skipped: no grok plugins installed
✔ Skills  up to date (52 skills · 0 git)

Done: 2 updated, 9 up to date, 1 skipped, 0 failed.
```

## Design

- **Zero runtime dependencies** — pure Node built-ins (`child_process`, `fs`, `os`).
  Nothing to audit; no supply-chain surface beyond the CLI itself.
- **Install-manager-aware updates** — the key difference from naive updaters (see above).
- **fnm/nvm multi-version safe** — a package installed under node v24's global root is
  updated via `npm install -g --prefix <that node root>`, not whatever node happens to be
  first in `PATH`.
- **Concurrent updates** — failures in one agent never block the others.
- **Project-local installs are never touched.**

## Adding an agent

Edit `src/agents.ts` (`KNOWN_AGENTS`) — one entry with the binary name, native update
command, npm package and/or brew formula. Detection and manager classification are generic.
Even when the cask name differs from the binary name (Grok: binary `grok`,
cask `grok-build`), the Caskroom path yields the right upgrade target.

Pi extension support lives in `src/pi-extensions.ts` (settings parsing, npm
latest checks, `pi update --extensions` delegation). Claude/Codex/Grok plugin
support lives in `src/agent-plugins.ts` (JSON list parsing, per-agent official
update flows). Local skills live in `src/skills.ts` (git-backed pull,
source-less reporting).

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # tsup → dist/cli.js
node dist/cli.js list
```

## Windows support

On Windows, npm global bins are plain shim scripts (`pi`, `pi.cmd`, `pi.ps1`)
with no `.exe`, and the global store lives at `<nodeRoot>\node_modules\` (no
`lib/` layer). auway handles both: bare command names are resolved to their
full shim path and run through `cmd.exe`, and the resolved `npm root -g` is
used to tell a global install apart from a project-local one. Slow native
installers can be given more time with `AUWAY_TIMEOUT_MS`
(e.g. `AUWAY_TIMEOUT_MS=900000 auway`); the default budget is 10 minutes —
`claude update` was observed dying mid-download at the old 5-minute cap.

npm-installed agents are updated with a staged tarball swap (pack → extract →
directory rename) instead of `npm install -g` — faster, and it skips
completely when the installed version already matches the registry.

**Windows file-locking caveat**: while POSIX lets you replace a running
tool's files in place (inode semantics), Windows locks a tool's native
modules (`.node` DLLs) while it is running — neither the file nor its
containing directory can be renamed or copied, so *no* update tool can hot-
swap it. auway detects this and tells you exactly which process to exit:
`auway update` skips nothing, but e.g. exit pi first, or update the others
with `auway update claude opencode`.

## License

MIT
