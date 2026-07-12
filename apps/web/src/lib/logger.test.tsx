import { afterEach, expect, test, vi } from 'vitest';

import { logger } from './logger';

afterEach(() => {
  vi.restoreAllMocks();
});

test('emits a structured record to the matching console method', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logger.error('ui.test', 'boom', { code: 42 });
  expect(spy).toHaveBeenCalledTimes(1);
  const [prefix, record] = spy.mock.calls[0]!;
  expect(prefix).toBe('[ui.test] boom');
  expect(record).toEqual({
    level: 'error',
    scope: 'ui.test',
    message: 'boom',
    fields: { code: 42 },
  });
});

test('omits the fields key when no fields are given', () => {
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logger.warn('ui.test', 'heads up');
  const [, record] = spy.mock.calls[0]!;
  expect(record).toEqual({ level: 'warn', scope: 'ui.test', message: 'heads up' });
});

test('omits the fields key when fields is empty', () => {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  logger.info('ui.test', 'nothing extra', {});
  const [, record] = spy.mock.calls[0]!;
  expect(record).not.toHaveProperty('fields');
});

test('routes each level to its own console method', () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  logger.info('ui.test', 'i');
  logger.debug('ui.test', 'd');
  expect(info).toHaveBeenCalledOnce();
  expect(debug).toHaveBeenCalledOnce();
});
