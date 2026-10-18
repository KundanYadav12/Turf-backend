const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function debugLogin() {
  const conn = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'Kundan@12',
    database: 'turf_sports_db'
  });
  
  const sql = `SELECT u.*, r.name as role 
     FROM users u
     JOIN user_roles ur ON u.id = ur.user_id
     JOIN roles r ON ur.role_id = r.id
     WHERE u.email = ?`;
  
  const [users] = await conn.execute(sql, ['player@turf.com']);
  console.log('Query Result Count:', users.length);
  
  if (users.length > 0) {
    const u = users[0];
    console.log('Found user:', u.email, '| Status:', u.status, '| Role:', u.role);
    console.log('Password hash:', u.password_hash.substring(0, 20));
    
    const match = await bcrypt.compare('admin123', u.password_hash);
    console.log('Password match result:', match);
  }
  
  await conn.end();
}
debugLogin().catch(console.error);
