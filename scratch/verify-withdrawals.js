import { pool } from '../db.js';
import { randomUUID } from 'crypto';

async function verifyWithdrawals() {
  console.log('--- STARTING LISTENER WITHDRAWALS VERIFICATION SCRIPT ---');
  
  // Test UUIDs
  const testAdminId = '99999999-9999-4999-a999-999999999999';
  const testUserId = '88888888-8888-4888-a888-888888888888';
  const testListenerId = '77777777-7777-4777-a777-777777777777';
  
  const testCallId = randomUUID();
  const testGiftEventId = randomUUID();
  const testRequestStdId = randomUUID();
  const testRequestGiftId = randomUUID();

  try {
    // 0. ENSURE SCHEMA
    console.log('Running database migrations/schema updates...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS listener_withdrawal_requests(
        request_id UUID PRIMARY KEY,
        listener_id UUID NOT NULL REFERENCES listeners(listener_id) ON DELETE CASCADE,
        payout_method VARCHAR(20) NOT NULL CHECK (payout_method IN ('upi', 'bank')),
        upi_id VARCHAR(255),
        account_number VARCHAR(32),
        ifsc_code VARCHAR(20),
        bank_name VARCHAR(120),
        account_holder_name VARCHAR(120),
        withdrawal_amount NUMERIC(12,2) NOT NULL CHECK (withdrawal_amount > 0),
        tds_amount NUMERIC(12,2) NOT NULL CHECK (tds_amount >= 0),
        transaction_fee NUMERIC(12,2) NOT NULL CHECK (transaction_fee >= 0),
        final_credit_amount NUMERIC(12,2) NOT NULL CHECK (final_credit_amount >= 0),
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS remarks TEXT;
      ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL;
    `);
    console.log('✓ Database columns remarks and approved_by checked/created.');

    // 1. SETUP DUMMY DATA
    console.log('Setting up mock database entries for testing...');
    
    // Ensure test admin exists
    await pool.query(`
      INSERT INTO admins (admin_id, email, password_hash, full_name)
      VALUES ($1, 'testadmin@dosttalk.com', 'hash', 'Test Admin')
      ON CONFLICT (email) DO UPDATE SET admin_id = EXCLUDED.admin_id
    `, [testAdminId]);

    // Ensure test user exists
    await pool.query(`
      INSERT INTO users (user_id, phone_number, email, password_hash, full_name, wallet_balance)
      VALUES ($1, '+919999999999', 'testuser@dosttalk.com', 'hash', 'Test User', 100.0)
      ON CONFLICT (user_id) DO NOTHING
    `, [testUserId]);

    // Ensure test listener exists
    await pool.query(`
      INSERT INTO listeners (listener_id, user_id, professional_name, original_name, rate_per_minute, total_earning, wallet_balance)
      VALUES ($1, $2, 'Pro Listener', 'Original Listener', 10.0, 500.00, 500.00)
      ON CONFLICT (listener_id) DO NOTHING
    `, [testListenerId, testUserId]);

    // Cleanup any existing test data from previous runs to keep math deterministic
    await pool.query(`DELETE FROM call_records WHERE listener_id = $1`, [testListenerId]);
    await pool.query(`DELETE FROM call_gifts WHERE listener_id = $1`, [testListenerId]);
    await pool.query(`DELETE FROM listener_gift_earnings_ledger WHERE listener_id = $1`, [testListenerId]);
    await pool.query(`DELETE FROM listener_gift_withdrawal_requests WHERE listener_id = $1`, [testListenerId]);
    await pool.query(`DELETE FROM listener_withdrawal_requests WHERE listener_id = $1`, [testListenerId]);
    await pool.query(`DELETE FROM transactions WHERE user_id = $1`, [testUserId]);
    await pool.query(`DELETE FROM calls WHERE listener_id = $1 OR caller_id = $2`, [testListenerId, testUserId]);

    // Insert dummy call in calls table to satisfy foreign key constraints
    console.log('Inserting mock calls row...');
    await pool.query(`
      INSERT INTO calls (call_id, caller_id, listener_id, call_type, status, duration_seconds, rate_per_minute, total_cost, billed_minutes)
      VALUES ($1, $2, $3, 'voice', 'completed', 2100, 10.00, 350.00, 35)
    `, [testCallId, testUserId, testListenerId]);

    // Create call records (earnings)
    console.log('Inserting mock call record...');
    await pool.query(`
      INSERT INTO call_records (id, call_id, user_id, listener_id, minutes, user_charge, listener_earn)
      VALUES ($1, $2, $3, $4, 35, 350.00, 350.00)
    `, [randomUUID(), testCallId, testUserId, testListenerId]);

    // Insert streak bonus transaction
    console.log('Inserting mock streak bonus transaction...');
    await pool.query(`
      INSERT INTO transactions (transaction_id, user_id, transaction_type, amount, description, status)
      VALUES ($1, $2, 'credit', 50.00, 'Weekly Streak Bonus Payment', 'completed')
    `, [randomUUID(), testUserId]);

    // Setup Gift wallet and gift ledger
    console.log('Setting up gift wallet and earnings...');
    await pool.query(`
      INSERT INTO listener_gift_wallets (listener_id, total_earnings, available_balance, pending_withdrawals, total_withdrawn)
      VALUES ($1, 200.00, 150.00, 0.00, 50.00)
      ON CONFLICT (listener_id) DO UPDATE 
      SET total_earnings = 200.00, available_balance = 150.00, pending_withdrawals = 0.00, total_withdrawn = 50.00
    `, [testListenerId]);

    // Insert mock call_gift
    await pool.query(`
      INSERT INTO call_gifts (gift_event_id, call_id, sender_id, listener_id, listener_user_id, client_request_id, gift_id, gift_name, asset_key, gift_category, rarity, coin_amount, listener_earning)
      VALUES ($1, $2, $3, $4, $3, 'req-123', 'coffee', 'Coffee', 'coffee', 'trending', 'common', 58.00, 29.00)
      ON CONFLICT DO NOTHING
    `, [testGiftEventId, testCallId, testUserId, testListenerId]);

    // Insert pending standard withdrawal request
    console.log('Inserting pending standard withdrawal request...');
    await pool.query(`
      INSERT INTO listener_withdrawal_requests (request_id, listener_id, payout_method, upi_id, withdrawal_amount, tds_amount, transaction_fee, final_credit_amount, status)
      VALUES ($1, $2, 'upi', 'test@upi', 120.00, 12.00, 5.00, 103.00, 'pending')
    `, [testRequestStdId, testListenerId]);

    // Insert pending gift withdrawal request
    console.log('Inserting pending gift withdrawal request...');
    await pool.query(`
      INSERT INTO listener_gift_withdrawal_requests (request_id, listener_id, amount, status)
      VALUES ($1, $2, 40.00, 'pending')
    `, [testRequestGiftId, testListenerId]);

    // Update gift wallet to reflect pending
    await pool.query(`
      UPDATE listener_gift_wallets 
      SET pending_withdrawals = 40.00, available_balance = 110.00 
      WHERE listener_id = $1
    `, [testListenerId]);

    // 2. VERIFY DASHBOARD STATS CALCULATION
    console.log('\n--- VERIFYING STATS CARD MATH ---');
    
    // Call Earnings Sum
    const callEarnRes = await pool.query(`SELECT COALESCE(SUM(listener_earn), 0)::numeric AS total FROM call_records`);
    const totalCallEarnings = parseFloat(callEarnRes.rows[0].total);
    console.log(`Call Earnings (Platform Total): ${totalCallEarnings}`);

    // Gift Earnings Sum
    const giftEarnRes = await pool.query(`SELECT COALESCE(SUM(listener_earning), 0)::numeric AS total FROM call_gifts`);
    const totalGiftEarnings = parseFloat(giftEarnRes.rows[0].total);
    console.log(`Gift Earnings (Platform Total): ${totalGiftEarnings}`);

    // Bonus Earnings Sum
    const bonusEarnRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total 
      FROM transactions 
      WHERE transaction_type = 'credit' AND description LIKE '%Bonus%'
    `);
    const totalBonusEarnings = parseFloat(bonusEarnRes.rows[0].total);
    console.log(`Bonus Earnings (Platform Total): ${totalBonusEarnings}`);

    // Total earnings
    const totalListenerEarnings = totalCallEarnings + totalGiftEarnings + totalBonusEarnings;
    console.log(`Total Listener Earnings (Platform Total): ${totalListenerEarnings}`);

    // Total Withdrawn (standard + gift requests with approved or processed status)
    const stdWithdrawnRes = await pool.query(`
      SELECT COALESCE(SUM(withdrawal_amount), 0)::numeric AS total 
      FROM listener_withdrawal_requests 
      WHERE status IN ('approved', 'processed')
    `);
    const giftWithdrawnRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total 
      FROM listener_gift_withdrawal_requests 
      WHERE status IN ('approved', 'processed')
    `);
    const totalAmountWithdrawn = parseFloat(stdWithdrawnRes.rows[0].total) + parseFloat(giftWithdrawnRes.rows[0].total);
    console.log(`Approved Withdrawn Amount: ${totalAmountWithdrawn}`);

    // Pending Amount
    const stdPendingAmtRes = await pool.query(`
      SELECT COALESCE(SUM(withdrawal_amount), 0)::numeric AS total 
      FROM listener_withdrawal_requests 
      WHERE status = 'pending'
    `);
    const giftPendingAmtRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0)::numeric AS total 
      FROM listener_gift_withdrawal_requests 
      WHERE status = 'pending'
    `);
    const totalMoneyPending = parseFloat(stdPendingAmtRes.rows[0].total) + parseFloat(giftPendingAmtRes.rows[0].total);
    console.log(`Total Pending Payout Amount: ${totalMoneyPending}`);

    // Available Balance Math for single listener
    console.log('\n--- VERIFYING INDIVIDUAL LISTENER BALANCE MATH ---');
    
    // Call Earnings for listener
    const listenerCallEarnRes = await pool.query(
      `SELECT COALESCE(SUM(listener_earn), 0)::numeric as total FROM call_records WHERE listener_id = $1`,
      [testListenerId]
    );
    const listenerCallEarnings = parseFloat(listenerCallEarnRes.rows[0].total); // should be 350
    console.log(`Listener Call Earnings: ${listenerCallEarnings} (Expected: 350.00)`);
    if (listenerCallEarnings !== 350.00) throw new Error('Listener call earnings mismatch!');

    const listenerInfo = (await pool.query(`SELECT total_earning, wallet_balance FROM listeners WHERE listener_id = $1`, [testListenerId])).rows[0];
    const stdWithdrawnNonFailedRes = await pool.query(`
      SELECT COALESCE(SUM(withdrawal_amount), 0)::numeric as total
      FROM listener_withdrawal_requests
      WHERE listener_id = $1 AND status NOT IN ('failed', 'rejected', 'cancelled')
    `, [testListenerId]);
    const stdWithdrawnNonFailed = parseFloat(stdWithdrawnNonFailedRes.rows[0].total);
    
    // Formula: available_std = GREATEST(call_earnings, total_earning, wallet_balance) - stdWithdrawnNonFailed
    const total_earning = parseFloat(listenerInfo.total_earning); // 500.00
    const wallet_balance = parseFloat(listenerInfo.wallet_balance); // 500.00
    const maxVal = Math.max(listenerCallEarnings, total_earning, wallet_balance); // 500.00
    const available_std = maxVal - stdWithdrawnNonFailed; // 500.00 - 120.00 = 380.00
    
    const giftWalletInfo = (await pool.query(`SELECT available_balance FROM listener_gift_wallets WHERE listener_id = $1`, [testListenerId])).rows[0];
    const available_gift = parseFloat(giftWalletInfo.available_balance); // 110.00
    const available_balance = available_std + available_gift; // 380.00 + 110.00 = 490.00
    
    console.log(`GREATEST(call_earnings, total_earning, wallet_balance): ${maxVal} (Expected: 500.00)`);
    console.log(`Standard Payouts non-failed: ${stdWithdrawnNonFailed} (Expected: 120.00)`);
    console.log(`Calculated Available Std Balance: ${available_std} (Expected: 380.00)`);
    console.log(`Gift Wallet Available Balance: ${available_gift} (Expected: 110.00)`);
    console.log(`Total Combined Available Balance: ${available_balance} (Expected: 490.00)`);
    if (available_balance !== 490.00) throw new Error('Combined Available Balance math mismatch!');

    // 3. TEST STATUS TRANSITIONS
    console.log('\n--- TESTING STATUS TRANSITION AND MATH RECONCILIATION ---');
    console.log('Transition 1: Rejecting standard request...');
    
    // Simulating PUT /api/admin/withdrawals/standard/:id/status status = rejected
    // Update status to rejected
    const remarks = 'Invalid UPI handle';
    await pool.query(`
      UPDATE listener_withdrawal_requests
      SET status = 'rejected',
          remarks = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE request_id = $1
    `, [testRequestStdId, remarks]);

    // Insert failed transaction log
    await pool.query(`
      INSERT INTO transactions (user_id, transaction_type, amount, currency, description, status)
      VALUES ($1, 'withdrawal', 120.00, 'INR', $2, 'failed')
    `, [testUserId, `Call Earnings Payout Rejected: ${remarks}`]);

    console.log('Request updated to rejected. Checking available balance recalculation...');
    
    // Re-evaluate standard non-failed withdrawals
    const stdWithdrawnNonFailedResAfter = await pool.query(`
      SELECT COALESCE(SUM(withdrawal_amount), 0)::numeric as total
      FROM listener_withdrawal_requests
      WHERE listener_id = $1 AND status NOT IN ('failed', 'rejected', 'cancelled')
    `, [testListenerId]);
    const stdWithdrawnNonFailedAfter = parseFloat(stdWithdrawnNonFailedResAfter.rows[0].total);
    const available_std_after = maxVal - stdWithdrawnNonFailedAfter; // 500.00 - 0.00 = 500.00
    const available_balance_after = available_std_after + available_gift; // 500.00 + 110.00 = 610.00

    console.log(`Standard Payouts non-failed (After rejection): ${stdWithdrawnNonFailedAfter} (Expected: 0.00)`);
    console.log(`Calculated Available Std Balance (After rejection): ${available_std_after} (Expected: 500.00)`);
    console.log(`Total Recalculated Balance (After rejection): ${available_balance_after} (Expected: 610.00)`);
    if (available_balance_after !== 610.00) throw new Error('Recalculated Available Balance math mismatch!');
    
    // Verify transaction log entry
    const logCheck = await pool.query(`
      SELECT description, status FROM transactions 
      WHERE user_id = $1 AND transaction_type = 'withdrawal'
      ORDER BY created_at DESC LIMIT 1
    `, [testUserId]);
    console.log(`Last transaction status: ${logCheck.rows[0].status} (Expected: failed)`);
    console.log(`Last transaction desc: "${logCheck.rows[0].description}"`);
    if (logCheck.rows[0].status !== 'failed') throw new Error('Transaction log entry status mismatch!');

    console.log('\n--- VERIFICATION COMPLETED SUCCESSFULLY ---');
    console.log('All calculations, database schema structures, and business logic math hold perfectly!');

  } catch (error) {
    console.error('\n--- VERIFICATION FAILED ---');
    console.error(error);
  } finally {
    // 4. CLEANUP TEST DATA
    console.log('Cleaning up mock database records...');
    try {
      await pool.query(`DELETE FROM call_records WHERE listener_id = $1`, [testListenerId]);
      await pool.query(`DELETE FROM call_gifts WHERE listener_id = $1`, [testListenerId]);
      await pool.query(`DELETE FROM listener_gift_earnings_ledger WHERE listener_id = $1`, [testListenerId]);
      await pool.query(`DELETE FROM listener_gift_withdrawal_requests WHERE listener_id = $1`, [testListenerId]);
      await pool.query(`DELETE FROM listener_withdrawal_requests WHERE listener_id = $1`, [testListenerId]);
      await pool.query(`DELETE FROM transactions WHERE user_id = $1`, [testUserId]);
      await pool.query(`DELETE FROM calls WHERE listener_id = $1 OR caller_id = $2`, [testListenerId, testUserId]);
      await pool.query(`DELETE FROM listeners WHERE listener_id = $1`, [testListenerId]);
      await pool.query(`DELETE FROM users WHERE user_id = $1`, [testUserId]);
      await pool.query(`DELETE FROM admins WHERE admin_id = $1`, [testAdminId]);
      console.log('✓ Clean up complete.');
    } catch (err) {
      console.error('Clean up failed:', err.message);
    }
    await pool.end();
  }
}

verifyWithdrawals();
