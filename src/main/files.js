'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED = new Set([
  'm4a', 'wav', 'flac', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'aifc',
  'alac', 'caf', 'ape', 'wv', 'amr', 'mp2', 'webm', 'mp4', 'mov', 'mkv', 'mp3',
]);

function extOf(p) {
  return path.extname(p).slice(1).toLowerCase();
}

function isSupported(p) {
  return SUPPORTED.has(extOf(p));
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // скрытые файлы, .part, ._ на macOS
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out);
    } else if (e.isFile()) {
      const ext = extOf(e.name);
      if (SUPPORTED.has(ext) && ext !== 'mp3') out.push({ path: full });
    }
  }
}

// Принимает список файлов и папок. Возвращает [{ path, skip?: 'mp3' }].
async function collect(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try {
      st = await fs.promises.stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      await walk(p, out);
    } else if (st.isFile()) {
      const name = path.basename(p);
      if (name.startsWith('._')) continue;
      const ext = extOf(name);
      if (ext === 'mp3') out.push({ path: p, skip: 'mp3' });
      else if (SUPPORTED.has(ext)) out.push({ path: p });
    }
  }
  const seen = new Set();
  const uniq = out.filter((x) => (seen.has(x.path) ? false : (seen.add(x.path), true)));
  uniq.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  return uniq;
}

// Уникальное имя результата: name.mp3, name (1).mp3, name (2).mp3 ...
// `reserved` — множество уже занятых (в этой партии) путей в нижнем регистре.
function uniqueOutputPath(dir, baseName, reserved = new Set()) {
  let n = 0;
  let candidate;
  do {
    const suffix = n === 0 ? '' : ` (${n})`;
    candidate = path.join(dir, `${baseName}${suffix}.mp3`);
    n++;
  } while (fs.existsSync(candidate) || reserved.has(candidate.toLowerCase()));
  reserved.add(candidate.toLowerCase());
  return candidate;
}

module.exports = { SUPPORTED, isSupported, collect, uniqueOutputPath, extOf };
