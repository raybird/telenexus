import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBool, parsePositiveInt, parseNumber, parseString } from '../src/utils/env.js';

test('parseBool returns fallback for undefined', () => {
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool(undefined, false), false);
});

test('parseBool returns fallback for empty string', () => {
  assert.equal(parseBool('', true), true);
  assert.equal(parseBool('', false), false);
});

test('parseBool parses truthy values', () => {
  for (const value of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', 'ON']) {
    assert.equal(parseBool(value, false), true, `expected true for "${value}"`);
  }
});

test('parseBool parses falsy values', () => {
  for (const value of ['0', 'false', 'no', 'off', 'FALSE', 'No', 'OFF']) {
    assert.equal(parseBool(value, true), false, `expected false for "${value}"`);
  }
});

test('parseBool returns fallback for unrecognized string', () => {
  assert.equal(parseBool('maybe', true), true);
  assert.equal(parseBool('maybe', false), false);
});

test('parsePositiveInt returns fallback for undefined', () => {
  assert.equal(parsePositiveInt(undefined, 42), 42);
});

test('parsePositiveInt returns fallback for empty string', () => {
  assert.equal(parsePositiveInt('', 10), 10);
});

test('parsePositiveInt parses valid positive integers', () => {
  assert.equal(parsePositiveInt('5', 10), 5);
  assert.equal(parsePositiveInt('100', 10), 100);
  assert.equal(parsePositiveInt(' 7 ', 10), 7);
});

test('parsePositiveInt returns fallback for zero or negative', () => {
  assert.equal(parsePositiveInt('0', 10), 10);
  assert.equal(parsePositiveInt('-1', 10), 10);
});

test('parsePositiveInt returns fallback for non-numeric string', () => {
  assert.equal(parsePositiveInt('abc', 10), 10);
  assert.equal(parsePositiveInt('12.5', 10), 12);
});

test('parseNumber returns fallback for undefined', () => {
  assert.equal(parseNumber(undefined, 3.14), 3.14);
});

test('parseNumber returns fallback for empty string', () => {
  assert.equal(parseNumber('', 3.14), 3.14);
});

test('parseNumber parses valid numbers', () => {
  assert.equal(parseNumber('2.5', 0), 2.5);
  assert.equal(parseNumber('-1', 0), -1);
  assert.equal(parseNumber('0', 99), 0);
});

test('parseNumber returns fallback for non-numeric string', () => {
  assert.equal(parseNumber('abc', 3.14), 3.14);
});

test('parseString returns fallback for undefined', () => {
  assert.equal(parseString(undefined, 'default'), 'default');
});

test('parseString returns fallback for empty or whitespace-only string', () => {
  assert.equal(parseString('', 'default'), 'default');
  assert.equal(parseString('   ', 'default'), 'default');
});

test('parseString returns trimmed value for valid string', () => {
  assert.equal(parseString('hello', 'default'), 'hello');
  assert.equal(parseString(' hello ', 'default'), 'hello');
});
