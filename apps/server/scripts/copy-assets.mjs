import fs from 'node:fs';
import path from 'node:path';

/** Копирует не-JS ресурсы (SQL-миграции) в dist после сборки. */
const here = path.dirname(new URL(import.meta.url).pathname);
const from = path.resolve(here, '../src/db/migrations');
const to = path.resolve(here, '../dist/db/migrations');
fs.mkdirSync(to, { recursive: true });
for (const file of fs.readdirSync(from)) {
  if (!file.endsWith('.sql')) continue;
  fs.copyFileSync(path.join(from, file), path.join(to, file));
}
console.log(`Скопировано миграций: ${fs.readdirSync(to).filter((f) => f.endsWith('.sql')).length}`);
