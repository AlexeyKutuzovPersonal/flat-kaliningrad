-- ============================================================
-- Хранилище разметки дашборда. Две таблицы, и обе нужны.
--
-- marks     — текущее состояние: что показывать при открытии страницы.
-- marks_log — все правки подряд, без удалений.
--
-- Журнал не роскошь. Пока Cloudflare Access выключен, ссылка равна
-- праву записи: любой, кому она попадёт, может стереть полгода чужой
-- работы одним кликом. Откатить можно только то, что записано.
-- ============================================================

CREATE TABLE IF NOT EXISTS marks (
  id     TEXT PRIMARY KEY,   -- «domclick:https://...» — ключ объявления
  color  TEXT,               -- 'g' | 'y' | 'r' | NULL
  note   TEXT,
  fin    TEXT,               -- отделка, переопределённая человеком
  author TEXT,
  at     TEXT NOT NULL,      -- ISO, время правки
  rev    INTEGER NOT NULL    -- номер правки, монотонный на всю базу
);

-- Опрос страницы спрашивает «что изменилось после rev N» — без индекса
-- это полный перебор таблицы на каждом опросе каждого из двоих.
CREATE INDEX IF NOT EXISTS marks_rev ON marks(rev);

CREATE TABLE IF NOT EXISTS marks_log (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  id     TEXT NOT NULL,
  color  TEXT,
  note   TEXT,
  fin    TEXT,
  author TEXT,
  at     TEXT NOT NULL,
  fields TEXT           -- какие поля правка реально трогала
);

CREATE INDEX IF NOT EXISTS marks_log_id ON marks_log(id);

-- Счётчик правок. Отдельной строкой, а не MAX(rev) по таблице: MAX
-- пришлось бы считать при каждой записи, и два одновременных клика
-- получили бы один и тот же номер.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);

INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', 0);
