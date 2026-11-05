import { describe, expect, it } from 'vitest';
import { replayAsSse } from '../src/streaming/replay.js';

const options = {
  id: 'chatcmpl-1',
  created: 5,
  model: 'fast',
  content: 'Hello there',
  finishReason: 'stop',
  includeUsage: false,
  promptTokens: 7,
  completionTokens: 2,
};

function events(body: string): string[] {
  return body
    .split('\n\n')
    .filter((part) => part !== '')
    .map((part) => part.replace(/^data: /, ''));
}

describe('replayAsSse', () => {
  it('is one content chunk, a closing chunk and [DONE]', () => {
    const parts = events(replayAsSse(options));
    expect(parts).toHaveLength(3);
    const first = JSON.parse(parts[0]!);
    expect(first).toMatchObject({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      model: 'fast',
      choices: [{ delta: { role: 'assistant', content: 'Hello there' }, finish_reason: null }],
    });
    expect(JSON.parse(parts[1]!).choices[0]).toMatchObject({ delta: {}, finish_reason: 'stop' });
    expect(parts[2]).toBe('[DONE]');
  });

  it('adds a usage chunk only on request', () => {
    const parts = events(replayAsSse({ ...options, includeUsage: true }));
    expect(parts).toHaveLength(4);
    expect(JSON.parse(parts[2]!)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    });
  });

  it('ends with exactly one [DONE]', () => {
    expect(replayAsSse(options).match(/\[DONE\]/g)).toHaveLength(1);
  });

  it('keeps content with newlines and quotes intact', () => {
    const content = 'Line one\n"quoted"\n\nLine three';
    const first = JSON.parse(events(replayAsSse({ ...options, content }))[0]!);
    expect(first.choices[0].delta.content).toBe(content);
  });
});
