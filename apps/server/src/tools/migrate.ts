import { ensureDirs, env, paths } from '../config/env.js';
import { openDatabase, runMigrations, closeDatabase, listMigrations, get } from '../db/index.js';
import { getSecret } from '../config/secrets.js';

ensureDirs();
getSecret('DB_KEY', { create: true });
getSecret('MEDIA_KEY', { create: true });
getSecret('SESSION_PEPPER', { create: true });
openDatabase();
const applied = runMigrations({ silent: true });
const all = listMigrations();
const done = (get<{ c: number }>('SELECT count(*) AS c FROM migrations')?.c ?? 0);
console.log(`Миграции: применено сейчас ${applied.length}, всего в базе ${done}/${all.length}`);
console.log(`База: ${paths.dbFile}`);
console.log(`Шифрование: ${env.dbEncryption === 'off' ? 'ВЫКЛЮЧЕНО (dev)' : 'SQLCipher'}`);
closeDatabase();
