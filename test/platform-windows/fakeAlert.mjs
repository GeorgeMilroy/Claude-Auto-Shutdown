// A stand-in for resources/win-countdown-alert.ps1 for unit tests: same stdout words, no window.
//
//   node fakeAlert.mjs <mode> [file]
//     shown   prints SHOWN and stays until killed
//     cancel  prints SHOWN, then CANCEL twice (a real window can only say it once), and exits
//     fail    writes to stderr and exits with code 1
//     env     writes its CAS_ALERT_* variables and arguments to [file], prints SHOWN, stays
import fs from 'node:fs';

const [mode, file] = process.argv.slice(2);
const stay = () => setInterval(() => undefined, 1000);

if (mode === 'fail') {
  process.stderr.write('The window could not be created.\n');
  process.exit(1);
} else if (mode === 'cancel') {
  process.stdout.write('SHOWN\r\n');
  setTimeout(() => {
    process.stdout.write('CANCEL\r\nCANCEL\r\n');
    setTimeout(() => process.exit(0), 50);
  }, 50);
} else if (mode === 'env') {
  const texts = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('CAS_ALERT_')));
  fs.writeFileSync(file, JSON.stringify({ texts, args: process.argv.slice(4) }));
  process.stdout.write('SHOWN\n');
  stay();
} else {
  process.stdout.write('SHOWN\n');
  stay();
}
