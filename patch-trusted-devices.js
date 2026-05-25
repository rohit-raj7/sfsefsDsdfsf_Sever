import { pool } from './db.js';

const patchDB = async () => {
  try {
    console.log('Connecting to database...');
    
    // Create trusted_devices table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
          device_id VARCHAR(255) NOT NULL,
          platform VARCHAR(50),
          device_name VARCHAR(255),
          app_version VARCHAR(50),
          is_trusted BOOLEAN DEFAULT TRUE,
          first_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, device_id)
      );
    `);
    console.log('Successfully created trusted_devices table.');
    
    process.exit(0);
  } catch (err) {
    console.error('Error patching database:', err);
    process.exit(1);
  }
};

patchDB();
