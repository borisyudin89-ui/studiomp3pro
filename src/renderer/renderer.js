'use strict';

const $ = (id) => document.getElementById(id);
const jobs = new Map();
let running = false;

const STATUS = {
  queued: 'в очереди',
  running: 'конвертация',
  done: 'готово',
  error: 'ошибка',
  skipped: 'пропущен',
  cancelled: 'отменено',
};

function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function renderRow(job) {
  const list = $('list');
  let li = document.getElementById(`job-${job.id}`);
  if (!li) {
    li = document.createElement('li');
    li.id = `job-${job.id}`;
    li.innerHTML =
      '<div class="row-top"><span class="row-name"></span><span class="row-status"></span></div>' +
      '<div class="row-bar"><div></div></div><div class="row-msg" hidden></div>';
    list.appendChild(li);
  }
  li.className = `row ${job.status}`;
  const nameEl = li.querySelector('.row-name');
  nameEl.textContent = job.name;
  nameEl.title = job.input;

  const st = li.querySelector('.row-status');
  st.textContent = '';
  let text = STATUS[job.status] || job.status;
  if (job.status === 'running') text += ` ${job.progress}%`;
  if (job.status === 'done' && job.outSize != null) text += ` · ${fmtSize(job.outSize)}`;
  st.append(text);
  if (job.status === 'done' && job.output) {
    const b = document.createElement('button');
    b.className = 'reveal';
    b.textContent = 'Показать в папке';
    b.dataset.id = String(job.id);
    st.append(b);
  }
  li.querySelector('.row-bar > div').style.width = `${job.progress}%`;
  const msg = li.querySelector('.row-msg');
  if (job.status === 'error' && job.error) {
    msg.textContent = job.error;
    msg.hidden = false;
  } else {
    msg.hidden = true;
  }
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
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || e.target === document.documentElement || e.relatedTarget === null) {
      drop.classList.remove('over');
    }
  })
);
window.addEventListener('drop', (e) => {
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
$('bitrate').addEventListener('change', (e) => window.api.setSettings({ bitrate: e.target.value }));

window.api.getSettings().then((s) => {
  $('bitrate').value = s.bitrate;
});
refresh();
