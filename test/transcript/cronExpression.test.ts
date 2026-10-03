// The next firing of a CronCreate schedule, in local time. Every date here is built in local time
// as well, so the tests mean the same in every time zone.

import { describe, expect, it } from 'vitest';

import { nextCronFire } from '../../src/core/cronExpression';

/** Saturday 3 October 2026, 12:00 local time. */
const SATURDAY_NOON = new Date(2026, 9, 3, 12, 0).getTime();
const WEEK_MS = 7 * 86_400_000;
const local = (month: number, day: number, hour: number, minute: number, year = 2026): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

function next(expression: string, afterMs = SATURDAY_NOON, untilMs = afterMs + WEEK_MS): number | null {
  return nextCronFire(expression, afterMs, untilMs);
}

describe('nextCronFire', () => {
  it.each([
    ['* * * * *', local(10, 3, 12, 1)],
    ['*/10 * * * *', local(10, 3, 12, 10)],
    ['7 * * * *', local(10, 3, 12, 7)],
    ['0 9 * * *', local(10, 4, 9, 0)],
    ['0-30/15 13 * * *', local(10, 3, 13, 0)],
    ['5/20 12 * * *', local(10, 3, 12, 5)],
    ['15,45 * * * *', local(10, 3, 12, 15)],
    ['0 9 * * 1-5', local(10, 5, 9, 0)],
    ['0 9 * * mon', local(10, 5, 9, 0)],
    ['0 9 * oct sun', local(10, 4, 9, 0)],
    ['0 9 * * 7', local(10, 4, 9, 0)],
    ['30 14 5 10 *', local(10, 5, 14, 30)],
  ])('%s fires next at the expected local time', (expression, expected) => {
    expect(next(expression)).toBe(expected);
  });

  it('is strictly after the given time', () => {
    expect(next('0 12 * * *')).toBe(local(10, 4, 12, 0));
    expect(next('* * * * *', SATURDAY_NOON + 30_000)).toBe(local(10, 3, 12, 1));
  });

  it('fires on either day when both day fields are restricted, as every cron does', () => {
    // The 10th of the month, or any Monday: Monday the 5th comes first.
    expect(next('0 9 10 * mon')).toBe(local(10, 5, 9, 0));
    // A restricted day of the month alone must match.
    expect(next('0 9 10 * *', SATURDAY_NOON, SATURDAY_NOON + 30 * 86_400_000)).toBe(local(10, 10, 9, 0));
  });

  it('crosses months and years', () => {
    expect(next('0 0 1 1 *', SATURDAY_NOON, SATURDAY_NOON + 400 * 86_400_000)).toBe(local(1, 1, 0, 0, 2027));
  });

  it('is null when nothing fires before the limit', () => {
    expect(next('30 14 28 2 *')).toBeNull();
    expect(next('0 9 31 2 *', SATURDAY_NOON, SATURDAY_NOON + 800 * 86_400_000)).toBeNull();
  });

  it.each(['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1-2-3 * * * *', '*/5/2 * * * *', 'every ten minutes'])(
    'cannot read %j',
    (expression) => {
      expect(next(expression)).toBeNull();
    },
  );

  it('is null for values that are not an expression or not a time', () => {
    expect(nextCronFire(null as unknown as string, SATURDAY_NOON, SATURDAY_NOON + WEEK_MS)).toBeNull();
    expect(nextCronFire('* * * * *', Number.NaN, SATURDAY_NOON)).toBeNull();
    expect(nextCronFire('* * * * *', SATURDAY_NOON, Infinity)).toBeNull();
  });
});
