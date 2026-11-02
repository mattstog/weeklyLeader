import { parseScheduleTime } from './scheduler.js';

export function localDate(now, timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function meetingDate(now, timezone) {
  const date = new Date(`${localDate(now, timezone)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (7 - date.getUTCDay()) % 7);
  return date.toISOString().slice(0, 10);
}

export function createWeeklyService({ load, save, send, messages, chooseLeader, chooseTopic, env = process.env, now = () => new Date(), scheduleChanged = async () => {} }) {
  let queue = Promise.resolve();
  const timezone = () => env.SCHEDULE_TIMEZONE || 'America/Chicago';
  const settings = config => ({ checkInTime: env.CHECKIN_TIME || '9:00', selectionTime: env.SELECTION_TIME || '14:00', minAttendees: Number(env.MIN_ATTENDEES) || 3, ...config.schedule });
  function week(config) {
    const key = meetingDate(now(), timezone());
    const previous = config.currentWeek || {};
    const previousKey = previous.meetingDate || (previous.date && meetingDate(new Date(previous.date), timezone()));
    if (previousKey !== key) config.currentWeek = { meetingDate: key, date: now().toISOString(), leader: null, topic: null, checkInMessageId: null };
    config.currentWeek.meetingDate = key;
    return config.currentWeek;
  }
  function skipped(w) {
    return w.cancelled === true || (w.skipOverride !== false && (env.SCHEDULE_SKIP_DATES || '').split(',').map(s => s.trim()).includes(w.meetingDate));
  }
  async function attendance(config, w) {
    const list = await messages();
    const match = list.find(m => m.sender_type === 'bot' &&
      (w.checkInMessageId ? String(m.id) === String(w.checkInMessageId) :
        m.text?.includes("Like or react to this message if you're in") &&
        (w.checkInSentAt ? m.created_at >= Math.floor(new Date(w.checkInSentAt).getTime() / 1000) : localDate(new Date(m.created_at * 1000), timezone()) === w.meetingDate)));
    if (!match) return { checkInFound: false, userIds: [], names: [] };
    w.checkInMessageId = match.id;
    const ids = new Set(match.favorited_by || []);
    for (const attachment of match.attachments || []) {
      if (attachment.type === 'emoji') for (const id of attachment.user_ids || []) ids.add(id);
      if (attachment.type === 'reactions') {
        for (const reaction of attachment.reactions || []) for (const id of reaction.user_ids || []) ids.add(id);
      }
    }
    const userIds = [...ids].map(String);
    return { checkInFound: true, userIds, names: userIds.map(id => config.members.find(m => String(m.user_id) === id)?.name || id) };
  }
  function rollback(config, entry) {
    if (!entry || entry.undone) return;
    entry.undone = true;
    const member = config.members.find(m => String(m.user_id) === String(entry.leaderId));
    if (member && !entry.cancelled) {
      member.timesLed = Math.max(0, member.timesLed - 1);
      member.lastLed = [...config.history].reverse().find(e => !e.undone && !e.cancelled && String(e.leaderId) === String(member.user_id))?.date || null;
    }
    if (entry.topic) {
      const index = config.usedTopics.lastIndexOf(entry.topic);
      if (index >= 0) config.usedTopics.splice(index, 1);
    }
  }
  function entryFor(config, w) {
    return [...config.history].reverse().find(e => !e.undone && (e.meetingDate || meetingDate(new Date(e.date), timezone())) === w.meetingDate);
  }
  async function perform(action, args, actor, scheduled) {
    const config = await load();
    const w = week(config);
    const admin = (env.SCHEDULER_ADMIN_USER_IDS || '').split(',').map(s => s.trim()).includes(String(actor?.user_id));
    const readOnly = ['status', 'attendance', 'history'].includes(action);
    const member = config.members.find(m => String(m.user_id) === String(actor?.user_id));
    const leaderTopic = action === 'set_topic' && member && !w.cancelled &&
      (w.leaderId ? String(w.leaderId) === String(member.user_id) : w.leader === member.name);
    if (!scheduled && !readOnly && !admin && !leaderTopic && !(action === 'volunteer' && config.members.some(m => String(m.user_id) === String(actor?.user_id)))) {
      throw new Error('Only a configured scheduler admin can make that change. Members may volunteer themselves, and the current leader may set the topic.');
    }
    if (!scheduled && !readOnly && actor?.id && (config.actionLog || []).some(entry => entry.messageId === actor.id && entry.action === action && entry.arguments === JSON.stringify(args))) return { unchanged: true, reason: 'This request was already applied.', currentWeek: w };
    if (readOnly) return { action, meetingDate: w.meetingDate, currentWeek: w, skipped: skipped(w), timezone: timezone(), schedule: settings(config), members: config.members.map(m => ({ name: m.name, user_id: m.user_id, lastLed: m.lastLed, timesLed: m.timesLed })), topics: config.topics, history: config.history.filter(e => !e.undone).slice(-10), ...(action === 'attendance' ? { attendance: await attendance(config, w) } : {}) };
    if (scheduled && skipped(w)) return { skipped: true, reason: 'This week is skipped or cancelled.' };
    if (['check_in', 'reminder', 'select'].includes(action) && skipped(w)) throw new Error('This week is skipped. Resume it explicitly before sending scheduled messages.');
    let result;
    if (action === 'check_in') {
      if (w.finalized) return { unchanged: true, reason: 'This week is already finalized.' };
      if (w.checkInSentAt || (await attendance(config, w)).checkInFound) return { unchanged: true, reason: 'This week already has a check-in.' };
      await send("👋 Like or react to this message if you're in for this week's meeting!");
      w.checkInSentAt = now().toISOString();
      result = { sent: true };
    } else if (action === 'reminder') {
      if (w.reminderSentAt || w.finalized) return { unchanged: true, reason: 'Already reminded or finalized.' };
      if (!(await attendance(config, w)).checkInFound) throw new Error('No check-in exists for this week. Send the check-in first.');
      await send("⏰ Reminder: Like or react to the check-in message if you're coming to group tonight!");
      w.reminderSentAt = now().toISOString();
      result = { sent: true };
    } else if (action === 'select') {
      if (w.finalized || entryFor(config, w)) return { unchanged: true, reason: 'This week is already finalized.', currentWeek: w };
      const a = await attendance(config, w);
      if (!a.checkInFound) throw new Error('No check-in exists for this week. Old check-ins will not be reused.');
      const enough = a.userIds.length >= settings(config).minAttendees;
      if (!enough) {
        await send(`⚠️ Less than ${settings(config).minAttendees} people reacted. Group is cancelled this week. See you next Sunday!`);
        Object.assign(w, { cancelled: true, leader: null, leaderId: null, topic: null });
        config.history.push({ date: now().toISOString(), meetingDate: w.meetingDate, leader: null, topic: null, attendees: a.userIds.length, cancelled: true });
      } else {
        const leader = w.leaderId ? config.members.find(m => String(m.user_id) === String(w.leaderId)) : chooseLeader(config, a.userIds);
        if (!leader) throw new Error('No eligible leader found. Ask a member to volunteer.');
        const topic = w.topic || chooseTopic(config);
        await send(`📣 This week's leader: @${leader.name}\n\n📖 Topic: ${topic}`, leader);
        leader.lastLed = now().toISOString();
        leader.timesLed += 1;
        if (!config.usedTopics.includes(topic)) config.usedTopics.push(topic);
        Object.assign(w, { leader: leader.name, leaderId: leader.user_id, topic });
        config.history.push({ date: now().toISOString(), meetingDate: w.meetingDate, leader: leader.name, leaderId: leader.user_id, topic, attendees: a.userIds.length, cancelled: false });
      }
      w.finalized = true;
      result = { sent: true };
    } else if (action === 'volunteer' || action === 'set_leader') {
      const id = action === 'volunteer' ? actor.user_id : args.member_id;
      const member = config.members.find(m => String(m.user_id) === String(id));
      if (!member) throw new Error('Choose a registered member by their user ID.');
      if (!admin && w.leader && (w.leaderId ? String(w.leaderId) !== String(id) : w.leader !== member.name)) throw new Error('A leader is already assigned. An admin can reassign them.');
      const entry = entryFor(config, w);
      if (entry && !entry.cancelled && String(entry.leaderId) !== String(id)) {
        rollback(config, entry);
        member.timesLed += 1;
        member.lastLed = now().toISOString();
        config.history.push({ ...entry, date: now().toISOString(), leader: member.name, leaderId: member.user_id, undone: false });
        if (entry.topic && !config.usedTopics.includes(entry.topic)) config.usedTopics.push(entry.topic);
      }
      Object.assign(w, { leader: member.name, leaderId: member.user_id });
      result = { updated: true };
    } else if (action === 'set_topic') {
      const topic = args.topic?.trim();
      if (!topic || topic.length > 200) throw new Error('Provide a topic of 1 to 200 characters.');
      const entry = entryFor(config, w);
      if (entry && !entry.cancelled) {
        const index = config.usedTopics.lastIndexOf(entry.topic);
        if (index >= 0) config.usedTopics.splice(index, 1);
        entry.topic = topic;
        if (!config.usedTopics.includes(topic)) config.usedTopics.push(topic);
      }
      w.topic = topic;
      result = { updated: true };
    } else if (action === 'cancel') {
      if (w.cancelled) return { unchanged: true, reason: 'This week is already cancelled.' };
      rollback(config, entryFor(config, w));
      Object.assign(w, { cancelled: true, finalized: true, leader: null, leaderId: null, topic: null });
      config.history.push({ date: now().toISOString(), meetingDate: w.meetingDate, leader: null, topic: null, attendees: 0, cancelled: true });
      result = { updated: true, reason: 'Remaining scheduled messages are cancelled for this week.' };
    } else if (action === 'resume') {
      const entry = entryFor(config, w);
      if (entry?.cancelled) rollback(config, entry);
      Object.assign(w, { cancelled: false, skipOverride: false, finalized: Boolean(entry && !entry.cancelled) });
      result = { updated: true, reason: 'This week is enabled. Missed times will not be replayed.' };
    } else if (action === 'undo') {
      const entry = [...config.history].reverse().find(e => !e.undone);
      if (!entry) throw new Error('No active history entry to undo.');
      rollback(config, entry);
      if ((entry.meetingDate || meetingDate(new Date(entry.date), timezone())) === w.meetingDate) Object.assign(w, { leader: null, leaderId: null, topic: null, finalized: false, cancelled: false });
      result = { updated: true, undone: entry };
    } else if (action === 'set_schedule') {
      const schedule = settings(config);
      if (args.check_in_time !== null && args.check_in_time !== undefined) { parseScheduleTime(args.check_in_time); schedule.checkInTime = args.check_in_time; }
      if (args.selection_time !== null && args.selection_time !== undefined) { parseScheduleTime(args.selection_time); schedule.selectionTime = args.selection_time; }
      if (args.min_attendees !== null && args.min_attendees !== undefined) {
        if (!Number.isInteger(args.min_attendees) || args.min_attendees < 1 || args.min_attendees > config.members.length) throw new Error('Attendance threshold must be between 1 and the member count.');
        schedule.minAttendees = args.min_attendees;
      }
      config.schedule = schedule;
      result = { updated: true, schedule };
    } else throw new Error(`Unknown scheduler action: ${action}`);
    config.actionLog = [...(config.actionLog || []), { date: now().toISOString(), action, actorId: scheduled ? 'scheduler' : String(actor.user_id), messageId: actor?.id || null, arguments: JSON.stringify(args) }].slice(-200);
    await save(config);
    if (action === 'set_schedule') await scheduleChanged();
    return { action, ...result, currentWeek: w, skipped: skipped(w) };
  }
  return {
    settings,
    execute(action, args = {}, actor = null, scheduled = false) {
      const result = queue.then(() => perform(action, args, actor, scheduled));
      queue = result.catch(() => {});
      return result;
    },
  };
}
