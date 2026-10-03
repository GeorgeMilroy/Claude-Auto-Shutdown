// When a scheduled task (CronCreate) fires next, for the "wakes up in ..." the UI shows. Only ever
// used for that text: whether a task keeps the PC on does not depend on reading its schedule.
//
// Standard 5-field cron in local time: "minute hour day-of-month month day-of-week", with
// '*', lists (1,15), ranges (1-5), steps (*/10, 0-30/5) and three-letter names (jan, mon).

const MINUTE_MS = 60_000;
/** The walk below skips whole months, days and hours; this only stops an expression gone wrong. */
const MAX_STEPS = 100_000;

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  min: number;
  max: number;
  /** Names for the values from `min` on. */
  names: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59, names: [] },
  { min: 0, max: 23, names: [] },
  { min: 1, max: 31, names: [] },
  { min: 1, max: 12, names: MONTH_NAMES },
  // 7 is Sunday as well.
  { min: 0, max: 7, names: DAY_NAMES },
];

interface Schedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Both day fields are restricted: then either one matching is enough (as in every cron). */
  eitherDay: boolean;
}

function valueOf(text: string, spec: FieldSpec): number | null {
  const named = spec.names.indexOf(text.toLowerCase());
  if (named >= 0) return spec.min + named;
  return /^\d{1,2}$/.test(text) ? Number(text) : null;
}

/** The values one comma-separated part stands for; null when it is not valid. */
function partValues(part: string, spec: FieldSpec): number[] | null {
  const [range = '', stepText, extra] = part.split('/');
  if (extra !== undefined) return null;
  const step = stepText === undefined ? 1 : /^\d{1,2}$/.test(stepText) ? Number(stepText) : 0;
  if (step < 1) return null;
  let from = spec.min;
  let to = spec.max;
  if (range !== '*') {
    const [first = '', last, more] = range.split('-');
    const start = valueOf(first, spec);
    // "5/15" means from 5 to the end, every 15.
    const end = last === undefined ? (stepText === undefined ? start : spec.max) : valueOf(last, spec);
    if (more !== undefined || start === null || end === null) return null;
    from = start;
    to = end;
  }
  if (from < spec.min || to > spec.max || from > to) return null;
  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

function fieldValues(text: string, spec: FieldSpec): Set<number> | null {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const found = partValues(part, spec);
    if (found === null) return null;
    for (const value of found) values.add(value);
  }
  return values;
}

/** null when the expression is not a 5-field cron expression this module understands. */
function parseCron(expression: unknown): Schedule | null {
  if (typeof expression !== 'string') return null;
  const texts = expression.trim().split(/\s+/);
  if (texts.length !== FIELDS.length) return null;
  const sets = texts.map((text, index) => fieldValues(text, FIELDS[index] as FieldSpec));
  const [minutes, hours, days, months, weekdays] = sets;
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (weekdays.delete(7)) weekdays.add(0);
  const restricted = (text: string | undefined): boolean => text !== undefined && !text.startsWith('*');
  return { minutes, hours, days, months, weekdays, eitherDay: restricted(texts[2]) && restricted(texts[4]) };
}

function dayMatches(schedule: Schedule, date: Date): boolean {
  const day = schedule.days.has(date.getDate());
  const weekday = schedule.weekdays.has(date.getDay());
  return schedule.eitherDay ? day || weekday : day && weekday;
}

/** Where to look next from `date`, which does not match: the start of the next month, day, hour or minute. */
function nextCandidate(schedule: Schedule, date: Date): number {
  const [year, month, day, hour] = [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()];
  if (!schedule.months.has(month + 1)) return new Date(year, month + 1, 1).getTime();
  if (!dayMatches(schedule, date)) return new Date(year, month, day + 1).getTime();
  if (!schedule.hours.has(hour)) return new Date(year, month, day, hour + 1).getTime();
  return date.getTime() + MINUTE_MS;
}

/**
 * The first minute after `afterMs` and no later than `untilMs` at which the expression fires, in
 * this machine's local time; null when there is none or the expression cannot be read.
 */
export function nextCronFire(expression: string, afterMs: number, untilMs: number): number | null {
  const schedule = parseCron(expression);
  if (schedule === null || !Number.isFinite(afterMs) || !Number.isFinite(untilMs)) return null;
  let at = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let steps = 0; at <= untilMs && steps < MAX_STEPS; steps++) {
    const date = new Date(at);
    const matches =
      schedule.months.has(date.getMonth() + 1) &&
      dayMatches(schedule, date) &&
      schedule.hours.has(date.getHours()) &&
      schedule.minutes.has(date.getMinutes());
    if (matches) return at;
    // A clock change can make the next local hour or day start "earlier"; the walk only moves on.
    at = Math.max(nextCandidate(schedule, date), at + MINUTE_MS);
  }
  return null;
}
