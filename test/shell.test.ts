import { describe, it, expect } from 'vitest';
import { needsShell, quoteArg, shellCommand } from '../src/shell.js';

describe('needsShell', () => {
  it('never needs a shell on POSIX', () => {
    expect(needsShell('linux', 'pi')).toBe(false);
    expect(needsShell('darwin', 'npm')).toBe(false);
  });
  it('spawns real .exe directly on Windows', () => {
    expect(needsShell('win32', 'claude.EXE')).toBe(false);
    expect(needsShell('win32', 'opencode.EXE')).toBe(false);
    expect(needsShell('win32', 'C:\\Program Files\\GitHub CLI\\gh.exe')).toBe(false);
  });
  it('routes extensionless names through the shell on Windows (PATHEXT resolution)', () => {
    expect(needsShell('win32', 'claude')).toBe(true);
  });
  it('routes npm shims (.cmd, extensionless) through the shell on Windows', () => {
    expect(needsShell('win32', 'pi')).toBe(true);
    expect(needsShell('win32', 'npm')).toBe(true);
    expect(needsShell('win32', 'pi.cmd')).toBe(true);
    expect(needsShell('win32', 'C:\\nvm4w\\nodejs\\npm.cmd')).toBe(true);
  });
});

describe('shellCommand', () => {
  it('quotes bin and args for the shell (win32: doubled double quotes)', () => {
    // Path with spaces must stay a single argument. Platform is passed
    // explicitly so the win32 quoting is tested on every OS.
    const s = shellCommand('C:\\Program Files\\npm\\npm.cmd', ['--prefix', 'C:\\x y'], 'win32');
    expect(s).toContain('"C:\\Program Files\\npm\\npm.cmd"');
    expect(s).toContain('"C:\\x y"');
  });
  it('quoteArg escapes embedded quotes (Windows: doubled; POSIX: \\\')', () => {
    expect(quoteArg('a"b', 'win32')).toBe('"a""b"');
    expect(quoteArg("a'b", 'darwin')).toBe(`'a'\\''b'`);
  });
});