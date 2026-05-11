import jwt from 'jsonwebtoken';
import config from './config/config.js';

async function testToken() {
    try {
        const payload = {
            admin_id: 'e976634d-d8c3-442a-99ed-8d6fd3ba3d28',
            email: 'rohitraj70615@gmail.com'
        };
        const token = jwt.sign(payload, config.jwt.secret, { expiresIn: '30d' });
        console.log('Testing token against live API...');
        const result = await fetch('https://api.appdost.com/api/admin/listeners', {
            headers: { Authorization: `Bearer ${token}` }
        });
        console.log('Status:', result.status);
        console.log('Response:', await result.text());
    } catch (err) {
        console.error(err);
    } finally {
        process.exit(0);
    }
}
testToken();
