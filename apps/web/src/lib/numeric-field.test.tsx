import { expect, test } from 'vitest';

import { parseNumericCommit } from './numeric-field';

test('blank input is a no-op (inherit)', () => {
  expect(parseNumericCommit('', 5, 1)).toBeNull();
  expect(parseNumericCommit('   ', 5, 1)).toBeNull();
});

test('non-finite / non-numeric input is a no-op', () => {
  expect(parseNumericCommit('abc', null, 0)).toBeNull();
  expect(parseNumericCommit('NaN', null, 0)).toBeNull();
});

test('below-min input is rejected', () => {
  expect(parseNumericCommit('0', null, 1)).toBeNull();
  expect(parseNumericCommit('-3', null, 0)).toBeNull();
});

test('a value equal to the current value is a no-op', () => {
  expect(parseNumericCommit('5', 5, 1)).toBeNull();
  expect(parseNumericCommit('5.0', 5, 1)).toBeNull();
});

test('a valid, changed value commits', () => {
  expect(parseNumericCommit('7', 5, 1)).toBe(7);
  expect(parseNumericCommit('2.5', null, 0)).toBe(2.5);
  expect(parseNumericCommit('1', null, 1)).toBe(1);
});
