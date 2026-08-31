// ============================================================
// check-sync.js — проверка общей разметки ДВУМЯ браузерами.
//
//   node tools\check-sync.js [--headed] [--port 8789]
//
// Что проверяется: то единственное, ради чего всё это делалось —
// отметка, поставленная одним человеком, доезжает до второго.
// Копия проверки дома (Task - search house in Kaliningrad\Rep\tools\
// check-sync.js) — протокол общий, различаются только имена (таблица
// sl вместо hs, столбец «до центра» вместо «минут», имя базы).
//
// Почему именно так, а не проще. «Страница собралась» и «запрос
// вернул 200» не доказывают ничего: слой синхронизации может писать
// на сервер и никогда не забирать чужое, и выглядеть это будет
// исправным ровно до дня, когда двое сядут размечать одновременно.
// Поэтому здесь два РАЗНЫХ БРАУЗЕРА — Edge и Chrome, у каждого своё
// localStorage и свой движок, как у двух людей на двух компьютерах.
// Chrome может быть не установлен: тогда второй участник — отдельный
// контекст Edge, и проверка об этом говорит, а не молчит.
//
// Проверяется не только доставка отметок: страница обязана открыться
// без ошибок JS, разметка — пережить перезагрузку у ОБОИХ, а фильтры и
// сортировка — работать у каждого своим порядком, не двигая чужую
// выборку, и переживать перезагрузку у того, кто их поставил (per-browser
// localStorage, без участия сервера).
//
// Сервер поднимается локальный (wrangler pages dev) с локальной базой,
// поэтому проверка ничего не пишет в боевую разметку.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PW = path.join(ROOT, '..', '..', '..', 'Job Search', 'agents', 'JS_Scraper',
  'node_modules', 'playwright');
const { chromium } = require(PW);

const HEADED = process.argv.indexOf('--headed') !== -1;
const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 8789;
})();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = fs.readFileSync(path.join(ROOT, '.sync-token'), 'utf8').trim();

let fails = 0;
let checks = 0;
function ok(cond, what) {
  checks++;
  if (cond) { console.log('  ок   ' + what); }
  else { fails++; console.error('  ПРОВАЛ ' + what); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ждём условия, а не «столько-то секунд»: фиксированная пауза либо
// растягивает проверку, либо врёт на медленной машине.
async function until(what, fn, ms = 30000, step = 500) {
  const till = Date.now() + ms;
  while (Date.now() < till) {
    let v = null;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    await sleep(step);
  }
  throw new Error('не дождались: ' + what);
}

// Правка человека уходит на сервер с задержкой (заметка иначе слала бы
// запрос на каждую букву). Прежде чем спрашивать со второго браузера,
// надо дождаться, пока очередь первого опустеет: иначе проверка ловит
// собственную гонку и выглядит как поломка синхронизации.
async function settle(page, кто) {
  await until('очередь ' + кто + ' опустела', async () =>
    await page.evaluate(() => window.slSync.state().pending === 0), 15000, 200);
}

function itogNote(m) {
  return !!(m && m.note && m.note.indexOf('дописываю') !== -1);
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
  else process.kill(pid);
}

async function main() {
  // Схема в локальной базе. Прогоняется каждый раз: таблиц может не
  // быть вовсе, а «CREATE TABLE IF NOT EXISTS» ничего не ломает.
  console.log('Схема в локальной базе…');
  const wrangler = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

  // База пересоздаётся ЦЕЛИКОМ, а не дочищается. Остатки прошлого
  // прогона делают стенд зелёным на сломанном коде — «отметка доехала»
  // может оказаться вчерашней; CREATE TABLE IF NOT EXISTS не добавит
  // новую колонку в уже существующую таблицу.
  const drop = spawnSync(process.execPath,
    [wrangler, 'd1', 'execute', 'kv-kgd-marks', '--local', '--yes',
      '--command=DROP TABLE IF EXISTS marks; DROP TABLE IF EXISTS marks_log; DROP TABLE IF EXISTS meta;'],
    { cwd: ROOT, encoding: 'utf8' });
  if (drop.status !== 0) {
    console.error(drop.stderr || drop.stdout);
    throw new Error('не удалось пересоздать локальную базу');
  }

  const schema = spawnSync(process.execPath,
    [wrangler, 'd1', 'execute', 'kv-kgd-marks', '--local', '--file=schema.sql', '--yes'],
    { cwd: ROOT, encoding: 'utf8' });
  if (schema.status !== 0) {
    console.error(schema.stderr || schema.stdout);
    throw new Error('схема не легла');
  }

  console.log(`Поднимаю сервер на ${BASE} …`);
  const srv = spawn(process.execPath, [wrangler, 'pages', 'dev', '--port', String(PORT), '--ip', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });

  let browser = null;
  let второй = null;
  try {
    await until('сервер отвечает', async () => {
      const r = await fetch(`${BASE}/api/marks?since=0`, { headers: { 'x-sync-token': TOKEN } });
      return r.ok;
    }, 90000).catch((e) => { console.error(log.slice(-1500)); throw e; });
    console.log('Сервер поднялся.\n');

    // ДВА РАЗНЫХ БРАУЗЕРА, а не две вкладки одного. Отдельный контекст
    // уже даёт своё localStorage, но общий движок скрывает целый класс
    // расхождений; страницу открывают на разных машинах и в разном
    // софте. Edge есть всегда, Chrome — не на всякой машине, поэтому его
    // отсутствие не проваливает проверку, а честно проговаривается.
    browser = await chromium.launch({ channel: 'msedge', headless: !HEADED });
    try {
      второй = await chromium.launch({ channel: 'chrome', headless: !HEADED });
    } catch (e) {
      console.log('Chrome не найден — второй участник будет отдельным контекстом Edge.');
    }
    console.log(`Браузеры: Алексей — Edge ${browser.version()}, `
      + `второй — ${второй ? 'Chrome ' + второй.version() : 'Edge, отдельный контекст'}\n`);

    // Два контекста — это два разных человека: у каждого своё
    // localStorage, свои отметки, своя очередь отправки.
    const errors = { 'Алексей': [], 'второй': [] };

    const mk = async (кто, где) => {
      const ctx = await (где || browser).newContext();
      await ctx.addInitScript((имя) => {
        try { localStorage.setItem('kgd-shortlist-marks-v1:who', имя); } catch (e) {}
      }, кто);
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors[кто].push(String(e.message).slice(0, 160)));
      await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await p.waitForSelector('#slBody tr', { timeout: 120000 });
      return p;
    };

    // Сколько строк показано сейчас. Берём из счётчика самой страницы,
    // а не считаем <tr>: расхождение этих двух чисел — тоже поломка.
    const shown = async (p) => await p.evaluate(() => {
      const t = (document.getElementById('slCount') || {}).textContent || '';
      const m = t.match(/показано (\d+) из (\d+)/);
      const rows = document.querySelectorAll('#slBody tr').length;
      return m ? { показано: +m[1], всего: +m[2], строк: rows } : null;
    });

    console.log('Открываю страницу как два разных человека…');
    const A = await mk('Алексей');
    const B = await mk('второй', второй);

    // Берём первую отрисованную строку — какая именно, неважно.
    const id = await A.evaluate(() => {
      const b = document.querySelector('#slBody .mkb');
      return b ? b.dataset.id : null;
    });
    if (!id) throw new Error('в таблице не нашлось кнопки метки');
    console.log(`Объект для проверки: ${id}\n`);

    const sel = (cls) => `#slBody .mkb[data-id="${id}"][data-c="${cls}"]`;

    // --- 1. метка доезжает ---
    console.log('1. Алексей ставит зелёную метку');
    await A.click(sel('g'));
    await settle(A, 'Алексея');
    await until('метка приехала ко второму', async () =>
      await B.evaluate((x) => {
        const m = window.slStore.marks()[x];
        return !!(m && m.c === 'g');
      }, id));
    ok(true, 'зелёная метка доехала до второго браузера');
    const painted = await B.evaluate((x) => {
      const btn = document.querySelector('#slBody .mkb[data-id="' + CSS.escape(x) + '"]');
      const tr = btn ? btn.closest('tr') : null;
      return !!(tr && tr.classList.contains('mk-g'));
    }, id).catch(() => false);
    ok(painted, 'строка у второго перерисовалась в зелёный, а не только обновилась в памяти');

    // --- 2. заметка доезжает ---
    console.log('\n2. Второй пишет заметку');
    const текст = 'смотрели 31 августа, шумно от дороги';
    await B.fill(`#slBody .sl-note[data-id="${id}"]`, текст);
    await settle(B, 'второго');
    await until('заметка приехала к Алексею', async () =>
      await A.evaluate((o) => {
        const m = window.slStore.marks()[o.id];
        return !!(m && m.note === o.t);
      }, { id, t: текст }));
    ok(true, 'заметка доехала в обратную сторону');

    // --- 3. одновременная правка разных полей одного объекта ---
    // Здесь ловится самая дорогая ошибка этого слоя: Алексей меняет
    // ТОЛЬКО метку, но если в запрос уедет вся запись целиком, вместе
    // с меткой уедет и его копия заметки — устаревшая ровно на те
    // секунды, пока второй её дописывал. Заметка молча заменится старой
    // версией.
    console.log('\n3. Второй дописывает заметку, Алексей в это же время меняет метку');
    await B.focus(`#slBody .sl-note[data-id="${id}"]`);
    await B.type(`#slBody .sl-note[data-id="${id}"]`, ' и ещё дописываю');
    await A.click(sel('r'));            // Алексей меняет метку в это же время
    await settle(A, 'Алексея');

    const целость = await B.evaluate((x) =>
      document.querySelector('#slBody .sl-note[data-id="' + CSS.escape(x) + '"]').value, id);
    ok(целость.indexOf('и ещё дописываю') !== -1,
      'текст под курсором пережил приход чужой правки');

    await settle(B, 'второго');
    await A.evaluate(() => window.slSync.poll());
    await B.evaluate(() => window.slSync.poll());
    await sleep(1500);

    const итог = await A.evaluate((x) => window.slStore.marks()[x], id);
    ok(itogNote(итог), 'заметка второго НЕ затёрта чужой правкой метки');
    ok(итог && итог.c === 'r', 'метка Алексея при этом на месте');

    // --- 4. снятие доезжает ---
    console.log('\n4. Алексей снимает метку и стирает заметку');
    await B.evaluate(() => document.activeElement && document.activeElement.blur());
    await A.click(sel('r'));                                  // повторный клик снимает
    await A.fill(`#slBody .sl-note[data-id="${id}"]`, '');
    await settle(A, 'Алексея');
    await B.evaluate(() => window.slSync.poll());
    await until('снятие доехало до второго', async () =>
      await B.evaluate((x) => !window.slStore.marks()[x], id));
    ok(true, 'снятие метки и заметки доехало до второго браузера');

    // --- 5. состояние связи проговаривается ---
    const текстПанели = await A.evaluate(() =>
      (document.getElementById('slStoreTxt') || {}).textContent || '');
    ok(текстПанели.indexOf('общая разметка') !== -1,
      'панель говорит, что разметка общая: «' + текстПанели.trim().slice(0, 60) + '»');

    // --- 6. разметка переживает перезагрузку у ОБОИХ ---
    // Звёздная оценка ремонта (rating) добавлена в эту же проверку
    // 2026-08-31 — именно она молча терялась на сервере до починки
    // Rep/functions/api/marks.js (схема D1 была скопирована с дома,
    // где опции rating у review-table.js никогда не было).
    console.log('\n6. Метка, заметка и звёздная оценка переживают перезагрузку у обоих');
    const заметка2 = 'звонил, договорились на субботу';
    await A.click(sel('y'));
    await A.fill(`#slBody .sl-note[data-id="${id}"]`, заметка2);
    await A.click(`#slBody .sl-star[data-id="${id}"][data-v="4"]`);
    await settle(A, 'Алексея');
    await B.evaluate(() => window.slSync.poll());
    await sleep(800);

    const рейтингУВторого = await B.evaluate((x) => {
      const m = window.slStore.marks()[x];
      return m ? m.rating : null;
    }, id);
    ok(рейтингУВторого === 4, 'звёздная оценка доехала до второго браузера ДО перезагрузки');

    for (const [p, кто] of [[A, 'у поставившего'], [B, 'у второго']]) {
      await p.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await p.waitForSelector('#slBody tr', { timeout: 120000 });
      const m = await until('разметка поднялась после перезагрузки ' + кто, async () =>
        await p.evaluate((x) => {
          const v = window.slStore.marks()[x];
          return v && v.c ? v : null;
        }, id));
      ok(m.c === 'y' && m.note === заметка2, `метка и заметка на месте после перезагрузки ${кто}`);
      ok(m.rating === 4, `звёздная оценка (4 из 5) на месте после перезагрузки ${кто}`);
      const виден = await p.evaluate((x) => {
        const el = document.querySelector('#slBody .sl-note[data-id="' + CSS.escape(x) + '"]');
        const btn = document.querySelector('#slBody .mkb[data-id="' + CSS.escape(x) + '"]');
        const tr = btn ? btn.closest('tr') : null;
        const stars = document.querySelectorAll('#slBody .sl-star[data-id="' + CSS.escape(x) + '"].on').length;
        return { заметка: el ? el.value : null, цвет: tr ? tr.className : null, звёзд: stars };
      }, id);
      ok(виден.заметка === заметка2 && /mk-y/.test(виден.цвет || ''),
        `после перезагрузки это ВИДНО в таблице ${кто}, а не только лежит в памяти`);
      ok(виден.звёзд === 4, `после перезагрузки закрашено ровно 4 звезды из 5 в таблице ${кто}`);
    }

    // Убираем тестовую оценку — иначе она останется в общей разметке.
    await A.click(`#slBody .sl-star[data-id="${id}"][data-v="4"]`);
    await settle(A, 'Алексея');

    // --- 7. фильтры и сортировка ---
    console.log('\n7. Фильтры и сортировка — у каждого свои');
    const было = await shown(A);
    ok(было && было.показано === было.строк,
      `счётчик сходится с таблицей: показано ${было.показано} из ${было.всего}, строк ${было.строк}`);

    // Порог берём ИЗ ДАННЫХ, а не придумываем: заведомо отсекающий часть
    // показанного, иначе фильтр не сужает выборку и проверка ничего не
    // доказывает.
    const значения = async (p, key) => await p.evaluate((k) => {
      const ths = [...document.querySelectorAll('#slHead th')];
      const i = ths.findIndex((t) => t.dataset.sort === k);
      if (i === -1) return [];
      return [...document.querySelectorAll('#slBody tr')].map((tr) => {
        const td = tr.children[i];
        const v = Number(String(td ? td.textContent : '').replace(/[^\d,]/g, '').replace(',', '.'));
        return Number.isFinite(v) && v > 0 ? v : null;
      });
    }, key);

    const дистанции = (await значения(A, 'dist')).filter((v) => v != null).sort((a, b) => a - b);
    const порог = дистанции[Math.floor(дистанции.length / 3)];
    await A.fill('#slDist', String(порог));
    await A.dispatchEvent('#slDist', 'change');
    await sleep(500);
    const послеФильтра = await shown(A);
    ok(послеФильтра.показано < было.показано && послеФильтра.показано > 0,
      `фильтр «до центра ≤ ${порог}» сузил выборку: ${было.показано} → ${послеФильтра.показано}`);
    ok(послеФильтра.показано === послеФильтра.строк, 'после фильтра счётчик по-прежнему сходится с таблицей');

    const уВторого = await shown(B);
    ok(уВторого.показано === было.показано,
      `отбор Алексея не сдвинул выборку у второго: у него по-прежнему ${уВторого.показано}`);

    await A.click('#slReset');
    await sleep(500);
    ok((await shown(A)).показано === было.показано, 'сброс фильтров вернул выборку к умолчанию');

    // Сортировка по цене (4-я колонка: метка, город, адрес, цена):
    // щелчок по заголовку переставляет строки, повторный разворачивает
    // порядок. Проверяем не «класс появился», а реальный порядок цен
    // в отрисованных строках.
    const цены = async (p) => (await p.$$eval('#slBody tr td:nth-child(4)',
      (tds) => tds.map((td) => Number(String(td.textContent).replace(/[^\d,]/g, '').replace(',', '.')))))
      .filter((v) => Number.isFinite(v) && v > 0);
    await A.click('#slHead th[data-sort="price"]');
    await sleep(400);
    const вверх = await цены(A);
    ok(вверх.length > 1 && вверх.every((v, i) => i === 0 || v >= вверх[i - 1]),
      `сортировка по цене по возрастанию: ${вверх[0]} … ${вверх[вверх.length - 1]} млн`);
    await A.click('#slHead th[data-sort="price"]');
    await sleep(400);
    const вниз = await цены(A);
    ok(вниз.length > 1 && вниз[0] >= вниз[вниз.length - 1] && вниз[0] === вверх[вверх.length - 1],
      `повторный щелчок развернул порядок: ${вниз[0]} … ${вниз[вниз.length - 1]} млн`);

    // Разметка обязана оставаться на СВОЁМ объекте при любой сортировке.
    const наМесте = await A.evaluate((x) => {
      const btn = document.querySelector('#slBody .mkb[data-id="' + CSS.escape(x) + '"]');
      const tr = btn ? btn.closest('tr') : null;
      if (!tr) return 'строка отфильтрована';
      const note = tr.querySelector('.sl-note');
      return { цвет: tr.className, заметка: note ? note.value : null };
    }, id);
    ok(наМесте === 'строка отфильтрована'
      || (/mk-y/.test(наМесте.цвет) && наМесте.заметка === заметка2),
    'после пересортировки метка и заметка остались на своём объекте');

    // Персистентность фильтров/сортировки — per-browser (своё localStorage
    // у каждого), сервер тут не участвует вообще. Периметр сохранения —
    // ЛЮБОЙ активный элемент, сужающий выборку, включая цветные метки и
    // «только с заметкой» (решение зафиксировано на дашборде дома
    // 2026-08-22, компонент общий — переносится сюда без изменений).
    await A.click('#slMarkFilter button[data-mark="g"]');
    await sleep(300);
    const сЦветомДоF5 = await shown(A);
    await A.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    // Не '#slBody tr' — с применённым цветовым фильтром список может
    // оказаться пустым, и ждать несуществующую строку было бы вечно.
    await A.waitForSelector('#slCount', { timeout: 120000 });
    await sleep(300);
    const послеF5 = await shown(A);
    ok(послеF5.показано === сЦветомДоF5.показано && послеF5.показано !== было.показано,
      `цветовой фильтр (не только диапазоны/сортировка) пережил перезагрузку: ${сЦветомДоF5.показано} → ${послеF5.показано} (было без фильтра ${было.показано})`);
    const кнопкаЗелёнаяПослеF5 = await A.evaluate(() =>
      (document.querySelector('#slMarkFilter button[data-mark="g"]') || {}).classList.contains('on'));
    ok(кнопкаЗелёнаяПослеF5, 'кнопка «зелёные» после перезагрузки по-прежнему выглядит нажатой');
    await A.click('#slMarkFilter button[data-mark=""]');
    await sleep(300);
    ok((await shown(A)).показано === было.показано, 'кнопка «все» вернула к полному списку после проверки');

    const сортПослеF5 = await A.evaluate(() => {
      const th = document.querySelector('#slHead th[data-sort="price"]');
      return th ? th.getAttribute('data-dir') : null;
    });
    ok(сортПослеF5 === 'down',
      'сортировка по цене (по убыванию) тоже пережила перезагрузку у того же браузера');

    // У второго браузера, который фильтры вообще не трогал, — свои
    // умолчания по-прежнему на месте.
    await B.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
    await B.waitForSelector('#slBody tr', { timeout: 120000 });
    const уВторогоПослеF5 = await shown(B);
    ok(уВторогоПослеF5.показано === было.показано,
      `у второго браузера, не трогавшего фильтры, умолчания на месте: ${уВторогоПослеF5.показано}`);

    // --- 7б. фильтр по цвету/меткам — multiselect ---
    await A.click('#slReset');
    await sleep(400);
    await A.evaluate((x) => {
      const btn = document.querySelector('#slBody .mkb[data-id="' + CSS.escape(x) + '"][data-c="y"]');
      if (btn) btn.click();
    }, id);
    await A.fill(`#slBody .sl-note[data-id="${id}"]`, '').catch(() => {});
    await settle(A, 'Алексея');
    await sleep(300);
    const дваОбъекта = await A.evaluate(() =>
      [...document.querySelectorAll('#slBody .mkb[data-c="g"]')].slice(0, 2).map((b) => b.dataset.id));
    if (дваОбъекта.length === 2) {
      const [первый, второй_id] = дваОбъекта;
      await A.click(`#slBody .mkb[data-id="${первый}"][data-c="g"]`);
      await A.click(`#slBody .mkb[data-id="${второй_id}"][data-c="y"]`);
      await sleep(300);
      await A.click('#slMarkFilter button[data-mark="g"]');
      await A.click('#slMarkFilter button[data-mark="y"]');
      await sleep(300);
      const обаЦветаВидны = await A.evaluate(() =>
        [...document.querySelectorAll('#slBody tr')].every((tr) =>
          tr.classList.contains('mk-g') || tr.classList.contains('mk-y')));
      ok(обаЦветаВидны, 'выбор двух цветов одновременно — объединение (ИЛИ), оба на экране');

      await A.click('#slHasNote');
      await sleep(300);
      const сЗаметкойСредиЦветных = await shown(A);
      ok(сЗаметкойСредиЦветных.показано === 0,
        '«есть заметка» пересекается (И) с выбором цвета — у тестовых меток нет заметки, список пуст');

      await A.click('#slHasNote');
      await A.click('#slMarkFilter button[data-mark=""]');
      await sleep(300);
      ok((await shown(A)).показано === было.показано,
        'кнопка «все» сбрасывает выбор цвета к полному списку');

      await A.click(`#slBody .mkb[data-id="${первый}"][data-c="g"]`);
      await A.click(`#slBody .mkb[data-id="${второй_id}"][data-c="y"]`);
      await settle(A, 'Алексея');
    } else {
      console.log('  (пропущено: не нашлось двух разных строк для проверки multiselect)');
    }

    // --- 7в. сохранение — делегированием, работает и для НЕИЗВЕСТНОГО панели контрола ---
    await A.evaluate(() => {
      window.__saveCalls = 0;
      var orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = function (k, v) {
        if (k.indexOf(':view:sl') !== -1) window.__saveCalls++;
        return orig(k, v);
      };
      var el = document.createElement('input');
      el.type = 'checkbox';
      el.id = 'slRogueTestControl';
      document.getElementById('slControls').appendChild(el);
    });
    await A.click('#slRogueTestControl');
    await sleep(200);
    const вызовыСохранения = await A.evaluate(() => window.__saveCalls);
    ok(вызовыСохранения > 0,
      'сохранение сработало и для контрола, добавленного в панель без ведома компонента — делегирование, не поштучная проводка');
    await A.evaluate(() => { var el = document.getElementById('slRogueTestControl'); if (el) el.remove(); });

    // --- 8. страница открылась без ошибок у обоих ---
    ok(errors['Алексей'].length === 0 && errors['второй'].length === 0,
      'ошибок JS ни в одной вкладке за весь прогон: '
      + ([...errors['Алексей'], ...errors['второй']].join(' | ') || 'нет'));

  } finally {
    if (browser) await browser.close().catch(() => {});
    if (второй) await второй.close().catch(() => {});
    killTree(srv.pid);
  }

  console.log(fails
    ? `\ncheck-sync: ПРОВАЛОВ ${fails} из ${checks}`
    : `\ncheck-sync: ${checks} проверок пройдено — разметка общая и доезжает в обе стороны`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('\nОшибка: ' + e.message); process.exit(1); });
