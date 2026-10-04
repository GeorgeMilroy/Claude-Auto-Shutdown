# Changelog

## 0.2.0

- Sessions are judged by Claude Code's own status first: the `status` it writes into each session entry (busy, idle, waiting for your answer). A session that is idle no longer shows as "still working" after an Esc, a local command such as `/model`, a declined permission, or a VS Code panel that was opened and never used. Without a status (an older Claude Code), or when the transcript shows the status is out of date, the transcript decides as before.
- The transcript itself also recognises those three endings in a session's own transcript.
- New setting `waitForAnswers` (on by default): stay on while a session waits for your answer. Off: such a session counts as finished once quiet.
- The dashboard says "needs your answer" for such a session instead of "still working", and shows Claude Code's status in the row details.
- A subagent stopped together with its session's turn no longer counts as working for up to 30 minutes.
- A one-shot reminder counts until it fires (plus 15 minutes), however many days ahead, and no longer keeps this PC on for 7 days after it fired.
- "Don't wait for this session" now also ends when Claude Code's status of the session changes. Overrides set before this version end once, because the key that names a session's state changed.

## 0.1.0

First version. A port of [kamiljan11/claude-autoshutdown](https://github.com/kamiljan11/claude-autoshutdown) (Python, MIT) to a VS Code extension, with a new interface.

- Dashboard in the side bar and in an editor tab: every Claude Code session on this PC, what is still being waited for, and the plan.
- Actions: shut down, hibernate, sleep, lock, or just a message.
- Test run by default; a real run is confirmed every time.
- Session state from Claude Code's session list and transcripts, including subagents, commands a session started, scheduled wake-ups and `/loop` tasks, and Claude processes without a session entry.
- "Don't wait for this" for a session, a process or a remote window, logged and reversible.
- Cancellable countdown in every window: dashboard, status bar, notification, `Esc` (also in the integrated terminal), and an always-on-top warning on Windows.
- Final check after the countdown; Emergency stop file (`STOP` in `~/.claude-auto-shutdown`).
- A lock, sleep or hibernation the operating system did not confirm is reported as **NOT CONFIRMED**.
- One window in control across VS Code, VS Code Insiders and forks; another window takes over when it closes. Windows trust each other only with a per-user secret.
- Sessions inside running WSL distributions are checked through `\\wsl.localhost`; session entries that WSL or a container writes into a shared Claude folder are judged by their transcript.
- Developed on Windows 11. The Linux and macOS backends are included but have not been run on real hardware.
