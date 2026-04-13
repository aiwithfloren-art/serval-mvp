const db = require('./db');

// Add admin_email column if missing (for existing DBs)
try {
  db.prepare("SELECT admin_email FROM companies LIMIT 1").get();
} catch(e) {
  console.log('Adding admin_email column...');
  db.exec("ALTER TABLE companies ADD COLUMN admin_email TEXT DEFAULT ''");
}

// Add manager_password column if missing
try {
  db.prepare("SELECT manager_password FROM companies LIMIT 1").get();
} catch(e) {
  console.log('Adding manager_password column...');
  db.exec("ALTER TABLE companies ADD COLUMN manager_password TEXT DEFAULT ''");
}

console.log('Migration done');
