import { meetingDate } from './weekly-service.js';

// Clear first-person updates bypass the conversational reply gate and cooldown.
// They update state silently and never enable a skipped week's messages.
export async function observeSchedulerMessage(service, message, {
  now = new Date(), timezone = process.env.SCHEDULE_TIMEZONE || 'America/Chicago',
} = {}) {
  if (!message?.id || message.sender_type !== 'user' || !message.user_id || !message.created_at) return null;
  const posted = new Date(message.created_at * 1000);
  if (posted > now || meetingDate(posted, timezone) !== meetingDate(now, timezone)) return null;
  const text = (message.text || '').trim();
  if (/^(?:I can lead|I'll lead|I’ll lead|I will lead|I can take the lead)(?: tonight| this week| this Sunday)?[.!]?$/i.test(text)) {
    return service.execute('volunteer', {}, message);
  }
  const topic = /^(?:the |my )?(?:word|topic)(?: for (?:tonight|this week|this Sunday))? (?:is|will be)\s+([^\n?!]{1,200})[.!]?$/i.exec(text);
  if (!topic) return null;
  const value = topic[1].replace(/[.!]+$/, '').trim();
  if (!value || /^(?:forthcoming|coming(?: soon)?|tbd|to be (?:determined|announced)|not decided|unknown)$/i.test(value)) return null;
  return service.execute('set_topic', { topic: value }, message);
}
