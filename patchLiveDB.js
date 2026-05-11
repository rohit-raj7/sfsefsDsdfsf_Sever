import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
    connectionString: 'postgres://postgres:hGcIz9HHsj6bwkTbm1NLfzGYMV09wJB5U33TynV3yHdBSCHGuPEST28h9jCk7OiX@91.108.111.194:5885/postgres',
});

async function viewAdmins() {
    try {
        const res = await pool.query('SELECT admin_id, email, is_active FROM admins');
        console.log(res.rows);
    } catch (error) {
        console.error(error);
    } finally {
        process.exit(0);
    }
}

viewAdmins();
