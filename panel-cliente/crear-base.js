// Crea la base panel_cliente si no existe, usando el mismo módulo pg que ya usa Oficina.
// Uso: node crear-base.js CLAVE_POSTGRES RUTA_DE_LA_APP_DE_OFICINA
const [clave, origen] = process.argv.slice(2);
const { Client } = require(origen + '/node_modules/pg');
(async () => {
  const c = new Client({ host: '127.0.0.1', port: 5432, user: 'postgres', password: clave, database: 'postgres' });
  await c.connect();
  const r = await c.query("SELECT 1 FROM pg_database WHERE datname = 'panel_cliente'");
  if (r.rowCount === 0) { await c.query('CREATE DATABASE panel_cliente'); console.log('creada'); } else console.log('existe');
  await c.end();
})().catch(e => { console.error(e.message); process.exit(1); });
