// Herramienta del dueño para cuentas del panel del cliente. Solo el dueño la usa.
// Ejemplos:
//   node crear-cliente.js crear --usuario pexsolutions --clave "CLAVE-SEGURA" --nombre "PEX Solution"
//   node crear-cliente.js suspender --usuario pexsolutions --motivo "Pago de noviembre pendiente"
//   node crear-cliente.js activar --usuario pexsolutions
//   node crear-cliente.js clave --usuario pexsolutions --clave "NUEVA-CLAVE"
//   node crear-cliente.js listar
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
      await pool.query('UPDATE cuentas SET suspendida = TRUE, motivo_suspension = $2 WHERE usuario = $1', [usuario, o.motivo || 'Tu cuenta está suspendida. Comunícate con Kaizen.']);
      await pool.query('DELETE FROM sesiones WHERE cuenta_id IN (SELECT id FROM cuentas WHERE usuario = $1)', [usuario]);
      console.log('Cuenta suspendida:', usuario);
    } else if (orden === 'activar') {
      await pool.query('UPDATE cuentas SET suspendida = FALSE, motivo_suspension = \'\' WHERE usuario = $1', [usuario]);
      console.log('Cuenta activa:', usuario);
    } else if (orden === 'clave') {
      if (!o.clave || o.clave.length < 8) throw new Error('La clave debe tener al menos 8 caracteres.');
      await pool.query('UPDATE cuentas SET clave_hash = $2 WHERE usuario = $1', [usuario, hashClave(o.clave)]);
      await pool.query('DELETE FROM sesiones WHERE cuenta_id IN (SELECT id FROM cuentas WHERE usuario = $1)', [usuario]);
      console.log('Clave cambiada:', usuario);
    } else {
      console.log('Órdenes: crear, suspender, activar, clave, listar. Ver el encabezado de este archivo.');
    }
  } catch (e) {
    console.error('Error:', e.message); process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
