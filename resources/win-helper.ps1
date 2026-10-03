# win-helper.ps1 - Claude Auto Shutdown, Windows platform helper
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads a BOM-less .ps1 as the ANSI code page.
#
# Protocol: one JSON object per line on stdin -> exactly one JSON object per line on stdout.
# Every response line is ASCII-only (non-ASCII is \uXXXX-escaped), so the console code page
# never matters. 64-bit values (FILETIME, CPU 100 ns, I/O bytes) are emitted as JSON STRINGS.
#
# This file contains NO power action (no shutdown / sleep / hibernate / lock). It only reads, with
# one exception: the keepAwake request holds a "system required" power request, which Windows drops
# by itself the moment this process ends.
#
# Tiers:
#   native   - Add-Type C# P/Invoke (OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION), GetLastInputInfo, ...)
#   fallback - cmdlets only (Get-Process). Works in ConstrainedLanguage. idleMs = null, no keepAwake.
#
# The extension stops this process by closing stdin. -ParentPid and -IdleExitSeconds are a second
# line of defence against an orphaned powershell.exe (native tier only).
param(
    [int]$ParentPid = 0,
    [int]$IdleExitSeconds = 0,
    [switch]$NoNative,
    # Diagnostics: run the script the way a WDAC / AppLocker machine would (cmdlets only).
    [switch]$SimulateClm
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:Protocol = 2
$script:KeepAwakeReason = 'Claude Auto Shutdown is waiting for Claude Code sessions to finish'

if ($SimulateClm) { $ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage' }
$script:FullLang = ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage')

if ($script:FullLang) {
    # Belt and braces only: output is ASCII anyway.
    try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
}

$csharp = @'
using System;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class CasNative
{
    const uint PQLI = 0x1000;            // PROCESS_QUERY_LIMITED_INFORMATION - the ONLY access right ever requested
    const uint STILL_ACTIVE = 259;
    const uint TH32CS_SNAPPROCESS = 2;
    const int POWER_REQUEST_SYSTEM_REQUIRED = 1;
    static readonly IntPtr INVALID = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperations; public ulong WriteOperations; public ulong OtherOperations;
        public ulong ReadBytes; public ulong WriteBytes; public ulong OtherBytes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
        public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    // The native REASON_CONTEXT ends in a union; the three trailing fields pad this struct to the
    // size of its larger ("detailed") member so the simple-string form is laid out exactly as declared.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct REASON_CONTEXT
    {
        public uint Version; public uint Flags;
        [MarshalAs(UnmanagedType.LPWStr)] public string SimpleReasonString;
        public uint Unused1; public uint Unused2; public IntPtr Unused3;
    }

    [DllImport("user32.dll", SetLastError = true)] static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long c, out long e, out long k, out long u);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessIoCounters(IntPtr h, out IO_COUNTERS io);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder buf, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT context);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerSetRequest(IntPtr request, int type);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool PowerClearRequest(IntPtr request, int type);
    [DllImport("powrprof.dll")] [return: MarshalAs(UnmanagedType.U1)] static extern bool IsPwrHibernateAllowed();
    [DllImport("powrprof.dll")] [return: MarshalAs(UnmanagedType.U1)] static extern bool IsPwrSuspendAllowed();
    [DllImport("powrprof.dll")] [return: MarshalAs(UnmanagedType.U1)] static extern bool GetPwrCapabilities([Out] byte[] caps);

    // ---- idle -------------------------------------------------------------------------------
    // -1 = unknown. NEVER 0 on failure.
    public static long IdleMs()
    {
        LASTINPUTINFO i = new LASTINPUTINFO();
        i.cbSize = 8;
        if (!GetLastInputInfo(ref i)) return -1;
        return (long)unchecked(GetTickCount() - i.dwTime);   // both 32-bit: wrap-safe subtraction
    }

    // ---- JSON helpers -----------------------------------------------------------------------
    static void Esc(StringBuilder sb, string s)
    {
        if (s == null) { sb.Append("null"); return; }
        sb.Append('"');
        for (int n = 0; n < s.Length; n++)
        {
            char c = s[n];
            if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
            else if (c < 0x20 || c > 0x7e) { sb.Append("\\u").Append(((int)c).ToString("x4")); }
            else sb.Append(c);
        }
        sb.Append('"');
    }

    [ThreadStatic] static StringBuilder pathBuf;

    // Appends ,"st":..,"path":..,"start":..,"cpu":..,"io":..  for one pid.
    //   st = ok      alive, path + times read
    //        partial alive, but a field could not be read (field = null)
    //        exited  handle opened but the process has already exited (zombie object)
    //        denied  process exists but cannot be opened (ERROR_ACCESS_DENIED)   -> UNKNOWN identity
    //        gone    no such pid (ERROR_INVALID_PARAMETER)
    //        error   anything else                                               -> UNKNOWN
    // io (read + write + other bytes transferred) is extra: null when unavailable, never part of st.
    static void AppendDetail(StringBuilder sb, uint pid)
    {
        IntPtr h = OpenProcess(PQLI, false, pid);
        if (h == IntPtr.Zero)
        {
            int err = Marshal.GetLastWin32Error();
            string st = err == 87 ? "gone" : (err == 5 ? "denied" : "error");
            sb.Append(",\"st\":\"").Append(st).Append("\",\"err\":").Append(err);
            return;
        }
        try
        {
            long c, e, k, u; uint code; IO_COUNTERS io;
            bool timesOk = GetProcessTimes(h, out c, out e, out k, out u);
            bool codeOk = GetExitCodeProcess(h, out code);
            bool ioOk = GetProcessIoCounters(h, out io);
            if (pathBuf == null) pathBuf = new StringBuilder(32768);
            pathBuf.Length = 0;
            uint size = 32767;
            bool pathOk = QueryFullProcessImageNameW(h, 0, pathBuf, ref size);
            bool exited = codeOk && code != STILL_ACTIVE;
            string st = exited ? "exited" : ((timesOk && pathOk && codeOk) ? "ok" : "partial");
            sb.Append(",\"st\":\"").Append(st).Append('"');
            sb.Append(",\"path\":"); Esc(sb, pathOk ? pathBuf.ToString(0, (int)size) : null);
            if (timesOk) { sb.Append(",\"start\":\"").Append(c).Append("\",\"cpu\":\"").Append(k + u).Append('"'); }
            else { sb.Append(",\"start\":null,\"cpu\":null"); }
            if (ioOk) { sb.Append(",\"io\":\"").Append(unchecked(io.ReadBytes + io.WriteBytes + io.OtherBytes)).Append('"'); }
            else { sb.Append(",\"io\":null"); }
        }
        finally { CloseHandle(h); }
    }

    static bool ContainsAny(string lowerName, string[] needles)
    {
        if (needles == null) return false;
        for (int i = 0; i < needles.Length; i++)
            if (needles[i].Length > 0 && lowerName.IndexOf(needles[i], StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    // Phase 1: Toolhelp snapshot = pid, ppid, image name for EVERY process, no handle opened.
    // Phase 2: a handle (PQLI only) is opened ONLY for pids in `pids` and names containing one of
    //          `detailNames`. There is deliberately no "detail for everything" switch: opening every
    //          process (lsass.exe included) on every poll is what security tools alert on.
    public static string Snapshot(uint[] pids, string[] detailNames)
    {
        HashSet<uint> asked = new HashSet<uint>();
        if (pids != null) foreach (uint p in pids) asked.Add(p);
        HashSet<uint> unlisted = new HashSet<uint>(asked);
        StringBuilder sb = new StringBuilder(96 * 1024);
        long idle = IdleMs();
        sb.Append("\"idleMs\":"); if (idle < 0) sb.Append("null"); else sb.Append(idle);
        sb.Append(",\"nameStyle\":\"image\",\"processes\":[");
        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID) throw new InvalidOperationException("CreateToolhelp32Snapshot failed, error " + Marshal.GetLastWin32Error());
        int count = 0, opened = 0;
        try
        {
            PROCESSENTRY32W e = new PROCESSENTRY32W();
            e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            bool more = Process32FirstW(snap, ref e);
            while (more)
            {
                uint pid = e.th32ProcessID;
                string name = e.szExeFile ?? "";
                if (count++ > 0) sb.Append(',');
                sb.Append("{\"pid\":").Append(pid).Append(",\"ppid\":").Append(e.th32ParentProcessID).Append(",\"name\":");
                Esc(sb, name);
                unlisted.Remove(pid);
                if (pid != 0 && (asked.Contains(pid) || ContainsAny(name.ToLowerInvariant(), detailNames))) { opened++; AppendDetail(sb, pid); }
                sb.Append('}');
                e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
                more = Process32NextW(snap, ref e);
            }
            int last = Marshal.GetLastWin32Error();
            if (last != 18 /* ERROR_NO_MORE_FILES */ && last != 0) throw new InvalidOperationException("Process32NextW failed, error " + last);
        }
        finally { CloseHandle(snap); }
        // requested pids that are not in the system list at all
        foreach (uint p in unlisted)
        {
            if (count++ > 0) sb.Append(',');
            sb.Append("{\"pid\":").Append(p).Append(",\"name\":null,\"listed\":false");
            if (p == 0) sb.Append(",\"st\":\"gone\",\"err\":87"); else AppendDetail(sb, p);
            sb.Append('}');
        }
        sb.Append("],\"count\":").Append(count).Append(",\"opened\":").Append(opened);
        return sb.ToString();
    }

    public static string Probe(uint[] pids)
    {
        StringBuilder sb = new StringBuilder(1024);
        sb.Append("\"processes\":[");
        for (int i = 0; i < pids.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"pid\":").Append(pids[i]);
            if (pids[i] == 0) sb.Append(",\"st\":\"gone\",\"err\":87"); else AppendDetail(sb, pids[i]);
            sb.Append('}');
        }
        sb.Append(']');
        return sb.ToString();
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool LookupPrivilegeValueW(string system, string name, out long luid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int infoClass, byte[] buf, int len, out int retLen);

    // Is SeShutdownPrivilege PRESENT in this process token? Pure read (TOKEN_QUERY); nothing is enabled or adjusted.
    // 1 = present, 0 = absent, -1 = unknown. Replaces `whoami /priv` (a child process that SOC rules flag as recon).
    public static int ShutdownPrivilege()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x0008 /* TOKEN_QUERY */, out token)) return -1;
        try
        {
            long want;
            if (!LookupPrivilegeValueW(null, "SeShutdownPrivilege", out want)) return -1;
            byte[] buf = new byte[4096];
            int len;
            if (!GetTokenInformation(token, 3 /* TokenPrivileges */, buf, buf.Length, out len)) return -1;
            int count = BitConverter.ToInt32(buf, 0);
            for (int i = 0; i < count; i++)
                if (BitConverter.ToInt64(buf, 4 + i * 12) == want) return 1;   // LUID_AND_ATTRIBUTES = 8 + 4 bytes
            return 0;
        }
        finally { CloseHandle(token); }
    }

    // Read-only power capability queries. Nothing here changes the power state.
    public static string PowerCaps()
    {
        StringBuilder sb = new StringBuilder(256);
        byte[] caps = new byte[256];
        bool ok = GetPwrCapabilities(caps);
        sb.Append("\"hibernateAllowed\":").Append(IsPwrHibernateAllowed() ? "true" : "false");
        sb.Append(",\"suspendAllowed\":").Append(IsPwrSuspendAllowed() ? "true" : "false");
        if (ok)
        {
            sb.Append(",\"s1\":").Append(caps[3] != 0 ? "true" : "false");
            sb.Append(",\"s2\":").Append(caps[4] != 0 ? "true" : "false");
            sb.Append(",\"s3\":").Append(caps[5] != 0 ? "true" : "false");
            sb.Append(",\"s4\":").Append(caps[6] != 0 ? "true" : "false");
            sb.Append(",\"s5\":").Append(caps[7] != 0 ? "true" : "false");
            sb.Append(",\"hiberFilePresent\":").Append(caps[8] != 0 ? "true" : "false");
            sb.Append(",\"fastStartup\":").Append(caps[18] != 0 ? "true" : "false");
            sb.Append(",\"modernStandby\":").Append(caps[20] != 0 ? "true" : "false");
        }
        return sb.ToString();
    }

    // ---- keep awake ---------------------------------------------------------------------------
    // Holds (or releases) a "system required" power request: the PC does not go to sleep by itself
    // while Claude is still working. It never wakes, sleeps or shuts down anything, it is listed by
    // `powercfg /requests`, and Windows releases it as soon as this process ends.
    static IntPtr powerRequest = IntPtr.Zero;
    static bool keepAwakeHeld;

    public static string KeepAwake(bool on, string reason)
    {
        if (on && !keepAwakeHeld)
        {
            if (powerRequest == IntPtr.Zero)
            {
                REASON_CONTEXT context = new REASON_CONTEXT();
                context.Version = 0;   // POWER_REQUEST_CONTEXT_VERSION
                context.Flags = 1;     // POWER_REQUEST_CONTEXT_SIMPLE_STRING
                context.SimpleReasonString = reason;
                IntPtr request = PowerCreateRequest(ref context);
                if (request == IntPtr.Zero || request == INVALID) throw new InvalidOperationException("PowerCreateRequest failed, error " + Marshal.GetLastWin32Error());
                powerRequest = request;
            }
            if (!PowerSetRequest(powerRequest, POWER_REQUEST_SYSTEM_REQUIRED)) throw new InvalidOperationException("PowerSetRequest failed, error " + Marshal.GetLastWin32Error());
            keepAwakeHeld = true;
        }
        else if (!on && keepAwakeHeld)
        {
            if (!PowerClearRequest(powerRequest, POWER_REQUEST_SYSTEM_REQUIRED)) throw new InvalidOperationException("PowerClearRequest failed, error " + Marshal.GetLastWin32Error());
            keepAwakeHeld = false;
        }
        return "\"held\":" + (keepAwakeHeld ? "true" : "false");
    }

    // ---- watchdog: no orphaned powershell.exe -------------------------------------------------
    static long lastTouch = Stopwatch.GetTimestamp();
    public static void Touch() { Interlocked.Exchange(ref lastTouch, Stopwatch.GetTimestamp()); }

    public static void StartWatchdog(int parentPid, int idleExitSeconds)
    {
        Thread t = new Thread(delegate()
        {
            Process parent = null;
            if (parentPid > 0) { try { parent = Process.GetProcessById(parentPid); } catch { Environment.Exit(3); } }
            while (true)
            {
                if (parent != null)
                {
                    bool gone;
                    try { gone = parent.WaitForExit(1000); } catch { gone = true; }
                    if (gone) Environment.Exit(3);
                }
                else Thread.Sleep(1000);
                if (idleExitSeconds > 0)
                {
                    double idle = (Stopwatch.GetTimestamp() - Interlocked.Read(ref lastTouch)) / (double)Stopwatch.Frequency;
                    if (idle > idleExitSeconds) Environment.Exit(4);
                }
            }
        });
        t.IsBackground = true;
        t.Start();
    }
}
'@

# ---------------------------------------------------------------------------------------------
# Tier selection
# ---------------------------------------------------------------------------------------------
$script:Native = $false
$script:NativeError = $null
if ($NoNative) {
    $script:NativeError = 'disabled by -NoNative'
}
else {
    try {
        Add-Type -TypeDefinition $csharp -Language CSharp -ErrorAction Stop
        $script:Native = $true
    }
    catch {
        $script:NativeError = ($_.Exception.Message -split "`n")[0]
    }
}

if ($script:Native -and ($ParentPid -gt 0 -or $IdleExitSeconds -gt 0)) {
    [CasNative]::StartWatchdog($ParentPid, $IdleExitSeconds)
}

# ---------------------------------------------------------------------------------------------
# JSON helpers that only use constructs allowed in ConstrainedLanguage
# ---------------------------------------------------------------------------------------------
function Esc($s) {
    if ($null -eq $s) { return 'null' }
    $t = ([string]$s).Replace('\', '\\').Replace('"', '\"')
    if ($t -match '[^\x20-\x7e]') {
        $o = ''
        foreach ($ch in $t.ToCharArray()) {
            $c = [int]$ch
            if ($c -lt 32 -or $c -gt 126) { $o += ('\u{0:x4}' -f $c) } else { $o += $ch }
        }
        $t = $o
    }
    return '"' + $t + '"'
}

function Test-ContainsAny([string]$lower, $needles) {
    if ($null -eq $needles) { return $false }
    foreach ($n in $needles) { if ($n -and $lower.Contains([string]$n)) { return $true } }
    return $false
}

# ---- fallback tier: Get-Process ------------------------------------------------------------
# NOTE: Process.MainModule (= the .Path script property) opens the target with
# PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. It is therefore requested ONLY for detail rows.
function Get-GpDetail($p) {
    $start = $null; $cpu = $null; $path = $null; $exited = $null; $errs = @()
    try { $start = $p.StartTime.ToFileTimeUtc() } catch { $errs += 'start' }
    try { $cpu = $p.TotalProcessorTime.Ticks } catch { $errs += 'cpu' }
    try { $path = $p.Path } catch { $errs += 'path' }
    if ($null -eq $path -and $errs -notcontains 'path') { $errs += 'path' }
    try { $exited = $p.HasExited } catch { $errs += 'exited' }
    $st = 'ok'
    if ($exited -eq $true) { $st = 'exited' }
    elseif ($null -eq $start -and $null -eq $path) { $st = 'denied' }
    elseif ($errs.Count -gt 0) { $st = 'partial' }
    $j = ',"st":"' + $st + '","path":' + (Esc $path)
    if ($null -ne $start) { $j += ',"start":"' + $start + '"' } else { $j += ',"start":null' }
    if ($null -ne $cpu) { $j += ',"cpu":"' + $cpu + '"' } else { $j += ',"cpu":null' }
    return $j + ',"io":null'
}

# Get-Process has no parent pid in Windows PowerShell 5.1. One WMI query supplies it (about 0.3 s).
# When WMI is unavailable the rows simply carry no ppid, which the client reads as "unknown".
function Get-ParentMap {
    $map = @{}
    try {
        foreach ($c in (Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId -ErrorAction Stop)) {
            $map[[long]$c.ProcessId] = [long]$c.ParentProcessId
        }
    }
    catch { }
    return $map
}

function Get-GpSnapshot($pids, $detailNames) {
    $rows = @()
    $seen = @{}
    $opened = 0
    $parents = Get-ParentMap
    foreach ($p in (Get-Process)) {
        $id = [long]$p.Id
        $seen[$id] = $true
        $name = $p.ProcessName
        $lower = $name.ToLowerInvariant()
        $j = '{"pid":' + $id
        if ($parents.ContainsKey($id)) { $j += ',"ppid":' + $parents[$id] }
        $j += ',"name":' + (Esc $name)
        $detail = ($id -ne 0) -and ((Test-ContainsAny $lower $detailNames) -or ($pids -contains $id))
        if ($detail) { $opened++; $j += (Get-GpDetail $p) }
        $rows += ($j + '}')
    }
    foreach ($id in $pids) {
        if (-not $seen.ContainsKey([long]$id)) { $rows += '{"pid":' + $id + ',"name":null,"listed":false,"st":"gone"}' }
    }
    return '"idleMs":null,"nameStyle":"noext","processes":[' + ($rows -join ',') + '],"count":' + $rows.Count + ',"opened":' + $opened
}

function Get-GpProbe($pids) {
    $rows = @()
    foreach ($id in $pids) {
        $p = $null
        try { $p = Get-Process -Id $id -ErrorAction Stop }
        catch {
            $fq = $_.FullyQualifiedErrorId
            if ($fq -like 'NoProcessFoundForGivenId*') { $rows += '{"pid":' + $id + ',"st":"gone"}' }
            else { $rows += '{"pid":' + $id + ',"st":"error","error":' + (Esc $fq) + '}' }
            continue
        }
        $rows += '{"pid":' + $id + (Get-GpDetail $p) + '}'
    }
    return '"processes":[' + ($rows -join ',') + ']'
}

# ---- capability (read-only) -----------------------------------------------------------------
function Get-Capability($allowWhoami) {
    $priv = 'unknown'
    $privSource = 'none'
    if ($script:Native) {
        $v = [CasNative]::ShutdownPrivilege()
        $privSource = 'token'
        if ($v -eq 1) { $priv = 'present' } elseif ($v -eq 0) { $priv = 'absent' }
    }
    if ($priv -eq 'unknown' -and $allowWhoami) {
        # Only on explicit request: "powershell -> whoami /priv" is a classic recon detection in SOC rule sets.
        try {
            $out = & "$env:SystemRoot\System32\whoami.exe" /priv /fo csv /nh 2>$null
            $privSource = 'whoami'
            if ($LASTEXITCODE -eq 0 -and $out) {
                if (@($out | Where-Object { $_ -like '"SeShutdownPrivilege"*' }).Count -gt 0) { $priv = 'present' } else { $priv = 'absent' }
            }
        }
        catch { }
    }
    $j = '"shutdownPrivilege":"' + $priv + '","privilegeSource":"' + $privSource + '"'
    if ($script:Native) {
        $j += ',"source":"powrprof",' + [CasNative]::PowerCaps()
    }
    else {
        $hib = 'null'
        try {
            $k = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Power' -ErrorAction Stop
            if ($null -ne $k.HibernateEnabled) { if ($k.HibernateEnabled -ne 0) { $hib = 'true' } else { $hib = 'false' } }
            elseif ($null -ne $k.HibernateEnabledDefault) { if ($k.HibernateEnabledDefault -ne 0) { $hib = 'true' } else { $hib = 'false' } }
        }
        catch { }
        $j += ',"source":"registry","hibernateAllowed":' + $hib + ',"suspendAllowed":null'
    }
    return $j
}

# ---------------------------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------------------------
function Invoke-Request($line) {
    $id = 'null'
    try {
        $req = $line | ConvertFrom-Json
        if ($null -ne $req.id) { $id = [string][long]$req.id }
        $op = [string]$req.op
        $pids = @(); if ($null -ne $req.pids) { $pids = @($req.pids | ForEach-Object { [long]$_ } | Where-Object { $_ -ge 0 -and $_ -le 4294967295 }) }
        $detailNames = @(); if ($null -ne $req.detailNames) { $detailNames = @($req.detailNames | ForEach-Object { ([string]$_).ToLowerInvariant() }) }
        $body = $null
        switch ($op) {
            'snapshot' {
                if ($script:Native) { $body = [CasNative]::Snapshot([uint32[]]$pids, [string[]]$detailNames) }
                else { $body = Get-GpSnapshot $pids $detailNames }
            }
            'probe' {
                if ($pids.Count -eq 0) { throw 'pids required' }
                if ($script:Native) { $body = [CasNative]::Probe([uint32[]]$pids) }
                else { $body = Get-GpProbe $pids }
            }
            'idle' {
                $body = '"idleMs":null'
                if ($script:Native) { $v = [CasNative]::IdleMs(); if ($v -ge 0) { $body = '"idleMs":' + $v } }
            }
            'capability' { $body = Get-Capability ($req.allowWhoami -eq $true) }
            'keepAwake' {
                if (-not $script:Native) { throw 'keepAwake needs the native tier' }
                $body = [CasNative]::KeepAwake(($req.on -eq $true), $script:KeepAwakeReason)
            }
            default { throw ('unknown op: ' + $op) }
        }
        return '{"id":' + $id + ',"ok":true,"tier":"' + $script:Tier + '",' + $body + '}'
    }
    catch {
        return '{"id":' + $id + ',"ok":false,"error":' + (Esc (($_.Exception.Message -split "`n")[0])) + '}'
    }
}

$script:Tier = 'fallback-gp'
if ($script:Native) { $script:Tier = 'native' }

$hello = '{"id":0,"ok":true,"hello":true,"protocol":' + $script:Protocol + ',"tier":"' + $script:Tier + '","native":' + $script:Native.ToString().ToLowerInvariant() +
    ',"nativeError":' + (Esc $script:NativeError) + ',"languageMode":"' + $ExecutionContext.SessionState.LanguageMode + '","psVersion":"' + $PSVersionTable.PSVersion.ToString() +
    '","pid":' + $PID + '}'

# STDIN: this script reads requests through the script-scope $input enumerator in BOTH language modes.
# Measured on PS 5.1:
#   * $input streams line by line (1-2 ms latency) and also works in ConstrainedLanguage.
#   * A script-scope reference to $input - even in dead code - makes the host feed stdin to the pipeline,
#     and then [Console]::In.ReadLine() gets nothing. The two readers can NOT be mixed in one file.
#   * With $input, a plain `exit` does not end the process while the parent still holds stdin open.
#     The parent stops the helper by CLOSING STDIN (exits in ~11 ms).
if ($script:FullLang) {
    $stdout = [Console]::Out
    $stdout.Write($hello + "`n"); $stdout.Flush()
    foreach ($line in $input) {
        if ($script:Native) { [CasNative]::Touch() }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $stdout.Write((Invoke-Request $line) + "`n"); $stdout.Flush()
    }
}
else {
    # ConstrainedLanguage: no [Console] method calls allowed -> pipeline output (CRLF line endings).
    $hello
    foreach ($line in $input) {
        if ("$line".Trim().Length -eq 0) { continue }
        Invoke-Request $line
    }
}
exit 0
