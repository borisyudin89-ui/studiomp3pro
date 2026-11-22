'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getFfmpegPath } = require('./ffmpeg-path');
const { Converter } = require('./converter');
const { collect, uniqueOutputPath, SUPPORTED } = require('./files');

// ---------- самопроверка упакованного приложения (используется в CI) ----------
async function runSelftest() {
  const out = process.env.SELFTEST_OUT;
  const result = { ok: false, log: [] };
  try {
    const ffmpeg = getFfmpegPath();
    result.ffmpeg = ffmpeg;
    const { spawnSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3conv-selftest-'));
    const wav = path.join(dir, 'тест трек.wav');
    const gen = spawnSync(ffmpeg, ['-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wav]);
    if (gen.status !== 0) throw new Error('ffmpeg не смог создать wav');
    const conv = new Converter(ffmpeg);
    const output = uniqueOutputPath(dir, 'тест трек');
    const r = await conv.convert({ input: wav, output, bitrate: '320' });
    if (!r.ok) throw new Error(r.error || 'конвертация не удалась');
    const p = await conv.probe(output);
    if (p.codec !== 'mp3' || p.bitrate !== 320) throw new Error(`неверный результат: ${JSON.stringify(p)}`);
    result.ok = true;
    result.probe = p;
  } catch (e) {
    result.error = String(e && e.message ? e.message : e);
  }
  const text = JSON.stringify(result);
  try {
    if (out) fs.writeFileSync(out, text);
    else process.stdout.write(text + '\n');
  } catch {
    /* ignore */
  }
  app.exit(result.ok ? 0 : 1);
}

if (process.argv.includes('--selftest')) {
  app.whenReady().then(runSelftest);
} else {
  startApp();
}

// ---------- само приложение ----------
function startApp() {
  const BITRATES = ['128', '192', '256', '320', 'v0'];
  let win = null;
  let converter = null;
  let running = false;
  let seq = 0;
  const jobs = new Map(); // id -> job
  const reserved = new Set();

  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  function loadSettings() {
    try {
      const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
      return { bitrate: BITRATES.includes(String(s.bitrate)) ? String(s.bitrate) : '320' };
    } catch {
      return { bitrate: '320' };
    }
  }
  function saveSettings(s) {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(s));
    } catch {
      /* не критично */
    }
  }
  let settings = { bitrate: '320' };

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
  function publish(job) {
    send('job:update', { ...job });
  }

  function createWindow() {
    win = new BrowserWindow({
      width: 780,
      height: 680,
      minWidth: 560,
      minHeight: 480,
      title: 'MP3 Converter',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    // Перетаскивание файла мимо зоны не должно открывать его в окне
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      if (converter) converter.cancelAll();
      win = null;
    });
  }

  async function addPaths(paths) {
    const found = await collect(paths);
    const existing = new Set([...jobs.values()].map((j) => j.input));
    const added = [];
    for (const f of found) {
      if (existing.has(f.path)) continue;
      const job = {
        id: ++seq,
        input: f.path,
        name: path.basename(f.path),
        status: f.skip ? 'skipped' : 'queued',
        progress: f.skip ? 100 : 0,
        output: null,
        error: f.skip ? 'уже MP3' : null,
        outSize: null,
      };
      jobs.set(job.id, job);
      added.push(job);
      publish(job);
    }
    return added.length;
  }

  async function worker() {
    for (;;) {
      if (converter.cancelled) return;
      const job = [...jobs.values()].find((j) => j.status === 'queued');
      if (!job) return;
      job.status = 'running';
      job.progress = 0;
      publish(job);

      const dir = path.dirname(job.input);
      const base = path.basename(job.input, path.extname(job.input));
      const output = uniqueOutputPath(dir, base, reserved);
      let last = -1;
      let res;
      try {
        res = await converter.convert({
          input: job.input,
          output,
          bitrate: settings.bitrate,
          onProgress: (p) => {
            if (p !== last) {
              last = p;
              job.progress = p;
              publish(job);
            }
          },
        });
      } catch (e) {
        res = { ok: false, error: String(e && e.message ? e.message : e) };
      } finally {
        reserved.delete(output.toLowerCase());
      }

      if (res.ok) {
        job.status = 'done';
        job.progress = 100;
        job.output = res.output;
        try {
          job.outSize = fs.statSync(res.output).size;
        } catch {
          /* ignore */
        }
      } else if (res.cancelled) {
        job.status = 'cancelled';
        job.progress = 0;
      } else {
        job.status = 'error';
        job.error = res.error || 'Ошибка';
      }
      publish(job);
    }
  }

  async function start() {
    if (running) return;
    running = true;
    converter.reset();
    send('batch:state', { running: true });
    const n = Math.max(1, Math.min(8, os.cpus().length - 1));
    try {
      await Promise.all(Array.from({ length: n }, () => worker()));
    } finally {
      // всё, что осталось в очереди после отмены
      if (converter.cancelled) {
        for (const j of jobs.values()) {
          if (j.status === 'queued' || j.status === 'running') {
            j.status = 'cancelled';
            j.progress = 0;
            publish(j);
          }
        }
      }
      running = false;
      send('batch:state', { running: false });
    }
  }

  function setupIpc() {
    ipcMain.handle('paths:add', (_e, paths) => (Array.isArray(paths) ? addPaths(paths.filter((p) => typeof p === 'string')) : 0));
    ipcMain.handle('dialog:files', async () => {
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Аудио и видео', extensions: [...SUPPORTED] },
          { name: 'Все файлы', extensions: ['*'] },
        ],
      });
      return r.canceled ? 0 : addPaths(r.filePaths);
    });
    ipcMain.handle('dialog:folder', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
      return r.canceled ? 0 : addPaths(r.filePaths);
    });
    ipcMain.handle('batch:start', () => {
      start();
    });
    ipcMain.handle('batch:cancel', () => {
      if (converter) converter.cancelAll();
    });
    ipcMain.handle('jobs:clear', () => {
      const removed = [];
      for (const [id, j] of jobs) {
        if (j.status !== 'running') {
          jobs.delete(id);
          removed.push(id);
        }
      }
      return removed;
    });
    ipcMain.handle('file:reveal', (_e, id) => {
      const j = jobs.get(id);
      if (j && j.output) shell.showItemInFolder(j.output);
    });
    ipcMain.handle('settings:get', () => settings);
    ipcMain.handle('settings:set', (_e, s) => {
      if (s && BITRATES.includes(String(s.bitrate))) {
        settings = { bitrate: String(s.bitrate) };
        saveSettings(settings);
      }
      return settings;
    });
  }

  app.whenReady().then(() => {
    settings = loadSettings();
    try {
      converter = new Converter(getFfmpegPath());
    } catch (e) {
      dialog.showErrorBox('MP3 Converter', `Не найден ffmpeg: ${e.message}`);
      app.quit();
      return;
    }
    setupIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
