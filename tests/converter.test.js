'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getFfmpegPath } = require('../src/main/ffmpeg-path');
const { Converter, parseProbe, chooseSampleRate, buildArgs } = require('../src/main/converter');
const { uniqueOutputPath } = require('../src/main/files');

const FFMPEG = getFfmpegPath();

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'мп3 conv-'));
}

function ff(args) {
  return spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-y', '-strict', '-2', ...args], {
    encoding: 'utf8',
  });
}

test('в ffmpeg есть libmp3lame', () => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  assert.match(r.stdout, /libmp3lame/);
});

test('разбор вывода ffmpeg', () => {
  const sample = [
    'Input #0, flac, from \'a.flac\':',
    '  Duration: 00:03:25.50, start: 0.000000, bitrate: 900 kb/s',
    '  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)',
    '  Stream #0:1: Video: mjpeg (Progressive), yuvj420p, 500x500, 90k tbr',
  ].join('\n');
  const p = parseProbe(sample);
  assert.equal(p.duration, 205.5);
  assert.equal(p.sampleRate, 96000);
  assert.equal(p.channels, 2);
  assert.equal(p.codec, 'flac');
  assert.equal(p.hasCover, true);
  assert.equal(parseProbe('  Duration: N/A, bitrate: N/A').duration, null);
});

test('подбор частоты дискретизации', () => {
  assert.equal(chooseSampleRate(44100), 44100);
  assert.equal(chooseSampleRate(96000), 48000);
  assert.equal(chooseSampleRate(88200), 44100);
  assert.equal(chooseSampleRate(192000), 48000);
  assert.equal(chooseSampleRate(undefined), null);
});

test('аргументы: 320k по умолчанию, V0, обложка', () => {
  const base = { input: 'i.wav', outPart: 'o.part', probe: { sampleRate: 44100, channels: 2 } };
  const a = buildArgs({ ...base, bitrate: '320', withCover: false });
  assert.ok(a.join(' ').includes('-b:a 320k'));
  assert.ok(!a.includes('attached_pic'));
  const b = buildArgs({ ...base, bitrate: 'v0', withCover: true });
  assert.ok(b.join(' ').includes('-q:a 0'));
  assert.ok(b.includes('attached_pic'));
});

const FORMATS = ['wav', 'flac', 'm4a', 'ogg', 'opus', 'aiff'];

for (const ext of FORMATS) {
  test(`конвертация ${ext} -> mp3 (320 kbps, длительность, путь с кириллицей)`, async (t) => {
    const dir = tmp();
    const input = path.join(dir, `Мой трек №1.${ext}`);
    const gen = ff([
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-metadata', 'title=Тест', '-metadata', 'artist=Артист',
      input,
    ]);
    if (gen.status !== 0 || !fs.existsSync(input)) {
      t.skip(`этот ffmpeg не умеет создавать .${ext}`);
      return;
    }
    const conv = new Converter(FFMPEG);
    const output = uniqueOutputPath(dir, 'Мой трек №1');
    const progress = [];
    const res = await conv.convert({ input, output, bitrate: '320', onProgress: (p) => progress.push(p) });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.output, output);
    assert.ok(fs.statSync(output).size > 1000);
    const p = await conv.probe(output);
    assert.equal(p.codec, 'mp3');
    assert.equal(p.bitrate, 320);
    assert.ok(Math.abs(p.duration - 3) < 0.15, `длительность ${p.duration}`);
    // не должно остаться временных файлов
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.part')), []);
    const tags = spawnSync(FFMPEG, ['-hide_banner', '-i', output], { encoding: 'utf8' }).stderr;
    assert.match(tags, /title\s*:\s*Тест/);
    if (ext !== 'aiff') assert.match(tags, /artist\s*:\s*Артист/); // AIFF не хранит artist
  });
}

test('обложка сохраняется', async (t) => {
  const dir = tmp();
  const cover = path.join(dir, 'cover.jpg');
  const input = path.join(dir, 'with cover.m4a');
  const g1 = ff(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', cover]);
  const g2 = ff([
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-i', cover,
    '-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'copy',
    '-disposition:v', 'attached_pic', input,
  ]);
  if (g1.status !== 0 || g2.status !== 0) {
    t.skip('не удалось создать тестовый файл с обложкой');
    return;
  }
  const conv = new Converter(FFMPEG);
  const output = uniqueOutputPath(dir, 'with cover');
  const res = await conv.convert({ input, output });
  assert.equal(res.ok, true, res.error);
  const info = spawnSync(FFMPEG, ['-hide_banner', '-i', output], { encoding: 'utf8' }).stderr;
  assert.match(info, /Video: mjpeg/);
});

test('ошибка на битом файле не оставляет мусора', async () => {
  const dir = tmp();
  const input = path.join(dir, 'broken.wav');
  fs.writeFileSync(input, 'это не аудио');
  const conv = new Converter(FFMPEG);
  const output = uniqueOutputPath(dir, 'broken');
  const res = await conv.convert({ input, output });
  assert.equal(res.ok, false);
  assert.ok(res.error);
  assert.equal(fs.existsSync(output), false);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.part')), []);
});

test('отмена убирает недописанные файлы', async () => {
  const dir = tmp();
  const input = path.join(dir, 'long.wav');
  const gen = ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=600', input]);
  assert.equal(gen.status, 0);
  const conv = new Converter(FFMPEG);
  const output = uniqueOutputPath(dir, 'long');
  const p = conv.convert({ input, output });
  setTimeout(() => conv.cancelAll(), 150);
  const res = await p;
  assert.equal(res.ok, false, 'конвертация должна была быть отменена');
  assert.equal(res.cancelled, true);
  {
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.part')), []);
  }
});
