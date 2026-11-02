import test from 'node:test';
import assert from 'node:assert/strict';
import { observeSchedulerMessage } from './scheduler-observer.js';
import { createWeeklyService } from './weekly-service.js';
const now = new Date('2026-11-02T00:40:00Z');
const message = (text, time = '2026-11-01T19:39:14Z', id = text) => ({ id, text, user_id: 'peter', sender_type: 'user', created_at: new Date(time).getTime() / 1000 });

test('records Peter’s exact two-message update without mentions, replies, or sends', async () => {
  let config = { members: [{ name: 'Peter Dempsey', user_id: 'peter', timesLed: 0, lastLed: null }], topics: ['Injuries'], usedTopics: [], history: [], currentWeek: { date: '2026-10-25T14:00:00Z', leader: 'Peter Dempsey', topic: 'Injuries' } };
  const service = createWeeklyService({ load: async () => structuredClone(config), save: async c => { config = c; }, send: async () => assert.fail('Must not send messages'), messages: async () => [], now: () => now, env: { SCHEDULE_SKIP_DATES: '2026-11-01' } });
  const options = { now, timezone: 'America/Chicago' };
  await observeSchedulerMessage(service, message('I can lead tonight', '2026-11-01T18:08:06Z'), options);
  assert.equal(await observeSchedulerMessage(service, message('Word forthcoming', '2026-11-01T18:08:19Z'), options), null);
  const word = message('Word is provision');
  await observeSchedulerMessage(service, word, options);
  await observeSchedulerMessage(service, word, options);
  assert.equal(config.currentWeek.meetingDate, '2026-11-01');
  assert.equal(config.currentWeek.leader, 'Peter Dempsey');
  assert.equal(config.currentWeek.topic, 'provision');
  assert.equal(config.actionLog.length, 2);
  assert.equal((await service.execute('status')).skipped, true);
  assert.equal(config.members[0].timesLed, 0);
  await assert.rejects(service.execute('set_topic', { topic: 'other' }, { user_id: 'someone else' }), /Only a configured/);
});

test('ignores questions, placeholders, old weeks, bots, quoted and ambiguous remarks', async () => {
  const service = { execute: () => assert.fail('Must not change state') };
  for (const text of ['Word forthcoming', 'Word is TBD', 'Word is coming soon', 'What is the word?', 'Word is provision?', 'Peter says word is provision', 'I can lead next week', 'Maybe I can lead tonight', '"Word is provision"']) {
    assert.equal(await observeSchedulerMessage(service, message(text), { now }), null);
  }
  assert.equal(await observeSchedulerMessage(service, message('Word is old', '2026-10-25T19:00:00Z'), { now }), null);
  assert.equal(await observeSchedulerMessage(service, { ...message('Word is provision'), sender_type: 'bot' }, { now }), null);
});
