const actions = ['status', 'attendance', 'history', 'check_in', 'reminder', 'select', 'volunteer', 'set_leader', 'set_topic', 'cancel', 'resume', 'undo', 'set_schedule'];
export const schedulerTool = {
  type: 'function', name: 'scheduler_action', strict: true,
  description: 'Read or change the shared Sunday scheduler. status includes member IDs, topics, current week, schedule, skips, and history. attendance reads actual reactions. check_in/reminder/select send messages now. volunteer assigns the requesting member. set_leader and set_topic update this week. cancel skips remaining jobs; resume enables this week. undo reverses the latest active history entry. set_schedule saves recurring Sunday times and attendance threshold. Use null for unused fields. All mutations require an explicit current request; admin permissions are checked by the server.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: actions },
      member_id: { type: ['string', 'null'] }, topic: { type: ['string', 'null'] },
      check_in_time: { type: ['string', 'null'], description: '24-hour Chicago time, H:MM or HH:MM.' },
      selection_time: { type: ['string', 'null'], description: '24-hour Chicago time, H:MM or HH:MM.' },
      min_attendees: { type: ['integer', 'null'] },
    },
    required: ['action', 'member_id', 'topic', 'check_in_time', 'selection_time', 'min_attendees'],
  },
};

export async function runActionChat({ request, input, instructions, execute, allowChanges, extractText }) {
  const conversation = [{ role: 'user', content: input }];
  const results = [];
  const completedCalls = new Map();
  for (let step = 0; step < 6; step++) {
    let data;
    try {
      data = await request({ input: conversation, instructions, tools: [schedulerTool], parallel_tool_calls: false, tool_choice: step === 5 ? 'none' : 'auto' });
    } catch (error) {
      if (results.length) return `Scheduler results: ${JSON.stringify(results)}. I couldn't generate the follow-up reply.`;
      throw error;
    }
    if (data.error || data.status === 'failed' || data.status === 'incomplete') {
      if (results.length) return `Scheduler results: ${JSON.stringify(results)}. The follow-up reply was incomplete.`;
      throw new Error('The reply service returned an unsuccessful response.');
    }
    const calls = (data.output || []).filter(item => item.type === 'function_call');
    if (!calls.length) {
      const reply = extractText(data);
      if (reply) return reply;
      if (results.length) return `Scheduler results: ${JSON.stringify(results)}`;
      throw new Error('The reply service returned no text.');
    }
    conversation.push(...data.output);
    for (const call of calls) {
      let result;
      try {
        if (call.name !== 'scheduler_action') throw new Error('Unknown tool.');
        const args = JSON.parse(call.arguments);
        if (!actions.includes(args.action)) throw new Error('Unknown action.');
        if (!allowChanges && !['status', 'attendance', 'history'].includes(args.action)) throw new Error('Proactive replies cannot change the scheduler. Ask the bot directly.');
        const key = JSON.stringify(args);
        if (completedCalls.has(key)) result = completedCalls.get(key);
        else {
          result = await execute(args.action, args);
          completedCalls.set(key, result);
          results.push(result);
        }
      } catch (error) {
        result = { error: error.message };
      }
      conversation.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) });
    }
  }
  return `Scheduler results: ${JSON.stringify(results)}. Please send a new request for further changes.`;
}
