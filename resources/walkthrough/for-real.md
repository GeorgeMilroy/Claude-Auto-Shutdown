# Use it for real, and know the brake

Pick **For real** in the dashboard, or in **Start Watching…**. You are asked to confirm every time: the dialog states the rules in force and what will happen to this PC. Its default button is **Keep this PC on**.

What is never seen: work outside Claude Code (a build in another terminal, a download, a `git push`). Add such programs to the keep-on list (`claudeAutoShutdown.guardProcesses`) so they keep this PC on while they run.

## Emergency stop

A file named `STOP` (or `STOP.txt`) in the folder `.claude-auto-shutdown` in your home folder blocks everything:

- watching can't be started while it exists
- a running countdown is cancelled within a second
- the final check before the action looks for it once more

It works from anywhere: Explorer, a terminal, another computer with access to your home folder. Delete the file to allow watching again.

If you press Cancel or Stop watching and the window in control doesn't answer within 2 seconds, the extension creates this file for you and says so.
