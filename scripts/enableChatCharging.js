import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

console.log('Enabling Chat Charging globally...\n');

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

console.log('Using connection:', connectionString ? connectionString.split('@')[1] : 'NONE');

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

async function enableChatCharging() {
  try {
    const client = await pool.connect();
    console.log('⏳ Connected to database.');

    // Update the config table to set charging_enabled to true
    const updateResult = await client.query(
      `UPDATE chat_charge_config 
       SET charging_enabled = TRUE 
       RETURNING *`
    );

    console.log('✅ Update query executed successfully!');
    if (updateResult.rows.length > 0) {
      console.log('Updated configuration rows:', updateResult.rows);
    } else {
      console.log('⚠️ No rows found in chat_charge_config. Attempting to seed default config...');
      const seedResult = await client.query(
        `INSERT INTO chat_charge_config 
           (charging_enabled, free_message_limit, message_block_size, charge_per_message_block)
         VALUES (TRUE, 5, 2, 1.00)
         RETURNING *`
      );
      console.log('Seeded configuration row:', seedResult.rows[0]);
    }

    client.release();
    await pool.end();
    console.log('\n🎉 Chat charging enabled successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Failed to enable chat charging!');
    console.error('Error:', error.message);
    await pool.end();
    process.exit(1);
  }
}

enableChatCharging();
