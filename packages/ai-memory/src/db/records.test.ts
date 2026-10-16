import assert from 'node:assert/strict';
import { test } from 'vitest';

import { toMemoryRecord } from './records.js';

test.each([
  { name: 'native pgvector text', input: '[1,0,-0.25,0.0025]', expected: [1, 0, -0.25, 0.0025] },
  { name: 'whitespace and exponent text', input: ' [ 1e-7, -2.5E+1, 0 ] ', expected: [1e-7, -25, 0] },
  { name: 'finite numeric arrays', input: [1, 0, -0.25, 0.0025], expected: [1, 0, -0.25, 0.0025] },
  { name: 'empty numeric arrays', input: [], expected: [] },
  { name: 'empty array text', input: '[]', expected: [] },
])('returned memory embeddings preserve $name', ({ input, expected }) => {
  assert.deepEqual(toMemoryRecord({ embedding: input }).embedding, expected);
});

test.each([
  { name: 'null', input: null },
  { name: 'absent values', input: undefined },
  { name: 'numeric scalars', input: 1 },
  { name: 'objects', input: {} },
  { name: 'empty text', input: '' },
  { name: 'null text', input: 'null' },
  { name: 'object text', input: '{}' },
  { name: 'scalar text', input: '1' },
  { name: 'missing brackets', input: '1,2' },
  { name: 'incomplete text', input: '[1,2' },
  { name: 'trailing commas', input: '[1,]' },
  { name: 'numeric string elements', input: '[1,"2"]' },
  { name: 'null elements', input: '[1,null]' },
  { name: 'boolean elements', input: '[1,true]' },
  { name: 'nested array text', input: '[[1],2]' },
  { name: 'NaN text', input: '[NaN]' },
  { name: 'Infinity text', input: '[Infinity]' },
  { name: 'overflowing exponents', input: '[1e999]' },
  { name: 'NaN arrays', input: [NaN] },
  { name: 'positive infinity arrays', input: [Infinity] },
  { name: 'negative infinity arrays', input: [-Infinity] },
  { name: 'mixed arrays', input: [1, '2'] },
  { name: 'null arrays', input: [1, null] },
  { name: 'nested arrays', input: [[1], 2] },
  { name: 'sparse arrays', input: new Array<number>(2) },
])('returned memory embeddings reject $name', ({ input }) => {
  assert.equal(toMemoryRecord({ embedding: input }).embedding, null);
});
