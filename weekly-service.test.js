import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeeklyService } from './weekly-service.js';

function fixture(options = {}) {
  let config = { topics: ['Hope', 'Faith'], usedTopics: [], members: [
    { user_id: '1', name: 'Matt', timesLed: 0, lastLed: null },
    { user_id: '2', name: 'Peter', timesLed: 0, lastLed: null },
  ], history: [], currentWeek: { date: '2026-10-25T14:00:00Z', leader: 'Old leader', topic: 'Old topic' } };
  const sent = [];
  let scheduled = 0;
  let now = new Date('2026-11-08T15:00:00Z');
  const list = [{ id: 'current', sender_type: 'bot', text: "Like or react to this message if you're in", created_at: now.getTime() / 1000, favorited_by: ['1'], attachments: [{ type: 'emoji', user_ids: ['2'] }] }];
  const service = createWeeklyService({
    load: async () => structuredClone(config), save: async c => { config = structuredClone(c); },
    send: async (...args) => sent.push(args), messages: async () => list,
    chooseLeader: c => c.members[0], chooseTopic: () => 'Hope',
    now: () => now, env: { SCHEDULER_ADMIN_USER_IDS: '1', MIN_ATTENDEES: '2', ...options },
    scheduleChanged: async () => scheduled++,
  });
  return { service, sent, list, config: () => config, scheduled: () => scheduled, setNow: value => { now = new Date(value); } };
}
const admin = { user_id: '1', id: 'admin-message' };
const peter = { user_id: '2', id: 'peter-message' };

test('chat state clears last week and reads current emoji attendance', async () => {
  const f = fixture();
  const status = await f.service.execute('status');
  assert.equal(status.currentWeek.leader, null);
  assert.equal(status.meetingDate, '2026-11-08');
  const a = await f.service.execute('attendance');
  assert.deepEqual(a.attendance.names, ['Matt', 'Peter']);
});

test('a volunteer and custom topic are respected by scheduled selection and rotation', async () => {
  const f = fixture();
  await f.service.execute('volunteer', {}, peter);
  await f.service.execute('set_topic', { topic: 'Brotherhood' }, admin);
  await f.service.execute('select', {}, null, true);
  await f.service.execute('select', {}, null, true);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][0], /Peter.*\n\n.*Brotherhood/);
  assert.equal(f.config().history.length, 1);
  assert.equal(f.config().members[1].timesLed, 1);
});

test('admin reassignments and undo preserve leader counts and history', async () => {
  const f = fixture();
  await f.service.execute('select', {}, null, true);
  await f.service.execute('set_leader', { member_id: '2' }, admin);
  await f.service.execute('set_topic', { topic: 'Faith' }, admin);
  assert.deepEqual(f.config().members.map(m => m.timesLed), [0, 1]);
  assert.deepEqual(f.config().usedTopics, ['Faith']);
  await f.service.execute('undo', {}, admin);
  assert.deepEqual(f.config().members.map(m => m.timesLed), [0, 0]);
  assert.deepEqual(f.config().usedTopics, []);
  assert.equal(f.config().currentWeek.leader, null);
});

test('skip survives restart; all sends are blocked until explicit admin resume', async () => {
  const f = fixture({ SCHEDULE_SKIP_DATES: '2026-11-08' });
  for (const action of ['check_in', 'reminder', 'select']) {
    assert.equal((await f.service.execute(action, {}, null, true)).skipped, true);
    await assert.rejects(f.service.execute(action, {}, admin), /Resume/);
  }
  await f.service.execute('resume', {}, admin);
  await f.service.execute('select', {}, null, true);
  assert.equal(f.sent.length, 1);
});

test('cancellation suppresses jobs and resume leaves later weeks unaffected', async () => {
  const f = fixture();
  await f.service.execute('cancel', {}, admin);
  await f.service.execute('reminder', {}, null, true);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.service.execute('status')).skipped, true);
  await f.service.execute('resume', {}, admin);
  assert.equal((await f.service.execute('status')).skipped, false);
  f.setNow('2026-11-15T15:00:00Z');
  assert.equal((await f.service.execute('status')).skipped, false);
});

test('old check-ins are never selected; concurrent check-ins and reminders are deduplicated', async () => {
  const f = fixture();
  f.list[0].created_at -= 604800;
  await assert.rejects(f.service.execute('select', {}, admin), /Old check-ins/);
  await Promise.all([f.service.execute('check_in', {}, admin), f.service.execute('check_in', {}, admin)]);
  assert.equal(f.sent.length, 1);
  f.list[0].created_at += 604800;
  await Promise.all([f.service.execute('reminder', {}, admin), f.service.execute('reminder', {}, admin)]);
  assert.equal(f.sent.length, 2);
});

test('server enforces admin actions and validates recurring settings', async () => {
  const f = fixture();
  for (const action of ['cancel', 'resume', 'set_leader', 'set_topic', 'select', 'reminder', 'check_in', 'undo', 'set_schedule']) {
    await assert.rejects(f.service.execute(action, {}, peter), /Only a configured/);
  }
  await assert.rejects(f.service.execute('volunteer', {}, { user_id: 'outsider' }), /Only a configured/);
  await assert.rejects(f.service.execute('set_schedule', { check_in_time: '25:00' }, admin), /Invalid/);
  await f.service.execute('set_schedule', { check_in_time: '10:00', selection_time: '15:00', min_attendees: 1 }, admin);
  assert.equal(f.scheduled(), 1);
  const status = await f.service.execute('status');
  assert.deepEqual(status.schedule, { checkInTime: '10:00', selectionTime: '15:00', minAttendees: 1 });
});

test('insufficient attendance cancels only once', async () => {
  const f = fixture();
  f.list[0].attachments = [];
  await f.service.execute('select', {}, null, true);
  await f.service.execute('select', {}, null, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.config().history[0].cancelled, true);
});

test('saved action receipts prevent a repeated webhook after a restart from undoing more history', async () => {
  const f = fixture();
  await f.service.execute('select', {}, null, true);
  await f.service.execute('undo', {}, admin);
  const result = await f.service.execute('undo', {}, admin);
  assert.equal(result.unchanged, true);
});
