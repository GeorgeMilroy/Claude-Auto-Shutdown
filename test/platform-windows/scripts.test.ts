// Static checks of the two PowerShell scripts that ship in resources/.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALERT_SCRIPT, HELPER_SCRIPT } from './support';

const SCRIPTS = [HELPER_SCRIPT, ALERT_SCRIPT];

/** The script without its PowerShell comment lines (they explain what the code must NOT do). */
function codeOf(script: string): string {
  return fs
    .readFileSync(script, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** Anything that turns off, suspends, restarts or locks a PC, by any of its usual names. */
const POWER_APIS = [
  'shutdown.exe',
  'Stop-Computer',
  'Restart-Computer',
  'SetSuspendState',
  'ExitWindowsEx',
  'InitiateSystemShutdown',
  'InitiateShutdown',
  'NtShutdownSystem',
  'LockWorkStation',
  'rundll32',
  'psshutdown',
  'Win32Shutdown',
  'logoff',
  'tsdiscon',
];

describe('PowerShell scripts', () => {
  for (const script of SCRIPTS) {
    const name = path.basename(script);

    // Windows PowerShell 5.1 reads a BOM-less script as the ANSI code page: one non-ASCII character
    // and the script means something else on a PC with another code page.
    it(`${name} is pure ASCII without a byte-order mark`, () => {
      const bytes = fs.readFileSync(script);
      const offenders: string[] = [];
      let line = 1;
      for (const byte of bytes) {
        if (byte === 0x0a) line++;
        const printable = byte >= 0x20 && byte <= 0x7e;
        if (!printable && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) offenders.push(`line ${line}: 0x${byte.toString(16)}`);
      }
      expect(offenders).toEqual([]);
      expect(bytes.length).toBeGreaterThan(500);
    });

    it(`${name} contains no power action`, () => {
      const text = fs.readFileSync(script, 'utf8').toLowerCase();
      for (const api of POWER_APIS) expect(text.includes(api.toLowerCase()), api).toBe(false);
    });

    it(`${name} is not fed through the console reader`, () => {
      const text = codeOf(script);
      expect(text).not.toMatch(/\[Console\]::In\b/);
      expect(text).not.toMatch(/Read-Host/);
    });
  }

  it('the screen-capture tool of the opt-in live test is pure ASCII too', () => {
    const bytes = fs.readFileSync(path.join(__dirname, 'capture-region.ps1'));
    expect([...bytes].filter((byte) => (byte < 0x20 || byte > 0x7e) && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)).toEqual([]);
  });

  it('the helper reads requests only through $input and never exits on request', () => {
    const text = codeOf(HELPER_SCRIPT);
    expect(text).toMatch(/foreach \(\$line in \$input\)/);
    expect(text).not.toMatch(/'exit'\s*\{/);
  });

  it('the helper opens processes with PROCESS_QUERY_LIMITED_INFORMATION only and has no "detail for all" switch', () => {
    const text = codeOf(HELPER_SCRIPT);
    const accessMasks = [...text.matchAll(/OpenProcess\(([^,]+),/g)].map((match) => match[1]?.trim());
    expect(accessMasks).toEqual(['uint access', 'PQLI']);
    expect(text).toMatch(/const uint PQLI = 0x1000;/);
    expect(text).not.toMatch(/detailAll/);
    expect(text).not.toMatch(/MainModule/);
  });

  it('the alert script compiles nothing and does not read stdin', () => {
    const text = codeOf(ALERT_SCRIPT);
    expect(text).not.toMatch(/-TypeDefinition|-MemberDefinition|DllImport/);
    expect(text).not.toMatch(/\$input\b/);
    const addTypes = [...text.matchAll(/^Add-Type (.+)$/gm)].map((match) => match[1]);
    expect(addTypes).toEqual(['-AssemblyName System.Windows.Forms', '-AssemblyName System.Drawing']);
  });

  it('the alert script touches neither files, the registry nor the network', () => {
    const text = codeOf(ALERT_SCRIPT);
    expect(text).not.toMatch(/Set-Content|Add-Content|Out-File|Remove-Item|New-Item|Set-ItemProperty|Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|Start-Process|Invoke-Expression|\biex\b/i);
  });

  it('the alert script counts down to the deadline it is given, on the clock, and never rounds up', () => {
    const text = codeOf(ALERT_SCRIPT);
    expect(text).toMatch(/\[long\]\$DeadlineUnixMs = 0/);
    expect(text).toMatch(/\[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\)/);
    // A stopwatch started when the window appears would ignore the seconds spent starting it.
    expect(text).not.toMatch(/Stopwatch|Ceiling/);
  });

  it.skipIf(process.platform !== 'win32')("the alert script's countdown arithmetic (its two pure functions, run on their own)", () => {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Only the function definitions are taken out of the parsed script; no window is ever created.
    const command = [
      '$tokens = $null; $errors = $null;',
      '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CAS_ALERT_FILE, [ref]$tokens, [ref]$errors);',
      '$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true);',
      "foreach ($name in @('Get-AlertDeadline', 'Get-SecondsLeft')) {",
      '  $fn = $functions | Where-Object { $_.Name -eq $name } | Select-Object -First 1;',
      "  if ($null -eq $fn) { 'MISSING ' + $name; exit 1 }",
      '  . ([ScriptBlock]::Create($fn.Extent.Text))',
      '}',
      '@((Get-SecondsLeft 100000 73400), (Get-SecondsLeft 100000 74000), (Get-SecondsLeft 100000 99001),',
      ' (Get-SecondsLeft 100000 100000), (Get-SecondsLeft 100000 104999),',
      " (Get-AlertDeadline 50000 1000 90), (Get-AlertDeadline 0 1000 90), (Get-AlertDeadline 999999 1000 90)) -join ','",
    ].join(' ');
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 30_000,
      cwd: path.dirname(powershell),
      env: { ...process.env, CAS_ALERT_FILE: ALERT_SCRIPT },
    });
    // 26.6 s left shows 26; under one second shows 0; past the deadline never goes negative.
    // The deadline given is kept, unless it is missing or later than -Seconds from now.
    expect(result.stdout.toString('utf8').trim()).toBe('26,26,0,0,0,50000,91000,91000');
    expect(result.status).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('both scripts parse without a syntax error (parsed, not run)', () => {
    const root = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // The parser only builds the syntax tree; nothing in the scripts is executed.
    const command =
      "$failed = $false; foreach ($file in ($env:CAS_PARSE_FILES -split '\\|')) { $tokens = $null; $errors = $null; " +
      '[void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors); ' +
      'if ($errors.Count -gt 0) { $failed = $true; foreach ($e in $errors) { "$file : $($e.Extent.StartLineNumber): $($e.Message)" } } }; ' +
      "if ($failed) { exit 1 } else { 'PARSE-OK' }";
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 30_000,
      cwd: path.dirname(powershell),
      env: { ...process.env, CAS_PARSE_FILES: SCRIPTS.join('|') },
    });
    expect(result.stdout.toString('utf8').trim()).toBe('PARSE-OK');
    expect(result.status).toBe(0);
  });
});
