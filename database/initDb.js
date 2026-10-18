const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

async function initDatabase() {
  console.log('🚀 Initializing Sports Booking Database...');
  
  const host = process.env.DB_HOST || 'localhost';
  const port = parseInt(process.env.DB_PORT || '3306');
  const user = process.env.DB_USER || 'root';
  const password = process.env.DB_PASSWORD || '';
  const dbName = process.env.DB_NAME || 'turf_sports_db';

  try {
    // 1. Connect without selecting database to ensure database exists
    const rootConnection = await mysql.createConnection({
      host, port, user, password, multipleStatements: true
    });
    
    await rootConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    console.log(`✅ Database '${dbName}' verified/created.`);
    await rootConnection.end();

    // 2. Connect to specific database
    const dbConnection = await mysql.createConnection({
      host, port, user, password, database: dbName, multipleStatements: true
    });

    // 3. Read and execute schema.sql
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
    await dbConnection.query(schemaSql);
    console.log('✅ Schema tables successfully created.');

    // 4. Read and execute seeders.sql
    const seedersSql = fs.readFileSync(path.join(__dirname, 'seeders.sql'), 'utf-8');
    await dbConnection.query(seedersSql);
    console.log('✅ Default seed data (roles, sports, venues, courts, users) populated.');

    await dbConnection.end();
    console.log('🎉 Database initialization complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Database Initialization Failed:', error.message);
    process.exit(1);
  }
}

initDatabase();
