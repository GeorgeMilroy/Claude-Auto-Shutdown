# Do a test run

A test run does everything the real thing does: it waits for every session to finish, re-checks, and counts down. At the end you get a message instead of the action. Nothing turns off.

1. Run **Start Watching…** and pick **Test run: PC stays on**.
2. Leave Claude working and step away. A test run takes as long as the real thing: with the default settings, about 7 minutes after the last session finishes, once you have been away for 10 minutes.
3. When you come back, the dashboard says **TEST RUN PASSED** and when this PC would have shut down.

If the dashboard still says **Watching** when you return, the **Waiting for** section says why. The activity log (**Show Log**) keeps a line for every change in what was being waited for.

Keep VS Code open while watching. Closing one window is fine: another window takes over. Quitting VS Code, or closing its last window, stops watching.
