// SPDX-License-Identifier: GPL-3.0-or-later

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openEntryStore } from '../vinyl-test/store.mjs';

test('without IndexedDB the store keeps entries in memory and says so', async () => {
  const store = await openEntryStore({ indexedDB: undefined });
  assert.equal(store.persistent, false);
  await store.put({ id: 'a', value: 1 });
  await store.put({ id: 'b', value: 2 });
  await store.put({ id: 'a', value: 3 });
  assert.deepEqual(await store.getAll(), [{ id: 'a', value: 3 }, { id: 'b', value: 2 }]);
  await store.deleteById('a');
  assert.deepEqual(await store.getAll(), [{ id: 'b', value: 2 }]);
  await store.clear();
  assert.deepEqual(await store.getAll(), []);
});

test('a failing IndexedDB open falls back to memory instead of throwing', async () => {
  const broken = { open() { throw new Error('private mode'); } };
  const store = await openEntryStore({ indexedDB: broken });
  assert.equal(store.persistent, false);
  await store.put({ id: 'x' });
  assert.deepEqual(await store.getAll(), [{ id: 'x' }]);
});
