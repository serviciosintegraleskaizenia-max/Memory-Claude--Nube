// Panel del cliente (PEX Solution y los que sigan). Servidor propio, en su propio puerto.
// No comparte código ni sesiones con Oficina. Solo el dueño crea cuentas (crear-cliente.js).
// Variables: PANEL_CLIENTE_PUERTO (3110), PANEL_CLIENTE_DB (postgres://...), PANEL_CLIENTE_INTERNO (clave para Oficina),
//            PANEL_CLIENTE_SEGURO=1 (cookie solo por HTTPS).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PUERTO = Number(process.env.PANEL_CLIENTE_PUERTO || 3110);
const SEGURO = process.env.PANEL_CLIENTE_SEGURO === '1';
const INTERNO = process.env.PANEL_CLIENTE_INTERNO || '';
const MAX_CUERPO = 9 * 1024 * 1024;
const MAX_ARCHIVO = 6 * 1024 * 1024;
const MAX_IMAGEN = 1.5 * 1024 * 1024;
const DURACION_SESION_MS = 12 * 60 * 60 * 1000;
const pool = new Pool({ connectionString: process.env.PANEL_CLIENTE_DB || 'postgres://localhost/panel_cliente' });
const intentos = new Map();

// ---------- Utilidades ----------
function texto(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function json(res, codigo, cuerpo) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(cuerpo));
}
function leerCuerpo(req) {
  return new Promise((resolver, rechazar) => {
    let total = 0; const trozos = [];
    req.on('data', t => { total += t.length; if (total > MAX_CUERPO) { rechazar(new Error('cuerpo_grande')); req.destroy(); } else trozos.push(t); });
    req.on('end', () => { try { resolver(trozos.length ? JSON.parse(Buffer.concat(trozos).toString('utf8')) : {}); } catch (e) { rechazar(new Error('json_invalido')); } });
    req.on('error', rechazar);
  });
}
function cookies(req) {
  const salida = {};
  (req.headers.cookie || '').split(';').forEach(par => { const i = par.indexOf('='); if (i > 0) salida[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim()); });
  return salida;
}
function hashClave(clave) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(clave, sal, 64).toString('hex');
  return 'scrypt$' + sal + '$' + hash;
}
function claveCorrecta(clave, guardada) {
  const [tipo, sal, hash] = String(guardada).split('$');
  if (tipo !== 'scrypt' || !sal || !hash) return false;
  const calculado = crypto.scryptSync(clave, sal, 64);
  const esperado = Buffer.from(hash, 'hex');
  return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}
function sinTildes(t) { return String(t || '').toLowerCase().replace(/[áéíóúü]/g, c => ({ 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ü': 'u' }[c])).replace(/ñ/g, 'n'); }

// ---------- Base de datos ----------
async function prepararBase() {
  const sql = fs.readFileSync(path.join(__dirname, 'esquema.sql'), 'utf8');
  await pool.query(sql);
}

async function sesionDe(req) {
  const token = cookies(req).pc_sesion;
  if (!token) return null;
  const r = await pool.query(`SELECT c.* FROM sesiones s JOIN cuentas c ON c.id = s.cuenta_id
    WHERE s.token = $1 AND s.expira > now() AND c.activa = TRUE`, [token]);
  return r.rows[0] || null;
}

async function cuentaDe(req, res) {
  const c = await sesionDe(req);
  if (!c) { json(res, 401, { error: 'Inicia sesión para continuar.' }); return null; }
  if (c.suspendida) { json(res, 403, { error: c.motivo_suspension || 'Tu cuenta está suspendida. Comunícate con Kaizen.', suspendida: true }); return null; }
  return c;
}

function kaizenConectado(cuenta) {
  return !!cuenta.kaizen_visto && (Date.now() - new Date(cuenta.kaizen_visto).getTime()) < 2 * 60 * 1000;
}

// ---------- Rutas ----------
const rutas = {};
function ruta(metodo, patron, fn) { rutas[metodo + ' ' + patron] = { re: new RegExp('^' + patron.replace(/:(\w+)/g, '([^/]+)') + '$'), fn }; }

// Sesión
ruta('POST', '/api/login', async (req, res) => {
  const f = await leerCuerpo(req);
  const usuario = texto(f.usuario, 60).toLowerCase(), clave = String(f.clave || '');
  const clave_intentos = intentos.get(usuario) || { n: 0, desde: Date.now() };
  if (Date.now() - clave_intentos.desde > 15 * 60 * 1000) { clave_intentos.n = 0; clave_intentos.desde = Date.now(); }
  if (clave_intentos.n >= 10) return json(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
  const r = await pool.query('SELECT * FROM cuentas WHERE usuario = $1', [usuario]);
  const c = r.rows[0];
  if (!c || !claveCorrecta(clave, c.clave_hash)) { clave_intentos.n++; intentos.set(usuario, clave_intentos); return json(res, 401, { error: 'Usuario o contraseña incorrectos.' }); }
  if (!c.activa) return json(res, 403, { error: 'Esta cuenta está desactivada. Comunícate con Kaizen.' });
  intentos.delete(usuario);
  if (c.suspendida) return json(res, 403, { error: c.motivo_suspension || 'Tu cuenta está suspendida. Comunícate con Kaizen.', suspendida: true });
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sesiones (token, cuenta_id, expira) VALUES ($1, $2, $3)', [token, c.id, new Date(Date.now() + DURACION_SESION_MS)]);
  res.setHeader('Set-Cookie', `pc_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACION_SESION_MS / 1000}${SEGURO ? '; Secure' : ''}`);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/logout', async (req, res) => {
  const token = cookies(req).pc_sesion;
  if (token) await pool.query('DELETE FROM sesiones WHERE token = $1', [token]);
  res.setHeader('Set-Cookie', `pc_sesion=; Path=/; HttpOnly; Max-Age=0${SEGURO ? '; Secure' : ''}`);
  json(res, 200, { ok: true });
});

// Datos generales
ruta('GET', '/api/yo', async (req, res) => {
  const c = await sesionDe(req);
  if (!c) return json(res, 401, { error: 'Inicia sesión para continuar.' });
  if (c.suspendida) return json(res, 403, { error: c.motivo_suspension || 'Tu cuenta está suspendida.', suspendida: true });
  const a = (await pool.query('SELECT * FROM ajustes WHERE cuenta_id = $1', [c.id])).rows[0] || {};
  const n = (await pool.query('SELECT count(*)::int AS n FROM notificaciones WHERE cuenta_id = $1 AND leida = FALSE', [c.id])).rows[0].n;
  json(res, 200, {
    cuenta: { usuario: c.usuario, nombre: c.nombre_empresa },
    ajustes: { logo: a.logo || '', banner: a.banner || '', ia_activa: a.ia_activa !== false, prompt: a.prompt || '', bienvenida: a.bienvenida || '', prueba_activa: !!a.prueba_activa },
    kaizen_conectado: kaizenConectado(c),
    notificaciones_sin_leer: n
  });
});
ruta('POST', '/api/marca', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const nombre = texto(f.nombre, 80) || c.nombre_empresa;
  await pool.query('UPDATE cuentas SET nombre_empresa = $1 WHERE id = $2', [nombre, c.id]);
  const logo = typeof f.logo === 'string' ? f.logo : null, banner = typeof f.banner === 'string' ? f.banner : null;
  for (const [campo, valor] of [['logo', logo], ['banner', banner]]) {
    if (valor === null) continue;
    if (valor && (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(valor) || valor.length > MAX_IMAGEN * 1.4)) return json(res, 400, { error: 'La imagen debe ser PNG, JPG, WEBP o GIF de hasta 1.5 MB.' });
    await pool.query(`INSERT INTO ajustes (cuenta_id, ${campo}) VALUES ($1, $2) ON CONFLICT (cuenta_id) DO UPDATE SET ${campo} = EXCLUDED.${campo}`, [c.id, valor]);
  }
  json(res, 200, { ok: true, nombre });
});
ruta('POST', '/api/ia', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  await pool.query(`INSERT INTO ajustes (cuenta_id, ia_activa) VALUES ($1, $2) ON CONFLICT (cuenta_id) DO UPDATE SET ia_activa = EXCLUDED.ia_activa`, [c.id, !!f.activa]);
  json(res, 200, { ok: true, ia_activa: !!f.activa });
});
ruta('POST', '/api/clave', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  if (!claveCorrecta(String(f.actual || ''), c.clave_hash)) return json(res, 400, { error: 'La contraseña actual no es correcta.' });
  if (String(f.nueva || '').length < 8) return json(res, 400, { error: 'La contraseña nueva debe tener al menos 8 caracteres.' });
  await pool.query('UPDATE cuentas SET clave_hash = $1 WHERE id = $2', [hashClave(String(f.nueva)), c.id]);
  json(res, 200, { ok: true });
});

// Entrenamiento
ruta('GET', '/api/prompt', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const a = (await pool.query('SELECT prompt, bienvenida FROM ajustes WHERE cuenta_id = $1', [c.id])).rows[0] || { prompt: '', bienvenida: '' };
  json(res, 200, a);
});
ruta('POST', '/api/prompt', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const prompt = texto(f.prompt, 12000), bienvenida = texto(f.bienvenida, 500);
  if (!prompt) return json(res, 400, { error: 'Escribe las instrucciones.' });
  await pool.query(`INSERT INTO ajustes (cuenta_id, prompt, bienvenida) VALUES ($1, $2, $3)
    ON CONFLICT (cuenta_id) DO UPDATE SET prompt = EXCLUDED.prompt, bienvenida = EXCLUDED.bienvenida`, [c.id, prompt, bienvenida]);
  await pool.query('INSERT INTO prompt_versiones (cuenta_id, prompt, bienvenida) VALUES ($1, $2, $3)', [c.id, prompt, bienvenida]);
  json(res, 200, { ok: true });
});
ruta('GET', '/api/prompt/versiones', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const r = await pool.query('SELECT id, creada FROM prompt_versiones WHERE cuenta_id = $1 ORDER BY id DESC LIMIT 30', [c.id]);
  json(res, 200, { versiones: r.rows });
});
ruta('POST', '/api/prompt/restaurar', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const v = (await pool.query('SELECT prompt, bienvenida FROM prompt_versiones WHERE id = $1 AND cuenta_id = $2', [Number(f.id) || 0, c.id])).rows[0];
  if (!v) return json(res, 404, { error: 'Esa versión ya no existe.' });
  await pool.query(`INSERT INTO ajustes (cuenta_id, prompt, bienvenida) VALUES ($1, $2, $3)
    ON CONFLICT (cuenta_id) DO UPDATE SET prompt = EXCLUDED.prompt, bienvenida = EXCLUDED.bienvenida`, [c.id, v.prompt, v.bienvenida]);
  await pool.query('INSERT INTO prompt_versiones (cuenta_id, prompt, bienvenida) VALUES ($1, $2, $3)', [c.id, v.prompt, v.bienvenida]);
  json(res, 200, { ok: true });
});
ruta('GET', '/api/archivos', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const r = await pool.query('SELECT id, nombre, tamano, creado FROM archivos_entrenamiento WHERE cuenta_id = $1 ORDER BY id DESC', [c.id]);
  json(res, 200, { archivos: r.rows });
});
ruta('POST', '/api/archivos', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const nombre = texto(f.nombre, 200), datos = String(f.datos || '');
  const m = datos.match(/^data:[^;]*;base64,(.*)$/);
  if (!nombre || !m) return json(res, 400, { error: 'Archivo no válido.' });
  const tamano = Math.floor(m[1].length * 3 / 4);
  if (tamano > MAX_ARCHIVO) return json(res, 400, { error: 'El archivo es muy grande (máximo 6 MB).' });
  const r = await pool.query('INSERT INTO archivos_entrenamiento (cuenta_id, nombre, tamano, datos) VALUES ($1, $2, $3, $4) RETURNING id, nombre, tamano, creado', [c.id, nombre, tamano, m[1]]);
  json(res, 200, { ok: true, archivo: r.rows[0] });
});
ruta('DELETE', '/api/archivos/:id', async (req, res, [id]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  await pool.query('DELETE FROM archivos_entrenamiento WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id]);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/prueba', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const a = (await pool.query('SELECT prueba_activa FROM ajustes WHERE cuenta_id = $1', [c.id])).rows[0];
  const encendida = f.encender === undefined ? !!(a && a.prueba_activa) : !!f.encender;
  if (f.encender !== undefined) await pool.query(`INSERT INTO ajustes (cuenta_id, prueba_activa) VALUES ($1, $2) ON CONFLICT (cuenta_id) DO UPDATE SET prueba_activa = EXCLUDED.prueba_activa`, [c.id, encendida]);
  const t = texto(f.texto, 1000);
  let respuesta = null;
  if (t) respuesta = encendida ? 'Respuesta de ejemplo: aquí aparecerá la respuesta real de la IA con tus instrucciones y archivos.' : 'La IA de prueba está apagada. Enciéndela para ver la respuesta.';
  json(res, 200, { ok: true, prueba_activa: encendida, respuesta });
});

// CRM
ruta('GET', '/api/clientes', async (req, res, _p, url) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const q = sinTildes(texto(url.searchParams.get('q'), 80)).replace(/\s/g, '');
  const r = await pool.query(`SELECT id, nombre, telefono, correo FROM clientes WHERE cuenta_id = $1 AND (
      $2 = '' OR translate(lower(nombre), 'áéíóúüñ', 'aeiouun') LIKE '%' || $2 || '%' OR replace(telefono, ' ', '') LIKE '%' || $2 || '%') ORDER BY nombre`, [c.id, q]);
  json(res, 200, { clientes: r.rows });
});
ruta('POST', '/api/clientes', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const nombre = texto(f.nombre, 120);
  if (!nombre) return json(res, 400, { error: 'Escribe el nombre del cliente.' });
  const r = await pool.query('INSERT INTO clientes (cuenta_id, nombre, telefono, correo) VALUES ($1, $2, $3, $4) RETURNING id, nombre, telefono, correo',
    [c.id, nombre, texto(f.telefono, 40), texto(f.correo, 150)]);
  json(res, 200, { ok: true, cliente: r.rows[0] });
});
ruta('GET', '/api/clientes/:id', async (req, res, [id]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const cl = (await pool.query('SELECT id, nombre, telefono, correo FROM clientes WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id])).rows[0];
  if (!cl) return json(res, 404, { error: 'Cliente no encontrado.' });
  const etiquetas = (await pool.query('SELECT id, texto FROM cliente_etiquetas WHERE cliente_id = $1 ORDER BY id', [cl.id])).rows;
  const notas = (await pool.query('SELECT id, texto, creada FROM cliente_notas WHERE cliente_id = $1 ORDER BY id DESC', [cl.id])).rows;
  json(res, 200, { cliente: cl, etiquetas, notas });
});
ruta('POST', '/api/clientes/:id/etiquetas', async (req, res, [id]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const t = texto(f.texto, 40);
  if (!t) return json(res, 400, { error: 'Escribe la etiqueta.' });
  const dueno = (await pool.query('SELECT 1 FROM clientes WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id])).rowCount;
  if (!dueno) return json(res, 404, { error: 'Cliente no encontrado.' });
  await pool.query('INSERT INTO cliente_etiquetas (cliente_id, texto) VALUES ($1, $2)', [Number(id), t]);
  json(res, 200, { ok: true });
});
ruta('DELETE', '/api/clientes/:id/etiquetas/:eid', async (req, res, [id, eid]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  await pool.query(`DELETE FROM cliente_etiquetas WHERE id = $1 AND cliente_id IN (SELECT id FROM clientes WHERE id = $2 AND cuenta_id = $3)`, [Number(eid) || 0, Number(id) || 0, c.id]);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/clientes/:id/notas', async (req, res, [id]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const t = texto(f.texto, 1000);
  if (!t) return json(res, 400, { error: 'Escribe la nota.' });
  const dueno = (await pool.query('SELECT 1 FROM clientes WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id])).rowCount;
  if (!dueno) return json(res, 404, { error: 'Cliente no encontrado.' });
  await pool.query('INSERT INTO cliente_notas (cliente_id, texto) VALUES ($1, $2)', [Number(id), t]);
  json(res, 200, { ok: true });
});

// Respuestas rápidas y plantillas
ruta('GET', '/api/rapidas', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  json(res, 200, { rapidas: (await pool.query('SELECT id, titulo, texto FROM respuestas_rapidas WHERE cuenta_id = $1 ORDER BY id', [c.id])).rows });
});
ruta('POST', '/api/rapidas', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const t = texto(f.titulo, 80), x = texto(f.texto, 1000);
  if (!t || !x) return json(res, 400, { error: 'Escribe el nombre y el texto.' });
  await pool.query('INSERT INTO respuestas_rapidas (cuenta_id, titulo, texto) VALUES ($1, $2, $3)', [c.id, t, x]);
  json(res, 200, { ok: true });
});
ruta('DELETE', '/api/rapidas/:id', async (req, res, [id]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  await pool.query('DELETE FROM respuestas_rapidas WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id]);
  json(res, 200, { ok: true });
});
ruta('GET', '/api/plantillas', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  json(res, 200, { plantillas: (await pool.query('SELECT id, nombre, tipo, texto, estado, motivo FROM plantillas_whatsapp WHERE cuenta_id = $1 ORDER BY id', [c.id])).rows });
});

// Chat con Kaizen
ruta('GET', '/api/chat', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const m = (await pool.query('SELECT id, de, texto, creado FROM mensajes_kaizen WHERE cuenta_id = $1 ORDER BY id DESC LIMIT 200', [c.id])).rows.reverse();
  json(res, 200, { mensajes: m, kaizen_conectado: kaizenConectado(c) });
});
ruta('POST', '/api/chat', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const t = texto(f.texto, 1000);
  if (!t) return json(res, 400, { error: 'Escribe el mensaje.' });
  await pool.query("INSERT INTO mensajes_kaizen (cuenta_id, de, texto) VALUES ($1, 'cliente', $2)", [c.id, t]);
  json(res, 200, { ok: true });
});

// Recibos y avisos
ruta('GET', '/api/recibos', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  json(res, 200, { recibos: (await pool.query('SELECT id, periodo, monto_centavos, vence, estado FROM recibos WHERE cuenta_id = $1 ORDER BY id DESC', [c.id])).rows });
});
ruta('GET', '/api/notificaciones', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  json(res, 200, { notificaciones: (await pool.query('SELECT id, texto, creada, leida FROM notificaciones WHERE cuenta_id = $1 ORDER BY id DESC LIMIT 30', [c.id])).rows });
});
ruta('POST', '/api/notificaciones/leer', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  await pool.query('UPDATE notificaciones SET leida = TRUE WHERE cuenta_id = $1', [c.id]);
  json(res, 200, { ok: true });
});

// Conexión pendiente (Chatwoot, correo y Meta se conectan en la siguiente etapa)
ruta('GET', '/api/canales', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  json(res, 200, { conectado: false, motivo: 'Las conversaciones se conectan en la siguiente etapa.' });
});

// Interno: solo para Oficina (con la clave PANEL_CLIENTE_INTERNO). Sin esa clave no hace nada.
ruta('POST', '/api/interno/presencia', async (req, res) => {
  if (!INTERNO || req.headers['x-clave-interna'] !== INTERNO) return json(res, 403, { error: 'No autorizado.' });
  const f = await leerCuerpo(req);
  await pool.query('UPDATE cuentas SET kaizen_visto = now() WHERE usuario = $1', [texto(f.usuario, 60).toLowerCase()]);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/interno/mensaje', async (req, res) => {
  if (!INTERNO || req.headers['x-clave-interna'] !== INTERNO) return json(res, 403, { error: 'No autorizado.' });
  const f = await leerCuerpo(req);
  const c = (await pool.query('SELECT id FROM cuentas WHERE usuario = $1', [texto(f.usuario, 60).toLowerCase()])).rows[0];
  if (!c) return json(res, 404, { error: 'Cuenta no encontrada.' });
  const t = texto(f.texto, 1000);
  if (!t) return json(res, 400, { error: 'Mensaje vacío.' });
  await pool.query("INSERT INTO mensajes_kaizen (cuenta_id, de, texto) VALUES ($1, 'kaizen', $2)", [c.id, t]);
  await pool.query('INSERT INTO notificaciones (cuenta_id, texto) VALUES ($1, $2)', [c.id, 'Kaizen te escribió en el chat']);
  json(res, 200, { ok: true });
});

// ---------- Servidor ----------
const INDEX = path.join(__dirname, 'index.html');
const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No encontrado.' });
    for (const clave of Object.keys(rutas)) {
      const [metodo] = clave.split(' ');
      if (metodo !== req.method) continue;
      const r = rutas[clave];
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      return await r.fn(req, res, m.slice(1), url);
    }
    json(res, 404, { error: 'No encontrado.' });
  } catch (e) {
    if (e.message === 'cuerpo_grande') return json(res, 413, { error: 'El envío es muy grande.' });
    if (e.message === 'json_invalido') return json(res, 400, { error: 'Envío no válido.' });
    console.error('[panel-cliente]', e);
    json(res, 500, { error: 'Algo salió mal. Intenta de nuevo.' });
  }
});

if (require.main === module) {
  prepararBase().then(() => servidor.listen(PUERTO, '127.0.0.1', () => console.log('Panel del cliente en http://127.0.0.1:' + PUERTO)))
    .catch(e => { console.error('No se pudo preparar la base:', e.message); process.exit(1); });
}
module.exports = { servidor, pool, prepararBase, hashClave, claveCorrecta };
