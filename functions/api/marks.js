// ============================================================
// /api/marks — общая разметка дашборда: чтение и запись.
//
// Живёт рядом со страницей (Cloudflare Pages Functions), поэтому origin
// у них один и CORS не нужен вовсе.
//
// ------------------------------------------------------------------
// Что здесь важно и почему именно так:
//
// 1. Пишем ДЕЛЬТУ, а не весь свод, и внутри объекта — только ТРОНУТЫЕ
//    ПОЛЯ. Записи по объекту целиком мало: человек ставит метку, а в
//    запрос уезжает и его копия чужой заметки — устаревшая на те
//    секунды, пока второй её дописывал. Заметка молча заменялась
//    старой версией. Поймано проверкой двумя браузерами 2026-08-20.
//
//    Правило то же, что и у файла выгрузки: ОТСУТСТВИЕ поля значит
//    «не знаю, не трогай», явный null — «стёрто». Разница только в
//    том, что здесь отсутствие выражается отсутствием ключа.
// 2. Снятая отметка — строка с пустыми полями, а НЕ удаление строки.
//    Удалённая строка не попадает в ответ «что изменилось после rev N»,
//    и снятая метка возвращалась бы обратно при следующем опросе.
// 3. Номер правки выдаёт база одним UPDATE ... RETURNING, а не
//    вычисляет MAX(rev). MAX между чтением и записью успевает устареть,
//    и два одновременных клика получают один номер — один из них
//    потом не доедет до второго браузера.
// 4. Сначала читаем meta.rev, потом строки rev <= него. В обратном
//    порядке правка, легшая между двумя запросами, получила бы номер
//    меньше возвращённого, и её никто уже не запросил бы.
// 5. Нет токена в окружении — отказ. Не «работаем без проверки»:
//    забытая переменная не должна выглядеть как исправная защита.
// ============================================================

const MAX_CHANGES = 5000;   // импорт папиной разметки идёт пачками
const MAX_NOTE = 4000;      // заметка человека, а не вставленный роман
const MAX_ID = 400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

// Проверка общего секрета. Пока Access выключен, это не защита от того,
// кому попала ссылка (токен лежит в самой странице), а защита от того,
// кто нащупал только адрес API.
function denied(request, env) {
  if (!env.SYNC_TOKEN) {
    return json({ ошибка: 'На сервере не задан SYNC_TOKEN' }, 500);
  }
  // Обе стороны подрезаются. Секрет попадает сюда через консоль или
  // через панель, и хвостовой перевод строки к нему цепляется молча:
  // страница шлёт верный токен, сервер отвечает «неверный», и понять
  // это по ответу невозможно. Значащих пробелов у токена не бывает.
  const прислан = (request.headers.get('x-sync-token') || '').trim();
  if (прислан !== String(env.SYNC_TOKEN).trim()) {
    return json({ ошибка: 'Неверный токен синхронизации' }, 403);
  }
  return null;
}

function noDb(env) {
  return env.DB ? null : json({ ошибка: 'База D1 не привязана к проекту' }, 500);
}

// Пустая строка и пустое значение — одно и то же «отметки нет».
function clean(v, max) {
  if (v == null) return null;
  const s = String(v).slice(0, max);
  return s.length ? s : null;
}

// rating — число 1..5, а не строка: клиент сравнивает его строгим
// равенством (снятие оценки повторным кликом по той же звезде), и
// clean() привёл бы его к тексту — сравнение молча перестало бы
// срабатывать. Та же логика, что уже проверена в tools/marks-server.js.
function cleanRating(v) {
  return v == null ? null : Math.max(1, Math.min(5, Math.round(Number(v))));
}

export async function onRequestGet({ request, env }) {
  const bad = denied(request, env) || noDb(env);
  if (bad) return bad;

  const url = new URL(request.url);
  const raw = url.searchParams.get('since');
  const since = Number.isFinite(Number(raw)) ? Math.max(0, Number(raw)) : 0;

  // Порядок обязателен: сначала верхняя граница, потом строки под ней.
  const head = await env.DB.prepare('SELECT v FROM meta WHERE k = ?1').bind('rev').first();
  const rev = head ? head.v : 0;

  const { results } = await env.DB
    .prepare('SELECT id, color, note, fin, rating, author FROM marks WHERE rev > ?1 AND rev <= ?2')
    .bind(since, rev)
    .all();

  const marks = {};
  for (const r of results || []) {
    marks[r.id] = { c: r.color, note: r.note, fin: r.fin, rating: r.rating, by: r.author };
  }
  return json({ rev, marks });
}

export async function onRequestPost({ request, env }) {
  const bad = denied(request, env) || noDb(env);
  if (bad) return bad;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ошибка: 'Тело запроса не разобралось как JSON' }, 400);
  }

  const changes = body && body.changes;
  if (!changes || typeof changes !== 'object') {
    return json({ ошибка: 'Нет объекта changes' }, 400);
  }

  const ids = Object.keys(changes).filter((id) => id && id.length <= MAX_ID);
  if (!ids.length) return json({ ошибка: 'Пустой список правок' }, 400);
  if (ids.length > MAX_CHANGES) {
    return json({ ошибка: `Больше ${MAX_CHANGES} правок за раз — разбейте на части` }, 413);
  }

  const author = clean(body.by, 80);
  const at = new Date().toISOString();

  // Какие поля правка трогает. Ключа нет — колонку не трогаем вовсе.
  // rating — не через clean() (число, не строка) — см. cleanRating().
  const ПОЛЯ = [
    { ключ: 'c', колонка: 'color', предел: 4 },
    { ключ: 'note', колонка: 'note', предел: MAX_NOTE },
    { ключ: 'fin', колонка: 'fin', предел: 120 },
    { ключ: 'rating', колонка: 'rating', рейтинг: true },
  ];

  // Занимаем сразу столько номеров, сколько правок: одним запросом,
  // чтобы параллельная запись не влезла в середину диапазона.
  const head = await env.DB
    .prepare('UPDATE meta SET v = v + ?1 WHERE k = ?2 RETURNING v')
    .bind(ids.length, 'rev')
    .first();
  if (!head) return json({ ошибка: 'Счётчик правок не найден — база не размечена схемой' }, 500);

  const top = head.v;
  const base = top - ids.length;   // номера base+1 … top

  // Обновляем ровно те колонки, что пришли. Флаг «поле присутствует»
  // уходит отдельным параметром: SQLite сам отличить «null, потому что
  // стёрли» от «null, потому что не прислали» не может.
  const upsert = env.DB.prepare(
    `INSERT INTO marks (id, color, note, fin, rating, author, at, rev)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(id) DO UPDATE SET
       color  = CASE WHEN ?9  THEN excluded.color  ELSE marks.color  END,
       note   = CASE WHEN ?10 THEN excluded.note   ELSE marks.note   END,
       fin    = CASE WHEN ?11 THEN excluded.fin    ELSE marks.fin    END,
       rating = CASE WHEN ?12 THEN excluded.rating ELSE marks.rating END,
       author = excluded.author, at = excluded.at, rev = excluded.rev`
  );
  const log = env.DB.prepare(
    'INSERT INTO marks_log (id, color, note, fin, rating, author, at, fields) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  );

  const batch = [];
  ids.forEach((id, i) => {
    const m = changes[id] || {};
    const знач = {};
    const тронуто = [];
    for (const п of ПОЛЯ) {
      const есть = Object.prototype.hasOwnProperty.call(m, п.ключ);
      знач[п.колонка] = есть ? (п.рейтинг ? cleanRating(m[п.ключ]) : clean(m[п.ключ], п.предел)) : null;
      if (есть) тронуто.push(п.колонка);
    }
    batch.push(upsert.bind(
      id, знач.color, знач.note, знач.fin, знач.rating, author, at, base + i + 1,
      тронуто.indexOf('color') !== -1 ? 1 : 0,
      тронуто.indexOf('note') !== -1 ? 1 : 0,
      тронуто.indexOf('fin') !== -1 ? 1 : 0,
      тронуто.indexOf('rating') !== -1 ? 1 : 0
    ));
    batch.push(log.bind(id, знач.color, знач.note, знач.fin, знач.rating, author, at, тронуто.join(',')));
  });

  await env.DB.batch(batch);
  return json({ rev: top, принято: ids.length });
}
