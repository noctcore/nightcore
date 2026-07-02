import { expect, test } from 'vitest';

import {
  ACCEPTED_IMAGE_MIME,
  fileToPending,
  formatFromMime,
  imageDataUrl,
  imageFilesFrom,
  MAX_IMAGE_BYTES,
  readImageFiles,
  toPayload,
} from './attachments';

const pngFile = (name: string) =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

test('formatFromMime maps accepted types and rejects the rest', () => {
  expect(formatFromMime('image/png')).toBe('png');
  expect(formatFromMime('image/jpeg')).toBe('jpeg');
  expect(formatFromMime('image/webp')).toBe('webp');
  expect(formatFromMime('image/gif')).toBe('gif');
  expect(formatFromMime('image/svg+xml')).toBeNull();
  expect(formatFromMime('application/pdf')).toBeNull();
  expect(formatFromMime('')).toBeNull();
});

test('the accepted mime set matches the format map', () => {
  for (const mime of ACCEPTED_IMAGE_MIME) {
    expect(formatFromMime(mime)).not.toBeNull();
  }
});

test('imageDataUrl builds a usable data URL', () => {
  expect(imageDataUrl('png', 'AAAA')).toBe('data:image/png;base64,AAAA');
  expect(imageDataUrl('jpeg', 'BBBB')).toBe('data:image/jpeg;base64,BBBB');
});

test('fileToPending validates type and reads base64 (no data prefix)', async () => {
  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
  const pending = await fileToPending(file);
  expect(pending.format).toBe('png');
  expect(pending.filename).toBe('shot.png');
  expect(pending.data).not.toContain('data:');
  expect(pending.data.length).toBeGreaterThan(0);
  expect(toPayload(pending)).toEqual({ filename: 'shot.png', format: 'png', data: pending.data });
});

test('fileToPending rejects an unsupported type', async () => {
  const file = new File(['x'], 'note.txt', { type: 'text/plain' });
  await expect(fileToPending(file)).rejects.toThrow(/not a supported image/i);
});

test('fileToPending rejects an oversize image', async () => {
  // A sparse file whose reported size exceeds the cap (no need to allocate 10MB).
  const file = new File(['x'], 'huge.png', { type: 'image/png' });
  Object.defineProperty(file, 'size', { value: MAX_IMAGE_BYTES + 1 });
  await expect(fileToPending(file)).rejects.toThrow(/larger than 10 MB/i);
});

test('imageFilesFrom keeps only accepted image files', () => {
  const png = new File(['a'], 'a.png', { type: 'image/png' });
  const txt = new File(['b'], 'b.txt', { type: 'text/plain' });
  const dt = new DataTransfer();
  dt.items.add(png);
  dt.items.add(txt);
  const files = imageFilesFrom(dt);
  expect(files.map((f) => f.name)).toEqual(['a.png']);
});

test('imageFilesFrom returns empty for null / no images', () => {
  expect(imageFilesFrom(null)).toEqual([]);
  const dt = new DataTransfer();
  dt.items.add(new File(['t'], 't.txt', { type: 'text/plain' }));
  expect(imageFilesFrom(dt)).toEqual([]);
});

test('readImageFiles rejects when there is no room', async () => {
  const { accepted, errors } = await readImageFiles([pngFile('a.png')], 0);
  expect(accepted).toHaveLength(0);
  expect(errors[0]).toMatch(/maximum/i);
});

test('readImageFiles caps to room and reports the overflow', async () => {
  const { accepted, errors } = await readImageFiles([pngFile('a.png'), pngFile('b.png')], 1);
  expect(accepted).toHaveLength(1);
  expect(errors.some((e) => /only 1 more/i.test(e))).toBe(true);
});

test('readImageFiles partitions valid from invalid files', async () => {
  const ok = pngFile('ok.png');
  const bad = new File(['x'], 'bad.txt', { type: 'text/plain' });
  const { accepted, errors } = await readImageFiles([ok, bad], 5);
  expect(accepted.map((a) => a.filename)).toEqual(['ok.png']);
  expect(errors.some((e) => /not a supported image/i.test(e))).toBe(true);
});
