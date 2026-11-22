'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect, uniqueOutputPath } = require('../src/main/files');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp3conv-files-'));
}

test('уникальные имена: a.mp3 -> a (1).mp3 -> a (2).mp3', () => {
  const d = tmp();
  assert.equal(uniqueOutputPath(d, 'a'), path.join(d, 'a.mp3'));
  fs.writeFileSync(path.join(d, 'a.mp3'), '');
  assert.equal(uniqueOutputPath(d, 'a'), path.join(d, 'a (1).mp3'));
  fs.writeFileSync(path.join(d, 'a (1).mp3'), '');
  assert.equal(uniqueOutputPath(d, 'a'), path.join(d, 'a (2).mp3'));
});

test('уникальные имена: резерв внутри партии', () => {
  const d = tmp();
  const reserved = new Set();
  assert.equal(uniqueOutputPath(d, 'x', reserved), path.join(d, 'x.mp3'));
  assert.equal(uniqueOutputPath(d, 'x', reserved), path.join(d, 'x (1).mp3'));
});

test('рекурсивный поиск, регистр расширений, пропуск посторонних и скрытых', async () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(d, 'one.WAV'), '');
  fs.writeFileSync(path.join(d, 'sub', 'two.flac'), '');
  fs.writeFileSync(path.join(d, 'sub', 'deep', 'Мой трек №1.m4a'), '');
  fs.writeFileSync(path.join(d, 'already.mp3'), '');
  fs.writeFileSync(path.join(d, 'notes.txt'), '');
  fs.writeFileSync(path.join(d, '._hidden.m4a'), '');
  const found = await collect([d]);
  const names = found.map((f) => path.basename(f.path)).sort();
  assert.deepEqual(names, ['one.WAV', 'two.flac', 'Мой трек №1.m4a'].sort());
});

test('явно переданный mp3 помечается как пропущенный', async () => {
  const d = tmp();
  const f = path.join(d, 'song.mp3');
  fs.writeFileSync(f, '');
  const found = await collect([f]);
  assert.equal(found.length, 1);
  assert.equal(found[0].skip, 'mp3');
});

test('дубликаты путей убираются', async () => {
  const d = tmp();
  const f = path.join(d, 'a.wav');
  fs.writeFileSync(f, '');
  const found = await collect([f, d, f]);
  assert.equal(found.length, 1);
});
