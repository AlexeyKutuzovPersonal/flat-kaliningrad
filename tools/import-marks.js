// ============================================================
// import-marks.js — перенос разметки из локального файла в общую базу.
//
// Метки лежали в localStorage локального сервера (tools/marks-server.js,
// см. Task - search flat in Kalningrad/CLAUDE.md) до переезда на
// Cloudflare Pages + D1. Здесь они переезжают на сервер.
//
//   node tools\import-marks.js <файл>                 сухой прогон
//   node tools\import-marks.js <файл> --apply         запись в базу
//   node tools\import-marks.js <файл> --author Алексей --url https://...
//
// Принимает оба носителя:
//   *.json  — кнопка «Только отметки»       (поле сырыеОтметки)
//   *.html  — «Сохранить страницу с отметками» (блок slSeed)
//
// ------------------------------------------------------------------
// Почему сухой прогон по умолчанию.
//
// Отметка привязана к id объявления, а id собран из его ссылки. Между
// выгрузками ссылка иногда меняется — и отметка повисает в воздухе.
// Молча записать «перенесено 118» там, где легло 74, значит потерять
// чужую работу так, что этого никто не заметит. Поэтому сначала
// показываем расклад, и только потом, отдельной командой, пишем.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------
// Приведение id к устойчивому виду.
//
// В сборке от 20 августа домкликовские ссылки встречаются с двумя
// хостами: kaliningrad.domclick.ru/card/... и domclick.ru/card/...
// Один и тот же дом, разные id, отметка не находит объект.
//
// Поэтому сравниваем не по ссылке, а по НОМЕРУ объявления внутри неё:
// он у площадки свой и хост с городом переживает. Где номер не
// вынимается — откатываемся на ссылку целиком, но уже без хоста.
// ---------------------------------------------------------------
function norm(id) {
  const s = String(id || '').trim();
  const cut = s.indexOf(':');
  if (cut === -1) return s.toLowerCase();
  const src = s.slice(0, cut).toLowerCase();
  const url = s.slice(cut + 1).toLowerCase().split('?')[0].replace(/\/+$/, '');

  // Номер объявления — последняя длинная цифровая группа в ссылке.
  const digits = url.match(/[0-9]{6,}/g);
  if (digits && digits.length) return src + ':#' + digits[digits.length - 1];

  return src + ':' + url.replace(/^https?:\/\/(www\.)?/, '').replace(/^[a-z-]+\./, '');
}

// ---------------------------------------------------------------
// Чтение носителя.
// ---------------------------------------------------------------
function readMarks(file) {
  const raw = fs.readFileSync(file, 'utf8');

  if (/\.html?$/i.test(file)) {
    const m = raw.match(/id="slSeed"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('В этом html нет блока slSeed — страница сохранена без отметок');
    const seed = JSON.parse(m[1]);
    return { marks: seed.marks || {}, savedAt: seed.savedAt || null };
  }

  const j = JSON.parse(raw);
  const marks = j.сырыеОтметки || j.marks || j;
  if (!marks || typeof marks !== 'object') throw new Error('В файле не нашлось карты отметок');
  return { marks, savedAt: j.savedAt || null };
}

// ---------------------------------------------------------------
// Объекты, которые есть на текущей странице.
// ---------------------------------------------------------------
function pageRows(pageFile) {
  const html = fs.readFileSync(pageFile, 'utf8');
  const rows = [];
  const re = /<script type="application\/json" id="(\w+)Data">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    for (const r of JSON.parse(m[2])) rows.push(r);
  }
  if (!rows.length) throw new Error('На странице не нашлось ни одной таблицы с данными');
  return rows;
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function token() {
  if (process.env.SYNC_TOKEN) return process.env.SYNC_TOKEN;
  const f = path.join(ROOT, '.sync-token');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('Нет токена: положите его в Rep\\.sync-token или задайте SYNC_TOKEN');
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sync-token': token() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch (e) {
    throw new Error('Ответ сервера не JSON — вероятно, это страница входа: ' + text.slice(0, 120));
  }
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error('Укажите файл: node tools\\import-marks.js <файл.json|файл.html> [--apply]');
    process.exit(2);
  }
  const apply = process.argv.indexOf('--apply') !== -1;
  const author = arg('--author', 'Алексей');
  const url = arg('--url', 'http://127.0.0.1:8788/api/marks');
  const page = arg('--page', path.join(ROOT, 'public', 'index.html'));

  const { marks, savedAt } = readMarks(file);
  const rows = pageRows(page);

  // Карта «устойчивый ключ → id, под которым объект лежит на странице».
  const byNorm = new Map();
  for (const r of rows) byNorm.set(norm(r.id), r);

  const landed = {};
  const orphans = [];
  let empty = 0;

  for (const [id, m] of Object.entries(marks)) {
    const mark = m || {};
    // rating тоже считается содержимым — метка ТОЛЬКО со звёздами, без
    // цвета/заметки/отделки, иначе тихо попадала бы в «пустые».
    if (!mark.c && !mark.note && !mark.fin && mark.rating == null) { empty++; continue; }
    const hit = byNorm.get(norm(id));
    if (hit) {
      landed[hit.id] = { c: mark.c || null, note: mark.note || null, fin: mark.fin || null, rating: mark.rating ?? null };
    } else {
      orphans.push({ id, отметка: mark.c || null, заметка: mark.note || null, отделка: mark.fin || null, рейтинг: mark.rating ?? null });
    }
  }

  const nL = Object.keys(landed).length;
  console.log(`Файл: ${path.basename(file)}${savedAt ? ', сохранён ' + savedAt : ''}`);
  console.log(`Отметок в файле: ${Object.keys(marks).length}` + (empty ? ` (из них пустых: ${empty})` : ''));
  console.log(`Объектов на странице: ${rows.length}`);
  console.log(`Легло на объекты: ${nL}`);
  console.log(`Повисло без объекта: ${orphans.length}`);

  if (orphans.length) {
    console.log('\nПовисшие — объявление сменило ссылку или ушло из выдачи:');
    for (const o of orphans.slice(0, 20)) {
      console.log(`  ${o.id}`);
      if (o.заметка) console.log(`      заметка: ${o.заметка.slice(0, 90)}`);
    }
    if (orphans.length > 20) console.log(`  … и ещё ${orphans.length - 20}`);

    const rep = path.join(ROOT, 'backup', `orphans-${new Date().toISOString().slice(0, 10)}.json`);
    fs.mkdirSync(path.dirname(rep), { recursive: true });
    fs.writeFileSync(rep, JSON.stringify(orphans, null, 1));
    console.log(`\nСписок целиком: ${path.relative(process.cwd(), rep)}`);
  }

  if (!apply) {
    console.log('\nЭто сухой прогон. Записать в базу: добавьте --apply');
    return;
  }

  // Повисшие пишем ТОЖЕ. Объявление может вернуться в выдачу — вместе
  // с ним вернётся и отметка. Выбросить их значит принять решение за
  // человека, который эту заметку писал.
  const all = Object.assign({}, landed);
  for (const o of orphans) {
    all[o.id] = { c: o.отметка, note: o.заметка, fin: o.отделка, rating: o.рейтинг };
  }

  const ids = Object.keys(all);
  const CHUNK = 500;
  let sent = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = {};
    for (const id of ids.slice(i, i + CHUNK)) part[id] = all[id];
    const j = await post(url, { by: author, changes: part });
    sent += j.принято || 0;
    console.log(`  отправлено ${sent} из ${ids.length} (rev ${j.rev})`);
  }
  console.log(`\nЗаписано: ${sent} (легло ${nL}, повисших сохранено ${orphans.length}) от имени «${author}»`);
}

main().catch((e) => { console.error('Ошибка: ' + e.message); process.exit(1); });
