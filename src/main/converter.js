'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { uniqueOutputPath } = require('./files');

const SUPPORTED_SR = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

// MP3 (libmp3lame) понимает не любые частоты — подбираем ближайшую допустимую.
function chooseSampleRate(sr) {
  if (!sr) return null;
  if (SUPPORTED_SR.includes(sr)) return sr;
  if (sr > 48000) return sr % 44100 === 0 ? 44100 : 48000;
  const lower = SUPPORTED_SR.filter((x) => x <= sr);
  return lower.length ? lower[lower.length - 1] : 8000;
}

// Разбор вывода `ffmpeg -i файл` (stderr).
function parseProbe(stderr) {
  const res = {
    duration: null,
    hasAudio: false,
    codec: null,
    sampleRate: null,
    channels: null,
    bitrate: null,
    hasCover: false,
    tagsInGlobal: false,
    tagsInStream: false,
  };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (d) res.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);

  const lines = stderr.split(/\r?\n/);
  const audio = lines.find((l) => /Stream #\d+:\d+.*: Audio:/.test(l));
  if (audio) {
    res.hasAudio = true;
    const c = /Audio:\s*([^\s,(]+)/.exec(audio);
    if (c) res.codec = c[1];
    const sr = /(\d+)\s*Hz/.exec(audio);
    if (sr) res.sampleRate = Number(sr[1]);
    const br = /(\d+)\s*kb\/s/.exec(audio);
    if (br) res.bitrate = Number(br[1]);
    if (/\bmono\b/.test(audio)) res.channels = 1;
    else if (/\bstereo\b/.test(audio)) res.channels = 2;
    else {
      const m = /(\d+) channels/.exec(audio);
      if (m) res.channels = Number(m[1]);
      else {
        const m2 = /,\s*(\d)\.(\d)(?:\([^)]*\))?\s*,/.exec(audio);
        if (m2) res.channels = Number(m2[1]) + Number(m2[2]);
      }
    }
  }
  // Теги: общие (контейнер) или в потоке (так у ogg/opus).
  const NOISE = /^(encoder|handler_name|vendor_id|language|creation_time|major_brand|minor_version|compatible_brands|duration|timecode)$/i;
  let section = null;
  let seenAudio = false;
  for (const l of lines) {
    if (/^Input #\d+/.test(l)) section = null;
    else if (/^ {2}Metadata:\s*$/.test(l)) section = 'global';
    else if (/^ {4}Metadata:\s*$/.test(l)) section = seenAudio ? 'astream' : 'other';
    else if (/^ {2}Stream #/.test(l)) {
      section = null;
      if (/: Audio:/.test(l)) seenAudio = true;
    } else if (/^ {2}Duration:/.test(l) || /^ {2}Chapter/.test(l)) section = null;
    else if (section && /^ {4,}\S/.test(l)) {
      const m = /^\s*([^:\s][^:]*?)\s*:\s*\S/.exec(l);
      if (m && !NOISE.test(m[1])) {
        if (section === 'global') res.tagsInGlobal = true;
        else if (section === 'astream') res.tagsInStream = true;
      }
    }
  }
  const video = lines.find((l) => /Stream #\d+:\d+.*: Video:/.test(l));
  if (video && /Video:\s*(mjpeg|png)\b/i.test(video)) res.hasCover = true;
  return res;
}

function qualityArgs(bitrate) {
  if (String(bitrate).toLowerCase() === 'v0') return ['-q:a', '0'];
  const n = Number(bitrate);
  const ok = [128, 192, 256, 320].includes(n) ? n : 320;
  return ['-b:a', `${ok}k`];
}

function buildArgs({ input, outPart, bitrate, withCover, probe }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:a:0'];
  if (withCover) args.push('-map', '0:v:0?', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  const tagsFromStream = probe && probe.tagsInStream && !probe.tagsInGlobal;
  args.push('-map_metadata', tagsFromStream ? '0:s:a:0' : '0', '-id3v2_version', '3', '-c:a', 'libmp3lame');
  args.push(...qualityArgs(bitrate));
  const sr = chooseSampleRate(probe && probe.sampleRate);
  if (sr) args.push('-ar', String(sr));
  if (probe && probe.channels && probe.channels > 2) args.push('-ac', '2');
  args.push('-progress', 'pipe:1', '-nostats', '-f', 'mp3', outPart);
  return args;
}

function lastErrorLine(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(size|frame|video:|audio:|Press)/i.test(l));
  return lines.length ? lines[lines.length - 1] : 'Неизвестная ошибка ffmpeg';
}

class Converter {
  constructor(ffmpegPath) {
    this.ffmpeg = ffmpegPath;
    this.procs = new Set();
    this.cancelled = false;
  }

  reset() {
    this.cancelled = false;
  }

  cancelAll() {
    this.cancelled = true;
    for (const p of this.procs) {
      try {
        p.kill();
      } catch {
        /* уже завершён */
      }
    }
  }

  _run(args, onStdoutLine) {
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(this.ffmpeg, args, { windowsHide: true });
      } catch (e) {
        resolve({ code: -1, stderr: String(e.message || e) });
        return;
      }
      this.procs.add(proc);
      let stderr = '';
      let buf = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString('utf8');
        if (stderr.length > 200000) stderr = stderr.slice(-100000);
      });
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line && onStdoutLine) onStdoutLine(line);
        }
      });
      proc.on('error', (e) => {
        this.procs.delete(proc);
        resolve({ code: -1, stderr: `Не удалось запустить ffmpeg: ${e.message}` });
      });
      proc.on('close', (code) => {
        this.procs.delete(proc);
        resolve({ code, stderr });
      });
    });
  }

  async probe(file) {
    const { stderr } = await this._run(['-hide_banner', '-nostdin', '-i', file]);
    return parseProbe(stderr);
  }

  // Конвертирует один файл. outputPath уже выбран (уникален).
  // Возвращает { ok, cancelled?, error? }.
  async convert({ input, output, bitrate = '320', onProgress }) {
    const probe = await this.probe(input);
    if (this.cancelled) return { ok: false, cancelled: true };
    if (!probe.hasAudio) return { ok: false, error: 'Нет звуковой дорожки' };

    const outPart = path.join(path.dirname(output), `.${path.basename(output)}.part`);
    const attempt = async (withCover) => {
      const args = buildArgs({ input, outPart, bitrate, withCover, probe });
      return this._run(args, (line) => {
        if (!onProgress || !probe.duration) return;
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m) {
          const sec = Number(m[1]) / 1e6;
          onProgress(Math.max(0, Math.min(99, Math.round((sec / probe.duration) * 100))));
        }
      });
    };

    const cleanup = () => fs.promises.rm(outPart, { force: true }).catch(() => {});

    let res = await attempt(probe.hasCover);
    if (this.cancelled) {
      await cleanup();
      return { ok: false, cancelled: true };
    }
    if (res.code !== 0 && probe.hasCover) {
      await cleanup();
      res = await attempt(false); // повтор без обложки
      if (this.cancelled) {
        await cleanup();
        return { ok: false, cancelled: true };
      }
    }
    if (res.code !== 0) {
      await cleanup();
      return { ok: false, error: lastErrorLine(res.stderr) };
    }

    let finalPath = output;
    if (fs.existsSync(finalPath)) {
      finalPath = uniqueOutputPath(path.dirname(output), path.basename(output, '.mp3'));
    }
    try {
      await fs.promises.rename(outPart, finalPath);
    } catch (e) {
      await cleanup();
      return { ok: false, error: `Не удалось сохранить файл: ${e.message}` };
    }
    return { ok: true, output: finalPath };
  }
}

module.exports = { Converter, parseProbe, buildArgs, chooseSampleRate, qualityArgs };
