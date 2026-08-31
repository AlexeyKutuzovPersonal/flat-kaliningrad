// ============================================================
// stamp-updated.js — отметка «когда эта версия выложена» в шапке
// страницы.
//
// Что она означает. Ровно одно: момент, когда страница в этом виде
// поехала к читателю. Не когда сняты данные (это отдельная дата в
// шапке) и не когда запускался генератор. Штамп ставится хуком
// pre-commit и ТОЛЬКО если в коммит попадает сам public/index.html:
// правка README или ночной снимок разметки страницу не меняют, и
// двигать отметку они не должны. Отметка, которая шевелится без
// причины, перестаёт что-либо значить на второй неделе.
//
// Почему разметка блока живёт здесь, а не в генераторе. Её пишут
// двое: генератор при сборке (начальное значение) и хук при коммите
// (окончательное). Две копии разметки разъехались бы при первой же
// правке вёрстки, и половина сборок молча получала бы старый вид.
// Генератор зовёт этот же модуль — Rep лежит внутри папки задачи.
//
// Почему подстановка блока своя, а не lib/splice.js. Rep обязан
// работать голым клоном: его GitHub Action делает checkout только
// этой папки, и общей библиотеки задачи там нет. Замена между двумя
// маркерами — десять строк, и ради них тянуть за собой полдерева
// проекта нельзя.
//
//   node tools\stamp-updated.js public\index.html
//   node tools\stamp-updated.js public\index.html --iso 2026-08-20T14:42:11Z
//
// Самопроверка:  node tools\stamp-updated.js --self
// ============================================================

'use strict';

const fs = require('fs');

const MARK = 'UPDATED';
const OPEN = '<!-- ' + MARK + ':START -->';
const CLOSE = '<!-- ' + MARK + ':END -->';

// Пояс для запасной подписи. Скрипт на странице перепишет время в пояс
// читателя, но если он почему-то не отработает, число обязано остаться
// осмысленным — а читает страницу отец, он в Калининграде.
const FALLBACK_TZ = 'Europe/Kaliningrad';

/** Человеческая подпись времени в заданном поясе. */
function humanTime(iso, tz) {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: tz,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Разметка блока отметки.
 *
 * В атрибуте datetime — машинный UTC, в тексте — запасная подпись по
 * Калининграду. Скрипт рядом переписывает текст во время читателя и
 * приписывает пояс сам (GMT+2, GMT+5): страницу открывают из разных
 * поясов, и время без пояса каждый прочитает как своё.
 *
 * @param {string} iso момент выкладки в ISO
 * @returns {string} html блока
 */
function stampBlock(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error('stamp-updated: не дата — ' + iso);
  const utc = d.toISOString();
  return [
    '  <p class="updated">',
    '    <span class="updated-dot" aria-hidden="true"></span>',
    '    Страница обновлена <time datetime="' + utc + '" data-updated>'
      + humanTime(utc, FALLBACK_TZ) + ' по Калининграду</time>',
    '  </p>',
    '  <script>',
    '  (function () {',
    '    var t = document.querySelector(\'time[data-updated]\');',
    '    if (!t) return;',
    '    var d = new Date(t.getAttribute(\'datetime\'));',
    '    if (isNaN(d.getTime())) return;',
    '    // Пояс приписывает сам браузер: у отца выйдет GMT+2, здесь GMT+5,',
    '    // и одинаковое число в разных поясах никого не собьёт.',
    '    t.textContent = d.toLocaleString(\'ru-RU\', {',
    '      day: \'numeric\', month: \'long\', year: \'numeric\',',
    '      hour: \'2-digit\', minute: \'2-digit\', timeZoneName: \'short\'',
    '    });',
    '  })();',
    '  </script>',
  ].join('\n');
}

/**
 * Ставит отметку в файл. Отсутствие маркеров — ошибка, а не пропуск:
 * страница без отметки выглядит исправной, и заметить это можно только
 * тогда, когда кто-то спросит «а это свежее?».
 *
 * @returns {string} записанный ISO
 */
function stampFile(file, iso) {
  const page = fs.readFileSync(file, 'utf8');
  const a = page.indexOf(OPEN);
  const b = page.indexOf(CLOSE);
  if (a === -1 || b === -1 || b < a) {
    throw new Error('stamp-updated: в ' + file + ' нет маркеров ' + OPEN + ' … ' + CLOSE);
  }
  const out = page.slice(0, a + OPEN.length) + '\n' + stampBlock(iso) + '\n' + page.slice(b);
  fs.writeFileSync(file, out);
  return new Date(iso).toISOString();
}

module.exports = { stampBlock, stampFile, humanTime, MARK, OPEN, CLOSE, FALLBACK_TZ };

// ---------- запуск ----------
if (require.main === module && process.argv.indexOf('--self') === -1) {
  const file = process.argv[2];
  if (!file) {
    console.error('Укажите файл: node tools\\stamp-updated.js public\\index.html');
    process.exit(2);
  }
  const i = process.argv.indexOf('--iso');
  const iso = i !== -1 ? process.argv[i + 1] : new Date().toISOString();
  try {
    const written = stampFile(file, iso);
    console.log('отметка выкладки: ' + humanTime(written, FALLBACK_TZ) + ' по Калининграду');
  } catch (e) {
    console.error(String(e.message));
    process.exit(3);
  }
}

// ---------- самопроверка ----------
if (require.main === module && process.argv.indexOf('--self') !== -1) {
  const os = require('os');
  const path = require('path');
  let fails = 0;
  let checks = 0;
  const ok = (cond, what) => { checks++; if (!cond) { fails++; console.error('FAIL: ' + what); } };

  const ISO = '2026-08-20T14:42:11Z';
  const b = stampBlock(ISO);

  // Машинное время — обязательно UTC и обязательно в datetime: именно
  // из него скрипт считает время читателя.
  ok(b.indexOf('datetime="2026-08-20T14:42:11.000Z"') !== -1,
    'в datetime лежит момент в UTC');
  ok(b.indexOf('data-updated') !== -1, 'у элемента есть крючок для скрипта');

  // Запасная подпись — по Калининграду, +2 к UTC.
  ok(b.indexOf('20 августа 2026') !== -1, 'запасная подпись содержит дату');
  ok(b.indexOf('16:42') !== -1, 'запасная подпись пересчитана в калининградское время');
  ok(b.indexOf('по Калининграду') !== -1, 'запасная подпись называет свой пояс');

  // Пояс читателя приписывает браузер — без этого одинаковое число
  // в Калининграде и в Екатеринбурге читается как одно и то же время.
  ok(b.indexOf("timeZoneName: 'short'") !== -1, 'скрипт приписывает пояс читателя');

  // Пересчёт поясов проверяем на границе суток: там ошибка на день.
  ok(humanTime('2026-08-20T23:30:00Z', 'Europe/Kaliningrad').indexOf('21 августа') !== -1,
    'полпервого ночи по Калининграду — это уже следующий день');
  ok(humanTime('2026-01-15T10:00:00Z', 'Europe/Kaliningrad').indexOf('12:00') !== -1,
    'зимой Калининград тоже +2 — перевода часов в России нет');

  let bad = false;
  try { stampBlock('не дата'); } catch (e) { bad = true; }
  ok(bad, 'мусор вместо даты — ошибка, а не молча пустая отметка');

  // ---- работа с файлом ----
  const tmp = path.join(os.tmpdir(), 'stamp-test-' + Date.now() + '.html');
  fs.writeFileSync(tmp, 'до\n' + OPEN + '\n' + CLOSE + '\nпосле');
  stampFile(tmp, ISO);
  const got = fs.readFileSync(tmp, 'utf8');
  ok(got.indexOf('до\n') === 0 && got.indexOf('после') !== -1, 'страница вокруг блока не тронута');
  ok(got.indexOf('16:42') !== -1, 'отметка попала в файл');

  // Повторный штамп заменяет прежний, а не копит блоки: за месяц
  // ежедневных коммитов страница иначе обрастает тридцатью отметками.
  stampFile(tmp, '2026-08-21T09:00:00Z');
  const again = fs.readFileSync(tmp, 'utf8');
  // Считаем сам тег, а не строку data-updated: она встречается в блоке
  // дважды — в атрибуте и в селекторе скрипта. Первая версия ассерта
  // ловила именно это и была неправа сама.
  ok((again.match(/<time datetime=/g) || []).length === 1, 'отметка ровно одна после повторного штампа');
  ok(again.indexOf('16:42') === -1, 'прежнее время затёрто');
  ok(again.indexOf('11:00') !== -1, 'новое время на месте');
  fs.unlinkSync(tmp);

  // Файл без маркеров — ошибка. Молча пропущенный штамп даёт страницу,
  // которая выглядит свежей и не является ею.
  const tmp2 = path.join(os.tmpdir(), 'stamp-test-nomark-' + Date.now() + '.html');
  fs.writeFileSync(tmp2, '<html>без маркеров</html>');
  let threw = false;
  try { stampFile(tmp2, ISO); } catch (e) { threw = true; }
  ok(threw, 'страница без маркеров — ошибка, а не тихий пропуск');
  fs.unlinkSync(tmp2);

  console.log(fails
    ? '\nstamp-updated.js: ПРОВАЛОВ ' + fails
    : '\nstamp-updated.js: ' + checks + ' проверок пройдено');
  process.exit(fails ? 1 : 0);
}
