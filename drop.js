import { pool } from './db.js';
pool.query('DROP TABLE IF EXISTS trusted_devices').then(() => {
  console.log('Dropped');
  process.exit(0);
}).catch(console.error);
