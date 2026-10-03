# Preview the countdown

The preview is a 20 second demo of the warning you get before anything happens to this PC. It is labelled **PREVIEW** everywhere and never turns anything off.

During a countdown you will see:

- the dashboard, with one button: **Cancel**
- a notification in every VS Code window, with a Cancel button
- the status bar item, which cancels when you click it
- on Windows, a small always-on-top window with a Cancel button, so the warning reaches you outside VS Code

Ways to cancel:

- press `Esc` while VS Code has the focus, also in its terminal (if you set `terminal.integrated.commandsToSkipShell` yourself, add `claudeAutoShutdown.cancelCountdownWithEscape` to it)
- press any of the Cancel buttons
- during a real countdown with "Require me to be away" on: move the mouse or type

There is no way to make a countdown go faster or to skip it.
