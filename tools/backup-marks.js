// ============================================================
// backup-marks.js — снимок общей разметки в файл.
//
//   node tools\backup-marks.js --url https://<адрес>/api/marks
//
// Зачем. Разметка живёт в базе на бесплатном тарифе стороннего
// сервиса. Полгода чужой работы не должны существовать в одном
// экземпляре там, куда мы не можем заглянуть руками. Снимок ложится
// в backup/ и коммитится: это единственная копия, которая останется,
// если проект в Cloudflare исчезнет вместе с аккаунтом.
//
// Тем же файлом чинится испорченная разметка: он подаётся обратно
// через import-marks.js --apply.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

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

async function main() {
  const url = arg('--url', 'http://127.0.0.1:8788/api/marks');
  const res = await fetch(url + '?since=0', { headers: { 'x-sync-token': token() } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Сервер ответил ${res.status}: ${text.slice(0, 200)}`);

  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Ответ не JSON — вероятно, страница входа: ' + text.slice(0, 120));
  }

  const marks = data.marks || {};
  const n = Object.keys(marks).length;

  // Пустой ответ — повод остановиться, а не перезаписать вчерашний
  // снимок пустотой. Уничтоженная разметка и молчащий сервер выглядят
  // на этом шаге одинаково, а бэкап нулём поверх хорошего — это уже
  // потеря, которую нечем откатить.
  if (!n) {
    const было = fs.existsSync(path.join(ROOT, 'backup'))
      ? fs.readdirSync(path.join(ROOT, 'backup')).filter((f) => f.startsWith('marks-')).length
      : 0;
    if (было) {
      throw new Error('Сервер вернул ноль отметок, а прежние снимки есть. Снимок не записан — разберитесь сначала.');
    }
  }

  const out = path.join(ROOT, 'backup', `marks-${new Date().toISOString().slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    снято: new Date().toISOString(),
    правка: data.rev,
    сырыеОтметки: marks,
  }, null, 1));

  console.log(`Отметок: ${n}, правка ${data.rev}`);
  console.log(`→ ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => { console.error('Ошибка: ' + e.message); process.exit(1); });
