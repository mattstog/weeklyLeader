import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduleTick, parseScheduleTime } from './scheduler.js';

test('runs each Sunday job once across the fall clock and month change', async () => {
  const calls = [];
  const tick = createScheduleTick([
    { hour: 9, minute: 0, run: () => calls.push('check-in') },
    { hour: 13, minute: 50, run: () => calls.push('reminder') },
    { hour: 14, minute: 0, run: () => calls.push('selection') },
  ]);
  for (const date of [
    '2026-10-31T09:00:00-05:00',
    '2026-11-01T01:59:59-05:00', '2026-11-01T01:00:00-06:00',
    '2026-11-01T08:59:59-06:00', '2026-11-01T09:00:00-06:00',
    '2026-11-01T09:00:30-06:00', '2026-11-01T13:50:00-06:00',
    '2026-11-01T14:00:00-06:00',
  ]) await tick(new Date(date));
  assert.deepEqual(calls, ['check-in', 'reminder', 'selection']);
});

test('uses Chicago time across spring DST, year changes, and following weeks', async () => {
  let calls = 0;
  const tick = createScheduleTick([{ hour: 9, minute: 0, run: () => calls++ }]);
  for (const date of ['2026-03-08T14:00:00Z', '2026-11-08T15:00:00Z', '2027-01-03T15:00:00Z']) {
    await tick(new Date(date));
  }
  assert.equal(calls, 3);
});

test('skips the requested Sunday without suppressing the following week or catching up', async () => {
  let calls = 0;
  const tick = createScheduleTick([{ hour: 9, minute: 0, run: () => calls++ }], {
    skipDates: ['2026-11-01'],
  });
  await tick(new Date('2026-11-01T09:00:00-06:00'));
  await tick(new Date('2026-11-08T09:01:00-06:00'));
  assert.equal(calls, 0);
  await tick(new Date('2026-11-15T09:00:00-06:00'));
  assert.equal(calls, 1);
});

test('does not repeat an in-flight or failed job during the same minute', async () => {
  let calls = 0;
  const errors = [];
  const tick = createScheduleTick([{ hour: 9, minute: 0, run: async () => {
    calls++;
    throw new Error('unavailable');
  } }], { onError: error => errors.push(error.message) });
  await Promise.all([tick(new Date('2026-11-08T15:00:00Z')), tick(new Date('2026-11-08T15:00:01Z'))]);
  assert.equal(calls, 1);
  assert.deepEqual(errors, ['unavailable']);
});

test('validates configured times', () => {
  assert.deepEqual(parseScheduleTime('9:00'), { hour: 9, minute: 0 });
  for (const value of ['24:00', '9:60', 'bad']) assert.throws(() => parseScheduleTime(value));
});
