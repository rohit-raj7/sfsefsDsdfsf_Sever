// Set NODE_ENV to 'test' so minioUpload mocks R2 delete commands
process.env.NODE_ENV = 'test';

import { pool } from '../db.js';
import { Chat } from '../models/Chat.js';

async function testDeleteForAll() {
  console.log('Starting "Delete Chat for All" integration test with NODE_ENV=test...');
  
  // 1. Create two test users if they don't exist
  const user1Id = '11111111-1111-4111-a111-111111111111';
  const user2Id = '22222222-2222-4222-a222-222222222222';
  
  try {
    await pool.query(`
      INSERT INTO users (user_id, email, password_hash, full_name, phone_number)
      VALUES 
        ($1, 'test1@dosttalk.com', 'hash', 'Test User 1', '1234567890'),
        ($2, 'test2@dosttalk.com', 'hash', 'Test User 2', '0987654321')
      ON CONFLICT (user_id) DO NOTHING
    `, [user1Id, user2Id]);

    // 2. Find or create a chat between them
    console.log('Creating test chat...');
    const chat = await Chat.findOrCreate(user1Id, user2Id);
    const chatId = chat.chat_id;
    console.log(`Test chat created/found with ID: ${chatId}`);

    // 3. Insert test messages (some with attachments)
    console.log('Inserting test messages...');
    await pool.query(`
      INSERT INTO messages (chat_id, sender_id, message_type, message_content, file_key, file_url)
      VALUES 
        ($1, $2, 'text', 'Hello, this is a test text message.', null, null),
        ($1, $2, 'image', 'Here is a test image attachment.', 'test_uploads/image_file_key_123.png', 'https://pub-url.com/test_uploads/image_file_key_123.png'),
        ($1, $3, 'audio', 'Here is a test audio attachment.', 'test_uploads/audio_file_key_456.mp3', 'https://pub-url.com/test_uploads/audio_file_key_456.mp3')
    `, [chatId, user1Id, user2Id]);

    // Verify messages exist in the database
    const initialMessagesCount = await pool.query('SELECT count(*) FROM messages WHERE chat_id = $1', [chatId]);
    console.log(`Initial message count: ${initialMessagesCount.rows[0].count} (Expected: 3)`);
    if (parseInt(initialMessagesCount.rows[0].count) !== 3) {
      throw new Error('Messages were not inserted correctly');
    }

    // 4. Call deleteForAll
    console.log('Calling Chat.deleteForAll...');
    await Chat.deleteForAll(chatId);

    // 5. Verify chat record is deleted
    const chatExists = await pool.query('SELECT * FROM chats WHERE chat_id = $1', [chatId]);
    console.log(`Chat still exists in database: ${chatExists.rows.length > 0} (Expected: false)`);
    if (chatExists.rows.length > 0) {
      throw new Error('Chat record was not deleted');
    }

    // 6. Verify message records are deleted
    const messagesCount = await pool.query('SELECT count(*) FROM messages WHERE chat_id = $1', [chatId]);
    console.log(`Remaining messages in database: ${messagesCount.rows[0].count} (Expected: 0)`);
    if (parseInt(messagesCount.rows[0].count) !== 0) {
      throw new Error('Message records were not deleted');
    }

    console.log('=== TEST SUCCESSFUL ===');
  } catch (err) {
    console.error('=== TEST FAILED ===');
    console.error(err);
  } finally {
    // Clean up test users if needed
    try {
      await pool.query('DELETE FROM users WHERE user_id IN ($1, $2)', [user1Id, user2Id]);
    } catch (cleanErr) {
      console.error('Clean up failed:', cleanErr);
    }
    
    await pool.end();
  }
}

testDeleteForAll();
