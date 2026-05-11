import { pool } from '../db.js';

async function checkAdmins() {
    try {
        console.log('Connecting to database...');
        const result = await pool.query('SELECT admin_id, email, is_active FROM admins');
        console.log('Admins found:', result.rows);
    } catch (error) {
        console.error('Error:', error);
    } finally {
        process.exit(0);
    }
}

checkAdmins();
