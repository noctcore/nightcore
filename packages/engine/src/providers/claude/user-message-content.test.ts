import { describe, expect, it } from 'bun:test';

import type { WireImage } from '@nightcore/contracts';

import { buildUserMessageContent } from './user-message-content.js';

describe('buildUserMessageContent', () => {
  it('returns a plain string when there are no images (byte-identical to before)', () => {
    expect(buildUserMessageContent('do the thing')).toBe('do the thing');
    expect(buildUserMessageContent('do the thing', [])).toBe('do the thing');
  });

  it('builds a text block followed by one base64 image block per attachment', () => {
    const images: WireImage[] = [
      { format: 'png', data: 'AAAA' },
      { format: 'jpeg', data: 'BBBB' },
    ];
    const content = buildUserMessageContent('look at these', images);
    expect(content).toEqual([
      { type: 'text', text: 'look at these' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } },
    ]);
  });

  it('maps every format token to its SDK media type', () => {
    const formats: WireImage['format'][] = ['png', 'jpeg', 'webp', 'gif'];
    for (const format of formats) {
      const content = buildUserMessageContent('x', [{ format, data: 'Z' }]);
      // content is the array form here.
      const block = (content as Array<{ source?: { media_type: string } }>)[1];
      expect(block.source?.media_type).toBe(`image/${format}`);
    }
  });
});
