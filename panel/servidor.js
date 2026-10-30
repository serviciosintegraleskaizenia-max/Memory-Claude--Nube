const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const nodemailer = require('nodemailer');
const config = require('./config');

const client = new Client(config.db);

const ESTADOS = ['pendiente de transcribir', 'transcrita', 'registrada', 'revisar', 'sin accion'];
const PERMISOS = ['ver_reservas', 'cambiar_estado', 'responder_correo', 'enviar_correo', 'editar_reservas', 'ver_todas_empresas', 'administrar_usuarios', 'ver_auditoria', 'usar_chat', 'exportar_datos'];
const TODOS = Object.fromEntries(PERMISOS.map(p => [p, true]));
const NINGUNO = Object.fromEntries(PERMISOS.map(p => [p, false]));
const EMPRESAS = ['todas', 'Republica Dominicana', 'Orlando'];
const sesiones = new Map();
const presencia = new Map();
const CARPETA = __dirname;

const MINUTOS_SIN_LATIDO = 2;
const MINUTOS_AUSENTE = 5;
const MINUTOS_DESCONECTADO = 20;
const MINUTOS_REVISION = 15;
const MAX_FALLOS_USUARIO = 5;
const MAX_FALLOS_IP = 20;
const MINUTOS_BLOQUEO = 15;
const fallosLogin = new Map();

const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };

async function inicializarTablas() {
  await client.query(`CREATE TABLE IF NOT EXISTS revisiones (
    reserva_id INTEGER PRIMARY KEY,
    usuario VARCHAR(50) NOT NULL,
    nombre VARCHAR(100) DEFAULT '',
    desde TIMESTAMP NOT NULL DEFAULT NOW(),
    actualizado TIMESTAMP NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS mensajes (
    id SERIAL PRIMARY KEY,
    de VARCHAR(50) NOT NULL,
    para VARCHAR(50) NOT NULL,
    texto TEXT NOT NULL,
    fecha TIMESTAMP NOT NULL DEFAULT NOW(),
    leido BOOLEAN NOT NULL DEFAULT FALSE)`);
  await client.query('CREATE INDEX IF NOT EXISTS mensajes_par ON mensajes (de, para)');
  await client.query('CREATE INDEX IF NOT EXISTS mensajes_destino ON mensajes (para, leido)');
  await client.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permisos JSONB DEFAULT '{}'::jsonb");
  await client.query('ALTER TABLE mensajes ADD COLUMN IF NOT EXISTS imagen TEXT');
  await client.query(`CREATE TABLE IF NOT EXISTS bloqueos (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(10) NOT NULL,
    valor VARCHAR(100) NOT NULL,
    hasta TIMESTAMP NOT NULL,
    motivo TEXT DEFAULT '',
    creado TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (tipo, valor))`);
  await client.query(`CREATE TABLE IF NOT EXISTS empresa_datos (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    nombre VARCHAR(120) NOT NULL DEFAULT 'Somos Viajes Punta Cana',
    rnc VARCHAR(30) NOT NULL DEFAULT '',
    direccion VARCHAR(300) NOT NULL DEFAULT '',
    logo TEXT,
    banner TEXT,
    banner_enlace TEXT NOT NULL DEFAULT '',
    actualizado TIMESTAMP NOT NULL DEFAULT NOW())`);
  await client.query('INSERT INTO empresa_datos (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
}

client.connect()
  .then(inicializarTablas)
  .catch(e => console.log('Error preparando tablas:', e.message));

function sinAcentos(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function fechaISO(anio, mes, dia) {
  return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function fechaServicioISO(texto, recibido) {
  const s = sinAcentos(String(texto || '').toLowerCase()).trim();
  if (!s) return null;
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return fechaISO(m[1], m[2], m[3]);
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return fechaISO(m[3], m[2], m[1]);
  m = s.match(/(\d{1,2})\s*(?:de\s+)?([a-z]{3,})\.?\s*(?:de\s+)?(\d{4})?/);
  if (m) {
    const mes = MESES[m[2].slice(0, 3)];
    if (mes) {
      const d = new Date(recibido);
      const anio = m[3] || (isNaN(d) ? new Date().getFullYear() : d.getFullYear());
      return fechaISO(anio, mes, m[1]);
    }
  }
  return null;
}

function imagenValida(s) {
  return typeof s === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(s) && s.length <= 3000000;
}

async function imagenEmpresa(res, campo) {
  const fila = (await client.query(`SELECT ${campo} AS img FROM empresa_datos WHERE id = 1`)).rows[0];
  const m = fila && fila.img && fila.img.match(/^data:(image\/[a-z]+);base64,(.*)$/);
  if (!m) {
    if (campo === 'logo') return archivo(res, path.join(CARPETA, 'inteligencia-artificial.png'), 'image/png');
    res.writeHead(404);
    return res.end('No encontrado');
  }
  res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=86400' });
  res.end(Buffer.from(m[2], 'base64'));
}

// Cuando todos los servicios de un correo quedan registrados, n8n lo marca como leído en la bandeja.
async function marcarLeidoSiCompleto(id, u) {
  const destino = config.n8n && config.n8n.marcarLeido;
  if (!destino) return;
  const fila = (await client.query('SELECT message_id, buzon FROM clasificacion WHERE id = $1', [id])).rows[0];
  if (!fila || !fila.message_id) return;
  const faltan = (await client.query(
    "SELECT COUNT(*)::int AS n FROM clasificacion WHERE message_id = $1 AND estado <> 'registrada'", [fila.message_id]
  )).rows[0].n;
  if (faltan > 0) return;
  try {
    const r = await fetch(destino, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: fila.message_id, buzon: fila.buzon })
    });
    if (!r.ok) throw new Error('n8n respondió ' + r.status);
    await registrar(u, 'marcar_leido', 'correo', fila.message_id, '', '', 'Marcado como leído en ' + fila.buzon);
  } catch (e) {
    await registrar(u, 'marcar_leido_fallido', 'correo', fila.message_id, '', '', e.message);
  }
}

function filtrarPermisos(p) {
  return Object.fromEntries(PERMISOS.map(k => [k, Boolean(p && p[k])]));
}

function ipCliente(req) {
  return (req.socket.remoteAddress || 'desconocida').replace('::ffff:', '');
}

function normalizarNombre(s) {
  return sinAcentos(String(s || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

async function bloqueoActivo(tipo, valor) {
  const r = await client.query('SELECT hasta FROM bloqueos WHERE tipo = $1 AND valor = $2 AND hasta > NOW()', [tipo, valor]);
  return r.rows[0] || null;
}

async function bloquear(tipo, valor, motivo) {
  await client.query(
    `INSERT INTO bloqueos (tipo, valor, hasta, motivo) VALUES ($1, $2, NOW() + INTERVAL '${MINUTOS_BLOQUEO} minutes', $3)
     ON CONFLICT (tipo, valor) DO UPDATE SET hasta = EXCLUDED.hasta, motivo = EXCLUDED.motivo`,
    [tipo, valor, motivo]
  );
}

function contarFallo(tipo, valor) {
  const clave = tipo + ':' + valor;
  const ahora = Date.now();
  const previo = fallosLogin.get(clave);
  const datos = previo && ahora - previo.inicio < MINUTOS_BLOQUEO * 60000 ? previo : { inicio: ahora, n: 0 };
  datos.n += 1;
  fallosLogin.set(clave, datos);
  return datos.n;
}

const transportes = new Map();

function transporteDe(buzon) {
  const c = (config.correo || {})[buzon];
  if (!c) return null;
  if (!transportes.has(buzon)) {
    transportes.set(buzon, nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.port === 465,
      auth: { user: c.usuario, pass: c.clave }
    }));
  }
  return { transporte: transportes.get(buzon), nombre: c.nombre || buzon };
}

function emailDeRemitente(valor) {
  const m = String(valor || '').match(/<([^>]+)>/);
  const candidato = (m ? m[1] : String(valor || '')).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidato) ? candidato : null;
}

function texto(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

async function registrar(u, accion, entidad, entidadId, anterior, nuevo, detalle = '') {
  await client.query(
    'INSERT INTO auditoria (usuario, nombre, accion, entidad, entidad_id, anterior, nuevo, detalle) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [u.usuario, u.nombre || '', accion, entidad, texto(entidadId), texto(anterior), texto(nuevo), texto(detalle)]
  );
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
  });
}

function leerCookie(req, nombre) {
  const cookies = req.headers.cookie || '';
  const par = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(nombre + '='));
  return par ? par.split('=')[1] : null;
}

function json(res, codigo, obj, cabeceras = {}) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', ...cabeceras });
  res.end(JSON.stringify(obj));
}

function archivo(res, ruta, tipo) {
  fs.readFile(ruta, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': tipo });
    res.end(data);
  });
}

async function mapaGrupos() {
  const r = await client.query('SELECT nombre, permisos FROM grupos');
  return new Map(r.rows.map(g => [g.nombre, { ...NINGUNO, ...g.permisos }]));
}

function permisosDe(u, mapa) {
  if (u.grupo === 'Programador') return { ...TODOS };
  return { ...NINGUNO, ...(mapa.get(u.grupo) || {}), ...(u.permisos || {}) };
}

async function grupoExiste(nombre) {
  const r = await client.query('SELECT 1 FROM grupos WHERE nombre = $1', [nombre]);
  return r.rowCount > 0;
}

function nombreGrupoValido(nombre) {
  return /^[\p{L}\p{N} _-]{2,40}$/u.test(nombre);
}

function cerrarSesionesDe(usuario) {
  for (const [token, s] of sesiones) {
    if (s.usuario === usuario) sesiones.delete(token);
  }
}

function esIntocable(destino) {
  return destino.grupo === 'Programador';
}

async function buscarPorId(id) {
  const r = await client.query('SELECT * FROM usuarios WHERE id = $1', [Number(id)]);
  return r.rows[0] || null;
}

function estadosConectados() {
  const ahora = Date.now();
  const mapa = new Map();
  for (const [usuario, p] of presencia) {
    const sinActividad = ahora - p.ultimaActividad;
    const sinLatido = ahora - p.ultimoLatido;
    if (sinLatido > MINUTOS_SIN_LATIDO * 60000 || sinActividad > MINUTOS_DESCONECTADO * 60000) {
      presencia.delete(usuario);
      continue;
    }
    mapa.set(usuario, {
      nombre: p.nombre || usuario,
      grupo: p.grupo,
      estado: sinActividad > MINUTOS_AUSENTE * 60000 ? 'ausente' : 'en linea'
    });
  }
  return mapa;
}

async function limpiarRevisiones() {
  await client.query(`DELETE FROM revisiones WHERE actualizado < NOW() - INTERVAL '${MINUTOS_REVISION} minutes'`);
}

async function usuarioDeSesion(req) {
  const token = leerCookie(req, 'sesion');
  if (!token || !sesiones.has(token)) return null;
  const s = sesiones.get(token);
  const limite = config.sesion.minutosInactividad * 60 * 1000;
  if (Date.now() - s.ultima > limite) {
    sesiones.delete(token);
    return null;
  }
  s.ultima = Date.now();
  const r = await client.query(
    'SELECT id, usuario, nombre, grupo, empresa, debe_cambiar, activo, permisos FROM usuarios WHERE usuario = $1',
    [s.usuario]
  );
  const u = r.rows[0];
  if (!u || !u.activo) {
    sesiones.delete(token);
    return null;
  }
  return u;
}

http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return archivo(res, path.join(CARPETA, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url === '/inteligencia-artificial.png') {
      return archivo(res, path.join(CARPETA, 'inteligencia-artificial.png'), 'image/png');
    }

    if (req.method === 'GET' && url === '/empresa/logo') return imagenEmpresa(res, 'logo');
    if (req.method === 'GET' && url === '/empresa/banner') return imagenEmpresa(res, 'banner');

    if (req.method === 'GET' && url === '/api/empresa') {
      const r = await client.query(
        `SELECT nombre, rnc, direccion, banner_enlace, logo IS NOT NULL AS "tieneLogo", banner IS NOT NULL AS "tieneBanner",
                EXTRACT(EPOCH FROM actualizado)::bigint AS version
         FROM empresa_datos WHERE id = 1`
      );
      return json(res, 200, r.rows[0] || { nombre: 'Somos Viajes Punta Cana', rnc: '', direccion: '', banner_enlace: '' });
    }

    if (req.method === 'POST' && url === '/api/login') {
      const { usuario, password } = await leerCuerpo(req);
      const nombreIntento = String(usuario || 'desconocido').slice(0, 50);
      const ip = ipCliente(req);
      if (await bloqueoActivo('ip', ip) || await bloqueoActivo('usuario', nombreIntento)) {
        await registrar({ usuario: nombreIntento, nombre: '' }, 'login_bloqueado', 'sesion', ip, '', '', 'Intento con cuenta o IP bloqueada');
        return json(res, 429, { error: 'Demasiados intentos fallidos. Espera 15 minutos o pide al programador que revise los bloqueos.' });
      }
      const r = await client.query('SELECT * FROM usuarios WHERE usuario = $1 AND activo = TRUE', [usuario || '']);
      const u = r.rows[0];
      if (!u || !(await bcrypt.compare(password || '', u.password_hash))) {
        await registrar({ usuario: nombreIntento, nombre: '' }, 'login_fallido', 'sesion', '', '', '', 'Usuario o contraseña incorrectos');
        const fallosUsuario = contarFallo('usuario', nombreIntento);
        const fallosIp = contarFallo('ip', ip);
        if (fallosUsuario >= MAX_FALLOS_USUARIO) await bloquear('usuario', nombreIntento, 'Demasiados intentos fallidos');
        if (fallosIp >= MAX_FALLOS_IP) await bloquear('ip', ip, 'Demasiados intentos fallidos desde esta IP');
        return json(res, 401, { error: 'Usuario o contraseña incorrectos' });
      }
      const token = crypto.randomBytes(32).toString('hex');
      sesiones.set(token, { usuario: u.usuario, ultima: Date.now() });
      fallosLogin.delete('usuario:' + nombreIntento);
      await registrar(u, 'login', 'sesion', u.usuario, '', '', 'Inicio de sesión');
      return json(res, 200, { ok: true }, { 'Set-Cookie': `sesion=${token}; HttpOnly; Path=/; SameSite=Strict` });
    }

    if (req.method === 'POST' && url === '/api/logout') {
      const token = leerCookie(req, 'sesion');
      const actual = await usuarioDeSesion(req);
      if (token) sesiones.delete(token);
      if (actual) {
        presencia.delete(actual.usuario);
        await client.query('DELETE FROM revisiones WHERE usuario = $1', [actual.usuario]);
        await registrar(actual, 'logout', 'sesion', actual.usuario, '', '', 'Cierre de sesión');
      }
      return json(res, 200, { ok: true }, { 'Set-Cookie': 'sesion=; HttpOnly; Path=/; Max-Age=0' });
    }

    const u = await usuarioDeSesion(req);

    if (req.method === 'GET' && url === '/api/sesion') {
      if (!u) return json(res, 401, { error: 'Sin sesión' });
      const permisos = permisosDe(u, await mapaGrupos());
      return json(res, 200, {
        usuario: u.usuario, nombre: u.nombre, grupo: u.grupo,
        permisos, debe_cambiar: u.debe_cambiar
      });
    }

    if (!u) {
      if (url.startsWith('/api/')) return json(res, 401, { error: 'Sesión expirada. Vuelve a entrar.' });
      res.writeHead(404);
      return res.end('No encontrado');
    }

    if (u.debe_cambiar && url !== '/api/cambiar-clave-propia') {
      return json(res, 403, { error: 'Debes cambiar tu contraseña antes de continuar.', debe_cambiar: true });
    }

    if (req.method === 'POST' && url === '/api/latido') {
      const { activo } = await leerCuerpo(req);
      const previa = presencia.get(u.usuario);
      const ahora = Date.now();
      if (activo) {
        presencia.set(u.usuario, {
          nombre: u.nombre, grupo: u.grupo,
          ultimoLatido: ahora, ultimaActividad: ahora
        });
      } else if (previa) {
        presencia.set(u.usuario, {
          nombre: u.nombre, grupo: u.grupo,
          ultimoLatido: ahora, ultimaActividad: previa.ultimaActividad
        });
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url === '/api/conectados') {
      const lista = Array.from(estadosConectados(), ([usuario, v]) => ({ usuario, ...v }));
      lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
      return json(res, 200, lista);
    }

    const permisos = permisosDe(u, await mapaGrupos());
    const puede = p => Boolean(permisos[p]);

    if (req.method === 'POST' && url === '/api/cambiar-clave-propia') {
      const { actual, nueva } = await leerCuerpo(req);
      const r = await client.query('SELECT password_hash FROM usuarios WHERE id = $1', [u.id]);
      if (!(await bcrypt.compare(actual || '', r.rows[0].password_hash))) {
        return json(res, 400, { error: 'La contraseña actual no es correcta' });
      }
      if (!nueva || nueva.length < 8) {
        return json(res, 400, { error: 'La nueva contraseña debe tener al menos 8 caracteres' });
      }
      await client.query('UPDATE usuarios SET password_hash = $1, debe_cambiar = FALSE WHERE id = $2',
        [bcrypt.hashSync(nueva, 10), u.id]);
      await registrar(u, 'cambiar_clave_propia', 'usuario', u.id, '', '', u.usuario);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url === '/api/reservas') {
      if (!puede('ver_reservas')) return json(res, 403, { error: 'No tienes permiso para ver las reservas.' });
      const r = await client.query(
        "SELECT id, categoria, agencia, remitente, asunto, fecha, estado, error_ia, cuerpo, aeropuerto, actividad, nombre_cliente, telefono, tipo_servicio, fecha_servicio, hora_servicio, vuelo, hotel, punto_partida, punto_llegada, adultos, ninos, infantes, numero_servicio FROM clasificacion ORDER BY id DESC LIMIT 500"
      );
      const reservasPorNombre = new Map();
      for (const x of r.rows) {
        if (x.categoria !== 'RESERVA') continue;
        const clave = normalizarNombre(x.nombre_cliente);
        if (!clave) continue;
        if (!reservasPorNombre.has(clave)) reservasPorNombre.set(clave, []);
        reservasPorNombre.get(clave).push(x.id);
      }
      return json(res, 200, r.rows.map(x => {
        const base = { ...x, fecha_servicio_iso: fechaServicioISO(x.fecha_servicio, x.fecha) };
        if (x.categoria === 'MODIFICACION') {
          const anteriores = (reservasPorNombre.get(normalizarNombre(x.nombre_cliente)) || []).filter(id => id < x.id);
          base.original_id = anteriores.length ? Math.max(...anteriores) : null;
        }
        return base;
      }));
    }

    if (req.method === 'POST' && url === '/api/estado') {
      if (!puede('cambiar_estado')) return json(res, 403, { error: 'No tienes permiso para cambiar el estado.' });
      const { id, estado } = await leerCuerpo(req);
      if (!ESTADOS.includes(estado)) return json(res, 400, { error: 'Estado no válido' });
      const previa = (await client.query('SELECT estado, nombre_cliente FROM clasificacion WHERE id = $1', [Number(id)])).rows[0];
      if (!previa) return json(res, 404, { error: 'Reserva no encontrada' });
      await client.query('UPDATE clasificacion SET estado = $1 WHERE id = $2', [estado, Number(id)]);
      await registrar(u, 'cambiar_estado', 'reserva', id, previa.estado, estado, previa.nombre_cliente || '');
      if (estado === 'registrada' && previa.estado !== 'registrada') {
        marcarLeidoSiCompleto(Number(id), u).catch(e => console.log('Error marcando como leído:', e.message));
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url === '/api/revisiones') {
      await limpiarRevisiones();
      const r = await client.query('SELECT reserva_id, usuario, nombre, desde FROM revisiones');
      return json(res, 200, r.rows);
    }

    if (req.method === 'POST' && url === '/api/revision/tomar') {
      if (!puede('cambiar_estado')) return json(res, 403, { error: 'No tienes permiso para atender reservas.' });
      const { id } = await leerCuerpo(req);
      const reservaId = Number(id);
      if (!(await client.query('SELECT 1 FROM clasificacion WHERE id = $1', [reservaId])).rowCount) {
        return json(res, 404, { error: 'Reserva no encontrada' });
      }
      await limpiarRevisiones();
      const ex = (await client.query('SELECT * FROM revisiones WHERE reserva_id = $1', [reservaId])).rows[0];
      if (ex && ex.usuario !== u.usuario) {
        return json(res, 409, { error: `Esta reserva está en revisión por ${ex.nombre || ex.usuario}.` });
      }
      if (ex) {
        await client.query('UPDATE revisiones SET actualizado = NOW() WHERE reserva_id = $1', [reservaId]);
      } else {
        try {
          await client.query('INSERT INTO revisiones (reserva_id, usuario, nombre) VALUES ($1, $2, $3)',
            [reservaId, u.usuario, u.nombre || '']);
        } catch (e) {
          if (e.code === '23505') return json(res, 409, { error: 'Esta reserva acaba de ser tomada por otro usuario.' });
          throw e;
        }
        await registrar(u, 'abrir_reserva', 'reserva', reservaId, '', '', '');
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/api/revision/liberar') {
      const { id } = await leerCuerpo(req);
      const reservaId = Number(id);
      const borrado = await client.query(
        'DELETE FROM revisiones WHERE reserva_id = $1 AND usuario = $2 RETURNING reserva_id',
        [reservaId, u.usuario]
      );
      if (borrado.rowCount) await registrar(u, 'cerrar_reserva', 'reserva', reservaId, '', '', '');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url === '/api/chat/contactos') {
      if (!puede('usar_chat')) return json(res, 403, { error: 'No tienes permiso para usar el chat.' });
      const estados = estadosConectados();
      const r = await client.query(
        'SELECT usuario, nombre, grupo FROM usuarios WHERE activo = TRUE AND usuario <> $1 ORDER BY nombre',
        [u.usuario]
      );
      const no = await client.query(
        'SELECT de, COUNT(*)::int AS n FROM mensajes WHERE para = $1 AND leido = FALSE GROUP BY de',
        [u.usuario]
      );
      const pendientes = new Map(no.rows.map(x => [x.de, x.n]));
      return json(res, 200, r.rows.map(x => ({
        usuario: x.usuario,
        nombre: x.nombre,
        grupo: x.grupo,
        estado: estados.get(x.usuario)?.estado || 'desconectado',
        noLeidos: pendientes.get(x.usuario) || 0
      })));
    }

    if (req.method === 'GET' && url === '/api/chat/mensajes') {
      if (!puede('usar_chat')) return json(res, 403, { error: 'No tienes permiso para usar el chat.' });
      const con = new URL(req.url, 'http://localhost').searchParams.get('con') || '';
      const existe = (await client.query('SELECT 1 FROM usuarios WHERE usuario = $1 AND activo = TRUE', [con])).rowCount > 0;
      if (!existe || con === u.usuario) return json(res, 400, { error: 'Contacto no válido' });
      await client.query('UPDATE mensajes SET leido = TRUE WHERE de = $1 AND para = $2 AND leido = FALSE', [con, u.usuario]);
      const r = await client.query(
        `SELECT id, de, para, texto, fecha, (imagen IS NOT NULL) AS "tieneImagen" FROM (
           SELECT * FROM mensajes
           WHERE (de = $1 AND para = $2) OR (de = $2 AND para = $1)
           ORDER BY fecha DESC, id DESC LIMIT 100
         ) t ORDER BY fecha ASC, id ASC`,
        [u.usuario, con]
      );
      return json(res, 200, r.rows);
    }

    if (req.method === 'GET' && url === '/api/chat/imagen') {
      if (!puede('usar_chat')) return json(res, 403, { error: 'No tienes permiso para usar el chat.' });
      const imagenId = Number(new URL(req.url, 'http://localhost').searchParams.get('id'));
      const fila = (await client.query(
        'SELECT imagen FROM mensajes WHERE id = $1 AND (de = $2 OR para = $2)', [imagenId, u.usuario]
      )).rows[0];
      if (!fila || !fila.imagen) return json(res, 404, { error: 'Imagen no encontrada' });
      const m = fila.imagen.match(/^data:(image\/[a-z]+);base64,(.*)$/);
      if (!m) return json(res, 404, { error: 'Imagen no válida' });
      res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=3600' });
      return res.end(Buffer.from(m[2], 'base64'));
    }

    if (req.method === 'POST' && url === '/api/chat/enviar') {
      if (!puede('usar_chat')) return json(res, 403, { error: 'No tienes permiso para usar el chat.' });
      const { para, texto: contenido, imagen } = await leerCuerpo(req);
      const limpio = String(contenido || '').trim();
      if ((!limpio && !imagen) || limpio.length > 1000) {
        return json(res, 400, { error: 'El mensaje debe tener entre 1 y 1000 caracteres.' });
      }
      if (imagen && (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(imagen) || imagen.length > 3000000)) {
        return json(res, 400, { error: 'La imagen debe ser PNG, JPG, WEBP o GIF y pesar menos de 2 MB.' });
      }
      const existe = (await client.query('SELECT 1 FROM usuarios WHERE usuario = $1 AND activo = TRUE', [para || ''])).rowCount > 0;
      if (!existe || para === u.usuario) return json(res, 400, { error: 'Destinatario no válido.' });
      await client.query('INSERT INTO mensajes (de, para, texto, imagen) VALUES ($1, $2, $3, $4)', [u.usuario, para, limpio, imagen || null]);
      await registrar(u, 'mensaje_enviado', 'chat', para, '', '', 'Mensaje privado a ' + para);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url === '/api/auditoria') {
      if (!puede('ver_auditoria')) return json(res, 403, { error: 'No tienes permiso para ver la auditoría.' });
      const p = new URL(req.url, 'http://localhost').searchParams;
      const cond = [];
      const val = [];
      if (p.get('reserva_id')) {
        val.push(p.get('reserva_id'));
        cond.push(`(entidad = 'reserva' AND entidad_id = $${val.length})`);
      }
      if (p.get('usuario')) {
        val.push('%' + p.get('usuario') + '%');
        cond.push(`(usuario ILIKE $${val.length} OR nombre ILIKE $${val.length})`);
      }
      if (p.get('desde')) {
        val.push(p.get('desde'));
        cond.push(`fecha >= $${val.length}::date`);
      }
      if (p.get('hasta')) {
        val.push(p.get('hasta'));
        cond.push(`fecha < ($${val.length}::date + INTERVAL '1 day')`);
      }
      const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
      const limite = Math.min(Number(p.get('limit')) || 500, 2000);
      const r = await client.query(`SELECT * FROM auditoria ${where} ORDER BY fecha DESC, id DESC LIMIT ${limite}`, val);
      return json(res, 200, r.rows);
    }

    if (req.method === 'POST' && url === '/api/empresa') {
      if (!puede('administrar_usuarios')) return json(res, 403, { error: 'No tienes permiso para cambiar los datos de la empresa.' });
      const b = await leerCuerpo(req);
      const nombre = String(b.nombre || '').trim();
      if (nombre.length < 2 || nombre.length > 120) return json(res, 400, { error: 'El nombre debe tener entre 2 y 120 caracteres.' });
      const rnc = String(b.rnc || '').trim().slice(0, 30);
      const direccion = String(b.direccion || '').trim().slice(0, 300);
      const enlace = String(b.banner_enlace || '').trim();
      if (enlace && !/^https?:\/\/\S+$/i.test(enlace)) {
        return json(res, 400, { error: 'El enlace del banner debe empezar con http:// o https://' });
      }
      for (const campo of ['logo', 'banner']) {
        if (b[campo] && !imagenValida(b[campo])) {
          return json(res, 400, { error: 'El logo y el banner deben ser PNG, JPG, WEBP o GIF de menos de 2 MB.' });
        }
      }
      const previa = (await client.query(
        'SELECT nombre, rnc, direccion, banner_enlace, logo IS NOT NULL AS logo, banner IS NOT NULL AS banner FROM empresa_datos WHERE id = 1'
      )).rows[0];
      const valores = [nombre, rnc, direccion, enlace];
      const cambios = ['nombre = $1', 'rnc = $2', 'direccion = $3', 'banner_enlace = $4', 'actualizado = NOW()'];
      for (const campo of ['logo', 'banner']) {
        if (b[campo] === undefined) continue;
        valores.push(b[campo] || null);
        cambios.push(`${campo} = $${valores.length}`);
      }
      await client.query(`UPDATE empresa_datos SET ${cambios.join(', ')} WHERE id = 1`, valores);
      await registrar(u, 'editar_empresa', 'empresa', 1, previa, {
        nombre, rnc, direccion, banner_enlace: enlace,
        logo: b.logo === undefined ? 'sin cambio' : (b.logo ? 'nuevo' : 'quitado'),
        banner: b.banner === undefined ? 'sin cambio' : (b.banner ? 'nuevo' : 'quitado')
      });
      return json(res, 200, { ok: true });
    }

    if (url.startsWith('/api/correo')) {
      if (req.method === 'GET' && url === '/api/correo/buzones') {
        if (!puede('responder_correo') && !puede('enviar_correo')) {
          return json(res, 403, { error: 'No tienes permiso para enviar correos.' });
        }
        return json(res, 200, Object.keys(config.correo || {}));
      }

      if (req.method === 'POST' && url === '/api/correo/responder') {
        if (!puede('responder_correo')) return json(res, 403, { error: 'No tienes permiso para responder correos.' });
        const { id, texto: respuesta } = await leerCuerpo(req);
        const limpio = String(respuesta || '').trim();
        if (!limpio || limpio.length > 5000) return json(res, 400, { error: 'El mensaje debe tener entre 1 y 5000 caracteres.' });
        const fila = (await client.query(
          'SELECT id, remitente, asunto, message_id, buzon, cuerpo, fecha FROM clasificacion WHERE id = $1', [Number(id)]
        )).rows[0];
        if (!fila) return json(res, 404, { error: 'Reserva no encontrada' });
        const para = emailDeRemitente(fila.remitente);
        if (!para) return json(res, 400, { error: 'No se encontró un correo válido del remitente.' });
        const salida = transporteDe(fila.buzon);
        if (!salida) return json(res, 400, { error: 'Esa cuenta no está configurada para enviar correos.' });
        const asunto = /^re:/i.test(fila.asunto || '') ? fila.asunto : 'Re: ' + (fila.asunto || '');
        const citado = String(fila.cuerpo || '').slice(0, 3000).split('\n').map(l => '> ' + l).join('\n');
        const cuerpoCompleto = limpio + '\n\nEl ' + fila.fecha + ', ' + fila.remitente + ' escribió:\n' + citado;
        const cabeceras = {};
        if (fila.message_id) {
          cabeceras['In-Reply-To'] = fila.message_id;
          cabeceras['References'] = fila.message_id;
        }
        await salida.transporte.sendMail({
          from: `"${salida.nombre}" <${fila.buzon}>`,
          to: para, subject: asunto, text: cuerpoCompleto, headers: cabeceras
        });
        await registrar(u, 'responder_correo', 'reserva', fila.id, '', para, 'Respuesta enviada desde ' + fila.buzon);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/correo/nuevo') {
        if (!puede('enviar_correo')) return json(res, 403, { error: 'No tienes permiso para enviar correos nuevos.' });
        const { buzon, para, asunto, texto: cuerpoNuevo } = await leerCuerpo(req);
        const destino = emailDeRemitente(para);
        if (!destino) return json(res, 400, { error: 'Escribe un correo de destino válido.' });
        const salida = transporteDe(buzon);
        if (!salida) return json(res, 400, { error: 'Esa cuenta no está configurada para enviar correos.' });
        const limpio = String(cuerpoNuevo || '').trim();
        const tema = String(asunto || '').trim();
        if (!limpio || !tema) return json(res, 400, { error: 'El asunto y el mensaje son obligatorios.' });
        await salida.transporte.sendMail({
          from: `"${salida.nombre}" <${buzon}>`,
          to: destino, subject: tema, text: limpio
        });
        await registrar(u, 'enviar_correo', 'correo', destino, '', tema, 'Enviado desde ' + buzon);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'Ruta no encontrada' });
    }

    if (url.startsWith('/api/bloqueos')) {
      if (u.grupo !== 'Programador') return json(res, 403, { error: 'Solo el programador puede revisar los bloqueos.' });
      if (req.method === 'GET' && url === '/api/bloqueos') {
        await client.query("DELETE FROM bloqueos WHERE hasta < NOW() - INTERVAL '1 day'");
        const r = await client.query('SELECT id, tipo, valor, motivo, hasta, creado FROM bloqueos WHERE hasta > NOW() ORDER BY hasta DESC');
        return json(res, 200, r.rows);
      }
      if (req.method === 'POST' && url === '/api/bloqueos/quitar') {
        const { id } = await leerCuerpo(req);
        const fila = (await client.query('DELETE FROM bloqueos WHERE id = $1 RETURNING tipo, valor', [Number(id)])).rows[0];
        if (fila) {
          fallosLogin.delete(fila.tipo + ':' + fila.valor);
          await registrar(u, 'quitar_bloqueo', fila.tipo, fila.valor, '', '', 'Bloqueo retirado');
        }
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Ruta no encontrada' });
    }

    if (url.startsWith('/api/grupos')) {
      if (!puede('administrar_usuarios')) {
        return json(res, 403, { error: 'No tienes permiso para administrar usuarios.' });
      }

      if (req.method === 'GET' && url === '/api/grupos') {
        const r = await client.query(`
          SELECT g.id, g.nombre, g.permisos, g.protegido,
                 (SELECT COUNT(*)::int FROM usuarios x WHERE x.grupo = g.nombre) AS usuarios
          FROM grupos g ORDER BY g.id`);
        return json(res, 200, r.rows);
      }

      if (u.grupo !== 'Programador') {
        return json(res, 403, { error: 'Solo el programador puede crear, editar o eliminar grupos.' });
      }

      if (req.method === 'POST' && url === '/api/grupos') {
        const { nombre, permisos: p } = await leerCuerpo(req);
        const limpio = String(nombre || '').trim();
        if (!nombreGrupoValido(limpio)) {
          return json(res, 400, { error: 'Nombre de grupo: de 2 a 40 caracteres (letras, números, espacio o guion).' });
        }
        if (limpio === 'Programador') return json(res, 400, { error: 'Ese nombre está reservado.' });
        const nuevoPermisos = filtrarPermisos(p);
        try {
          await client.query('INSERT INTO grupos (nombre, permisos, protegido) VALUES ($1, $2, FALSE)',
            [limpio, JSON.stringify(nuevoPermisos)]);
        } catch (e) {
          if (e.code === '23505') return json(res, 409, { error: 'Ya existe un grupo con ese nombre.' });
          throw e;
        }
        await registrar(u, 'crear_grupo', 'grupo', limpio, '', { nombre: limpio, permisos: nuevoPermisos });
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/grupos/editar') {
        const { id, nombre, permisos: p } = await leerCuerpo(req);
        const g = (await client.query('SELECT * FROM grupos WHERE id = $1', [Number(id)])).rows[0];
        if (!g) return json(res, 404, { error: 'Grupo no encontrado' });

        if (g.protegido) {
          if (nombre && nombre.trim() !== g.nombre) {
            return json(res, 403, { error: 'El grupo Programador no se puede renombrar.' });
          }
          return json(res, 200, { ok: true });
        }

        const limpio = String(nombre || '').trim();
        if (!nombreGrupoValido(limpio)) {
          return json(res, 400, { error: 'Nombre de grupo: de 2 a 40 caracteres (letras, números, espacio o guion).' });
        }
        if (limpio === 'Programador') return json(res, 400, { error: 'Ese nombre está reservado.' });

        const nuevoPermisos = filtrarPermisos(p);
        await client.query('BEGIN');
        try {
          await client.query('UPDATE grupos SET nombre = $1, permisos = $2 WHERE id = $3',
            [limpio, JSON.stringify(nuevoPermisos), g.id]);
          if (limpio !== g.nombre) {
            await client.query('UPDATE usuarios SET grupo = $1 WHERE grupo = $2', [limpio, g.nombre]);
          }
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          if (e.code === '23505') return json(res, 409, { error: 'Ya existe un grupo con ese nombre.' });
          throw e;
        }
        await registrar(u, 'editar_grupo', 'grupo', g.id,
          { nombre: g.nombre, permisos: g.permisos }, { nombre: limpio, permisos: nuevoPermisos });
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/grupos/eliminar') {
        const { id } = await leerCuerpo(req);
        const g = (await client.query('SELECT * FROM grupos WHERE id = $1', [Number(id)])).rows[0];
        if (!g) return json(res, 404, { error: 'Grupo no encontrado' });
        if (g.protegido) return json(res, 403, { error: 'El grupo Programador no se puede eliminar.' });
        const n = await client.query('SELECT COUNT(*)::int AS n FROM usuarios WHERE grupo = $1', [g.nombre]);
        if (n.rows[0].n > 0) {
          return json(res, 400, { error: 'Primero cambia de grupo a los usuarios de este grupo.' });
        }
        await client.query('DELETE FROM grupos WHERE id = $1', [g.id]);
        await registrar(u, 'eliminar_grupo', 'grupo', g.id, g.nombre, '');
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'Ruta no encontrada' });
    }

    if (url.startsWith('/api/usuarios')) {
      if (!puede('administrar_usuarios')) {
        return json(res, 403, { error: 'No tienes permiso para administrar usuarios.' });
      }

      if (req.method === 'GET' && url === '/api/usuarios') {
        const r = await client.query('SELECT id, usuario, nombre, grupo, empresa, activo, debe_cambiar, permisos FROM usuarios ORDER BY id');
        return json(res, 200, r.rows);
      }

      if (req.method === 'POST' && url === '/api/usuarios') {
        const { usuario, nombre, grupo, empresa, clave, permisos } = await leerCuerpo(req);
        if (!/^[a-z0-9._-]{3,30}$/.test(usuario || '')) {
          return json(res, 400, { error: 'Usuario: de 3 a 30 caracteres, solo minúsculas, números, punto, guion o guion bajo.' });
        }
        if (!nombre || !clave || clave.length < 8) {
          return json(res, 400, { error: 'El nombre y la contraseña temporal (mínimo 8 caracteres) son obligatorios.' });
        }
        if (grupo === 'Programador' && u.grupo !== 'Programador') {
          return json(res, 403, { error: 'Solo el programador puede crear otro programador.' });
        }
        if (!(await grupoExiste(grupo))) return json(res, 400, { error: 'Grupo no válido' });
        if (!EMPRESAS.includes(empresa)) return json(res, 400, { error: 'Empresa no válida' });
        try {
          await client.query(
            'INSERT INTO usuarios (usuario, nombre, grupo, empresa, password_hash, activo, debe_cambiar, permisos) VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, $6)',
            [usuario, nombre, grupo, empresa, bcrypt.hashSync(clave, 10), JSON.stringify(filtrarPermisos(permisos))]
          );
        } catch (e) {
          if (e.code === '23505') return json(res, 409, { error: 'Ese nombre de usuario ya existe.' });
          throw e;
        }
        await registrar(u, 'crear_usuario', 'usuario', usuario, '', { nombre, grupo, empresa });
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/usuarios/editar') {
        const { id, nombre, grupo, empresa, permisos } = await leerCuerpo(req);
        const destino = await buscarPorId(id);
        if (!destino) return json(res, 404, { error: 'Usuario no encontrado' });
        if (esIntocable(destino) && destino.id !== u.id) {
          return json(res, 403, { error: 'El usuario programador solo puede ser editado por sí mismo.' });
        }
        if (destino.id === u.id && grupo !== destino.grupo) {
          return json(res, 403, { error: 'No puedes cambiar tu propio grupo.' });
        }
        if (grupo === 'Programador' && u.grupo !== 'Programador') {
          return json(res, 403, { error: 'Solo el programador puede asignar el grupo Programador.' });
        }
        if (!nombre || !nombre.trim()) return json(res, 400, { error: 'El nombre es obligatorio.' });
        if (!(await grupoExiste(grupo))) return json(res, 400, { error: 'Grupo no válido' });
        if (!EMPRESAS.includes(empresa)) return json(res, 400, { error: 'Empresa no válida' });
        await client.query('UPDATE usuarios SET nombre = $1, grupo = $2, empresa = $3, permisos = $5 WHERE id = $4',
          [nombre.trim(), grupo, empresa, destino.id, JSON.stringify(filtrarPermisos(permisos))]);
        await registrar(u, 'editar_usuario', 'usuario', destino.id,
          { nombre: destino.nombre, grupo: destino.grupo, empresa: destino.empresa },
          { nombre: nombre.trim(), grupo, empresa }, destino.usuario);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/usuarios/clave') {
        const { id, clave } = await leerCuerpo(req);
        if (!clave || clave.length < 8) return json(res, 400, { error: 'La contraseña temporal debe tener al menos 8 caracteres.' });
        const destino = await buscarPorId(id);
        if (!destino) return json(res, 404, { error: 'Usuario no encontrado' });
        if (esIntocable(destino) && destino.id !== u.id) {
          return json(res, 403, { error: 'La contraseña del programador no se puede restablecer desde otra cuenta.' });
        }
        await client.query('UPDATE usuarios SET password_hash = $1, debe_cambiar = TRUE WHERE id = $2',
          [bcrypt.hashSync(clave, 10), destino.id]);
        cerrarSesionesDe(destino.usuario);
        await registrar(u, 'restablecer_clave', 'usuario', destino.id, '', '', destino.usuario);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/usuarios/activo') {
        const { id, activo } = await leerCuerpo(req);
        const destino = await buscarPorId(id);
        if (!destino) return json(res, 404, { error: 'Usuario no encontrado' });
        if (esIntocable(destino)) {
          return json(res, 403, { error: 'El usuario programador no puede ser desactivado.' });
        }
        if (destino.id === u.id && !activo) {
          return json(res, 403, { error: 'No puedes desactivar tu propio usuario.' });
        }
        await client.query('UPDATE usuarios SET activo = $1 WHERE id = $2', [Boolean(activo), destino.id]);
        if (!activo) cerrarSesionesDe(destino.usuario);
        await registrar(u, activo ? 'activar_usuario' : 'desactivar_usuario', 'usuario', destino.id, '', '', destino.usuario);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'Ruta no encontrada' });
    }

    json(res, 404, { error: 'Ruta no encontrada' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(config.puerto, () => console.log('Panel en http://localhost:' + config.puerto));
