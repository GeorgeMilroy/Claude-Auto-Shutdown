# Claude Auto Shutdown

A VS Code extension that shuts down, hibernates, sleeps or locks your computer after every Claude Code session on it, including subagents, has finished. It reads Claude Code's own session files to tell "finished" from "still working", and it keeps the computer on whenever it can't tell. A dashboard shows every session, what is still being waited for, and a countdown you can cancel before anything happens.

The rule underneath everything: **not knowing is never permission to shut down.**

## Quick start (60 seconds)

1. Install the extension: `code --install-extension claude-auto-shutdown-0.1.0.vsix`, or build it yourself (see [Development](#development)).
2. Click the eye icon in the activity bar. The dashboard lists the Claude Code sessions found on this PC and says whether each one is working.
3. Open **Help** at the bottom of the dashboard and pick **Preview the countdown**. This is a 20 second demo of the warning. Press `Esc` to cancel it.
4. Leave **Test run** selected and press **Start test run**. A test run does everything the real thing does, but ends with a message instead of the action. Nothing turns off.
5. Let Claude work and step away. With the default settings a test run passes about 7 minutes after the last session finishes, once you have been away for 10 minutes.
6. When the dashboard says **TEST RUN PASSED**, select **For real** and start again. You are asked to confirm every time.

Keep VS Code open while watching. Closing one window is fine: another window takes over. Quitting VS Code, or closing its last window, stops watching.

## How it decides a session is finished

| What is looked at | Counts as working when |
| --- | --- |
| Session list (`~/.claude/sessions/*.json`) | The entry's process is alive. An entry is dropped only with proof that the process is gone (PID and start time). |
| Last conversation record of the transcript | A tool call is in flight, a tool result is being read, a reply is being written, the context is being compacted, or a record is half written. Only `end_turn` / `stop_sequence` ends a turn, and in a session's own transcript only the main thread's: a subagent finishing there (a sidechain record) does not end the session's turn. |
| Subagent transcripts | One was written in the last 2 minutes (or the quiet time, if longer), or has an open turn and was written in the last 30 minutes. |
| Quiet time | Anything was written in the last `quietSeconds` (default 5 minutes). |
| Commands the session started | A child process is still using the CPU (2 % of a core or more) or the disk (32 KB/s or more). |
| Scheduled wake-up | The session scheduled itself to wake up with the self-paced `/loop`: until that time plus 2 minutes. |
| Scheduled tasks (`/loop 10m …`, reminders) | The session set up a task with CronCreate that has not been cancelled with CronDelete: as long as the session's process runs (for a session in WSL or another system: as long as it is listed), and at most until 7 days and 15 minutes after the task was made, when recurring tasks expire. A one-shot reminder counts the same way, because the extension can't see that it already fired. **Don't wait for this session** lasts only until the session writes again, which a running loop does at its next firing; to let a loop go for good, cancel it in Claude Code. |
| Claude Code processes without a session entry | Such a process keeps this PC on until it exits or you choose **Don't wait for it**. The one exception: while a transcript written since it started is still being waited for (working, just finished or can't tell), that transcript stands in for it and is shown and judged like a session, with a quiet time of at least 2 minutes, so such a process never makes this PC wait less. A transcript that reads as finished does not clear it, because it may belong to any other session. The commands it started are measured like a session's (same busy rule), even after you choose **Don't wait for it** for the process itself; each busy one is listed under it ("… started by an unmatched Claude process") with its own **Don't wait for it**. |

Each session is shown with one of four words: **Working**, **Just finished** (turn ended, quiet time not reached), **Finished**, or **Can't tell**. "Can't tell" counts as working.

With very many sessions (dozens, with long subagent histories) the dashboard may list only some of them, so that what the window in control sends the other windows stays small enough. The rest still count in every check, and the list says how many are not shown. One message between windows is limited to 256 KB; when the shared state is larger, the other windows get a shortened copy: subagent and command lists cut to 3, Claude processes without a session entry to 20, activity to the last 10 entries, scan errors to 10, and finally session rows left out, the ones that keep this PC on kept first. The window in control itself shows every row.

A session that blocks for an ordinary reason (it was never used, a turn was interrupted, it started a dev server) can be skipped by hand: expand the row and choose **Don't wait for this session**. The override is logged, can be undone, and ends by itself when the session writes again.

## Safety gates

- **Test run by default.** A real run is confirmed in a dialog every time you start watching. The dialog's default button is "Keep this PC on".
- **Every check must pass, several times in a row** (default 3 checks, 10 seconds apart) before the countdown starts. The checks in a row are always at least one poll interval apart: **Check again** and **Don't wait for this** clicks update the dashboard and can reset the count, but never count as one of them.
- **A countdown you can cancel** (default 90 seconds): `Esc` while VS Code has the focus, the Cancel button in the dashboard, the status bar item, the notification in every window, and on Windows an always-on-top warning with its own Cancel button. Pressing Cancel on any of them, in any window, while watching always stops watching, also when the countdown had already been cancelled automatically a moment earlier (Emergency stop, mouse or keyboard input, a session going back to work, the window in control closing). A Cancel while not watching does nothing. `Esc` also works while the integrated terminal has the focus: the extension adds its Esc command to `terminal.integrated.commandsToSkipShell` by default, and only while a countdown runs does Esc go to it instead of the shell. If you set `terminal.integrated.commandsToSkipShell` yourself, add `claudeAutoShutdown.cancelCountdownWithEscape` to it: your list replaces the default one.
- **You have to be away** (default 10 minutes without mouse or keyboard input). Input during the countdown cancels it. If input can't be measured, this PC stays on.
- **A final check after the countdown**: a new scan of everything. Any change cancels.
- **Emergency stop**: a file named `STOP` in `~/.claude-auto-shutdown` blocks everything (see below).
- **Unknown never passes.** An unreadable transcript, a process list that can't be read, a session whose state can't be determined: each one keeps this PC on and is shown as "Can't tell".
- **Keep-on list**: programs that keep this PC on while they run.
- **Sleep or a clock change stops watching.** After hours of sleep every "quiet for 5 minutes" check would pass on stale evidence.
- **A settings change stops watching.** The rules in force are the ones you saw when you started. Changing the plan in the editor that pressed Start while the start is still being checked with the operating system refuses the start: "Settings changed. Check the plan and try again."
- **Settings are user settings only.** A workspace can't change them, and they are not synced.
- **One window is in control.** If it closes, another window takes over. If none can, watching stops and the next start says so. If the window in control loses its connection to the other windows while it stays open, watching stops too, and every window says why.
- **Windows trust each other only with a shared secret.** The name of the pipe or socket the windows meet at can be worked out by anyone on this PC; a window that can't prove it knows your secret (see below) is not trusted in either direction.
- **No shortcut.** There is no command to skip or shorten the countdown, and no command takes arguments.
- **While the action runs, every window shows the rules of that run** (test run or real, which action), not the current settings of the window in control.
- **After the action, watching is off.** Waking the PC does not start it again.
- **An action is reported as done only when it is.** A lock, sleep or hibernation the operating system did not confirm is reported as **NOT CONFIRMED**, with a warning, and so is a shutdown after which this PC was still on 2 minutes later. A lock counts as confirmed on Windows when the lock screen (LogonUI) appears within about 3 seconds, and on Linux when logind's `LockedHint` says so; on macOS a lock (the display turning off) is always reported as not confirmed. Sleep and hibernate are confirmed only when this PC was seen to be suspended (a gap in time on resume); on Windows a sleep or hibernate command still running after 25 seconds with no such gap is reported as not confirmed.
- **Messages can't carry links.** Session and folder names, OS error texts and what other windows send are shown as plain text in notifications and dialogs: link syntax in them never becomes a clickable command.

## What this extension runs on your machine

Every program is started by absolute path, with an argument list, without a shell. Programs that read are never the ones that act. The extension makes no network requests and sends no telemetry.

It reads `~/.claude/sessions/*.json` and the tails of `~/.claude/projects/*/*.jsonl` (also in `$CLAUDE_CONFIG_DIR` and in the folders listed in `extraClaudeDirs`). It writes only in `~/.claude-auto-shutdown` (a folder only you can open): `activity.log`, `last-run.json`, `watching.json`, `secret` and, when a Cancel could not be delivered, `STOP`. The VS Code windows of one user talk to each other over a local named pipe (Windows) or a Unix socket in that folder (Linux, macOS). `secret` is a random key created once and readable only by you. Every window proves it knows the key before the others trust it, so another account on this PC can't pose as the window in control and start watching with rules you never saw. If the file can't be read or created, the window doesn't join the others and watching is off in it. The proof is an HMAC of a fresh random nonce, in both directions, so a recorded one can't be replayed. If you delete the folder while windows are open, newer windows create a new key and can't coordinate with the older ones (they show "Can't reach the other windows. Watching is off in this window.", which is safe) until those are reloaded.

### Windows

| Purpose | Command |
| --- | --- |
| Read-only helper (one per machine, while watching or while a dashboard is visible): lists processes, reads start time, CPU and I/O counters of the Claude processes and their children, reads the time since the last input, holds the keep-awake request | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <extension>\resources\win-helper.ps1 -ParentPid <pid> -IdleExitSeconds 120` |
| The same helper when PowerShell runs in Constrained Language mode (no idle time, no keep-awake) | the line above plus `-NoNative`; it then uses `Get-Process` and one `Get-CimInstance Win32_Process` query, and once `whoami.exe /priv /fo csv /nh` to find out whether shutting down is allowed |
| Warning window during the countdown (it counts down to the deadline fixed when the countdown asked for it, rounding down, so it may show a second or two less than the dashboard, never more) | `powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File <extension>\resources\win-countdown-alert.ps1 -Seconds <n> -DeadlineUnixMs <unix ms> -Kind <real\|test\|preview> -ParentPid <pid> [-Sound]` |
| Find running WSL distributions (only when a WSL process is running and `scanWsl` is on) | `%SystemRoot%\System32\wsl.exe -l --running -q` (and `wsl.exe -l -q` if that fails) |
| Shut down | `%SystemRoot%\System32\shutdown.exe /s /t 0 /f` (`/f` only with `forceCloseApps`) |
| Hibernate | `%SystemRoot%\System32\shutdown.exe /h` |
| Sleep | `powershell.exe -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; if ([System.Windows.Forms.Application]::SetSuspendState('Suspend',$false,$false)) { exit 0 } else { exit 1 }"` |
| Lock | `%SystemRoot%\System32\rundll32.exe user32.dll,LockWorkStation` |

### Linux

Processes are read from `/proc` directly. Tools are looked up in `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, `/usr/local/bin` and `/run/current-system/sw/bin`, never through `PATH`.

| Purpose | Command |
| --- | --- |
| Clock ticks per second | `getconf CLK_TCK` |
| Time since the last input (first one that answers) | `busctl --user call org.gnome.Mutter.IdleMonitor /org/gnome/Mutter/IdleMonitor/Core org.gnome.Mutter.IdleMonitor GetIdletime`; `gdbus call --session --dest org.gnome.Mutter.IdleMonitor --object-path /org/gnome/Mutter/IdleMonitor/Core --method org.gnome.Mutter.IdleMonitor.GetIdletime`; `xprintidle` (X11 sessions only); `loginctl show-session auto -p IdleHint -p IdleSinceHint` |
| Is the action allowed without a password | `busctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager CanPowerOff` (or `CanHibernate`, `CanSuspend`) |
| Keep awake while watching | `systemd-inhibit --what=idle:sleep "--who=Claude Auto Shutdown" "--why=Claude Code sessions are still working" cat` |
| Warning during the countdown (names the whole-second deadline, "Planned for HH:MM:SS", stays up until it, and times the last five sounds to it; the same on macOS) | `notify-send -u critical -a "Claude Auto Shutdown" -i dialog-warning -t <ms> -- <title> <text>` and, for the sound, `canberra-gtk-play -i dialog-warning` |
| Shut down | `systemctl poweroff` (`-i` with `forceCloseApps`) |
| Hibernate | `systemctl hibernate` |
| Sleep | `systemctl suspend` |
| Lock | `loginctl lock-session auto`, then `loginctl show-session auto -p LockedHint` to confirm |

### macOS

| Purpose | Command |
| --- | --- |
| Process list | `/bin/ps -axww -o pid= -o ppid= -o lstart= -o time= -o comm=` (and `/bin/ps -ww ... -p <pids>` for single processes) |
| Time since the last input | `/usr/sbin/ioreg -r -c IOHIDSystem -k HIDIdleTime -d 1` |
| Is shutting down allowed (this makes macOS ask for the Automation permission while you are there) | `/usr/bin/osascript -e 'tell application "System Events" to get name'` |
| Keep awake while watching | `/usr/bin/caffeinate -i -w <pid of the extension host>` |
| Warning during the countdown | `/usr/bin/osascript -e 'on run argv' -e 'display notification (item 2 of argv) with title (item 1 of argv)' -e 'end run' <title> <text>` and, for the sound, `/usr/bin/afplay /System/Library/Sounds/Sosumi.aiff` |
| Shut down | `/usr/bin/osascript -e 'tell application "System Events" to shut down'` |
| Sleep | `/usr/bin/pmset sleepnow` |
| Lock (turns the display off; macOS locks only if it is set to ask for the password at once) | `/usr/bin/pmset displaysleepnow` |
| Hibernate | not offered: macOS chooses between sleep and hibernate itself |

## Settings

All settings start with `claudeAutoShutdown.`. They are user settings only (application scope): a workspace or a remote (WSL, SSH, container) can't change them, every window of one editor uses the same ones, and Settings Sync never copies them to or from another computer.

| Setting | Default | Range | Meaning |
| --- | --- | --- | --- |
| `action` | `shutdown` | `shutdown`, `hibernate`, `sleep`, `lock`, `notify` | What happens to this PC once every session has finished. `notify` only shows a message. |
| `testMode` | `true` | | Test run: everything runs as normal, but instead of the action you get a message. |
| `quietSeconds` | `300` | 30 to 3600 | How long every session must have written nothing before it counts as finished. |
| `pollSeconds` | `10` | 5 to 60 | Seconds between checks. |
| `requiredPolls` | `3` | 2 to 10 | Checks in a row that must all agree. |
| `countdownSeconds` | `90` | 15 to 600 | Length of the warning before the action. |
| `requireUserIdle` | `true` | | Only act when you have been away. If that can't be measured, this PC stays on. |
| `userIdleSeconds` | `600` | 30 to 7200 | How long you must have been away. |
| `allowWhenNoSessions` | `false` | | Allow the action when no session was ever seen. Off: wait for one to appear and finish. On: the dashboard says this PC can act even if no session ever appears, and when. |
| `forceCloseApps` | `true` | | Shut down only: close other apps without asking. Unsaved work in them is lost. |
| `guardProcesses` | `[]` | | Keep-on list: process names, wildcards or regular expressions. |
| `watchOnStartup` | `false` | | Start watching when VS Code starts. For real, a warning appears in every window. |
| `countdownSound` | `true` | | Sound at the start of the countdown and in its last 5 seconds. |
| `countdownAlert` | `true` | | Warning outside VS Code during the countdown. |
| `keepAwake` | `true` | | While watching, stop this PC from going to sleep by itself. |
| `waitForChildProcesses` | `true` | | Stay on while a command started by a session is still doing work. |
| `extraClaudeDirs` | `[]` | | Extra Claude config folders to watch. |
| `scanWsl` | `true` | | Windows: also look inside running WSL distributions. |
| `showStatusBar` | `true` | | Show the status bar item. A running countdown is always shown. |

A value outside its range is clamped. A value that can't be understood becomes the default; an unknown `action` becomes `notify`.

## Commands

| Command | What it does |
| --- | --- |
| Open Dashboard / Open Dashboard in Editor | Show the dashboard in the side bar or in an editor tab. |
| Start Watching… | Pick test run, for real or just notify, then start. A real run is confirmed first. |
| Stop Watching | Stop watching. This PC stays on. |
| Cancel Countdown: Keep This PC On | Cancel a running countdown and stop watching (while watching, it stops watching even when no countdown is running). `Esc` does the same while a countdown is running, also in the integrated terminal. |
| Preview the Countdown (20 s) | The demo countdown. |
| Check Again | Scan now. |
| Show Log / Open Log File | The activity log: every change in what was being waited for, with the reason. |
| What Happened Last Time? | The last result on record. |
| Reveal Emergency Stop Folder | Open `~/.claude-auto-shutdown`. |
| Open Settings / Get Started | The settings of this extension; the walkthrough. |

## Emergency stop

Create a file named `STOP` (or `STOP.txt`) in the folder `.claude-auto-shutdown` in your home folder. While it exists:

- watching can't be started,
- a running countdown is cancelled within a second,
- the final check before the action refuses.

It needs no VS Code window: Explorer, a terminal or another computer with access to your home folder will do. Delete the file to allow watching again. If the folder itself can't be read, that counts as "stop is set".

When you press Cancel or Stop watching and the window in control doesn't confirm it within 2 seconds, the extension creates this file for you and tells you. It removes the file again only if it created it and the request was confirmed afterwards.

## Limitations

- **It only works while VS Code is open.** There is no background service. Quitting VS Code stops watching; the next start tells you that it did.
- **WSL**: sessions inside a running WSL distribution are checked through `\\wsl.localhost` by their transcripts only (their processes can't be seen from Windows).
- **A session entry written by another system into a shared Claude folder** (Claude Code in WSL with `~/.claude` linked to the Windows one, a container with a bind mount) is never dropped because this PC has no such process. It is recognised by a working directory starting with `/` or a start time that is no Windows time stamp (on Windows), or a `C:\` style working directory (on Linux and macOS), and judged by its transcript only, like a WSL session. Commands it started can't be measured.
- **Scheduled tasks are found by reading each transcript from the start once**, 8 MB per transcript per check. On a very large transcript a task made in it counts only once that first read is done (about 13 checks for 100 MB after the editor starts); until then the usual turn rules apply.
- **A session resumed into the same transcript by a new Claude process** keeps a task made by the old process (which ended with it) counted until it is cancelled or the 7 days pass.
- **SSH, containers, Codespaces**: Claude sessions there are not visible from this PC. While a VS Code window is connected to one, this PC stays on until you choose **Don't wait for remote windows** in the dashboard.
- **macOS and Linux**: these backends have not been run on real hardware yet. Use test runs. On macOS the dashboard says so.
- **Work outside Claude Code is not seen**: a build in another terminal, a download, a `git push`. Add those programs to the keep-on list (`guardProcesses`).
- **Claude Code started through node or bun** (installed with `npm install`) is only seen through its session entry. If that entry is not in a watched folder (for example a `CLAUDE_CONFIG_DIR` that only its terminal knows), the session is not seen: add that folder to `extraClaudeDirs`.
- **Another account on this PC can take the meeting point first.** It can never start watching, send a state or hand over a watch, but it can keep your windows at "Can't reach the other windows. Watching is off in this window." They try again every 5 seconds until the name is free.
- **The Linux and macOS countdown warning has no Cancel button** (it is a desktop notification). Cancel in VS Code, or move the mouse when "Require me to be away" is on.
- **Locking on macOS** turns the display off; whether that locks depends on the system's password setting.

## Development

```
npm install
npm run build        # bundles dist/extension.js and dist/webview
npm run typecheck
npm test             # unit tests (vitest); no test can run a power command
npm run package      # builds the .vsix
```

Press `F5` in VS Code to start an Extension Development Host. The launch configuration sets `CLAUDE_AUTOSHUTDOWN_NO_POWER=1`, which makes every power action refuse to run, and points the state folder and the leader endpoint at their own locations, so the development host does not join the windows of your installed copy.

Environment variables, honoured only outside production builds (except the first, which always applies):

| Variable | Effect |
| --- | --- |
| `CLAUDE_AUTOSHUTDOWN_NO_POWER=1` | Power actions refuse to run. |
| `CLAUDE_AUTOSHUTDOWN_HOME` | State folder instead of `~/.claude-auto-shutdown`. |
| `CLAUDE_AUTOSHUTDOWN_ENDPOINT` | Name of the leader pipe or socket. |
| `CLAUDE_AUTOSHUTDOWN_TEST_HOME` | Home folder the scanner looks in for `.claude`. |

`node test/e2e/launch.mjs` runs the extension in a throw-away VS Code instance against a synthetic Claude folder (Windows only).

## Credits

This extension is a port, with a new interface, of [kamiljan11/claude-autoshutdown](https://github.com/kamiljan11/claude-autoshutdown), a Python application by Kamil Jan (MIT). The way a finished session is told from a working one comes from that project.

## License

MIT. The full text is in the `LICENSE` file.
