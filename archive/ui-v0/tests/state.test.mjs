import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, hydrateState, toggleFavorite, addReminder, updateReminder, emitReminder } from '../dist/state.mjs';

const now = new Date('2026-10-13T10:00:00+08:00').getTime();
const later = now + 60_000;

test('favourites refer to stable messages and toggle without duplicates', () => {
  const state = createInitialState(now);
  const id = state.messages.campus[0].id;
  toggleFavorite(state, id);
  assert.deepEqual(state.favorites, [id]);
  toggleFavorite(state, id);
  assert.deepEqual(state.favorites, []);
  assert.throws(() => toggleFavorite(state, 'missing'));
});

test('invalid, empty and past reminders are rejected', () => {
  for (const input of [{ title: '', dueAt: later }, { title: '作业', dueAt: 'bad' }, { title: '作业', dueAt: now - 1 }]) {
    assert.throws(() => addReminder(createInitialState(now), input, now));
  }
});

test('a reminder is delivered once and completion prevents future delivery', () => {
  const state = createInitialState(now);
  const reminder = addReminder(state, { title: '完成数学作业', dueAt: later }, now);
  const first = emitReminder(state, reminder.id, later);
  assert.equal(first.kind, 'reminder');
  assert.equal(emitReminder(state, reminder.id, later + 1), null);
  updateReminder(state, reminder.id, { status: 'done' }, later);
  assert.equal(emitReminder(state, reminder.id, later + 2), null);
});

test('snoozing preserves reminder identity and permits one subsequent delivery', () => {
  const state = createInitialState(now);
  const reminder = addReminder(state, { title: '作业', dueAt: later }, now);
  const count = state.reminders.length;
  emitReminder(state, reminder.id, later);
  updateReminder(state, reminder.id, { dueAt: later + 600_000 }, later);
  assert.equal(state.reminders.length, count);
  assert.equal(state.reminders.find(r => r.id === reminder.id).status, 'pending');
  assert.ok(emitReminder(state, reminder.id, later + 600_000));
  assert.equal(emitReminder(state, reminder.id, later + 600_001), null);
});

test('linked reminders are reused instead of duplicating a notification reminder', () => {
  const state = createInitialState(now);
  const id = state.messages.campus[0].id;
  const a = addReminder(state, { title: '报告会', dueAt: later, messageId: id }, now);
  const b = addReminder(state, { title: '报告会', dueAt: later + 1000, messageId: id }, now);
  assert.equal(a.id, b.id);
  assert.equal(state.reminders.filter(r => r.messageId === id && r.status === 'pending').length, 1);
});

test('hydration recovers corrupted records and persists valid identity and saved messages', () => {
  assert.equal(hydrateState('invalid-json', now).profile.name, '小浙');
  const state = createInitialState(now);
  state.profile.nickname = '阿俊';
  toggleFavorite(state, state.messages.campus[0].id);
  const saved = hydrateState(JSON.stringify(state), now);
  assert.equal(saved.profile.nickname, '阿俊');
  assert.deepEqual(saved.favorites, state.favorites);
  const dirty = hydrateState(JSON.stringify({ profile: { name: 42, avatar: 'javascript:alert(1)' }, messages: { main: [null, { id: 'x', text: '<img onerror=alert(1)>', role: 'user', kind: 'chat', channel: 'main', createdAt: now }], campus: 'bad' }, reminders: [null], favorites: ['missing'] }), now);
  assert.equal(dirty.profile.name, '小浙');
  assert.equal(dirty.profile.avatar, null);
  assert.deepEqual(dirty.favorites, []);
  assert.ok(dirty.messages.main.some(m => m.text === '<img onerror=alert(1)>'));
});
