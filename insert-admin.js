import pkg from 'pg';
const { Pool } = pkg;
import bcrypt from 'bcryptjs';

const pool = new Pool({
  host: '91.108.111.194',
  port: 5885,
  user: 'postgres',
  password: 'hGcIz9HHsj6bwkTbm1NLfzGYMV09wJB5U33TynV3yHdBSCHGuPEST28h9jCk7OiX',
  database: 'postgres'
});

async function run() {
  try {
    console.log('📝 Inserting default admin...');
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash('admin123', saltRounds);

    const insertAdminQuery = `
      INSERT INTO admins (email, password_hash, full_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO NOTHING
    `;
    await pool.query(insertAdminQuery, ['rohitraj70615@gmail.com', hashedPassword, 'Admin User']);
    console.log('✅ Admin inserted!');
  } catch(err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
