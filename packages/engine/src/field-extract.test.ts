/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import {
  getBoolean,
  getNumber,
  getObject,
  getString,
  getStringArray,
} from './field-extract.js';

describe('getString', () => {
  test('returns the field when it is a string', () => {
    expect(getString({ a: 'x' }, 'a')).toBe('x');
  });
  test('returns undefined when the field is the wrong type', () => {
    expect(getString({ a: 1 }, 'a')).toBeUndefined();
    expect(getString({ a: true }, 'a')).toBeUndefined();
  });
  test('returns undefined when the field is absent', () => {
    expect(getString({}, 'a')).toBeUndefined();
  });
  test('returns undefined for non-object inputs', () => {
    expect(getString(null, 'a')).toBeUndefined();
    expect(getString(undefined, 'a')).toBeUndefined();
    expect(getString('a string', 'a')).toBeUndefined();
    expect(getString(42, 'a')).toBeUndefined();
  });
  test('preserves the empty string (not coerced to undefined)', () => {
    expect(getString({ a: '' }, 'a')).toBe('');
  });
});

describe('getBoolean', () => {
  test('returns the field when it is a boolean', () => {
    expect(getBoolean({ a: false }, 'a')).toBe(false);
    expect(getBoolean({ a: true }, 'a')).toBe(true);
  });
  test('returns undefined for non-boolean values', () => {
    expect(getBoolean({ a: 'true' }, 'a')).toBeUndefined();
    expect(getBoolean({ a: 0 }, 'a')).toBeUndefined();
  });
  test('returns undefined for non-object inputs', () => {
    expect(getBoolean(null, 'a')).toBeUndefined();
  });
});

describe('getNumber', () => {
  test('returns the field when it is a number', () => {
    expect(getNumber({ a: 42 }, 'a')).toBe(42);
  });
  test('preserves zero (not coerced to undefined)', () => {
    expect(getNumber({ a: 0 }, 'a')).toBe(0);
  });
  test('returns undefined for non-number values', () => {
    expect(getNumber({ a: '42' }, 'a')).toBeUndefined();
  });
  test('returns undefined for non-object inputs', () => {
    expect(getNumber(undefined, 'a')).toBeUndefined();
  });
});

describe('getObject', () => {
  test('returns a nested non-null object', () => {
    expect(getObject({ a: { b: 1 } }, 'a')).toEqual({ b: 1 });
  });
  test('returns undefined when the field is null', () => {
    expect(getObject({ a: null }, 'a')).toBeUndefined();
  });
  test('returns undefined when the field is a primitive or array', () => {
    expect(getObject({ a: 1 }, 'a')).toBeUndefined();
    expect(getObject({ a: 'x' }, 'a')).toBeUndefined();
    // Arrays are objects in JS, so they are returned as records — documenting the
    // (matching legacy) behavior: an array IS a non-null object.
    expect(getObject({ a: [1, 2] }, 'a')).toEqual([1, 2] as unknown as Record<
      string,
      unknown
    >);
  });
  test('returns undefined for non-object inputs', () => {
    expect(getObject(null, 'a')).toBeUndefined();
  });
});

describe('getStringArray', () => {
  test('returns the string members of an array field', () => {
    expect(getStringArray({ a: ['x', 'y'] }, 'a')).toEqual(['x', 'y']);
  });
  test('filters out non-string members', () => {
    expect(getStringArray({ a: ['x', 1, true, 'y', null] }, 'a')).toEqual([
      'x',
      'y',
    ]);
  });
  test('returns [] when the field is not an array', () => {
    expect(getStringArray({ a: 'x' }, 'a')).toEqual([]);
    expect(getStringArray({ a: 1 }, 'a')).toEqual([]);
  });
  test('returns [] when the field is absent', () => {
    expect(getStringArray({}, 'a')).toEqual([]);
  });
  test('returns [] for non-object inputs', () => {
    expect(getStringArray(null, 'a')).toEqual([]);
    expect(getStringArray(undefined, 'a')).toEqual([]);
  });
});
