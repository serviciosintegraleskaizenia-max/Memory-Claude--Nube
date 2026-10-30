const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const config = require('./config');

(async () => {
  const [usuario, clave] = process.argv.slice(2);
  if (!usuario || !clave || clave.length < 8) {
    console.log('Uso: node cambiar-clave.js usuario clave (mínimo 8 caracteres)');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(clave, 10);
  const cliente = new Client(config.db);
  await cliente.connect();
  await cliente.query(
    `INSERT INTO usuarios (usuario, nombre, grupo, empresa, password_hash, activo)
     VALUES ($1, 'Christian Jose', 'Programador', 'todas', $2, TRUE)
     ON CONFLICT (usuario) DO UPDATE SET password_hash = EXCLUDED.password_hash, activo = TRUE`,
    [usuario, hash]
  );
  console.log('Usuario listo:', usuario);
  await cliente.end();
})().catch(e => console.log('Error:', e.message));