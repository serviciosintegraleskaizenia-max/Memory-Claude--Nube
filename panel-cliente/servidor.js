// Panel del cliente (PEX Solution y los que sigan). Servidor propio, en su propio puerto.
// No comparte código ni sesiones con Oficina. Oficina lo controla por dentro del servidor con la clave interna.
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
const EN_LINEA_MS = 2 * 60 * 1000;
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const MODELO_POR_DEFECTO = 'anthropic/claude-haiku-5.5';
const pool = new Pool({ connectionString: process.env.PANEL_CLIENTE_DB || 'postgres://localhost/panel_cliente' });
const intentos = new Map();

// Secciones del panel que Oficina enciende o apaga. Si Oficina no dijo nada, están encendidas.
const MODULOS = ['redes', 'conversaciones', 'plantillas', 'chat', 'crm', 'entreno', 'pagos', 'correo'];
const RUTA_MODULO = [['/api/clientes', 'crm'], ['/api/rapidas', 'plantillas'], ['/api/plantillas', 'plantillas'], ['/api/chat', 'chat'],
  ['/api/prompt', 'entreno'], ['/api/archivos', 'entreno'], ['/api/prueba', 'entreno'], ['/api/recibos', 'pagos'], ['/api/canales', 'conversaciones']];
const CANALES = ['whatsapp', 'instagram', 'facebook', 'tiktok', 'publicidad', 'web'];

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
function enLinea(fecha) { return !!fecha && (Date.now() - new Date(fecha).getTime()) < EN_LINEA_MS; }
function modulosDe(c) { const m = c.modulos || {}; return Object.fromEntries(MODULOS.map(k => [k, m[k] !== false])); }
function archivoDeDataUrl(datos) {
  const m = String(datos || '').match(/^data:([^;,]*)(;[^,]*)?;base64,(.*)$/);
  if (!m) return null;
  return { tipo: texto(m[1] || 'application/octet-stream', 100), base64: m[3], tamano: Math.floor(m[3].length * 3 / 4) };
}

// La clave de OpenRouter se guarda cifrada con una llave sacada de la clave interna del servidor.
function llaveCifrado() { return INTERNO ? crypto.createHash('sha256').update('panel-cliente:' + INTERNO).digest() : null; }
function cifrar(t) {
  const k = llaveCifrado(); if (!k) throw new Error('Falta la clave interna del servidor para guardar claves.');
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const d = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
  return 'gcm$' + iv.toString('hex') + '$' + c.getAuthTag().toString('hex') + '$' + d.toString('hex');
}
function descifrar(t) {
  try {
    const [tipo, iv, tag, d] = String(t || '').split('$'); const k = llaveCifrado();
    if (tipo !== 'gcm' || !k) return '';
    const x = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'hex')); x.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([x.update(Buffer.from(d, 'hex')), x.final()]).toString('utf8');
  } catch (e) { return ''; }
}

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
async function cuentaPorUsuario(usuario) {
  return (await pool.query('SELECT * FROM cuentas WHERE usuario = $1', [texto(usuario, 60).toLowerCase()])).rows[0] || null;
}
async function ajustesDe(id) {
  await pool.query('INSERT INTO ajustes (cuenta_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  return (await pool.query('SELECT * FROM ajustes WHERE cuenta_id = $1', [id])).rows[0];
}
async function avisarKaizen(c, tipo, t) {
  await pool.query('INSERT INTO avisos_kaizen (cuenta_id, tipo, texto) VALUES ($1, $2, $3)', [c.id, tipo, texto(t, 300)]);
}

// ---------- Rutas ----------
const rutas = {};
function ruta(metodo, patron, fn) { rutas[metodo + ' ' + patron] = { re: new RegExp('^' + patron.replace(/:(\w+)/g, '([^/]+)') + '$'), fn }; }

// Sesión
ruta('POST', '/api/login', async (req, res) => {
  const f = await leerCuerpo(req);
  const usuario = texto(f.usuario, 60).toLowerCase(), clave = String(f.clave || '');
  const cuenta_intentos = intentos.get(usuario) || { n: 0, desde: Date.now() };
  if (Date.now() - cuenta_intentos.desde > 15 * 60 * 1000) { cuenta_intentos.n = 0; cuenta_intentos.desde = Date.now(); }
  if (cuenta_intentos.n >= 10) return json(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
  const c = await cuentaPorUsuario(usuario);
  if (!c || !claveCorrecta(clave, c.clave_hash)) { cuenta_intentos.n++; intentos.set(usuario, cuenta_intentos); return json(res, 401, { error: 'Usuario o contraseña incorrectos.' }); }
  if (!c.activa) return json(res, 403, { error: 'Esta cuenta está desactivada. Comunícate con Kaizen.' });
  intentos.delete(usuario);
  if (c.suspendida) return json(res, 403, { error: c.motivo_suspension || 'Tu cuenta está suspendida. Comunícate con Kaizen.', suspendida: true });
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sesiones (token, cuenta_id, expira) VALUES ($1, $2, $3)', [token, c.id, new Date(Date.now() + DURACION_SESION_MS)]);
  await pool.query('UPDATE cuentas SET visto = now() WHERE id = $1', [c.id]);
  res.setHeader('Set-Cookie', `pc_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DURACION_SESION_MS / 1000}${SEGURO ? '; Secure' : ''}`);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/logout', async (req, res) => {
  const token = cookies(req).pc_sesion;
  if (token) await pool.query('DELETE FROM sesiones WHERE token = $1', [token]);
  res.setHeader('Set-Cookie', `pc_sesion=; Path=/; HttpOnly; Max-Age=0${SEGURO ? '; Secure' : ''}`);
  json(res, 200, { ok: true });
});

// Datos generales (también marca que el cliente está en línea)
ruta('GET', '/api/yo', async (req, res) => {
  const c = await sesionDe(req);
  if (!c) return json(res, 401, { error: 'Inicia sesión para continuar.' });
  if (c.suspendida) return json(res, 403, { error: c.motivo_suspension || 'Tu cuenta está suspendida.', suspendida: true });
  await pool.query('UPDATE cuentas SET visto = now() WHERE id = $1', [c.id]);
  const a = await ajustesDe(c.id);
  const n = (await pool.query('SELECT count(*)::int AS n FROM notificaciones WHERE cuenta_id = $1 AND leida = FALSE', [c.id])).rows[0].n;
  const recibos = (await pool.query(`SELECT id, periodo, monto_centavos, to_char(vence, 'YYYY-MM-DD') AS vence, mensaje, enlace_pago FROM recibos
    WHERE cuenta_id = $1 AND estado <> 'Pagado' ORDER BY id DESC LIMIT 3`, [c.id])).rows;
  const anuncios = (await pool.query('SELECT id, titulo, texto, creado FROM anuncios WHERE cuenta_id = $1 AND cerrado IS NULL ORDER BY id DESC LIMIT 3', [c.id])).rows;
  json(res, 200, {
    cuenta: { usuario: c.usuario, nombre: c.nombre_empresa, estado: c.estado || 'activa', motivo: c.estado === 'pausada' ? c.motivo_suspension : '' },
    modulos: modulosDe(c),
    redes: c.redes || {},
    ajustes: { logo: a.logo || '', banner: a.banner || '', ia_activa: a.ia_activa !== false, prueba_activa: !!a.prueba_activa, ia_conectada: !!descifrar(a.ia_clave) },
    kaizen_conectado: enLinea(c.kaizen_visto),
    notificaciones_sin_leer: n,
    recibos_pendientes: recibos,
    anuncios
  });
});
ruta('POST', '/api/anuncios/:id/cerrar', async (req, res, [id]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  await pool.query('UPDATE anuncios SET cerrado = now() WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id]);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/marca', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const nombre = texto(f.nombre, 80) || c.nombre_empresa;
  await pool.query('UPDATE cuentas SET nombre_empresa = $1 WHERE id = $2', [nombre, c.id]);
  await ajustesDe(c.id);
  for (const campo of ['logo', 'banner']) {
    const valor = typeof f[campo] === 'string' ? f[campo] : null;
    if (valor === null) continue;
    if (valor && (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(valor) || valor.length > MAX_IMAGEN * 1.4)) return json(res, 400, { error: 'La imagen debe ser PNG, JPG, WEBP o GIF de hasta 1.5 MB.' });
    await pool.query(`UPDATE ajustes SET ${campo} = $2 WHERE cuenta_id = $1`, [c.id, valor]);
  }
  json(res, 200, { ok: true, nombre });
});
ruta('POST', '/api/ia', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  await ajustesDe(c.id);
  await pool.query('UPDATE ajustes SET ia_activa = $2 WHERE cuenta_id = $1', [c.id, !!f.activa]);
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

// Entrenamiento: la base la pone Kaizen desde Oficina; el cliente agrega sus ajustes, con historial.
ruta('GET', '/api/prompt', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const a = await ajustesDe(c.id);
  json(res, 200, { prompt: a.prompt, bienvenida: a.bienvenida, prompt_base: a.prompt_base, bienvenida_base: a.bienvenida_base });
});
ruta('POST', '/api/prompt', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const prompt = texto(f.prompt, 12000), bienvenida = texto(f.bienvenida, 500);
  const a = await ajustesDe(c.id);
  if (!prompt && !a.prompt_base) return json(res, 400, { error: 'Escribe las instrucciones.' });
  await pool.query('UPDATE ajustes SET prompt = $2, bienvenida = $3 WHERE cuenta_id = $1', [c.id, prompt, bienvenida]);
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
  await ajustesDe(c.id);
  await pool.query('UPDATE ajustes SET prompt = $2, bienvenida = $3 WHERE cuenta_id = $1', [c.id, v.prompt, v.bienvenida]);
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
  const nombre = texto(f.nombre, 200), a = archivoDeDataUrl(f.datos);
  if (!nombre || !a) return json(res, 400, { error: 'Archivo no válido.' });
  if (a.tamano > MAX_ARCHIVO) return json(res, 400, { error: 'El archivo es muy grande (máximo 6 MB).' });
  const r = await pool.query('INSERT INTO archivos_entrenamiento (cuenta_id, nombre, tamano, datos) VALUES ($1, $2, $3, $4) RETURNING id, nombre, tamano, creado', [c.id, nombre, a.tamano, a.base64]);
  json(res, 200, { ok: true, archivo: r.rows[0] });
});
ruta('DELETE', '/api/archivos/:id', async (req, res, [id]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  await pool.query('DELETE FROM archivos_entrenamiento WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id]);
  json(res, 200, { ok: true });
});
// Prueba de la IA: si Kaizen ya conectó la clave de OpenRouter, responde de verdad con la base + los ajustes del cliente.
async function responderIA(a, pregunta) {
  const clave = descifrar(a.ia_clave);
  if (!clave) return 'Todavía no hay IA conectada. Kaizen la conecta desde Oficina; mientras tanto no hay respuesta real.';
  const sistema = [a.prompt_base, a.prompt ? 'Ajustes del cliente:\n' + a.prompt : '',
    (a.bienvenida || a.bienvenida_base) ? 'Mensaje de bienvenida: ' + (a.bienvenida || a.bienvenida_base) : ''].filter(Boolean).join('\n\n') || 'Eres un asistente amable y breve.';
  const control = new AbortController(); const reloj = setTimeout(() => control.abort(), 25000);
  try {
    const r = await fetch(OPENROUTER, { method: 'POST', signal: control.signal, headers: { Authorization: 'Bearer ' + clave, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: a.ia_modelo || MODELO_POR_DEFECTO, max_tokens: 600, messages: [{ role: 'system', content: sistema }, { role: 'user', content: pregunta }] }) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return 'La clave de IA no es válida. Avísale a Kaizen.';
    if (!r.ok) return 'La IA no respondió (código ' + r.status + '). Intenta de nuevo.';
    const t = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    return String(t || '').trim() || 'La IA respondió vacío. Intenta de nuevo.';
  } catch (e) { return 'La IA tardó demasiado o no se pudo conectar. Intenta de nuevo.'; } finally { clearTimeout(reloj); }
}
ruta('POST', '/api/prueba', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  let a = await ajustesDe(c.id);
  if (f.encender !== undefined) { await pool.query('UPDATE ajustes SET prueba_activa = $2 WHERE cuenta_id = $1', [c.id, !!f.encender]); a = await ajustesDe(c.id); }
  const t = texto(f.texto, 1000);
  let respuesta = null;
  if (t) respuesta = a.prueba_activa ? await responderIA(a, t) : 'La IA de prueba está apagada. Enciéndela para ver la respuesta.';
  json(res, 200, { ok: true, prueba_activa: !!a.prueba_activa, respuesta, ia_conectada: !!descifrar(a.ia_clave) });
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
  if (!(await pool.query('SELECT 1 FROM clientes WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id])).rowCount) return json(res, 404, { error: 'Cliente no encontrado.' });
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
  if (!(await pool.query('SELECT 1 FROM clientes WHERE id = $1 AND cuenta_id = $2', [Number(id) || 0, c.id])).rowCount) return json(res, 404, { error: 'Cliente no encontrado.' });
  await pool.query('INSERT INTO cliente_notas (cliente_id, texto) VALUES ($1, $2)', [Number(id), t]);
  json(res, 200, { ok: true });
});

// Respuestas rápidas y plantillas (las que crea el cliente esperan la aprobación de Kaizen)
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
  json(res, 200, { plantillas: (await pool.query('SELECT id, nombre, tipo, texto, estado, motivo, origen, creada FROM plantillas_whatsapp WHERE cuenta_id = $1 ORDER BY id', [c.id])).rows });
});
ruta('POST', '/api/plantillas', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const nombre = texto(f.nombre, 60).toLowerCase();
  const tipo = f.tipo === 'Utilidad' ? 'Utilidad' : 'Marketing';
  const t = String(f.texto || '').trim().slice(0, 1024);
  if (!/^[a-z0-9_]{3,60}$/.test(nombre)) return json(res, 400, { error: 'El nombre solo lleva minúsculas, números y _ (por ejemplo: promo_diciembre).' });
  if (t.length < 10) return json(res, 400, { error: 'Escribe el texto de la plantilla.' });
  if ((await pool.query('SELECT 1 FROM plantillas_whatsapp WHERE cuenta_id = $1 AND nombre = $2', [c.id, nombre])).rowCount) return json(res, 400, { error: 'Ya tienes una plantilla con ese nombre.' });
  await pool.query(`INSERT INTO plantillas_whatsapp (cuenta_id, nombre, tipo, texto, estado, origen) VALUES ($1, $2, $3, $4, 'Por aprobar (Kaizen)', 'cliente')`, [c.id, nombre, tipo, t]);
  await avisarKaizen(c, 'plantilla', `${c.nombre_empresa} creó la plantilla ${nombre}: espera tu aprobación.`);
  json(res, 200, { ok: true });
});

// Chat con Kaizen (con documentos)
ruta('GET', '/api/chat', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  await pool.query('UPDATE cuentas SET visto = now() WHERE id = $1', [c.id]);
  const m = (await pool.query(`SELECT id, de, texto, creado, archivo_nombre FROM mensajes_kaizen WHERE cuenta_id = $1 ORDER BY id DESC LIMIT 200`, [c.id])).rows.reverse();
  json(res, 200, { mensajes: m, kaizen_conectado: enLinea(c.kaizen_visto) });
});
ruta('POST', '/api/chat', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const f = await leerCuerpo(req);
  const t = texto(f.texto, 1000);
  let archivo = null;
  if (f.archivo) {
    archivo = archivoDeDataUrl(f.archivo.datos);
    if (!archivo || !texto(f.archivo.nombre, 200)) return json(res, 400, { error: 'Documento no válido.' });
    if (archivo.tamano > MAX_ARCHIVO) return json(res, 400, { error: 'El documento es muy grande (máximo 6 MB).' });
    archivo.nombre = texto(f.archivo.nombre, 200);
  }
  if (!t && !archivo) return json(res, 400, { error: 'Escribe el mensaje o adjunta un documento.' });
  await pool.query(`INSERT INTO mensajes_kaizen (cuenta_id, de, texto, archivo_nombre, archivo_tipo, archivo_datos) VALUES ($1, 'cliente', $2, $3, $4, $5)`,
    [c.id, t, archivo ? archivo.nombre : '', archivo ? archivo.tipo : '', archivo ? archivo.base64 : '']);
  await avisarKaizen(c, 'mensaje', `${c.nombre_empresa} te escribió en el chat${archivo ? ' (1 documento: ' + archivo.nombre + ')' : ''}: ${t.slice(0, 120)}`);
  json(res, 200, { ok: true });
});
ruta('GET', '/api/chat/archivo/:id', async (req, res, [id]) => {
  const c = await cuentaDe(req, res); if (!c) return;
  const m = (await pool.query("SELECT archivo_nombre, archivo_tipo, archivo_datos FROM mensajes_kaizen WHERE id = $1 AND cuenta_id = $2 AND archivo_nombre <> ''", [Number(id) || 0, c.id])).rows[0];
  if (!m) return json(res, 404, { error: 'Documento no encontrado.' });
  enviarArchivo(res, m);
});
function enviarArchivo(res, m) {
  res.writeHead(200, { 'Content-Type': m.archivo_tipo || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(m.archivo_nombre)}` });
  res.end(Buffer.from(m.archivo_datos, 'base64'));
}

// Recibos y avisos
ruta('GET', '/api/recibos', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  json(res, 200, { recibos: (await pool.query(`SELECT id, periodo, monto_centavos, to_char(vence, 'YYYY-MM-DD') AS vence, estado, mensaje, enlace_pago, pagado_el FROM recibos WHERE cuenta_id = $1 ORDER BY id DESC`, [c.id])).rows });
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
ruta('GET', '/api/canales', async (req, res) => {
  const c = await cuentaDe(req, res); if (!c) return;
  json(res, 200, { conectado: false, motivo: 'Las conversaciones se conectan en la siguiente etapa.' });
});

// ---------- Puente con Oficina (solo con la clave interna, solo dentro del servidor) ----------
function internoOk(req, res) {
  const dada = Buffer.from(String(req.headers['x-clave-interna'] || ''));
  const esperada = Buffer.from(INTERNO);
  if (!INTERNO || dada.length !== esperada.length || !crypto.timingSafeEqual(dada, esperada)) { json(res, 403, { error: 'No autorizado.' }); return false; }
  return true;
}
async function cuentaInterna(req, res, usuario) {
  if (!internoOk(req, res)) return null;
  const c = await cuentaPorUsuario(usuario);
  if (!c) { json(res, 404, { error: 'No existe la cuenta ' + texto(usuario, 60) + '.' }); return null; }
  return c;
}
async function resumenCuenta(c) {
  const n = async (sql) => (await pool.query(sql, [c.id])).rows[0].n;
  return {
    usuario: c.usuario, nombre: c.nombre_empresa, estado: c.suspendida ? 'suspendida' : (c.estado || 'activa'), motivo: c.motivo_suspension || '',
    en_linea: enLinea(c.visto), visto: c.visto, modulos: modulosDe(c), redes: c.redes || {},
    plantillas_por_aprobar: await n("SELECT count(*)::int AS n FROM plantillas_whatsapp WHERE cuenta_id = $1 AND estado = 'Por aprobar (Kaizen)'"),
    mensajes_sin_leer: await n("SELECT count(*)::int AS n FROM mensajes_kaizen WHERE cuenta_id = $1 AND de = 'cliente' AND leido = FALSE"),
    recibos_por_pagar: await n("SELECT count(*)::int AS n FROM recibos WHERE cuenta_id = $1 AND estado <> 'Pagado'")
  };
}

ruta('GET', '/api/interno/cuentas', async (req, res) => {
  if (!internoOk(req, res)) return;
  const filas = (await pool.query('SELECT * FROM cuentas ORDER BY usuario')).rows;
  json(res, 200, { cuentas: await Promise.all(filas.map(resumenCuenta)) });
});
ruta('GET', '/api/interno/estado', async (req, res, _p, url) => {
  const c = await cuentaInterna(req, res, url.searchParams.get('usuario')); if (!c) return;
  json(res, 200, await resumenCuenta(c));
});
// Oficina crea la cuenta del cliente y le pone la clave (el cliente no se registra solo).
ruta('POST', '/api/interno/cuenta', async (req, res) => {
  if (!internoOk(req, res)) return;
  const f = await leerCuerpo(req);
  const usuario = texto(f.usuario, 60).toLowerCase(), clave = String(f.clave || '');
  if (!/^[a-z0-9._-]{3,60}$/.test(usuario)) return json(res, 400, { error: 'El usuario solo lleva minúsculas, números, punto, guion o _.' });
  if (clave.length < 8) return json(res, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });
  const existe = await cuentaPorUsuario(usuario);
  if (existe) {
    await pool.query('UPDATE cuentas SET clave_hash = $2 WHERE id = $1', [existe.id, hashClave(clave)]);
    await pool.query('DELETE FROM sesiones WHERE cuenta_id = $1', [existe.id]);
    return json(res, 200, { ok: true, creada: false });
  }
  const r = await pool.query('INSERT INTO cuentas (usuario, nombre_empresa, clave_hash) VALUES ($1, $2, $3) RETURNING id', [usuario, texto(f.nombre, 80) || usuario, hashClave(clave)]);
  await ajustesDe(r.rows[0].id);
  json(res, 200, { ok: true, creada: true });
});
// Todo lo que Oficina decide del cliente: nombre, módulos, estado (activa, pausada, suspendida), redes y la IA.
ruta('POST', '/api/interno/configurar', async (req, res) => {
  const f = await leerCuerpo(req);
  const c = await cuentaInterna(req, res, f.usuario); if (!c) return;
  if (f.nombre) await pool.query('UPDATE cuentas SET nombre_empresa = $2 WHERE id = $1', [c.id, texto(f.nombre, 80)]);
  if (f.modulos && typeof f.modulos === 'object') {
    const m = Object.fromEntries(MODULOS.map(k => [k, f.modulos[k] === undefined ? modulosDe(c)[k] : !!f.modulos[k]]));
    await pool.query('UPDATE cuentas SET modulos = $2 WHERE id = $1', [c.id, m]);
  }
  if (f.estado) {
    const motivo = texto(f.motivo, 300);
    if (f.estado === 'suspendida') {
      await pool.query("UPDATE cuentas SET estado = 'suspendida', suspendida = TRUE, motivo_suspension = $2 WHERE id = $1", [c.id, motivo || 'Tu servicio está suspendido. Comunícate con Kaizen.']);
      await pool.query('DELETE FROM sesiones WHERE cuenta_id = $1', [c.id]);
    } else if (f.estado === 'pausada') {
      await pool.query("UPDATE cuentas SET estado = 'pausada', suspendida = FALSE, motivo_suspension = $2 WHERE id = $1", [c.id, motivo || 'Tu servicio está en pausa. La IA no responde mientras tanto.']);
    } else if (f.estado === 'activa') {
      await pool.query("UPDATE cuentas SET estado = 'activa', suspendida = FALSE, motivo_suspension = '' WHERE id = $1", [c.id]);
    } else return json(res, 400, { error: 'El estado debe ser activa, pausada o suspendida.' });
  }
  if (f.redes && typeof f.redes === 'object') {
    const redes = {};
    for (const canal of CANALES) {
      const x = f.redes[canal];
      if (!x || typeof x !== 'object') continue;
      redes[canal] = Object.fromEntries(Object.entries(x).slice(0, 8).map(([k, v]) => [texto(k, 30), texto(v, 160)]));
    }
    await pool.query('UPDATE cuentas SET redes = $2 WHERE id = $1', [c.id, redes]);
  }
  if (f.ia && typeof f.ia === 'object') {
    await ajustesDe(c.id);
    if (typeof f.ia.prompt_base === 'string') await pool.query('UPDATE ajustes SET prompt_base = $2 WHERE cuenta_id = $1', [c.id, texto(f.ia.prompt_base, 12000)]);
    if (typeof f.ia.bienvenida_base === 'string') await pool.query('UPDATE ajustes SET bienvenida_base = $2 WHERE cuenta_id = $1', [c.id, texto(f.ia.bienvenida_base, 500)]);
    if (typeof f.ia.modelo === 'string') await pool.query('UPDATE ajustes SET ia_modelo = $2 WHERE cuenta_id = $1', [c.id, texto(f.ia.modelo, 100)]);
    if (typeof f.ia.clave === 'string') {
      const clave = f.ia.clave.trim();
      await pool.query('UPDATE ajustes SET ia_clave = $2 WHERE cuenta_id = $1', [c.id, clave ? cifrar(clave) : '']);
    }
  }
  const actual = await cuentaPorUsuario(c.usuario);
  json(res, 200, { ok: true, estado: await resumenCuenta(actual) });
});
ruta('GET', '/api/interno/plantillas', async (req, res, _p, url) => {
  const c = await cuentaInterna(req, res, url.searchParams.get('usuario')); if (!c) return;
  json(res, 200, { plantillas: (await pool.query('SELECT id, nombre, tipo, texto, estado, motivo, origen, creada FROM plantillas_whatsapp WHERE cuenta_id = $1 ORDER BY id', [c.id])).rows });
});
// Oficina carga las plantillas oficiales: reemplaza las de Kaizen y deja las del cliente.
ruta('POST', '/api/interno/plantillas/cargar', async (req, res) => {
  const f = await leerCuerpo(req);
  const c = await cuentaInterna(req, res, f.usuario); if (!c) return;
  if (!Array.isArray(f.plantillas)) return json(res, 400, { error: 'Faltan las plantillas.' });
  await pool.query("DELETE FROM plantillas_whatsapp WHERE cuenta_id = $1 AND origen = 'kaizen'", [c.id]);
  for (const p of f.plantillas.slice(0, 100)) {
    await pool.query(`INSERT INTO plantillas_whatsapp (cuenta_id, nombre, tipo, texto, estado, motivo, origen) VALUES ($1, $2, $3, $4, $5, $6, 'kaizen')`,
      [c.id, texto(p.nombre, 60), texto(p.tipo, 30), String(p.texto || '').slice(0, 1024), texto(p.estado, 60) || 'Pendiente de envío a Meta', texto(p.motivo, 300)]);
  }
  json(res, 200, { ok: true, cargadas: Math.min(f.plantillas.length, 100) });
});
ruta('POST', '/api/interno/plantillas/decidir', async (req, res) => {
  const f = await leerCuerpo(req);
  const c = await cuentaInterna(req, res, f.usuario); if (!c) return;
  const p = (await pool.query('SELECT * FROM plantillas_whatsapp WHERE id = $1 AND cuenta_id = $2', [Number(f.id) || 0, c.id])).rows[0];
  if (!p) return json(res, 404, { error: 'Esa plantilla ya no existe.' });
  const aprobar = f.aprobar === true;
  const motivo = texto(f.motivo, 300);
  if (!aprobar && !motivo) return json(res, 400, { error: 'Escribe el motivo del rechazo para que el cliente lo corrija.' });
  await pool.query('UPDATE plantillas_whatsapp SET estado = $2, motivo = $3 WHERE id = $1', [p.id, aprobar ? 'Aprobada por Kaizen · pendiente de envío a Meta' : 'Rechazada por Kaizen', aprobar ? '' : motivo]);
  await pool.query('INSERT INTO notificaciones (cuenta_id, texto) VALUES ($1, $2)', [c.id, aprobar ? `Kaizen aprobó tu plantilla ${p.nombre}.` : `Kaizen rechazó tu plantilla ${p.nombre}: ${motivo}`]);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/interno/recibo', async (req, res) => {
  const f = await leerCuerpo(req);
  const c = await cuentaInterna(req, res, f.usuario); if (!c) return;
  const periodo = texto(f.periodo, 60), monto = Math.round(Number(f.monto_centavos));
  if (!periodo || !Number.isFinite(monto) || monto <= 0) return json(res, 400, { error: 'Falta el periodo o el monto del recibo.' });
  const vence = /^\d{4}-\d{2}-\d{2}$/.test(String(f.vence || '')) ? f.vence : null;
  const enlace = texto(f.enlace_pago, 300);
  if (enlace && !/^https:\/\/\S+$/i.test(enlace)) return json(res, 400, { error: 'El enlace de pago debe empezar con https://' });
  const r = await pool.query(`INSERT INTO recibos (cuenta_id, periodo, monto_centavos, vence, estado, mensaje, enlace_pago) VALUES ($1, $2, $3, $4, 'Por pagar', $5, $6) RETURNING id`,
    [c.id, periodo, monto, vence, texto(f.mensaje, 600), enlace]);
  await pool.query('INSERT INTO notificaciones (cuenta_id, texto) VALUES ($1, $2)', [c.id, `Nuevo recibo: ${periodo} · US$ ${(monto / 100).toFixed(2)}`]);
  json(res, 200, { ok: true, id: r.rows[0].id });
});
ruta('POST', '/api/interno/recibo/pagado', async (req, res) => {
  const f = await leerCuerpo(req);
  const c = await cuentaInterna(req, res, f.usuario); if (!c) return;
  const r = await pool.query("UPDATE recibos SET estado = 'Pagado', pagado_el = now() WHERE id = $1 AND cuenta_id = $2 RETURNING periodo", [Number(f.id) || 0, c.id]);
  if (!r.rowCount) return json(res, 404, { error: 'Ese recibo no existe.' });
  await pool.query('INSERT INTO notificaciones (cuenta_id, texto) VALUES ($1, $2)', [c.id, `Kaizen registró tu pago de ${r.rows[0].periodo}. Gracias.`]);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/interno/anuncio', async (req, res) => {
  const f = await leerCuerpo(req);
  const c = await cuentaInterna(req, res, f.usuario); if (!c) return;
  const t = texto(f.texto, 1000);
  if (!t) return json(res, 400, { error: 'Escribe el anuncio.' });
  await pool.query('INSERT INTO anuncios (cuenta_id, titulo, texto) VALUES ($1, $2, $3)', [c.id, texto(f.titulo, 120) || 'Aviso de Kaizen IA', t]);
  await pool.query('INSERT INTO notificaciones (cuenta_id, texto) VALUES ($1, $2)', [c.id, texto(f.titulo, 120) || 'Aviso de Kaizen IA']);
  json(res, 200, { ok: true });
});
ruta('POST', '/api/interno/presencia', async (req, res) => {
  const f = await leerCuerpo(req);
  const c = await cuentaInterna(req, res, f.usuario); if (!c) return;
  await pool.query('UPDATE cuentas SET kaizen_visto = now() WHERE id = $1', [c.id]);
  json(res, 200, { ok: true });
});
ruta('GET', '/api/interno/mensajes', async (req, res, _p, url) => {
  const c = await cuentaInterna(req, res, url.searchParams.get('usuario')); if (!c) return;
  const m = (await pool.query('SELECT id, de, texto, creado, archivo_nombre, leido FROM mensajes_kaizen WHERE cuenta_id = $1 ORDER BY id DESC LIMIT 200', [c.id])).rows.reverse();
  await pool.query("UPDATE mensajes_kaizen SET leido = TRUE WHERE cuenta_id = $1 AND de = 'cliente' AND leido = FALSE", [c.id]);
  await pool.query('UPDATE cuentas SET kaizen_visto = now() WHERE id = $1', [c.id]);
  json(res, 200, { mensajes: m, en_linea: enLinea(c.visto) });
});
ruta('POST', '/api/interno/mensaje', async (req, res) => {
  const f = await leerCuerpo(req);
  const c = await cuentaInterna(req, res, f.usuario); if (!c) return;
  const t = texto(f.texto, 1000);
  if (!t) return json(res, 400, { error: 'Mensaje vacío.' });
  await pool.query("INSERT INTO mensajes_kaizen (cuenta_id, de, texto, leido) VALUES ($1, 'kaizen', $2, TRUE)", [c.id, t]);
  await pool.query('UPDATE cuentas SET kaizen_visto = now() WHERE id = $1', [c.id]);
  await pool.query('INSERT INTO notificaciones (cuenta_id, texto) VALUES ($1, $2)', [c.id, 'Kaizen te escribió en el chat']);
  json(res, 200, { ok: true });
});
ruta('GET', '/api/interno/archivo', async (req, res, _p, url) => {
  const c = await cuentaInterna(req, res, url.searchParams.get('usuario')); if (!c) return;
  const m = (await pool.query("SELECT archivo_nombre, archivo_tipo, archivo_datos FROM mensajes_kaizen WHERE id = $1 AND cuenta_id = $2 AND archivo_nombre <> ''", [Number(url.searchParams.get('id')) || 0, c.id])).rows[0];
  if (!m) return json(res, 404, { error: 'Documento no encontrado.' });
  enviarArchivo(res, m);
});
// Avisos para la campanita de Oficina (todas las cuentas).
ruta('GET', '/api/interno/avisos', async (req, res, _p, url) => {
  if (!internoOk(req, res)) return;
  const r = await pool.query(`SELECT a.id, a.tipo, a.texto, a.creado, a.leido, c.usuario, c.nombre_empresa FROM avisos_kaizen a JOIN cuentas c ON c.id = a.cuenta_id
    WHERE ($1 = 'todos' OR a.leido = FALSE) ORDER BY a.id DESC LIMIT 50`, [url.searchParams.get('ver') === 'todos' ? 'todos' : 'nuevos']);
  json(res, 200, { avisos: r.rows });
});
ruta('POST', '/api/interno/avisos/leidos', async (req, res) => {
  if (!internoOk(req, res)) return;
  const f = await leerCuerpo(req);
  const ids = (Array.isArray(f.ids) ? f.ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
  if (ids.length) await pool.query('UPDATE avisos_kaizen SET leido = TRUE WHERE id = ANY($1::int[])', [ids]);
  json(res, 200, { ok: true });
});

// ---------- Servidor ----------
const INDEX = path.join(__dirname, 'index.html');
function moduloDeRuta(ruta) { const m = RUTA_MODULO.find(([pre]) => ruta === pre || ruta.startsWith(pre + '/')); return m ? m[1] : null; }
const servidor = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No encontrado.' });
    // Lo que Oficina apaga deja de funcionar también aquí, no solo en la pantalla.
    const modulo = moduloDeRuta(url.pathname);
    if (modulo) {
      const c = await sesionDe(req);
      if (c && !modulosDe(c)[modulo]) return json(res, 403, { error: 'Esta sección no está activa en tu plan. Comunícate con Kaizen.', modulo });
    }
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
