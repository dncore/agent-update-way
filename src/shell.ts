/**
 * Windows command spawn helpers.
 *
 * On POSIX, npm global bins are symlinks and everything is a real executable
 * file. On Windows, npm installs shims (a bare shell script `pi`, `pi.cmd`,
 * `pi.ps1`) instead of symlinks — there is no `pi.exe`. Node's
 * `child_process.execFile` (no shell) can only spawn real executables:
 * `execFile('pi')` → ENOENT, `execFile('pi.cmd')` → EINVAL. The only
 * reliable way to run these is through the shell (`cmd.exe`), which resolves
 * the command via PATHEXT exactly like a user typing in a terminal.
 *
 * We additionally resolve bare command names to their full path before
 * handing them to the shell: with npm@11's `.cmd` shims, letting cmd.exe
 * search the name itself can fail in project dirs (the shim's npm-prefix
 * resolution mis-resolves against the project `node_modules`). Quoted full
 * paths bypass that entirely.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** `which`-style lookup honoring PATH, like a shell would. */
export function which(cmd: string): string | null {
  const isWin = process.platform === 'win32';
  const pathEnv = process.env.PATH ?? '';
  const pathExt = isWin ? (process.env.PATHEXT ?? '').split(';').filter(Boolean) : [];
  for (const dir of pathEnv.split(isWin ? ';' : ':')) {
    if (!dir) continue;
    const full = join(dir, cmd);
    if (isWin) {
      // Windows: prefer PATHEXT candidates (.exe/.cmd/...) over the bare name
      // (an extensionless npm shim script is not directly runnable by cmd).
      for (const ext of pathExt) {
        if (existsSync(`${full}${ext}`)) return `${full}${ext}`;
      }
      if (existsSync(full)) return full;
    } else {
      if (existsSync(full)) return full;
    }
  }
  return null;
}

/**
 * Resolve `bin` to an executable the current platform can actually launch.
 * On Windows this returns the PATHEXT-matched full path (npm `pi`/`npm` shims
 * have no .exe); elsewhere it is the input unchanged.
 */
export function resolveBin(bin: string): string {
  if (process.platform !== 'win32') return bin;
  return which(bin) ?? bin;
}

/** True when `bin` cannot be spawned directly and must run through a shell. */
export function needsShell(platform: NodeJS.Platform, bin: string): boolean {
  if (platform !== 'win32') return false;
  // Real Windows executables spawn fine without a shell.
  if (/\.(exe|com)$/i.test(bin)) return false;
  // Anything else (.cmd/.bat/.ps1, extensionless npm shims) needs cmd.exe.
  return true;
}

/** Quote one argument for the platform's default shell. */
export function quoteArg(arg: string): string {
  if (process.platform === 'win32') {
    // cmd.exe: double quotes; embedded quotes are doubled (no backslash escapes).
    return `"${arg.replace(/"/g, '""')}"`;
  }
  // POSIX shell: single quotes; embedded quotes via '\''.
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Join a bin + args into a single shell command string (for shell: true). */
export function shellCommand(bin: string, args: string[]): string {
  return [bin, ...args].map(quoteArg).join(' ');
}