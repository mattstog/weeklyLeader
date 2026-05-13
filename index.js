import cron from 'node-cron';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

const CONFIG_FILE = './config.json';
const DEFAULT_BOT_PERSONALITY_FILE = './bot-personality.md';
const GROUPME_API_BASE = 'https://api.groupme.com/v3';
const OPENAI_API_BASE = 'https://api.openai.com/v1';
const processedMessageIds = new Set();
const mentionCooldowns = new Map();

function parsePositiveInteger(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getRequestTimeoutMs() {
  return parsePositiveInteger(process.env.REQUEST_TIMEOUT_MS, 15000);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = getRequestTimeoutMs()) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function truncateForGroupMe(text) {
  const maxLength = parsePositiveInteger(process.env.MAX_REPLY_LENGTH, 900);

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatForGroupMe(text) {
  return text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .trim();
}

function rememberProcessedMessage(id) {
  if (!id) return;
  processedMessageIds.add(id);

  if (processedMessageIds.size > 100) {
    const [oldestId] = processedMessageIds;
    processedMessageIds.delete(oldestId);
  }
}

// Load configuration
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading config:', error);
    throw error;
  }
}

function validateConfig(config) {
  const errors = [];

  if (!Array.isArray(config.topics) || config.topics.length === 0) {
    errors.push('topics must be a non-empty array');
  }

  if (!Array.isArray(config.usedTopics)) {
    errors.push('usedTopics must be an array');
  }

  if (!Array.isArray(config.members) || config.members.length === 0) {
    errors.push('members must be a non-empty array');
  } else {
    config.members.forEach((member, index) => {
      if (!member.user_id) errors.push(`members[${index}].user_id is required`);
      if (!member.name) errors.push(`members[${index}].name is required`);
      if (!Number.isFinite(member.timesLed)) errors.push(`members[${index}].timesLed must be a number`);
    });
  }

  if (!Array.isArray(config.history)) {
    errors.push('history must be an array');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid config.json:\n- ${errors.join('\n- ')}`);
  }
}

// Save configuration
async function saveConfig(config) {
  try {
    const tempFile = `${CONFIG_FILE}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(config, null, 2));
    await fs.rename(tempFile, CONFIG_FILE);
    console.log('Config saved successfully');
  } catch (error) {
    console.error('Error saving config:', error);
    throw error;
  }
}

async function loadBotPersonality() {
  const personalityFile = process.env.BOT_PERSONALITY_FILE || DEFAULT_BOT_PERSONALITY_FILE;

  try {
    const personality = await fs.readFile(personalityFile, 'utf8');
    return personality.trim();
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Error loading bot personality:', error);
    }

    return [
      'You are Weekly Leader Bot in a GroupMe chat for a weekly discussion group.',
      'Reply conversationally and helpfully when tagged.',
      'Use the recent message context and bot state to answer. If the context is not enough, say what you are missing.',
      'Keep replies concise, usually under 120 words.',
      'Do not claim to have taken an action unless the provided state or recent messages show it.',
    ].join(' ');
  }
}

// Retry helper - retries a function up to `retries` times with `delayMs` between attempts
async function withRetry(fn, retries = 3, delayMs = 10000, label = 'operation') {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) {
        console.error(`❌ ${label} failed after ${retries} attempts.`);
        throw error;
      }
      console.warn(`⚠️ ${label} attempt ${attempt} failed (${error.code || error.message}). Retrying in ${delayMs / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Send message to GroupMe
async function sendMessage(text) {
  const botId = process.env.GROUPME_BOT_ID;

  return withRetry(async () => {
    const response = await fetchWithTimeout('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot_id: botId,
        text: text,
      }),
    });

    // Check if response is ok before trying to parse
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GroupMe API error (${response.status}):`, errorText);
      throw new Error(`GroupMe API returned ${response.status}: ${errorText}`);
    }

    // GroupMe bot post returns 202 with empty body on success
    if (response.status === 202) {
      console.log('✅ Message sent:', text);
      return { success: true };
    }

    const data = await response.json();
    console.log('✅ Message sent:', text);
    return data;
  }, 3, 10000, `sendMessage("${text.substring(0, 30)}...")`).catch(error => {
    console.error('Bot ID being used:', botId);
    throw error;
  });
}

// Get messages from group (to find likes)
async function getGroupMessages(limit = 100) {
  const accessToken = encodeURIComponent(process.env.GROUPME_ACCESS_TOKEN);
  const groupId = process.env.GROUP_ID;
  
  try {
    const response = await fetchWithTimeout(
      `${GROUPME_API_BASE}/groups/${groupId}/messages?token=${accessToken}&limit=${limit}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GroupMe API returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.response?.messages || [];
  } catch (error) {
    console.error('Error getting messages:', error);
    throw error;
  }
}

function getBotMentionNames() {
  return [
    process.env.GROUPME_BOT_NAME,
    process.env.GROUPME_BOT_HANDLE,
    'Weekly Leader',
    'Leader Bot',
  ].filter(Boolean);
}

function getWakePhrases() {
  const configuredPhrases = (process.env.GROUPME_WAKE_PHRASES || '')
    .split(',')
    .map(phrase => phrase.trim())
    .filter(Boolean);

  return [
    ...configuredPhrases,
    process.env.GROUPME_BOT_NAME,
    process.env.GROUPME_BOT_HANDLE,
  ].filter(Boolean);
}

function stripBotTrigger(text = '') {
  let cleanedText = text;

  for (const name of getBotMentionNames()) {
    cleanedText = cleanedText.replace(new RegExp(`@${escapeRegExp(name)}\\b`, 'gi'), '').trim();
  }

  for (const phrase of getWakePhrases()) {
    cleanedText = cleanedText.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b[:,]?`, 'gi'), '').trim();
  }

  return cleanedText;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMentioningBot(message) {
  const botUserId = process.env.GROUPME_BOT_USER_ID;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const mentionAttachment = attachments.find(attachment => attachment.type === 'mentions');
  const mentionedUserIds = mentionAttachment?.user_ids?.map(userId => String(userId)) || [];

  if (
    botUserId &&
    mentionedUserIds.includes(String(botUserId))
  ) {
    return true;
  }

  if (mentionedUserIds.length > 0) {
    return false;
  }

  const text = message.text || '';
  return getBotMentionNames().some(name => new RegExp(`@${escapeRegExp(name)}\\b`, 'i').test(text));
}

function hasWakePhrase(message) {
  const text = message.text || '';

  return getWakePhrases().some(phrase => new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(text));
}

function shouldReplyToMessage(message) {
  if (hasWakePhrase(message)) {
    return true;
  }

  return isMentioningBot(message);
}

function formatMessageForContext(message) {
  const date = message.created_at
    ? new Date(message.created_at * 1000).toISOString()
    : 'unknown time';
  const name = message.name || message.sender_name || message.user_id || 'Unknown';
  const text = message.text || '[no text]';

  return `[${date}] ${name}: ${text}`;
}

function summarizeConfig(config) {
  const currentWeek = config.currentWeek || {};
  const recentHistory = Array.isArray(config.history)
    ? config.history.slice(-5).map(entry => ({
        date: entry.date,
        leader: entry.leader,
        topic: entry.topic,
        attendees: entry.attendees,
        cancelled: entry.cancelled,
      }))
    : [];

  return {
    currentWeek: {
      leader: currentWeek.leader || null,
      topic: currentWeek.topic || null,
      date: currentWeek.date || null,
    },
    members: Array.isArray(config.members)
      ? config.members.map(member => ({
          name: member.name,
          user_id: member.user_id,
          lastLed: member.lastLed,
          timesLed: member.timesLed,
        }))
      : [],
    recentHistory,
  };
}

async function buildMentionReply(message, contextMessages, config) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required for mention replies');
  }

  const promptContext = contextMessages
    .map(formatMessageForContext)
    .join('\n');
  const configContext = JSON.stringify(summarizeConfig(config), null, 2);
  const directQuestion = stripBotTrigger(message.text || '');
  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const personality = await loadBotPersonality();

  const input = [
    `Bot state:\n${configContext}`,
    `Recent group context, oldest to newest:\n${promptContext}`,
    `Message that tagged you:\n${formatMessageForContext(message)}`,
    `Direct question after removing the bot mention:\n${directQuestion || '(none)'}`,
  ].join('\n\n');

  const response = await fetchWithTimeout(`${OPENAI_API_BASE}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      instructions: personality,
      input,
      max_output_tokens: 220,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API returned ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const reply = extractResponseText(data);

  if (!reply) {
    throw new Error('OpenAI API returned an empty reply');
  }

  return truncateForGroupMe(formatForGroupMe(reply));
}

function extractResponseText(response) {
  if (response.output_text) {
    return response.output_text.trim();
  }

  return (response.output || [])
    .flatMap(item => item.content || [])
    .filter(content => content.type === 'output_text' || content.type === 'text')
    .map(content => content.text)
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function getMentionContext(currentMessage) {
  const limit = parsePositiveInteger(process.env.MENTION_CONTEXT_LIMIT, 20);
  const messages = await getGroupMessages(limit);
  const seenIds = new Set(messages.map(message => message.id).filter(Boolean));
  const combinedMessages = seenIds.has(currentMessage.id)
    ? messages
    : [currentMessage, ...messages];

  return combinedMessages
    .filter(message => message.text || message.id === currentMessage.id)
    .sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
    .slice(-limit);
}

function getMentionCooldownKey(message) {
  return String(message.user_id || message.name || message.sender_id || 'unknown');
}

function isRateLimited(message) {
  const cooldownMs = parsePositiveInteger(process.env.MENTION_COOLDOWN_SECONDS, 15) * 1000;
  const key = getMentionCooldownKey(message);
  const now = Date.now();
  const previousReplyAt = mentionCooldowns.get(key) || 0;

  if (now - previousReplyAt < cooldownMs) {
    return true;
  }

  mentionCooldowns.set(key, now);

  if (mentionCooldowns.size > 100) {
    const cutoff = now - cooldownMs;

    for (const [cooldownKey, timestamp] of mentionCooldowns) {
      if (timestamp < cutoff) {
        mentionCooldowns.delete(cooldownKey);
      }
    }
  }

  return false;
}

async function handleIncomingMessage(message) {
  if (!message || !message.id) return;
  if (processedMessageIds.has(message.id)) return;
  rememberProcessedMessage(message.id);

  if (message.sender_type === 'bot' || message.system) return;
  if (
    process.env.GROUP_ID &&
    message.group_id &&
    String(message.group_id) !== String(process.env.GROUP_ID)
  ) return;
  if (!shouldReplyToMessage(message)) return;
  if (isRateLimited(message)) {
    console.log(`⏳ Mention from ${message.name || message.user_id} skipped due to cooldown`);
    return;
  }

  console.log(`💬 Mention received from ${message.name || message.user_id}: ${message.text || ''}`);

  try {
    const [config, contextMessages] = await Promise.all([
      loadConfig(),
      getMentionContext(message),
    ]);
    const reply = await buildMentionReply(message, contextMessages, config);
    await sendMessage(reply);
  } catch (error) {
    console.error('Error replying to mention:', error);
    await sendMessage("I saw the tag, but I couldn't build a reply right now. Check my logs and config?");
  }
}

function parseJsonRequest(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', chunk => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        request.destroy();
        reject(new Error('Request body too large'));
      }
    });

    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    request.on('error', reject);
  });
}

function startWebhookServer() {
  const port = parsePositiveInteger(process.env.PORT, 3000);
  const path = process.env.GROUPME_CALLBACK_PATH || '/groupme/callback';
  const webhookToken = process.env.GROUPME_CALLBACK_TOKEN;

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    const requestPath = requestUrl.pathname;

    if (request.method === 'GET' && requestPath === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method !== 'POST' || requestPath !== path) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    if (webhookToken) {
      const providedToken = requestUrl.searchParams.get('token') || request.headers['x-groupme-callback-token'];

      if (providedToken !== webhookToken) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    try {
      const message = await parseJsonRequest(request);
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      handleIncomingMessage(message).catch(error => {
        console.error('Unhandled webhook processing error:', error);
      });
    } catch (error) {
      console.error('Error parsing webhook request:', error);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      console.log('✅ Webhook server initialized');
      console.log(`   Listening on port ${port}`);
      console.log(`   GroupMe callback path: ${path}`);
      resolve(server);
    });
  });
}

// Find the check-in message and get who liked/reacted to it
async function getCheckInLikes(messageId) {
  const messages = await getGroupMessages();
  const checkInMessage = messages.find(msg => msg.id === messageId);
  
  if (!checkInMessage) {
    console.log('Check-in message not found');
    return [];
  }

  // GroupMe stores likes as an array of user_ids who favorited the message
  const likes = checkInMessage.favorited_by || [];
  
  // Also check for emoji reactions in attachments
  const reactions = new Set(likes); // Use Set to avoid duplicates
  
  if (checkInMessage.attachments) {
    for (const attachment of checkInMessage.attachments) {
      if (attachment.type === 'emoji' && attachment.user_ids) {
        // Add all users who reacted with any emoji
        attachment.user_ids.forEach(userId => reactions.add(userId));
      }
    }
  }
  
  const allAttendees = Array.from(reactions);
  console.log(`Found ${likes.length} likes and ${allAttendees.length - likes.length} other reactions`);
  console.log(`Total attendees: ${allAttendees.length}`);
  
  return allAttendees;
}

// Select leader (person who hasn't led in longest)
function selectLeader(config, attendees) {
  // Filter members to only those who liked the message
  const attendingMembers = config.members.filter(member => 
    attendees.includes(member.user_id)
  );

  if (attendingMembers.length === 0) {
    console.log('No attending members found');
    return null;
  }

  // Sort by last led date (null = never led, oldest first)
  const sorted = attendingMembers.sort((a, b) => {
    if (a.lastLed === null && b.lastLed === null) return 0;
    if (a.lastLed === null) return -1; // Never led = highest priority
    if (b.lastLed === null) return 1;
    return new Date(a.lastLed) - new Date(b.lastLed);
  });

  // Get all members who are tied for longest time since leading
  const oldestDate = sorted[0].lastLed;
  const tiedMembers = sorted.filter(m => m.lastLed === oldestDate);

  // Random selection from tied members
  const leader = tiedMembers[Math.floor(Math.random() * tiedMembers.length)];
  
  console.log(`Selected leader: ${leader.name}`);
  return leader;
}

// Select topic (rotate through, avoiding recent topics)
function selectTopic(config) {
  const { topics, usedTopics } = config;
  
  // If we've used all topics, reset the used list
  if (usedTopics.length >= topics.length) {
    console.log('All topics used, resetting rotation');
    config.usedTopics = [];
  }

  // Get topics that haven't been used recently
  const availableTopics = topics.filter(topic => !config.usedTopics.includes(topic));
  
  if (availableTopics.length === 0) {
    console.log('No available topics, resetting');
    config.usedTopics = [];
    return topics[Math.floor(Math.random() * topics.length)];
  }

  // Random selection from available topics
  const topic = availableTopics[Math.floor(Math.random() * availableTopics.length)];
  console.log(`Selected topic: ${topic}`);
  return topic;
}

// Sunday 9 AM - Send check-in message
async function sendCheckIn() {
  console.log('--- SENDING CHECK-IN MESSAGE ---');
  const config = await loadConfig();
  
  const message = "👋 Like or react to this message if you're in for this week's meeting!";
  await sendMessage(message);
  
  // Note: We can't get the message ID from bot post, so we'll fetch it later
  // Store that we sent it
  config.currentWeek = {
    checkInMessageId: null, // Will be populated when we fetch messages
    leader: null,
    topic: null,
    date: new Date().toISOString(),
  };
  
  await saveConfig(config);
}

// Sunday 1:50 PM - Send reminder to like the message
async function sendReminder() {
  console.log('--- SENDING REMINDER ---');
  const reminder = "⏰ 10 minute reminder: Don't forget to like or react to the check-in message if you're coming to group tonight!";
  await sendMessage(reminder);
}

// Sunday 2 PM - Select leader and topic, send announcement
async function selectAndAnnounce() {
  console.log('--- SELECTING LEADER AND TOPIC ---');
  const config = await loadConfig();
  
  // Get minimum attendees threshold from environment variable (default: 3)
  const minAttendees = parsePositiveInteger(process.env.MIN_ATTENDEES, 3);
  
  // Find the check-in message by searching for its text content
  const messages = await getGroupMessages(50); // Increased limit to ensure we find it
  const botMessages = messages.filter(msg => msg.sender_type === 'bot');
  
  // Look for the specific check-in message text
  const checkInMessage = botMessages.find(msg => 
    msg.text && msg.text.includes("Like or react to this message if you're in")
  );
  
  if (!checkInMessage) {
    console.error('❌ Could not find check-in message');
    console.log('💡 Make sure the check-in message was sent and try again');
    return;
  }
  
  const messageId = checkInMessage.id;
  
  console.log(`✅ Found check-in message: "${checkInMessage.text}"`);
  console.log(`   Message ID: ${messageId}`);
  
  // Get who liked the message
  const attendees = await getCheckInLikes(messageId);
  
  console.log(`Found ${attendees.length} people who liked the message`);
  console.log(`Minimum required: ${minAttendees}`);
  
  // Check if we have enough people
  if (attendees.length < minAttendees) {
    config.history.push({
      date: new Date().toISOString(),
      leader: null,
      leaderId: null,
      topic: null,
      attendees: attendees.length,
      cancelled: true
    });
    await saveConfig(config);
    await sendMessage(`⚠️ Less than ${minAttendees} people reacted. Group is cancelled this week. See you next Sunday!`);
    return;
  }
  
  // Select leader
  const leader = selectLeader(config, attendees);
  
  if (!leader) {
    await sendMessage("⚠️ Could not select a leader. Please volunteer!");
    return;
  }
  
  // Select topic
  const topic = selectTopic(config);
  
  // Update config
  leader.lastLed = new Date().toISOString();
  leader.timesLed += 1;
  config.usedTopics.push(topic);
  config.currentWeek.leader = leader.name;
  config.currentWeek.topic = topic;
  
  // Add to history
  config.history.push({
    date: new Date().toISOString(),
    leader: leader.name,
    leaderId: leader.user_id,
    topic: topic,
    attendees: attendees.length,
    cancelled: false
  });
  
  await saveConfig(config);
  
  // Send announcement with @mention
  const announcement = `📣 This week's leader: @${leader.name}

📖 Topic: ${topic}`;
  
  // Calculate mention position - need to account for emoji and @ symbol
  const beforeMention = "📣 This week's leader: @";
  const mentionStart = [...beforeMention].length; // Use spread to count actual characters including emoji
  const mentionLength = [...leader.name].length + 1; // adding one to Claude's code to get full name
  
  await sendMessageWithMention(announcement, {
    loci: [[mentionStart, mentionLength]],
    user_ids: [leader.user_id]
  });
}

// Send message with @mention to GroupMe
async function sendMessageWithMention(text, mentions) {
  const botId = process.env.GROUPME_BOT_ID;

  return withRetry(async () => {
    const response = await fetchWithTimeout('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot_id: botId,
        text: text,
        attachments: [
          {
            type: 'mentions',
            loci: mentions.loci,
            user_ids: mentions.user_ids
          }
        ]
      }),
    });

    // Check if response is ok before trying to parse
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GroupMe API error (${response.status}):`, errorText);
      throw new Error(`GroupMe API returned ${response.status}: ${errorText}`);
    }

    // GroupMe bot post returns 202 with empty body on success
    if (response.status === 202) {
      console.log('✅ Message with mention sent:', text);
      return { success: true };
    }

    const data = await response.json();
    console.log('✅ Message with mention sent:', text);
    return data;
  }, 3, 10000, `sendMessageWithMention("${text.substring(0, 30)}...")`);
}

// Initialize cron jobs
function initScheduler() {
  const checkInTime = process.env.CHECKIN_TIME || '9:00';
  const selectionTime = process.env.SELECTION_TIME || '14:00';
  const minAttendees = parsePositiveInteger(process.env.MIN_ATTENDEES, 3);
  
  const [checkInHour, checkInMinute] = checkInTime.split(':');
  const [selectionHour, selectionMinute] = selectionTime.split(':');
  
  // Calculate reminder time (10 minutes before selection)
  let reminderHour = parseInt(selectionHour);
  let reminderMinute = parseInt(selectionMinute) - 10;
  
  // Handle cases where subtracting 10 minutes goes negative
  if (reminderMinute < 0) {
    reminderMinute += 60;
    reminderHour -= 1;
  }
  
  // Sunday 9 AM check-in
  cron.schedule(`${checkInMinute} ${checkInHour} * * 0`, () => {
    sendCheckIn().catch(console.error);
  });
  
  // Sunday 1:50 PM reminder (10 min before selection)
  cron.schedule(`${reminderMinute} ${reminderHour} * * 0`, () => {
    sendReminder().catch(console.error);
  });
  
  // Sunday 2 PM selection
  cron.schedule(`${selectionMinute} ${selectionHour} * * 0`, () => {
    selectAndAnnounce().catch(console.error);
  });
  
  console.log('✅ Scheduler initialized');
  console.log(`   Check-in: Every Sunday at ${checkInTime}`);
  console.log(`   Reminder: Every Sunday at ${reminderHour}:${reminderMinute.toString().padStart(2, '0')}`);
  console.log(`   Selection: Every Sunday at ${selectionTime}`);
  console.log(`   Minimum attendees required: ${minAttendees}`);
}

// Manual trigger functions for testing
export async function manualCheckIn() {
  console.log('🧪 MANUAL TEST: Sending check-in message...');
  await sendCheckIn();
  console.log('✅ Check-in sent! Go like the message in GroupMe, then wait 10 seconds before running manualSelection()');
}

export async function manualReminder() {
  console.log('🧪 MANUAL TEST: Sending reminder...');
  await sendReminder();
}

export async function manualSelection() {
  console.log('🧪 MANUAL TEST: Running leader selection...');
  await selectAndAnnounce();
}

// Test both with proper delay
export async function manualTestBoth() {
  console.log('🧪 FULL TEST: Running complete workflow...');
  console.log('');
  
  // Step 1: Send check-in
  await manualCheckIn();
  
  console.log('');
  console.log('⏳ Waiting 1 minute for you to like the message...');
  console.log('   👉 Go to GroupMe and LIKE the check-in message now!');
  console.log('');
  
  // Wait 30 seconds
  await new Promise(resolve => setTimeout(resolve, 30000));
  
  // Send 30-second reminder
  console.log('⏰ 30 seconds left!');
  await manualReminder();
  console.log('');
  
  // Wait another 30 seconds (total of 1 minute)
  await new Promise(resolve => setTimeout(resolve, 30000));
  
  // Step 2: Run selection
  console.log('⏰ Time is up! Running selection now...');
  console.log('');
  await manualSelection();
}

// Start the bot
async function start() {
  console.log('🤖 GroupMe Leader Bot Starting...');
  
  // Validate environment variables
  if (!process.env.GROUPME_BOT_ID || !process.env.GROUPME_ACCESS_TOKEN || !process.env.GROUP_ID) {
    console.error('❌ Missing required environment variables. Check your .env file.');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.warn('⚠️ OPENAI_API_KEY is not set. Scheduled leader selection will still work, but tagged replies will fail.');
  }

  if (!process.env.GROUPME_BOT_USER_ID && !process.env.GROUPME_BOT_NAME && !process.env.GROUPME_BOT_HANDLE) {
    console.warn('⚠️ Set GROUPME_BOT_NAME or GROUPME_BOT_USER_ID so the bot knows when it has been tagged.');
  }

  validateConfig(await loadConfig());
  
  const webhookServer = await startWebhookServer();
  initScheduler();
  console.log('🚀 Bot is running! Waiting for scheduled times...');

  return webhookServer;
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

if (process.env.pm_id !== undefined || import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export {
  buildMentionReply,
  handleIncomingMessage,
  loadBotPersonality,
  start,
  startWebhookServer,
};
