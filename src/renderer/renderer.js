'use strict';

const $ = (id) => document.getElementById(id);
const jobs = new Map();
let running = false;

const TEXT = {
  queued: 'в очереди',
  skipped: 'уже MP3',
  cancelled: 'отменено',
};

// Статические иконки (без пользовательских данных, поэтому innerHTML безопасен)
const SVG = (inner) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICONS = {
  done: SVG('<path d="M3 8.5l3.2 3.2L13 5"/>'),
  running: SVG('<path d="M8 2.5a5.5 5.5 0 1 0 5.5 5.5"/>'),
  queued: SVG('<circle cx="8" cy="8" r="5.5"/>'),
  skipped: SVG('<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/>'),
  cancelled: SVG('<circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/>'),
  error: SVG('<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.5M8 11v0"/>'),
};

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function rightText(job) {
  switch (job.status) {
    case 'done': return fmtSize(job.outSize);
    case 'running': return `${job.progress}%`;
    case 'error': return job.error || 'ошибка';
    default: return TEXT[job.status] || job.status;
  }
}

function renderRow(job) {
  const list = $('list');
  let li = document.getElementById(`job-${job.id}`);
  if (!li) {
    li = document.createElement('li');
    li.id = `job-${job.id}`;
    li.innerHTML =
      '<div class="row-main"><span class="row-ico"></span><span class="row-name"></span><span class="row-right"></span></div>' +
      '<div class="row-bar"><div></div></div>';
    list.appendChild(li);
  }
  li.className = `row ${job.status}`;

  const ico = li.querySelector('.row-ico');
  if (ico.dataset.s !== job.status) {
    ico.innerHTML = ICONS[job.status] || ICONS.queued;
    ico.dataset.s = job.status;
  }

  const nameEl = li.querySelector('.row-name');
  nameEl.textContent = job.name;
  nameEl.title = job.input;

  const right = li.querySelector('.row-right');
  right.textContent = rightText(job);
  right.title = job.status === 'error' && job.error ? job.error : '';

  const main = li.querySelector('.row-main');
  let reveal = main.querySelector('.reveal');
  if (job.status === 'done' && job.output) {
    if (!reveal) {
      reveal = document.createElement('button');
      reveal.className = 'reveal';
      reveal.textContent = 'Показать';
      reveal.title = 'Показать в папке';
      main.appendChild(reveal);
    }
    reveal.dataset.id = String(job.id);
  } else if (reveal) {
    reveal.remove();
  }

  li.querySelector('.row-bar > div').style.width = `${job.progress}%`;
}

function refresh() {
  const all = [...jobs.values()];
  const total = all.length;
  const finished = all.filter((j) => ['done', 'error', 'skipped', 'cancelled'].includes(j.status)).length;
  const queued = all.filter((j) => j.status === 'queued').length;
  const errors = all.filter((j) => j.status === 'error').length;
  const avg = total ? all.reduce((s, j) => s + (j.progress || 0), 0) / total : 0;

  $('drop').classList.toggle('has-items', total > 0);
  $('list').hidden = total === 0;
  $('overallBar').style.width = `${Math.round(avg)}%`;

  const summary = $('summaryText');
  summary.hidden = total === 0;
  if (total) {
    let t = `Готово ${finished} из ${total}`;
    if (errors) t += ` · ошибок: ${errors}`;
    summary.textContent = t;
  }

  $('clear').hidden = total === 0;
  $('clear').disabled = running && all.every((j) => j.status === 'running');
  $('cancel').hidden = !running;
  $('start').disabled = running || queued === 0;
  $('start').textContent = running ? 'Идёт конвертация…' : 'Конвертировать';
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

// Клик по пустому месту поля выбирает файлы (по строкам списка и кнопкам — нет)
drop.addEventListener('click', (e) => {
  if (e.target.closest('.row') || e.target.closest('button')) return;
  window.api.pickFiles();
});
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
