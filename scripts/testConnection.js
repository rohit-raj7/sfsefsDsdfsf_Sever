import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

console.log('Testing database connection...\n');
console.log('Config:');
console.log('  Host:', process.env.DB_HOST);
console.log('  Port:', process.env.DB_PORT || 5432);
console.log('  Database:', process.env.DB_NAME);
console.log('  User:', process.env.DB_USER);
console.log('  Password:', process.env.DB_PASSWORD ? '***' + process.env.DB_PASSWORD.slice(-4) : 'NOT SET');
console.log('\nAttempting connection...\n');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 30000 // 30 second timeout for testing
});

async function test() {
  try {
    console.log('⏳ Connecting to PostgreSQL...');
    const client = await pool.connect();
    console.log('✅ Connection successful!');
    
    const result = await client.query('SELECT NOW(), version()');
    console.log('\n✓ Current time:', result.rows[0].now);
    console.log('✓ Database version:', result.rows[0].version.split(',')[0]);
    
    client.release();
    await pool.end();
    
    console.log('\n✅ Test completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Connection failed!');
    console.error('Error:', error.message);
    
    if (error.code === 'ENOTFOUND') {
      console.error('\n💡 DNS lookup failed - check DB_HOST value');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('\n💡 Connection refused - database may be down or firewall blocking');
    } else if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      console.error('\n💡 Connection timeout - possible causes:');
      console.error('   1. AWS RDS Security Group not allowing your IP');
      console.error('   2. RDS instance is stopped or starting up');
      console.error('   3. Wrong hostname/port');
      console.error('   4. RDS is in private subnet without public access');
    } else if (error.message.includes('password')) {
      console.error('\n💡 Authentication failed - check DB_USER and DB_PASSWORD');
    }
    
    await pool.end();
    process.exit(1);
  }
}

test();
