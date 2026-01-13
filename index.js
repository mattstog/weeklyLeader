import cron from 'node-cron';
import fetch from 'node-fetch';
import fs from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();

const CONFIG_FILE = './config.json';
const GROUPME_API_BASE = 'https://api.groupme.com/v3';

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

// Save configuration
async function saveConfig(config) {
  try {
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log('Config saved successfully');
  } catch (error) {
    console.error('Error saving config:', error);
    throw error;
  }
}

// Send message to GroupMe
async function sendMessage(text) {
  const botId = process.env.GROUPME_BOT_ID;
  
  try {
    const response = await fetch('https://api.groupme.com/v3/bots/post', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot_id: botId,
        text: text,
      }),
    });

    const data = await response.json();
    console.log('Message sent:', text);
    return data;
  } catch (error) {
    console.error('Error sending message:', error);
    throw error;
  }
}

// Get messages from group (to find likes)
async function getGroupMessages(limit = 100) {
  const accessToken = process.env.GROUPME_ACCESS_TOKEN;
  const groupId = process.env.GROUP_ID;
  
  try {
    const response = await fetch(
      `${GROUPME_API_BASE}/groups/${groupId}/messages?token=${accessToken}&limit=${limit}`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();
    return data.response.messages;
  } catch (error) {
    console.error('Error getting messages:', error);
    throw error;
  }
}

// Find the check-in message and get who liked it
async function getCheckInLikes(messageId) {
  const messages = await getGroupMessages();
  const checkInMessage = messages.find(msg => msg.id === messageId);
  
  if (!checkInMessage) {
    console.log('Check-in message not found');
    return [];
  }

  // GroupMe stores likes as an array of user_ids who favorited the message
  const likes = checkInMessage.favorited_by || [];
  console.log(`Found ${likes.length} likes on check-in message`);
  return likes;
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
  
  const message = "👋 Like this message if you're in for this week's meeting!";
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

// Sunday 2 PM - Select leader and topic, send announcement
async function selectAndAnnounce() {
  console.log('--- SELECTING LEADER AND TOPIC ---');
  const config = await loadConfig();
  
  // Find the most recent bot message (our check-in)
  const messages = await getGroupMessages(20);
  const botMessages = messages.filter(msg => msg.sender_type === 'bot');
  
  if (botMessages.length === 0) {
    console.error('Could not find check-in message');
    return;
  }
  
  const checkInMessage = botMessages[0]; // Most recent bot message
  const messageId = checkInMessage.id;
  
  // Get who liked the message
  const attendees = await getCheckInLikes(messageId);
  
  if (attendees.length === 0) {
    await sendMessage("⚠️ No one liked the check-in message. Are we meeting this week?");
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
  
  await saveConfig(config);
  
  // Send announcement
  const announcement = `📣 This week's leader: ${leader.name}

📖 Topic: ${topic}

${leader.name}, please share your thoughts on this topic before we meet!`;
  
  await sendMessage(announcement);
}

// Initialize cron jobs
function initScheduler() {
  const checkInTime = process.env.CHECKIN_TIME || '9:00';
  const selectionTime = process.env.SELECTION_TIME || '14:00';
  
  const [checkInHour, checkInMinute] = checkInTime.split(':');
  const [selectionHour, selectionMinute] = selectionTime.split(':');
  
  // Sunday 9 AM check-in
  cron.schedule(`${checkInMinute} ${checkInHour} * * 0`, () => {
    sendCheckIn().catch(console.error);
  });
  
  // Sunday 2 PM selection
  cron.schedule(`${selectionMinute} ${selectionHour} * * 0`, () => {
    selectAndAnnounce().catch(console.error);
  });
  
  console.log('✅ Scheduler initialized');
  console.log(`   Check-in: Every Sunday at ${checkInTime}`);
  console.log(`   Selection: Every Sunday at ${selectionTime}`);
}

// Manual trigger functions for testing
export async function manualCheckIn() {
  await sendCheckIn();
}

export async function manualSelection() {
  await selectAndAnnounce();
}

// Start the bot
async function start() {
  console.log('🤖 GroupMe Leader Bot Starting...');
  
  // Validate environment variables
  if (!process.env.GROUPME_BOT_ID || !process.env.GROUPME_ACCESS_TOKEN || !process.env.GROUP_ID) {
    console.error('❌ Missing required environment variables. Check your .env file.');
    process.exit(1);
  }
  
  initScheduler();
  console.log('🚀 Bot is running! Waiting for scheduled times...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

start();
