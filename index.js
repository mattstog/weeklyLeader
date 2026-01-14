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
  } catch (error) {
    console.error('Error sending message:', error);
    console.error('Bot ID being used:', botId);
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
  
  // Find the most recent bot message (our check-in)
  const messages = await getGroupMessages(20);
  const botMessages = messages.filter(msg => msg.sender_type === 'bot');
  
  if (botMessages.length === 0) {
    console.error('❌ Could not find check-in message');
    console.log('💡 Make sure you ran manualCheckIn() first and waited a few seconds!');
    return;
  }
  
  const checkInMessage = botMessages[0]; // Most recent bot message
  const messageId = checkInMessage.id;
  
  console.log(`✅ Found check-in message: "${checkInMessage.text}"`);
  console.log(`   Message ID: ${messageId}`);
  
  // Get who liked the message
  const attendees = await getCheckInLikes(messageId);
  
  console.log(`Found ${attendees.length} people who liked the message`);
  
  // Check if we have enough people
  if (attendees.length < 2) {
    config.history.push({
      date: new Date().toISOString(),
      leader: null,
      leaderId: null,
      topic: null,
      attendees: attendees.length,
      cancelled: true
    });
    await saveConfig(config);
    await sendMessage("⚠️ Less than 2 people reacted. Group is cancelled this week. See you next Sunday!");
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
  
  await sendMessageWithMention(announcement, {
    loci: [[mentionStart, mentionLength]],
    user_ids: [leader.user_id]
  });
}

// Send message with @mention to GroupMe
async function sendMessageWithMention(text, mentions) {
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
  } catch (error) {
    console.error('Error sending message with mention:', error);
    throw error;
  }
}

// Initialize cron jobs
function initScheduler() {
  const checkInTime = process.env.CHECKIN_TIME || '9:00';
  const selectionTime = process.env.SELECTION_TIME || '14:00';
  
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
  console.log('⏳ Waiting 2 minutes for you to like the message...');
  console.log('   👉 Go to GroupMe and LIKE the check-in message now!');
  console.log('');
  
  // Wait 2 Minutes
  await new Promise(resolve => setTimeout(resolve, 120000));
  
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
  
  initScheduler();
  console.log('🚀 Bot is running! Waiting for scheduled times...');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

start();