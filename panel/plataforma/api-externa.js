// API de Zentralia para sistemas externos (SYSSTOURS u otros): solo lectura de reservas y operaciones.
//
// Oficina crea una llave por sistema y la guarda (solo su huella SHA-256) en la base de la empresa,
// en la tabla op_api_llaves. La llave se muestra una sola vez. El panel de la empresa la revisa en cada
// petición: /api/v1/... con "Authorization: Bearer zt_...". No usa la sesión del panel.
//
// No expone precios, costos, teléfonos, correos ni notas internas.

const crypto = require('crypto');

const ALCANCES = { 'reservas:leer': 'Leer reservas y servicios' };
const PREFIJO = 'zt_';
const LIMITE_MAX = 500;
const DIAS_MAX = 365;
const DIAS_DEFECTO = 365;

const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const fechaISO = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

async function preparar(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS op_api_llaves (
    id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, huella TEXT NOT NULL UNIQUE, fin TEXT NOT NULL DEFAULT '',
    alcance TEXT NOT NULL DEFAULT 'reservas:leer', vence DATE NOT NULL, activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), ultimo_uso TIMESTAMPTZ)`);
}

// Crea una llave nueva. Devuelve la clave completa una sola vez.
async function crearLlave(db, { nombre, alcance, dias }) {
  await preparar(db);
  const n = String(nombre || '').trim().slice(0, 60);
  if (!n) throw Object.assign(new Error('Ponle un nombre al sistema que se conecta.'), { codigo: 400 });
  if (!ALCANCES[alcance]) throw Object.assign(new Error('Alcance no válido.'), { codigo: 400 });
  const d = Math.min(Math.max(Number(dias) || DIAS_DEFECTO, 1), DIAS_MAX);
  const clave = PREFIJO + crypto.randomBytes(24).toString('base64url');
  const vence = new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  await db.query('INSERT INTO op_api_llaves (nombre, huella, fin, alcance, vence) VALUES ($1, $2, $3, $4, $5)',
    [n, hash(clave), clave.slice(-4), alcance, vence]);
  return { clave, vence };
}

async function listarLlaves(db) {
  await preparar(db);
  const filas = (await db.query(`SELECT id, nombre, fin, alcance, to_char(vence, 'YYYY-MM-DD') AS vence, activo,
    to_char(ultimo_uso, 'YYYY-MM-DD HH24:MI') AS ultimo_uso FROM op_api_llaves ORDER BY creado DESC`)).rows;
  const hoy = new Date().toISOString().slice(0, 10);
  return filas.map(f => ({ ...f, vigente: f.activo && f.vence >= hoy }));
}

async function revocarLlave(db, id) {
  await preparar(db);
  const r = await db.query('UPDATE op_api_llaves SET activo = FALSE WHERE id = $1 RETURNING nombre', [Number(id) || 0]);
  return r.rows[0] ? r.rows[0].nombre : null;
}

// Revisa la llave del encabezado. Devuelve la fila de la llave o null.
async function llaveDe(db, req) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(zt_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const f = (await db.query(`SELECT id, alcance FROM op_api_llaves WHERE huella = $1 AND activo AND vence >= CURRENT_DATE`, [hash(m[1])])).rows[0];
  if (f) await db.query('UPDATE op_api_llaves SET ultimo_uso = NOW() WHERE id = $1', [f.id]);
  return f || null;
}

// Forma pública de una reserva: sin precios, costos ni datos de contacto.
function reservaPublica(f) {
  return {
    id: f.id, numero_servicio: f.numero_servicio, estado: f.estado, clase: f.clase, tipo: f.tipo_servicio || f.clase,
    fecha: f.fecha, hora: f.hora, sede: f.sede, agencia: f.agencia, cliente: f.nombre_cliente,
    pax: { adultos: f.adultos || 0, ninos: f.ninos || 0, infantes: f.infantes || 0 },
    hotel: f.hotel, origen: f.punto_partida, destino: f.punto_llegada, aeropuerto: f.aeropuerto,
    actividad: f.actividad, vuelo: f.vuelo
  };
}

const SELECT = `SELECT o.id, o.estado, o.clase, o.fecha, o.hora, o.sede, o.agencia,
  c.numero_servicio, c.tipo_servicio, c.nombre_cliente, c.adultos, c.ninos, c.infantes, c.hotel,
  c.punto_partida, c.punto_llegada, c.aeropuerto, c.actividad, c.vuelo
  FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id`;

// Atiende /api/v1/... Devuelve true si la ruta era de la API.
async function manejarApi(db, req, res, url, { json }) {
  if (!url.startsWith('/api/v1/')) return false;
  if (req.method !== 'GET') { json(res, 405, { error: 'Solo lectura.' }); return true; }
  const ruta = url.split('?')[0];
  if (ruta === '/api/v1/estado') { json(res, 200, { ok: true, version: 1 }); return true; }

  const llave = await llaveDe(db, req);
  if (!llave) { json(res, 401, { error: 'Llave no válida, vencida o revocada.' }); return true; }
  if (llave.alcance !== 'reservas:leer') { json(res, 403, { error: 'La llave no tiene permiso para esto.' }); return true; }

  const p = new URL(req.url, 'http://localhost').searchParams;
  if (ruta === '/api/v1/reservas') {
    const desde = fechaISO(p.get('desde')), hasta = fechaISO(p.get('hasta'));
    if (!desde || !hasta) { json(res, 400, { error: 'Indica desde y hasta (AAAA-MM-DD).' }); return true; }
    if (hasta < desde) { json(res, 400, { error: 'hasta debe ser igual o posterior a desde.' }); return true; }
    const dias = (new Date(hasta) - new Date(desde)) / 86400000;
    if (dias > 62) { json(res, 400, { error: 'El rango máximo es de 62 días.' }); return true; }
    const limite = Math.min(Math.max(Number(p.get('limite')) || 200, 1), LIMITE_MAX);
    const filas = (await db.query(`${SELECT} WHERE o.fecha >= $1 AND o.fecha <= $2 ORDER BY o.fecha, o.hora, o.id LIMIT $3`, [desde, hasta, limite])).rows;
    json(res, 200, { datos: filas.map(reservaPublica), total: filas.length, limite });
    return true;
  }
  const m = ruta.match(/^\/api\/v1\/reservas\/(\d+)$/);
  if (m) {
    const f = (await db.query(`${SELECT} WHERE o.id = $1`, [Number(m[1])])).rows[0];
    if (!f) { json(res, 404, { error: 'No existe esa reserva.' }); return true; }
    json(res, 200, { dato: reservaPublica(f) });
    return true;
  }
  json(res, 404, { error: 'No existe esa ruta.' });
  return true;
}

module.exports = { preparar, crearLlave, listarLlaves, revocarLlave, manejarApi, ALCANCES };
