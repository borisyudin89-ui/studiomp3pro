'use strict';

// Путь к ffmpeg. В упакованном приложении бинарник лежит в app.asar.unpacked.
function getFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  let p = require('ffmpeg-static');
  if (!p) throw new Error('ffmpeg-static не нашёл бинарник ffmpeg для этой платформы');
  p = p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
  return p;
}

module.exports = { getFfmpegPath };
