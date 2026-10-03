# Changelog

## Unreleased

### Fixed

- Session names, folder names, OS error texts and what other windows send could turn into a clickable command link in a notification or dialog. Every message is now shown with link syntax broken up.
- `Esc` did not cancel the countdown while the integrated terminal had the focus: the key went to the shell. The extension now adds its Esc command to `terminal.integrated.commandsToSkipShell` (a list of your own replaces that default; add `claudeAutoShutdown.cancelCountdownWithEscape` to it).
- A lock, sleep or hibernation the operating system did not confirm was reported as done ("LOCKED"). It is now reported as **NOT CONFIRMED**, with a warning, in the dashboard, the status bar and the notification.
- A window in control that lost its connection to the other windows while still open recorded "the window closed". It now says it lost control.
- With no session listed and "Allow the action when no session was ever seen" on, the dashboard said "I wait for one to appear and finish". It now says this PC can act even if no session ever appears, and when.
- The status bar and the notification showed one second less than the dashboard during a countdown. All three now round the same way.
- A Claude Code process without a session entry could be counted as accounted for by an unrelated transcript, and the commands it started were never measured. It now keeps this PC on until it exits or you choose **Don't wait for it** (unless a transcript written for it is still active), and its busy commands are listed under it, each with its own **Don't wait for it**.
- A recurring task set up with the fixed-interval `/loop 10m …` (CronCreate) was not waited for between its runs. It now is, for as long as the session's process runs and the task has not been cancelled or expired.
- Another account on the same PC could pose as the window in control, because the name of the pipe the windows meet at can be worked out. Windows now prove to each other that they know a per-user secret kept in `~/.claude-auto-shutdown/secret`.
- A shared state too large to send between windows (about 40 sessions with long subagent histories) was not sent at all, and the other windows lost contact. Sessions that do not fit are now left out of the list, still counted in every check, and the list says how many.
- The on-screen warning on Windows could show more time than was really left, because it started counting only once its window appeared. It now counts from the moment it is started.
- A Cancel that reached the window in control just after the countdown had been cancelled automatically (Emergency stop, input, a session going back to work, a change of window in control) was answered as done while watching went on, and the Emergency stop set for it was removed. A Cancel while watching now always stops watching.
- A settings change made in the editor that pressed Start, while the start was still being checked with the operating system, was ignored and the old rules were armed. The start is now refused with "Settings changed. Check the plan and try again."
- Pressing **Check again** or **Don't wait for this** could squeeze the checks in a row into a few seconds. Only checks at least one poll interval apart count now.
- A session entry that Claude Code in WSL or a container wrote into a shared Claude folder was dropped as dead, because its process ID was looked up on this PC. Such an entry is now kept and judged by its transcript.
- A subagent finishing inside a session's own transcript could end the session's turn while the main thread was still working. Only the main thread's records end it now.
- With a quiet time under 2 minutes, a Claude process without a session entry made transcripts written since it started stop keeping this PC on sooner than without it. They now wait at least 2 minutes.
- While the action ran, every window showed the settings of the window in control (for example "Test run finishing…" during a real shutdown started from another editor). They now show the rules of the run in progress.
- A session waiting for a scheduled `/loop` run due now could read "wakes itself up in 0 s". It now reads "a scheduled run is pending", and "next scheduled run in …" otherwise.
- Why a window could not join the others (no readable secret file, an untrusted program holding the meeting point) was logged only at debug level. It is now a warning in the log.

## 0.1.0

First version. A port of [kamiljan11/claude-autoshutdown](https://github.com/kamiljan11/claude-autoshutdown) (Python, MIT) to a VS Code extension, with a new interface.

- Dashboard in the side bar and in an editor tab: every Claude Code session on this PC, what is still being waited for, and the plan.
- Actions: shut down, hibernate, sleep, lock, or just a message.
- Test run by default; a real run is confirmed every time.
- Session state from Claude Code's session list and transcripts, including subagents, commands a session started, scheduled wake-ups, and Claude processes without a session entry.
- "Don't wait for this" for a session, a process or a remote window, logged and reversible.
- Cancellable countdown in every window: dashboard, status bar, notification, `Esc`, and an always-on-top warning on Windows.
- Final check after the countdown; Emergency stop file (`STOP` in `~/.claude-auto-shutdown`).
- One window in control across VS Code, VS Code Insiders and forks; another window takes over when it closes.
- Sessions inside running WSL distributions are checked through `\\wsl.localhost`.
- Developed on Windows 11. The Linux and macOS backends are included but have not been run on real hardware.
