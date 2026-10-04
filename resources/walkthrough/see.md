# See what it sees

The dashboard lists every Claude Code session found on this PC and gives each one of four words:

| Word | Meaning |
| --- | --- |
| **Working** | Claude Code says the session is busy or needs your answer, or its turn is still open: a tool is running, a result is being read, a subagent is active. |
| **Just finished** | The turn ended, but less than the quiet time ago. |
| **Finished** | The turn ended and nothing has been written for the quiet time. |
| **Can't tell** | Something could not be read. It counts as working. |

Above the sessions, **Waiting for** names what still keeps this PC on: Claude, you, this PC, or the final re-check.

Nothing happens to this PC while you only look. The extension starts checking when the dashboard is visible and stops when you close it, unless you have started watching.

Sessions inside WSL are read through `\\wsl.localhost`. Sessions reached over SSH, in a container or in a Codespace can't be seen from here.
