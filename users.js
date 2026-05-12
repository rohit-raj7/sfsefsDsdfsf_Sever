const { pool, executeQuery } = require('./db');

// Create users table
async function createUsersTable() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  
  try {
    await pool.query(createTableQuery);
    console.log('✓ Table "users" created successfully');
    return true;
  } catch (error) {
    console.error('Error creating table:', error.message);
    return false;
  }
}

// Insert a new user
async function insertUser(name, email) {
  const insertQuery = 'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *';
  try {
    const result = await executeQuery(insertQuery, [name, email]);
    console.log('✓ User inserted:', result[0]);
    return result[0];
  } catch (error) {
    console.error('Error inserting user:', error.message);
    throw error;
  }
}

// Get all users
async function getAllUsers() {
  const selectQuery = 'SELECT * FROM users ORDER BY created_at DESC';
  try {
    const users = await executeQuery(selectQuery);
    console.log(`✓ Found ${users.length} user(s)`);
    return users;
  } catch (error) {
    console.error('Error fetching users:', error.message);
    throw error;
  }
}

// Get user by ID
async function getUserById(id) {
  const selectQuery = 'SELECT * FROM users WHERE id = $1';
  try {
    const result = await executeQuery(selectQuery, [id]);
    return result[0];
  } catch (error) {
    console.error('Error fetching user:', error.message);
    throw error;
  }
}

// Update user
async function updateUser(id, name, email) {
  const updateQuery = 'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING *';
  try {
    const result = await executeQuery(updateQuery, [name, email, id]);
    console.log('✓ User updated:', result[0]);
    return result[0];
  } catch (error) {
    console.error('Error updating user:', error.message);
    throw error;
  }
}

// Delete user
async function deleteUser(id) {
  const deleteQuery = 'DELETE FROM users WHERE id = $1 RETURNING *';
  try {
    const result = await executeQuery(deleteQuery, [id]);
    console.log('✓ User deleted:', result[0]);
    return result[0];
  } catch (error) {
    console.error('Error deleting user:', error.message);
    throw error;
  }
}

module.exports = {
  createUsersTable,
  insertUser,
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser
};
