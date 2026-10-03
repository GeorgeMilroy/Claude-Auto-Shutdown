// Output of the macOS tools as documented (LC_ALL=C TZ=UTC). No Mac was available: these are
// reconstructions of the formats, not captures.

/** `/bin/ps -axww -o pid= -o ppid= -o lstart= -o time= -o comm=` */
export const PS_OUTPUT = [
  '    1     0 Mon Sep 28 10:00:00 2026   5:12.34 /sbin/launchd',
  '  321     1 Mon Sep 28 10:00:05 2026   0:41.07 /usr/libexec/logd',
  '  501     1 Sat Oct  3 09:15:02 2026   0:00.03 /usr/libexec/trustd',
  ' 4242     1 Sat Oct  3 11:00:00 2026   1:02.50 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
  ' 7001  4242 Sat Oct  3 11:30:00 2026   0:12.00 /Users/u/.local/bin/claude',
  ' 7002  7001 Sat Oct  3 11:31:00 2026 123:45.67 /opt/homebrew/bin/node',
  ' 7003     1 Sat Oct  3 11:32:00 2026   0:00.00 (zsh)',
  ' 7004   600 Sat Oct  3 11:33:00 2026   0:00.10 -zsh',
  ' 7005     1 Sat Oct  3 11:34:00 2026   0:01.00 /Applications/Claude.app/Contents/MacOS/Claude',
  '',
].join('\n');

/** `/usr/sbin/ioreg -r -c IOHIDSystem -k HIDIdleTime -d 1` */
export const IOREG_OUTPUT = [
  '+-o IOHIDSystem  <class IOHIDSystem, id 0x100000a4f, registered, matched, active, busy 0 (5 ms), retain 28>',
  '    {',
  '      "IOClass" = "IOHIDSystem"',
  '      "HIDIdleTime" = 66615000000',
  '      "HIDParameters" = {"HIDKeyRepeat"=83333333,"HIDInitialKeyRepeat"=500000000}',
  '      "IOProviderClass" = "IOResources"',
  '    }',
  '',
].join('\n');
