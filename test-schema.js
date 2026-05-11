import pkg from 'pg';
const { Pool } = pkg;
const pool = new Pool({
    host: '91.108.111.194',
    port: 5885,
    user: 'postgres',
    password: 'hGcIz9HHsj6bwkTbm1NLfzGYMV09wJB5U33TynV3yHdBSCHGuPEST28h9jCk7OiX',
    database: 'postgres'
});

async function run() {
    try {
        const res = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
        console.log("Existing tables:", res.rows.map(r => r.table_name));

        // Rename old tables if they exist to get them out of the way safely
        const tables = res.rows.map(r => r.table_name);
        if (tables.includes('users')) {
            console.log('Renaming "users" to "users_old" to allow fresh migration...');
            await pool.query('ALTER TABLE users RENAME TO users_old;');
        }

        console.log('Cleanup complete!');
    } catch (err) {
        console.error(err);
    } finally {
        pool.end();
    }
}

run();
