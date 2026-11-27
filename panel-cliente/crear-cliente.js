// Herramienta del dueño para cuentas del panel del cliente. Solo el dueño la usa.
// Ejemplos:
//   node crear-cliente.js crear --usuario pexsolutions --clave "CLAVE-SEGURA" --nombre "PEX Solution"
//   node crear-cliente.js suspender --usuario pexsolutions --motivo "Pago de noviembre pendiente"
//   node crear-cliente.js activar --usuario pexsolutions
//   node crear-cliente.js clave --usuario pexsolutions --clave "NUEVA-CLAVE"
//   node crear-cliente.js listar
//   node crear-cliente.js plantillas --usuario pexsolutions   (carga plantillas-pex.json, reemplaza las de esa cuenta)
const { pool, prepararBase, hashClave } = require('./servidor');

function opciones(argv) {
  const o = {}; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1] || ''; i++; } }
  return o;
}
(async () => {
  const [orden, ...resto] = process.argv.slice(2);
  const o = opciones(resto);
  const usuario = String(o.usuario || '').trim().toLowerCase();
  await prepararBase();
  try {
    if (orden === 'listar') {
      const r = await pool.query('SELECT usuario, nombre_empresa, activa, suspendida, motivo_suspension FROM cuentas ORDER BY usuario');
      console.table(r.rows);
    } else if (orden === 'crear') {
      if (!usuario || !o.clave || o.clave.length < 8) throw new Error('Falta --usuario o --clave (mínimo 8 caracteres).');
      const r = await pool.query('INSERT INTO cuentas (usuario, nombre_empresa, clave_hash) VALUES ($1, $2, $3) RETURNING id', [usuario, o.nombre || usuario, hashClave(o.clave)]);
      await pool.query('INSERT INTO ajustes (cuenta_id) VALUES ($1) ON CONFLICT DO NOTHING', [r.rows[0].id]);
      console.log('Cuenta creada:', usuario);
    } else if (orden === 'suspender') {
      await pool.query('UPDATE cuentas SET suspendida = TRUE, estado = \'suspendida\', motivo_suspension = $2 WHERE usuario = $1', [usuario, o.motivo || 'Tu cuenta está suspendida. Comunícate con Kaizen.']);
      await pool.query('DELETE FROM sesiones WHERE cuenta_id IN (SELECT id FROM cuentas WHERE usuario = $1)', [usuario]);
      console.log('Cuenta suspendida:', usuario);
    } else if (orden === 'activar') {
      await pool.query('UPDATE cuentas SET suspendida = FALSE, estado = \'activa\', motivo_suspension = \'\' WHERE usuario = $1', [usuario]);
      console.log('Cuenta activa:', usuario);
    } else if (orden === 'clave') {
      if (!o.clave || o.clave.length < 8) throw new Error('La clave debe tener al menos 8 caracteres.');
      await pool.query('UPDATE cuentas SET clave_hash = $2 WHERE usuario = $1', [usuario, hashClave(o.clave)]);
      await pool.query('DELETE FROM sesiones WHERE cuenta_id IN (SELECT id FROM cuentas WHERE usuario = $1)', [usuario]);
      console.log('Clave cambiada:', usuario);
    } else if (orden === 'plantillas') {
      const fs = require('fs'); const path = require('path');
      const archivo = o.archivo || path.join(__dirname, 'plantillas-pex.json');
      const lista = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      const c = (await pool.query('SELECT id FROM cuentas WHERE usuario = $1', [usuario])).rows[0];
      if (!c) throw new Error('No existe la cuenta ' + usuario + '.');
      await pool.query('DELETE FROM plantillas_whatsapp WHERE cuenta_id = $1', [c.id]);
      for (const p of lista) {
        await pool.query('INSERT INTO plantillas_whatsapp (cuenta_id, nombre, tipo, texto, estado, motivo) VALUES ($1, $2, $3, $4, $5, $6)',
          [c.id, p.nombre, p.tipo, p.texto, p.estado, p.motivo || '']);
      }
      console.log('Plantillas cargadas:', lista.length);
    } else {
      console.log('Órdenes: crear, suspender, activar, clave, listar, plantillas. Ver el encabezado de este archivo.');
    }
  } catch (e) {
    console.error('Error:', e.message); process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
