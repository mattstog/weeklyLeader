# GroupMe Leader Bot 🤖

Automates weekly leader selection and topic rotation for your men's group.

## Features

- **Sunday 9 AM**: Sends check-in message asking people to like or react if they're attending
- **Sunday 1:50 PM**: Sends 10-minute reminder to react to the check-in
- **Sunday 2 PM**: 
  - If less than 2 people reacted: Automatically cancels group for the week
  - If 2+ people reacted: Selects leader (who hasn't led in longest) and topic, sends announcement with @mention
- Tracks leader history and rotates through topics evenly
- Accepts any reaction (heart, thumbs up, fire, etc.) as attendance
- Randomizes selection when there are ties
- Maintains full history log of all assignments and cancellations

## Setup

### 1. Get GroupMe Credentials

#### Bot ID
1. Go to https://dev.groupme.com/bots
2. Log in with your GroupMe account
3. Click "Create Bot"
4. Select your men's group
5. Name it something like "Leader Bot"
6. Copy the **Bot ID**

#### Access Token
1. Go to https://dev.groupme.com/
2. Click "Access Token" in the top right
3. Copy your access token

#### Group ID
1. Go to https://web.groupme.com/
2. Open your men's group
3. Look at the URL: `https://web.groupme.com/groups/12345678`
4. Copy the number (that's your Group ID)

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your credentials:

```env
GROUPME_BOT_ID=your_bot_id_here
GROUPME_ACCESS_TOKEN=your_access_token_here
GROUP_ID=your_group_id_here
```

### 4. Configure Topics and Members

Edit `config.json`:

```json
{
  "topics": [
    "Your Topic 1",
    "Your Topic 2",
    "Your Topic 3"
  ],
  "members": [
    {
      "user_id": "their_groupme_user_id",
      "name": "John",
      "lastLed": null,
      "timesLed": 0
    }
  ]
}
```

#### How to get User IDs:

You need each member's GroupMe user ID. Here's how:

1. Use the GroupMe API to fetch recent messages
2. Look at the `user_id` field in messages from each member
3. OR use this quick script:

```bash
curl "https://api.groupme.com/v3/groups/YOUR_GROUP_ID/messages?token=YOUR_ACCESS_TOKEN&limit=50" | jq '.response.messages[] | {name: .name, user_id: .user_id}' | sort | uniq
```

### 5. Run the Bot

```bash
npm start
```

The bot will run continuously and execute at the scheduled times every Sunday.

## Testing Manually

Want to test without waiting for Sunday? Open a Node REPL:

```bash
node
```

Then:

```javascript
import('./index.js').then(bot => {
  // Test check-in message
  bot.manualCheckIn();
  
  // Test reminder message
  bot.manualReminder();
  
  // Test selection (make sure someone liked the message first!)
  // Wait a few seconds, then:
  bot.manualSelection();
  
  // OR test the full workflow with 2-minute delay
  bot.manualTestBoth();
});
```

## Running 24/7

### On Raspberry Pi (Recommended)

1. **Install Node.js:**
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

2. **Transfer your project to the Pi:**
```bash
# Option A: Use git
git clone YOUR_REPO_URL
cd weeklyLeader

# Option B: Use scp from your Mac
scp -r weeklyLeader pi@raspberrypi.local:~/
```

3. **Install dependencies:**
```bash
npm install
```

4. **Create .env file with your credentials**

5. **Use PM2 to keep it running:**
```bash
npm install -g pm2
pm2 start index.js --name groupme-bot
pm2 save
pm2 startup
# Follow the command it shows you
```

6. **Useful PM2 commands:**
```bash
pm2 status                 # Check if running
pm2 logs groupme-bot       # View logs
pm2 restart groupme-bot    # Restart after updates
pm2 stop groupme-bot       # Stop the bot
```

### On Cloud (Railway, Render, etc.)
### On Cloud (Railway, Render, etc.)

1. Create a new project
2. Connect your GitHub repo
3. Set environment variables in the dashboard
4. Deploy!

## Customization

### Change Times

Edit `.env`:

```env
CHECKIN_TIME=9:00
SELECTION_TIME=14:00
```

(24-hour format)

### Add More Topics

Just edit the `topics` array in `config.json`

### Reset Topic Rotation

Clear the `usedTopics` array in `config.json` to start fresh

### Reset Leader History

Set each member's `lastLed` to `null` and `timesLed` to `0`

## Admin Commands

### View History
See all past weeks and cancellations:
```bash
npm run history
```

Shows output like:
```
📜 History (3 entries):

1. Sun Jan 12, 2025 - Matthew led on "Courage" (5 attendees)
2. Sun Jan 19, 2025 - ❌ CANCELLED (1 attendees)
3. Sun Jan 26, 2025 - John led on "Faith" (4 attendees)
```

### Undo Last Week
If something went wrong (group cancelled but bot assigned a leader, or you picked a different topic):
```bash
npm run undo
```

This will:
- Show what happened last week
- Revert the leader's stats (lastLed date and timesLed count)
- Remove the topic from usedTopics
- Delete that history entry

The bot looks at history to find the leader's previous date, so you won't lose that info!

## Troubleshooting

### Bot not sending messages
- Check your Bot ID is correct
- Make sure the bot is in the group

### Can't find likes
- Check your Access Token is correct
- Make sure Group ID is correct
- Bot needs a few seconds after posting to fetch likes

### Leader not being selected
- Make sure members' user_ids match the people who liked the message
- Check the logs to see what's happening

## How It Works

1. **Check-in (9 AM)**: Bot posts a message asking for likes or reactions
2. **Reminder (1:50 PM)**: Bot sends a 10-minute reminder to react
3. **Selection (2 PM)**: Bot:
   - Fetches who liked/reacted to the check-in message (any reaction counts!)
   - **If less than 2 people**: Automatically cancels group for the week
   - **If 2+ people**: 
     - Finds the person who hasn't led in longest (or random if tie)
     - Picks a topic that hasn't been used recently (or random if all used)
     - Updates the config with leader's last led date
     - Announces leader + topic with @mention
     - Logs everything to history
4. **Rotation**: Topics rotate through the list, resetting when all are used

## License

MIT - Do whatever you want with it!