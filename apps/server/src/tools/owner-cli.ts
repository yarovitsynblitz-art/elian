import { ensureDirs } from '../config/env.js';
import { openDatabase, runMigrations } from '../db/index.js';
import { ownerCliCommand } from '../owner/console.js';
import { getSecret } from '../config/secrets.js';

ensureDirs();
getSecret('DB_KEY', { create: false });
openDatabase();
runMigrations({ silent: true });
const code = ownerCliCommand(process.argv.slice(2));
process.exit(code);
