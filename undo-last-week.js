import fs from 'fs/promises';

const CONFIG_FILE = './config.json';

async function undoLastWeek() {
  try {
    // Load config
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const config = JSON.parse(data);
    
    if (config.history.length === 0) {
      console.log('❌ No history to undo');
      return;
    }
    
    // Get the last entry
    const lastEntry = config.history[config.history.length - 1];
    
    console.log('Last entry:');
    console.log(`  Date: ${new Date(lastEntry.date).toLocaleString()}`);
    console.log(`  Leader: ${lastEntry.leader || 'None (cancelled)'}`);
    console.log(`  Topic: ${lastEntry.topic || 'None'}`);
    console.log(`  Attendees: ${lastEntry.attendees}`);
    console.log(`  Cancelled: ${lastEntry.cancelled}`);
    console.log('');
    
    // If it wasn't cancelled, we need to undo the leader's stats
    if (!lastEntry.cancelled && lastEntry.leaderId) {
      const leader = config.members.find(m => m.user_id === lastEntry.leaderId);
      
      if (leader) {
        console.log(`Reverting stats for ${leader.name}:`);
        console.log(`  timesLed: ${leader.timesLed} -> ${leader.timesLed - 1}`);
        
        // Decrease times led
        leader.timesLed = Math.max(0, leader.timesLed - 1);
        
        // Find their previous lastLed date from history
        const previousEntries = config.history
          .slice(0, -1) // Exclude the one we're removing
          .filter(entry => entry.leaderId === lastEntry.leaderId && !entry.cancelled);
        
        if (previousEntries.length > 0) {
          const previousDate = previousEntries[previousEntries.length - 1].date;
          leader.lastLed = previousDate;
          console.log(`  lastLed: ${new Date(previousDate).toLocaleString()}`);
        } else {
          leader.lastLed = null;
          console.log(`  lastLed: null (never led before this)`);
        }
        
        // Remove topic from usedTopics if it was used
        if (lastEntry.topic) {
          const topicIndex = config.usedTopics.indexOf(lastEntry.topic);
          if (topicIndex > -1) {
            config.usedTopics.splice(topicIndex, 1);
            console.log(`  Removed "${lastEntry.topic}" from used topics`);
          }
        }
      }
    }
    
    // Remove the last entry from history
    config.history.pop();
    
    // Save config
    await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    
    console.log('');
    console.log('✅ Successfully undid last week\'s assignment');
    console.log(`   ${config.history.length} entries remaining in history`);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

undoLastWeek();
