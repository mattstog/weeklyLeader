import test from 'node:test';
import assert from 'node:assert/strict';
import { runActionChat } from './action-chat.js';
const call = (action, id = 'call1') => ({ type: 'function_call', name: 'scheduler_action', arguments: JSON.stringify({ action }), call_id: id });
const text = value => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: value }] }] });
const extractText = data => data.output?.find(i => i.type === 'message')?.content[0].text || '';

test('passes actual action results back to the model and preserves reasoning items', async () => {
  const requests = [];
  const input = { instructions: 'test', input: 'change it', allowChanges: true, extractText,
    execute: async () => ({ updated: true }),
    request: async options => {
      requests.push(structuredClone(options));
      return requests.length === 1 ? { output: [{ type: 'reasoning', id: 'reason', summary: [] }, call('cancel')] } : text('Cancelled.');
    },
  };
  assert.equal(await runActionChat(input), 'Cancelled.');
  assert.equal(requests[1].input[1].type, 'reasoning');
  assert.equal(JSON.parse(requests[1].input.at(-1).output).updated, true);
});

test('blocks proactive mutations and gives the model a real permission error', async () => {
  let writes = 0;
  let count = 0;
  await runActionChat({ input: 'context', instructions: '', allowChanges: false, extractText,
    execute: async () => writes++, request: async options => {
      if (++count === 1) return { output: [call('cancel')] };
      assert.match(options.input.at(-1).output, /Proactive replies cannot/);
      return text('Ask me directly.');
    },
  });
  assert.equal(writes, 0);
});

test('deduplicates repeated model calls and reports a completed action if follow-up fails', async () => {
  let writes = 0;
  let count = 0;
  const reply = await runActionChat({ input: 'context', instructions: '', allowChanges: true, extractText,
    execute: async () => { writes++; return { updated: true }; }, request: async () => {
      if (++count < 3) return { output: [call('set_topic', `call${count}`)] };
      throw new Error('network');
    },
  });
  assert.equal(writes, 1);
  assert.match(reply, /updated/);
});
