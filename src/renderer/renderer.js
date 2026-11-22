'use strict';

const $ = (id) => document.getElementById(id);
const jobs = new Map();
let running = false;

const STATUS = {
  queued: 'В очереди',
  running: '',
  done: 'Готово',
  error: 'Ошибка',
  skipped: 'Уже MP3',
  cancelled: 'Отменено',
};

function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function splitName(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, i), ext: name.slice(i + 1).toUpperCase() };
}

function renderRow(job) {
  const list = $('list');
  let li = document.getElementById(`job-${job.id}`);
  if (!li) {
    li = document.createElement('li');
    li.id = `job-${job.id}`;
    li.innerHTML =
      '<div class="c-name"><span class="badge"></span><span class="row-name"></span></div>' +
      '<div class="c-status"><span class="st-text"></span><div class="pbar"><div></div></div><span class="pct"></span></div>' +
      '<div class="c-size"></div>';
    list.appendChild(li);
  }
  li.className = `row ${job.status}`;

  const { stem, ext } = splitName(job.name);
  const badge = li.querySelector('.badge');
  badge.textContent = ext || '—';
  badge.hidden = !ext;
  const nameEl = li.querySelector('.row-name');
  nameEl.textContent = stem;
  nameEl.title = job.input;

  const cs = li.querySelector('.c-status');
  const stText = cs.querySelector('.st-text');
  stText.textContent = job.status === 'error' && job.error ? job.error : STATUS[job.status] || job.status;
  stText.title = job.status === 'error' && job.error ? job.error : '';
  cs.querySelector('.pbar > div').style.width = `${job.progress}%`;
  cs.querySelector('.pct').textContent = `${job.progress}%`;

  let reveal = cs.querySelector('.reveal');
  if (job.status === 'done' && job.output) {
    if (!reveal) {
      reveal = document.createElement('button');
      reveal.className = 'reveal';
      reveal.textContent = 'Показать';
      reveal.title = 'Показать в папке';
      cs.appendChild(reveal);
    }
    reveal.dataset.id = String(job.id);
  } else if (reveal) {
    reveal.remove();
  }

  li.querySelector('.c-size').textContent = job.status === 'done' ? fmtSize(job.outSize) : '—';
}

function refresh() {
  const all = [...jobs.values()];
  const total = all.length;
  const finished = all.filter((j) => ['done', 'error', 'skipped', 'cancelled'].includes(j.status)).length;
  const queued = all.filter((j) => j.status === 'queued').length;
  const errors = all.filter((j) => j.status === 'error').length;
  const avg = total ? all.reduce((s, j) => s + (j.progress || 0), 0) / total : 0;

  $('overallBar').style.width = `${Math.round(avg)}%`;
  if (!total) $('summaryText').textContent = 'Список пуст';
  else {
    let t = `Готово ${finished} из ${total}`;
    if (errors) t += ` · ошибок: ${errors}`;
    $('summaryText').textContent = t;
  }
  $('start').disabled = running || queued === 0;
  $('cancel').disabled = !running;
  $('clear').disabled = running && all.every((j) => j.status === 'running');
  $('start').textContent = running ? 'Идёт конвертация…' : 'Конвертировать';

  let empty = document.getElementById('empty');
  if (!total) {
    if (!empty) {
      empty = document.createElement('li');
      empty.id = 'empty';
      empty.className = 'empty';
      empty.textContent = 'Добавьте файлы — они появятся здесь';
      $('list').appendChild(empty);
    }
  } else if (empty) {
    empty.remove();
  }
}

window.api.onJob((job) => {
  jobs.set(job.id, job);
  renderRow(job);
  refresh();
});
window.api.onBatchState((s) => {
  running = s.running;
  refresh();
});

// --- добавление файлов ---
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  })
);
window.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (e.relatedTarget === null) drop.classList.remove('over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
  if (paths.length) window.api.addPaths(paths);
});

$('pickFiles').addEventListener('click', () => window.api.pickFiles());
$('pickFolder').addEventListener('click', () => window.api.pickFolder());
$('start').addEventListener('click', () => window.api.start());
$('cancel').addEventListener('click', () => window.api.cancel());
$('clear').addEventListener('click', async () => {
  const removed = await window.api.clear();
  for (const id of removed) {
    jobs.delete(id);
    const li = document.getElementById(`job-${id}`);
    if (li) li.remove();
  }
  refresh();
});
$('list').addEventListener('click', (e) => {
  const b = e.target.closest('.reveal');
  if (b) window.api.reveal(Number(b.dataset.id));
});

// --- качество ---
$('bitrate').addEventListener('change', (e) => window.api.setSettings({ bitrate: e.target.value }));
window.api.getSettings().then((s) => {
  $('bitrate').value = s.bitrate;
});

refresh();
