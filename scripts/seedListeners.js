import { pool } from '../db.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

async function seedListeners() {
  try {
    console.log('🌱 Seeding sample listeners...');

    const saltRounds = 10;
    const password = await bcrypt.hash('password123', saltRounds);

    const sampleListeners = [
      {
        display_name: 'Khushi Singh',
        professional_name: 'Expert Khushi',
        email: 'khushi@example.com',
        specialties: ['Confidence', 'Relationship'],
        languages: ['Hindi', 'English'],
        rate_per_minute: 20.00,
        profile_image: 'assets/images/girl1.jpg',
        city: 'Mumbai'
      },
      {
        display_name: 'Anjali Sharma',
        professional_name: 'Expert Anjali',
        email: 'anjali@example.com',
        specialties: ['Marriage', 'Breakup'],
        languages: ['Hindi', 'English', 'Punjabi'],
        rate_per_minute: 25.00,
        profile_image: 'assets/images/girl2.jpg',
        city: 'Delhi'
      },
      {
        display_name: 'Rahul Verma',
        professional_name: 'Expert Rahul',
        email: 'rahul@example.com',
        specialties: ['Career', 'Confidence'],
        languages: ['English', 'Hindi'],
        rate_per_minute: 15.00,
        profile_image: 'assets/images/male.jpg',
        city: 'Bangalore'
      }
    ];

    for (const data of sampleListeners) {
      // 1. Create user
      const userResult = await pool.query(
        `INSERT INTO users (email, password_hash, display_name, full_name, account_type, city, is_active, is_verified)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (email) DO UPDATE SET is_active = TRUE
         RETURNING user_id`,
        [data.email, password, data.display_name, data.display_name, 'listener', data.city, true, true]
      );
      
      const userId = userResult.rows[0].user_id;

      // 2. Create listener profile
      const payoutRate = Number((data.rate_per_minute * 0.25).toFixed(2));

      await pool.query(
        `INSERT INTO listeners (
           user_id, professional_name, specialties, languages,
           rate_per_minute, user_rate_per_min, listener_payout_per_min,
           profile_image, is_available, is_verified
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (user_id) DO UPDATE SET is_available = TRUE
         RETURNING listener_id`,
        [
          userId,
          data.professional_name,
          data.specialties,
          data.languages,
          data.rate_per_minute,
          data.rate_per_minute,
          payoutRate,
          data.profile_image,
          true,
          true
        ]
      );
      
      console.log(`✅ Added listener: ${data.display_name}`);
    }

    console.log('🎉 Seeding completed successfully!');
  } catch (error) {
    console.error('💥 Error seeding listeners:', error.message);
  } finally {
    await pool.end();
  }
}

seedListeners();
