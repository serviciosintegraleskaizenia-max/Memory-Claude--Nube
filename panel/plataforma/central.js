// Panel central de Kaizen IA: pestaña Empresas (solo programador, solo si config.central.activo = true).
// Crea empresas nuevas (base de datos propia + su panel en otro puerto), las enciende, pausa y cobra,
// manda anuncios y maneja la demo de ventas con accesos de 48 horas.
//
// Cada empresa:
//   - Base de datos propia (panel_<nombre>) en el mismo PostgreSQL: los datos nunca se mezclan.
//   - Su propio panel (el mismo programa) en su puerto: http://IP-de-la-PC:puerto, o nombre.kaizenia.app en el servidor.
//   - Sus claves (correo, IA) solo en su archivo empresas/<nombre>/config.js. Nunca se vuelven a mostrar.

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const { MODULOS, TEXTOS_PAGO, etapaPago, hoyLocal } = require('./cuenta');
const { sembrarDemo, GRUPOS } = require('./demo');

// Modelo de IA por defecto (el mismo de Somos Viajes). Debe leer imágenes: el motor manda las capturas.
const MODELO_DEFECTO = 'anthropic/claude-haiku-5.5';
const MODELO_VALIDO = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
// Si OpenRouter no responde, se ofrecen estos.
const MODELOS_RESPALDO = [
  { id: 'anthropic/claude-haiku-5.5', nombre: 'Anthropic: Claude Haiku 5.5', imagenes: true },
  { id: 'anthropic/claude-sonnet-5.5', nombre: 'Anthropic: Claude Sonnet 5.5', imagenes: true }
];

// Subdominios que no puede usar un cliente: la web de Kaizen IA, tu consola de trabajo y los servicios.
const RESERVADOS = new Set(['admin', 'www', 'api', 'app', 'mail', 'correo', 'central', 'kaizen', 'kaizenia', 'panel', 'chat', 'n8n', 'pruebas',
  'consola', 'oficina', 'hq', 'soporte', 'ayuda', 'pagos', 'pago', 'cotizar', 'tienda', 'blog', 'status', 'estado', 'docs', 'login', 'cuenta', 'clientes', 'ventas']);
const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

function claveAleatoria(n = 10) {
  // Sin letras que se confunden (0/O, 1/l/I).
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(n), b => letras[b % letras.length]).join('');
}

// IP de esta PC en la red de la oficina. Primero 192.168.x.x y 10.x.x.x (WiFi o cable);
// las 172.x.x.x suelen ser redes virtuales de Docker o WSL.
function ipLocal() {
  const todas = [];
  for (const [nombre, lista] of Object.entries(os.networkInterfaces())) {
    for (const x of lista || []) if (x.family === 'IPv4' && !x.internal) todas.push({ nombre, ip: x.address });
  }
  const puntos = x => (/^192\.168\./.test(x.ip) ? 3 : /^10\./.test(x.ip) ? 2 : 1) - (/docker|vethernet|wsl|virtual|vmware|vbox/i.test(x.nombre) ? 2 : 0);
  todas.sort((a, b) => puntos(b) - puntos(a));
  return todas.length ? todas[0].ip : '127.0.0.1';
}

function puertoLibre(puerto) {
  return new Promise(r => {
    const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true)));
    s.listen(puerto);
  });
}

function texto(v, max = 200) {
  return String(v ?? '').trim().slice(0, max);
}

module.exports = function crearCentral({ client, config, registrar, CARPETA }) {
  const aj = Object.assign({ activo: false, carpeta: path.join(CARPETA, 'empresas'), puertoInicial: 3101, dominio: '' }, config.central || {});
  const activo = !!aj.activo;
  const CARPETA_EMPRESAS = path.resolve(aj.carpeta);
  const fallos = new Map();

  // Plantillas base para empezar. Son borradores: nadie las usa hasta que una persona las marque como buenas.
  const PLANTILLAS_BASE = [
    { nombre: 'seguimiento_48h', categoria: 'marketing', cuerpo: 'Hola {{1}}, ¿pudiste revisar la información que te enviamos? Si tienes alguna duda, con gusto te ayudamos.' },
    { nombre: 'seguimiento_2_semanas', categoria: 'marketing', cuerpo: 'Hola {{1}}, hace unas semanas conversamos sobre {{2}}. ¿Sigues interesado? Respóndenos y te damos los detalles.' },
    { nombre: 'recordatorio_pago', categoria: 'utilidad', cuerpo: 'Hola {{1}}, te recordamos que tu pago de {{2}} vence el {{3}}. Si ya lo hiciste, ignora este mensaje.' },
    { nombre: 'confirmacion_reserva', categoria: 'utilidad', cuerpo: 'Hola {{1}}, tu reserva para {{2}} el {{3}} está confirmada. Te escribiremos si hay algún cambio.' }
  ];
  // Reglas fijas de revisión. Las escribimos nosotros, a partir de las políticas de Meta; hay que actualizarlas cuando Meta cambie.
  const PALABRAS_RIESGO = ['gratis', 'urgente', 'última oportunidad', 'ganador', 'garantizado', 'haz clic', 'click aquí'];
  function revisarPlantilla(p) {
    const cuerpo = String(p.cuerpo || '');
    const variables = [...cuerpo.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
    const consecutivas = variables.every((v, i) => v === i + 1);
    const bajo = cuerpo.toLowerCase();
    const riesgos = PALABRAS_RIESGO.filter(w => bajo.includes(w));
    const cadena = (cuerpo.match(/https?:\/\/\S+/g) || []).some(u => /bit\.ly|tinyurl|goo\.gl/.test(u));
    const empiezaOTermina = /^\s*\{\{\d+\}\}/.test(cuerpo) || /\{\{\d+\}\}\s*$/.test(cuerpo);
    return [
      { ok: /^[a-z0-9_]{3,512}$/.test(p.nombre || ''), texto: 'Nombre en minúsculas, números y guion bajo' },
      { ok: cuerpo.length > 0 && cuerpo.length <= 1024, texto: 'Texto de 1 a 1024 caracteres' },
      { ok: consecutivas, texto: 'Variables numeradas en orden ({{1}}, {{2}}…)' },
      { ok: !empiezaOTermina, texto: 'No empieza ni termina con una variable' },
      { ok: riesgos.length === 0, texto: riesgos.length ? 'Tiene palabras de riesgo: ' + riesgos.join(', ') : 'Sin palabras de riesgo' },
      { ok: !cadena, texto: 'Sin enlaces acortados' },
      { ok: ['utilidad', 'marketing'].includes(p.categoria), texto: 'Categoría utilidad o marketing (confirmar con Meta)' }
    ];
  }
  async function plantillasWa() {
    const filas = (await client.query('SELECT id, nombre, categoria, cuerpo, estado, motivo, meta_id, meta_estado, meta_motivo FROM plantillas_wa ORDER BY id')).rows;
    return filas.map(p => ({ ...p, checks: revisarPlantilla(p) }));
  }
  async function guardarPlantillaWa(u, f) {
    const id = Number(f.id) || 0;
    const nombre = texto(f.nombre, 512).toLowerCase();
    const categoria = texto(f.categoria, 20) || 'utilidad';
    const cuerpo = String(f.cuerpo ?? '').trim().slice(0, 1200);
    if (id) {
      const previo = (await client.query('SELECT nombre, categoria, cuerpo FROM plantillas_wa WHERE id = $1', [id])).rows[0];
      if (!previo) throw Object.assign(new Error('Esa plantilla ya no existe.'), { codigo: 404 });
      const cambio = previo.nombre !== nombre || previo.categoria !== categoria || previo.cuerpo !== cuerpo;
      await client.query(`UPDATE plantillas_wa SET nombre = $2, categoria = $3, cuerpo = $4,
        estado = CASE WHEN $5 THEN 'borrador' ELSE estado END, motivo = CASE WHEN $5 THEN '' ELSE motivo END, actualizada = NOW() WHERE id = $1`,
        [id, nombre, categoria, cuerpo, cambio]);
      await registrar(u, 'editar_plantilla_wa', 'plantilla', nombre, '', '', cambio ? 'cambió: vuelve a borrador' : 'sin cambios');
      return { id };
    }
    const r = await client.query(`INSERT INTO plantillas_wa (nombre, categoria, cuerpo) VALUES ($1, $2, $3) RETURNING id`, [nombre, categoria, cuerpo]).catch(e => {
      if (e.code === '23505') throw Object.assign(new Error('Ya existe una plantilla con ese nombre.'), { codigo: 400 });
      throw e;
    });
    await registrar(u, 'crear_plantilla_wa', 'plantilla', nombre, '', '', '');
    return { id: r.rows[0].id };
  }
  // Una persona decide: "buena" solo si pasa todas las reglas; "mala" pide el motivo.
  async function marcarPlantillaWa(u, f) {
    const id = Number(f.id) || 0;
    const decision = String(f.decision || '');
    const p = (await client.query('SELECT id, nombre, categoria, cuerpo FROM plantillas_wa WHERE id = $1', [id])).rows[0];
    if (!p) throw Object.assign(new Error('Esa plantilla ya no existe.'), { codigo: 404 });
    if (decision === 'buena') {
      const fallos = revisarPlantilla(p).filter(c => !c.ok);
      if (fallos.length) throw Object.assign(new Error('No se puede marcar como buena: ' + fallos.map(c => c.texto).join('; ') + '.'), { codigo: 400 });
      await client.query(`UPDATE plantillas_wa SET estado = 'aprobada_por_ti', motivo = '', actualizada = NOW() WHERE id = $1`, [id]);
    } else if (decision === 'mala') {
      const motivo = texto(f.motivo, 300);
      if (!motivo) throw Object.assign(new Error('Escribe por qué no sirve, para no repetir el error.'), { codigo: 400 });
      await client.query(`UPDATE plantillas_wa SET estado = 'rechazada_por_ti', motivo = $2, actualizada = NOW() WHERE id = $1`, [id, motivo]);
    } else throw Object.assign(new Error('Decisión no válida.'), { codigo: 400 });
    await registrar(u, 'decidir_plantilla_wa', 'plantilla', p.nombre, '', '', decision);
    return { ok: true };
  }

  // Prompts maestro de la IA de automatización. {negocio} y {tono} se cambian por los datos de cada cliente.
  const PROMPTS_INICIALES = [
    { clave: 'maestro', orden: 0, nombre: 'Reglas generales (se aplican a todos los clientes)',
      texto: 'Eres el asistente de atención por redes sociales de {negocio}. Respondes en el idioma de la persona, con tono {tono}. Respuestas cortas, claras y sin tecnicismos. Nunca inventes precios, disponibilidad, descuentos ni promociones: si no está en tu información, dilo y ofrece pasar a una persona. Nunca pidas contraseñas ni claves. Si la persona pide hablar con alguien, hay una queja o un pago no se puede validar, pasa la conversación al equipo.' },
    { clave: 'inmobiliaria', orden: 1, nombre: 'Asesor inmobiliario',
      texto: 'Asesoras a personas que quieren comprar, alquilar o vender una propiedad. Antes de recomendar, pregunta: zona, tipo de propiedad, presupuesto y plazo. Ofrece agendar una visita. No confirmes disponibilidad ni precios que no estén en tu información.' },
    { clave: 'ferreteria', orden: 2, nombre: 'Ferretería y materiales (tuberías PEX, accesorios, herramientas)',
      texto: 'Ayudas a elegir materiales y accesorios para un trabajo. Antes de cotizar, pregunta: medida o diámetro, uso y cantidad. Da precios solo si están en la lista de precios. Sugiere el producto correcto para el trabajo y avisa cuando falta un dato técnico para decidir.' },
    { clave: 'sorteo', orden: 3, nombre: 'Guía de sorteo (cómo participar)',
      texto: 'Guías a la persona para participar en el sorteo: qué debe comprar, cómo enviar el comprobante de pago y cuándo se anuncia el resultado. Explica las reglas con claridad. No prometas premios distintos a los oficiales ni garantices que la persona gane. Si el pago no se puede validar, pide una foto más clara y pasa la conversación a una persona.' },
    { clave: 'otro', orden: 4, nombre: 'Otro negocio (consultas generales)',
      texto: 'Atiendes consultas generales del negocio con la información disponible. Si no sabes algo, dilo y pasa la conversación a una persona.' }
  ];

  async function preparar() {
    if (!activo) return;
    await client.query(`CREATE TABLE IF NOT EXISTS automatizacion_config (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)`);
    await client.query("INSERT INTO automatizacion_config (clave, valor) VALUES ('clave_n8n', $1) ON CONFLICT (clave) DO NOTHING",
      [crypto.randomBytes(24).toString('hex')]);
    // Token que Meta usa para verificar el receptor de WhatsApp (se muestra en Oficina).
    await client.query("INSERT INTO automatizacion_config (clave, valor) VALUES ('verify_token_whatsapp', $1) ON CONFLICT (clave) DO NOTHING",
      [crypto.randomBytes(18).toString('hex')]);
    // Biblioteca de plantillas de WhatsApp. Las decide una persona; las reglas de revisión son fijas y las escribimos nosotros.
    await client.query(`CREATE TABLE IF NOT EXISTS plantillas_wa (
      id SERIAL PRIMARY KEY, nombre TEXT UNIQUE NOT NULL, categoria TEXT NOT NULL DEFAULT 'utilidad',
      cuerpo TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'borrador', motivo TEXT NOT NULL DEFAULT '',
      actualizada TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    if (!(await client.query('SELECT 1 FROM plantillas_wa LIMIT 1')).rowCount) {
      for (const pl of PLANTILLAS_BASE) {
        await client.query('INSERT INTO plantillas_wa (nombre, categoria, cuerpo) VALUES ($1, $2, $3) ON CONFLICT (nombre) DO NOTHING', [pl.nombre, pl.categoria, pl.cuerpo]);
      }
    }
    // Registro de cada envío de plantilla que sale desde Oficina.
    // Estado de la plantilla en Meta (Video 2): id, estado (APPROVED, PENDING, REJECTED…) y motivo que da Meta.
    for (const c of ["meta_id TEXT NOT NULL DEFAULT ''", "meta_estado TEXT NOT NULL DEFAULT ''", "meta_motivo TEXT NOT NULL DEFAULT ''"]) {
      await client.query(`ALTER TABLE plantillas_wa ADD COLUMN IF NOT EXISTS ${c}`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS whatsapp_envios (
      id SERIAL PRIMARY KEY, numero_id TEXT NOT NULL, destino TEXT NOT NULL, plantilla TEXT NOT NULL,
      idioma TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL, respuesta TEXT NOT NULL DEFAULT '',
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // Estado de cada número de la API y alertas (revisión programada).
    await client.query(`CREATE TABLE IF NOT EXISTS whatsapp_estado (
      numero_id TEXT PRIMARY KEY, slug TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT '',
      verificado TEXT NOT NULL DEFAULT '', calidad TEXT NOT NULL DEFAULT '', detalle TEXT NOT NULL DEFAULT '',
      revisado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS whatsapp_alertas (
      id SERIAL PRIMARY KEY, numero_id TEXT NOT NULL, slug TEXT NOT NULL DEFAULT '', nivel TEXT NOT NULL,
      texto TEXT NOT NULL, creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    setTimeout(() => revisarWhatsapp().catch(e => console.log('WhatsApp revisión:', e.message)), 5 * 60e3).unref();
    setInterval(() => revisarWhatsapp().catch(e => console.log('WhatsApp revisión:', e.message)), 60 * 60e3).unref();
    // Mensajes de WhatsApp que llegan desde Meta, esperando que el CRM del cliente los tome.
    await client.query(`CREATE TABLE IF NOT EXISTS whatsapp_entrantes (
      id SERIAL PRIMARY KEY, meta_id TEXT UNIQUE NOT NULL, slug TEXT NOT NULL DEFAULT '', numero_id TEXT NOT NULL DEFAULT '',
      de TEXT NOT NULL DEFAULT '', nombre TEXT NOT NULL DEFAULT '', tipo TEXT NOT NULL DEFAULT '', texto TEXT NOT NULL DEFAULT '',
      recibido TIMESTAMPTZ NOT NULL DEFAULT NOW(), procesado BOOLEAN NOT NULL DEFAULT FALSE)`);
    await client.query(`CREATE TABLE IF NOT EXISTS automatizacion_prompts (
      clave TEXT PRIMARY KEY, nombre TEXT NOT NULL, texto TEXT NOT NULL, orden INTEGER NOT NULL DEFAULT 0,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const p of PROMPTS_INICIALES) {
      await client.query('INSERT INTO automatizacion_prompts (clave, nombre, texto, orden) VALUES ($1, $2, $3, $4) ON CONFLICT (clave) DO NOTHING',
        [p.clave, p.nombre, p.texto, p.orden]);
    }
    // Clientes de automatización (redes y CRM): perfil guardado desde Oficina. No guarda claves ni contraseñas.
    await client.query(`CREATE TABLE IF NOT EXISTS automatizacion_clientes (
      id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, nombre TEXT NOT NULL,
      perfil JSONB NOT NULL DEFAULT '{}'::jsonb, estado TEXT NOT NULL DEFAULT 'borrador',
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS empresas (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(30) UNIQUE NOT NULL,
      nombre VARCHAR(120) NOT NULL,
      base_datos VARCHAR(63) UNIQUE NOT NULL,
      puerto INTEGER UNIQUE NOT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'activa',
      es_demo BOOLEAN NOT NULL DEFAULT FALSE,
      correo JSONB NOT NULL DEFAULT '{}'::jsonb,
      pago JSONB NOT NULL DEFAULT '{}'::jsonb,
      pid INTEGER,
      notas TEXT NOT NULL DEFAULT '',
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // Empresa externa: ya existía (ej. Somos Viajes en C:\panel-correos). El central solo la administra
    // (cobro, anuncios, módulos, pausa); no la enciende, no la apaga y nunca borra su base de datos.
    await client.query('ALTER TABLE empresas ADD COLUMN IF NOT EXISTS externa BOOLEAN NOT NULL DEFAULT FALSE');
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS url_externa TEXT NOT NULL DEFAULT ''");
    await client.query(`CREATE TABLE IF NOT EXISTS plantillas_mensaje (
      id SERIAL PRIMARY KEY,
      tipo VARCHAR(20) NOT NULL,
      titulo VARCHAR(120) NOT NULL,
      texto TEXT NOT NULL,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // El central es de Kaizen IA (la tabla nace con el nombre de Somos Viajes por defecto).
    await client.query("UPDATE empresa_datos SET nombre = 'Kaizen IA - Central' WHERE id = 1 AND nombre = 'Somos Viajes Punta Cana'");
    const hay = (await client.query('SELECT COUNT(*)::int AS n FROM plantillas_mensaje')).rows[0].n;
    if (!hay) {
      for (const [tipo, titulo] of [['antes', 'Recordatorio amable (antes de la fecha)'], ['dia', 'Hoy vence el pago'], ['vencido', 'Pago vencido']]) {
        await client.query('INSERT INTO plantillas_mensaje (tipo, titulo, texto) VALUES ($1, $2, $3)', [tipo, titulo, TEXTOS_PAGO[tipo]]);
      }
      await client.query('INSERT INTO plantillas_mensaje (tipo, titulo, texto) VALUES ($1, $2, $3)',
        ['general', 'Mantenimiento programado', 'Hola {usuario}: este domingo de 2:00 a 3:00 a. m. haremos mejoras en el panel. Puede que no esté disponible unos minutos. Equipo Kaizen IA.']);
    }
  }

  // ---------- Conexión y procesos de cada empresa ----------

  async function conEmpresa(e, fn) {
    const c = new Client({ ...config.db, database: e.base_datos });
    await c.connect();
    try { return await fn(c); } finally { await c.end().catch(() => {}); }
  }

  const carpetaDe = e => path.join(CARPETA_EMPRESAS, e.slug);
  const archivoDe = e => path.join(carpetaDe(e), 'config.js');
  const urlDe = e => (e.externa && e.url_externa ? e.url_externa
    : aj.dominio ? `https://${e.slug}.${aj.dominio}` : `http://${ipLocal()}:${e.puerto}`);

  async function responde(e, ms = 2500) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), ms);
    try {
      const r = await fetch(`http://127.0.0.1:${e.puerto}/api/listo`, { signal: control.signal });
      return r.ok;
    } catch (err) { return false; } finally { clearTimeout(reloj); }
  }

  function leerAjustes(e) {
    const archivo = archivoDe(e);
    if (!fs.existsSync(archivo)) return null;
    delete require.cache[require.resolve(archivo)];
    return require(archivo);
  }

  function escribirAjustes(e, datos) {
    fs.mkdirSync(carpetaDe(e), { recursive: true });
    const cabecera = `// Ajustes de ${e.nombre} (creado por la pestaña Empresas del panel central de Kaizen IA).\n// Tiene claves: no lo compartas ni lo subas a internet.\n`;
    fs.writeFileSync(archivoDe(e), cabecera + 'module.exports = ' + JSON.stringify(datos, null, 2) + ';\n', { mode: 0o600 });
  }

  // Arma el config.js de la empresa a partir del formulario. Las claves vacías conservan las anteriores.
  function ajustesDesde(e, f, previo = {}) {
    const correo = f.correo || {};
    const proveedor = ['microsoft', 'imap', 'ninguno'].includes(correo.proveedor) ? correo.proveedor : 'ninguno';
    const buzon = texto(correo.buzon, 120).toLowerCase();
    const pm = (previo.motor && previo.motor.cuentas && previo.motor.cuentas[0]) || {};
    const pp = (previo.motor && previo.motor.perfil) || {};
    // Listas separadas por coma o espacio; vacío = se queda lo anterior.
    const lista = (v, antes) => { const l = texto(v, 300).split(/[\s,]+/).filter(Boolean); return l.length ? l : (antes || []); };
    const motor = {
      activo: proveedor !== 'ninguno' && !e.es_demo,
      sombra: false,
      intervaloMinutos: 10,
      ventanaDias: 2,
      modelo: MODELO_VALIDO.test(texto(f.ia && f.ia.modelo, 100)) ? texto(f.ia.modelo, 100) : ((previo.motor && previo.motor.modelo) || MODELO_DEFECTO),
      perfil: {
        nombre: texto(f.perfil && f.perfil.nombre, 80) || pp.nombre || e.nombre,
        dominios: lista(f.perfil && f.perfil.dominios, pp.dominios),
        telefonos: lista(f.perfil && f.perfil.telefonos, pp.telefonos)
      },
      cuentas: []
    };
    const smtp = {};
    if (proveedor === 'microsoft') {
      const m = correo.microsoft || {};
      const pmm = pm.microsoft || {};
      motor.cuentas.push({ proveedor, buzon, microsoft: {
        tenantId: texto(m.tenantId, 80) || pmm.tenantId || '', clientId: texto(m.clientId, 80) || pmm.clientId || '',
        clientSecret: texto(m.clientSecret, 200) || pmm.clientSecret || '' } });
    } else if (proveedor === 'imap') {
      const i = correo.imap || {};
      const pi = pm.imap || {};
      const imap = {
        host: texto(i.host, 120) || pi.host || '', puerto: Number(i.puerto) || pi.puerto || 993,
        usuario: texto(i.usuario, 120) || pi.usuario || buzon, clave: texto(i.clave, 200) || pi.clave || '',
        smtpHost: texto(i.smtpHost, 120) || pi.smtpHost || '', smtpPuerto: Number(i.smtpPuerto) || pi.smtpPuerto || 465
      };
      motor.cuentas.push({ proveedor, buzon, imap });
      // El mismo buzón responde por SMTP (Gmail: contraseña de aplicación).
      if (imap.smtpHost) smtp[buzon] = { host: imap.smtpHost, port: imap.smtpPuerto, usuario: imap.usuario, clave: imap.clave, nombre: e.nombre, empresa: 'todas' };
    }
    return {
      db: { ...config.db, database: e.base_datos },
      sesion: { minutosInactividad: (config.sesion && config.sesion.minutosInactividad) || 30, secreto: (previo.sesion && previo.sesion.secreto) || crypto.randomBytes(32).toString('hex') },
      puerto: e.puerto,
      carpetaDatos: carpetaDe(e),
      empresa: e.slug,
      demo: !!e.es_demo,
      sedes: texto(f.sedes, 300).split(',').map(x => x.trim()).filter(Boolean),
      motor,
      openrouter: { apiKey: texto(f.ia && f.ia.apiKey, 200) || (previo.openrouter && previo.openrouter.apiKey) || '' },
      correo: smtp,
      alertas: config.alertas || {}
    };
  }

  // Resumen sin claves (lo que se guarda en la base del central y se muestra en pantalla).
  function resumenCorreo(a) {
    const c = (a && a.motor && a.motor.cuentas && a.motor.cuentas[0]) || {};
    return {
      proveedor: c.proveedor || 'ninguno', buzon: c.buzon || '',
      modelo: (a && a.motor && a.motor.modelo) || MODELO_DEFECTO,
      host: c.imap ? c.imap.host : '', clavePuesta: !!(c.imap ? c.imap.clave : c.microsoft && c.microsoft.clientSecret),
      iaPuesta: !!(a.openrouter && a.openrouter.apiKey),
      perfil: a.motor && a.motor.perfil ? { nombre: a.motor.perfil.nombre, dominios: a.motor.perfil.dominios.join(', '), telefonos: a.motor.perfil.telefonos.join(', ') } : null
    };
  }

  async function encender(e) {
    if (await responde(e)) return true;
    fs.mkdirSync(carpetaDe(e), { recursive: true });
    const salida = fs.openSync(path.join(carpetaDe(e), 'panel.log'), 'a');
    const errores = fs.openSync(path.join(carpetaDe(e), 'panel-error.log'), 'a');
    const hijo = spawn(process.execPath, [path.join(CARPETA, 'servidor.js')], {
      cwd: CARPETA, detached: true, windowsHide: true, stdio: ['ignore', salida, errores],
      env: { ...process.env, PANEL_CONFIG: archivoDe(e), ARRANQUE_VIGILANTE: '' }
    });
    let termino = false;
    hijo.on('exit', () => { termino = true; }); // si se cierra con error al arrancar, no hace falta seguir esperando
    hijo.unref();
    fs.closeSync(salida); fs.closeSync(errores);
    await client.query('UPDATE empresas SET pid = $1 WHERE id = $2', [hijo.pid, e.id]);
    // Hasta 90 segundos: la primera vez crea todas sus tablas (en Docker puede tardar).
    for (let i = 0; i < 90 && !termino; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await responde(e, 1000)) return true;
    }
    return false;
  }

  // Borra la base de datos, la carpeta (ajustes y claves) y el registro de una empresa. Primero apaga su panel.
  async function borrarTodo(e) {
    // Externa: solo se quita de la lista. Su base de datos y su carpeta no se tocan nunca.
    if (e.externa) {
      if (e.id) await client.query('DELETE FROM empresas WHERE id = $1', [e.id]);
      return;
    }
    await apagar(e).catch(() => {});
    const base = String(e.base_datos || '');
    if (/^panel_[a-z0-9_]+$/.test(base)) {
      try {
        await client.query(`DROP DATABASE IF EXISTS "${base}" WITH (FORCE)`);
      } catch (err) {
        // Postgres viejo (sin FORCE): se cierran las conexiones y se borra.
        await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [base]).catch(() => {});
        await client.query(`DROP DATABASE IF EXISTS "${base}"`);
      }
    }
    const carpeta = path.resolve(carpetaDe(e));
    if (SLUG.test(e.slug) && carpeta.startsWith(path.resolve(CARPETA_EMPRESAS) + path.sep)) {
      for (let i = 0; i < 5; i++) {
        try { fs.rmSync(carpeta, { recursive: true, force: true }); break; } catch (err) { await new Promise(r => setTimeout(r, 1000)); }
      }
    }
    if (e.id) await client.query('DELETE FROM empresas WHERE id = $1', [e.id]);
  }

  // Se le pide al panel de la empresa que se apague (con su clave secreta). No se cierra un proceso por número:
  // después de reiniciar la PC ese número puede ser de otro programa.
  async function apagar(e) {
    const secreto = ((leerAjustes(e) || {}).sesion || {}).secreto || '';
    try {
      await fetch(`http://127.0.0.1:${e.puerto}/api/interno/apagar`, { method: 'POST', headers: { 'x-kaizen': secreto } });
    } catch (err) {}
    for (let i = 0; i < 20 && await responde(e, 500); i++) await new Promise(r => setTimeout(r, 300));
    await client.query('UPDATE empresas SET pid = NULL WHERE id = $1', [e.id]);
  }

  // Cada minuto: si una empresa encendida no responde dos veces seguidas, se vuelve a encender.
  async function supervisar() {
    const lista = (await client.query("SELECT * FROM empresas WHERE estado IN ('activa', 'pausada') AND externa = FALSE")).rows;
    for (const e of lista) {
      if (await responde(e)) { fallos.delete(e.id); continue; }
      const n = (fallos.get(e.id) || 0) + 1;
      fallos.set(e.id, n);
      if (n >= 2) {
        fallos.delete(e.id);
        const ok = await encender(e).catch(() => false);
        console.log(`Empresa ${e.slug}: ${ok ? 'encendida de nuevo' : 'no pudo encender (revisa ' + path.join(carpetaDe(e), 'panel-error.log') + ')'}`);
      }
    }
  }

  function iniciar() {
    if (!activo) return;
    // Al encender el central, se encienden las empresas que estaban activas.
    setTimeout(async () => {
      const lista = (await client.query("SELECT * FROM empresas WHERE estado IN ('activa', 'pausada') AND externa = FALSE")).rows;
      for (const e of lista) await encender(e).catch(err => console.log('Empresa', e.slug, err.message));
    }, 3000);
    setInterval(() => supervisar().catch(err => console.log('Supervisión de empresas:', err.message)), 60 * 1000);
  }

  // ---------- Crear empresa ----------

  async function siguientePuerto() {
    const usado = new Set((await client.query('SELECT puerto FROM empresas')).rows.map(x => x.puerto));
    for (let p = aj.puertoInicial; p < aj.puertoInicial + 500; p++) {
      if (!usado.has(p) && p !== config.puerto && await puertoLibre(p)) return p;
    }
    throw new Error('No hay puertos libres.');
  }

  // Perfil de un cliente de automatización. Solo datos que no son secretos: IDs, nombres de cuenta, casillas de Meta y preferencias.
  // Las claves (OpenRouter, tokens de Meta) no entran aquí; se cargan después, cifradas, en el panel del cliente.
  function limpiarPerfil(p) {
    const t = (v, max = 120) => texto(v, max);
    const b = v => v === true;
    const red = (r, campos) => Object.fromEntries(campos.map(c => [c, t(r && r[c], c.includes('notas') ? 300 : 120)]));
    const redes = p.redes || {};
    return {
      sedes: t(p.sedes, 300),
      gerente: { nombre: t(p.gerente && p.gerente.nombre, 100), usuario: t(p.gerente && p.gerente.usuario, 50).toLowerCase() },
      redes: {
        whatsapp: red(redes.whatsapp, ['cuenta_id', 'numero_id', 'numero_visible']),
        instagram: red(redes.instagram, ['cuenta_id', 'usuario']),
        facebook: red(redes.facebook, ['pagina_id', 'nombre']),
        tiktok: red(redes.tiktok, ['cuenta'])
      },
      meta: {
        business_id: t((p.meta || {}).business_id, 60),
        cuenta_publicitaria: t((p.meta || {}).cuenta_publicitaria, 60),
        socio_agregado: b((p.meta || {}).socio_agregado),
        pagina_asignada: b((p.meta || {}).pagina_asignada),
        instagram_asignado: b((p.meta || {}).instagram_asignado),
        whatsapp_verificado: b((p.meta || {}).whatsapp_verificado),
        permisos_aprobados: b((p.meta || {}).permisos_aprobados)
      },
      ia: {
        modelo: t((p.ia || {}).modelo, 80), tono: t((p.ia || {}).tono, 40), tipo: t((p.ia || {}).tipo, 40),
        tipo_nombre: t((p.ia || {}).tipo_nombre, 80),
        que_ofrece: t((p.ia || {}).que_ofrece, 600), zona_horario: t((p.ia || {}).zona_horario, 300),
        pagos: t((p.ia || {}).pagos, 300), no_prometer: t((p.ia || {}).no_prometer, 600),
        pasar_persona: t((p.ia || {}).pasar_persona, 600), activa: b((p.ia || {}).activa)
      },
      crm: { activo: b((p.crm || {}).activo) }
    };
  }

  // ---------- WhatsApp (Meta): receptor de mensajes entrantes ----------
  async function leerConfigAuto(clave) {
    return (await client.query('SELECT valor FROM automatizacion_config WHERE clave = $1', [clave])).rows[0]?.valor || '';
  }
  function leerCrudo(req) {
    return new Promise((resolve, reject) => {
      const partes = []; let total = 0;
      req.on('data', d => {
        total += d.length;
        if (total > 1024 * 1024) { reject(Object.assign(new Error('Cuerpo demasiado grande'), { codigo: 413 })); req.destroy(); return; }
        partes.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(partes)));
      req.on('error', reject);
    });
  }
  async function clientePorNumero(numeroId) {
    if (!numeroId) return '';
    const r = await client.query(`SELECT slug FROM automatizacion_clientes WHERE perfil->'redes'->'whatsapp'->>'numero_id' = $1 LIMIT 1`, [numeroId]);
    return r.rows[0] ? r.rows[0].slug : '';
  }
  // Meta llama a esta ruta: primero verifica el token, luego envía cada mensaje firmado con la clave de la app.
  async function manejarWhatsapp(req, res, url, { json }) {
    if (url !== '/api/whatsapp/webhook') return json(res, 404, { error: 'No existe esa ruta.' });
    const pregunta = new URL(req.url, 'http://x').searchParams;
    if (req.method === 'GET') {
      const token = await leerConfigAuto('verify_token_whatsapp');
      const ok = pregunta.get('hub.mode') === 'subscribe' && Boolean(token) && pregunta.get('hub.verify_token') === token;
      if (!ok) return json(res, 403, { error: 'Verificación no válida.' });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(pregunta.get('hub.challenge') || '');
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Método no permitido.' });
    let crudo;
    try { crudo = await leerCrudo(req); } catch (e) { return json(res, e.codigo || 400, { error: e.message }); }
    const cifrada = await leerConfigAuto('app_secret_whatsapp_enc');
    const secreto = descifrarAuto(cifrada);
    if (!secreto) return json(res, 503, { error: 'Falta la clave de la app de Meta en Oficina.' });
    const firma = String(req.headers['x-hub-signature-256'] || '');
    const esperada = 'sha256=' + crypto.createHmac('sha256', secreto).update(crudo).digest('hex');
    const firmaOk = firma.length === esperada.length && crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
    if (!firmaOk) return json(res, 401, { error: 'Firma no válida.' });
    let cuerpo;
    try { cuerpo = JSON.parse(crudo.toString('utf8')); } catch (e) { return json(res, 400, { error: 'Cuerpo no válido.' }); }
    let guardados = 0;
    for (const entrada of cuerpo.entry || []) {
      for (const cambio of entrada.changes || []) {
        const v = cambio.value || {};
        const numero = String((v.metadata || {}).phone_number_id || '');
        const nombres = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, ((c.profile || {}).name) || '']));
        const slug = await clientePorNumero(numero);
        for (const m of v.messages || []) {
          const r = await client.query(`INSERT INTO whatsapp_entrantes (meta_id, slug, numero_id, de, nombre, tipo, texto)
            VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (meta_id) DO NOTHING`,
            [texto(m.id, 120), slug, numero, texto(m.from, 40), texto(nombres[m.from], 120), texto(m.type, 20), texto((m.text || {}).body, 2000)]);
          guardados += r.rowCount;
        }
      }
    }
    return json(res, 200, { ok: true, guardados });
  }

  // ---------- Revisión programada de los números de la API ----------
  // Versión de la API de Meta que usamos. Confirmar en la documentación vigente antes de activar.
  const VERSION_META = 'v21.0';
  async function tokenNumero(numeroId) {
    return descifrarAuto(await leerConfigAuto('token_wa_' + numeroId));
  }
  async function consultarNumeroMeta(numeroId, token) {
    const r = await fetch(`https://graph.facebook.com/${VERSION_META}/${encodeURIComponent(numeroId)}?fields=verified_name,code_verification_status,quality_rating`,
      { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d.error && d.error.message) || ('Meta respondió ' + r.status));
    return { verificado: String(d.code_verification_status || ''), calidad: String(d.quality_rating || ''), nombre: String(d.verified_name || '') };
  }
  // Solo genera alerta cuando algo cambia (o es la primera revisión), para no repetirlas cada hora.
  function alertasDe(previo, nuevo) {
    const cambio = !previo || previo.estado !== nuevo.estado || previo.calidad !== nuevo.calidad || previo.verificado !== nuevo.verificado;
    if (!cambio) return [];
    const out = [];
    if (nuevo.estado === 'sin_conectar') out.push({ nivel: 'info', texto: 'Número sin conectar a la API de Meta.' });
    if (nuevo.estado === 'error') out.push({ nivel: 'alto', texto: 'No se pudo revisar el número: ' + nuevo.detalle });
    if (nuevo.verificado && nuevo.verificado !== 'VERIFIED') out.push({ nivel: 'alto', texto: 'El número no está verificado (' + nuevo.verificado + ').' });
    if (nuevo.calidad === 'RED') out.push({ nivel: 'alto', texto: 'Calidad en rojo: Meta puede limitar los envíos. Revisa qué mensajes se están enviando.' });
    else if (nuevo.calidad === 'YELLOW') out.push({ nivel: 'medio', texto: 'Calidad en amarillo: vigila los mensajes que salen.' });
    if (previo && previo.calidad && nuevo.calidad && previo.calidad !== nuevo.calidad) out.push({ nivel: 'info', texto: `La calidad cambió de ${previo.calidad} a ${nuevo.calidad}.` });
    return out;
  }
  async function revisarWhatsapp() {
    const numeros = (await client.query(`SELECT slug, perfil->'redes'->'whatsapp'->>'numero_id' AS numero FROM automatizacion_clientes
      WHERE COALESCE(perfil->'redes'->'whatsapp'->>'numero_id', '') <> ''`)).rows;
    let revisados = 0;
    for (const n of numeros) {
      const previo = (await client.query('SELECT estado, verificado, calidad FROM whatsapp_estado WHERE numero_id = $1', [n.numero])).rows[0];
      const token = await tokenNumero(n.numero);
      let nuevo;
      if (!token) nuevo = { estado: 'sin_conectar', verificado: '', calidad: '', detalle: 'Falta conectar este número con Meta.' };
      else {
        try { nuevo = { estado: 'conectado', ...(await consultarNumeroMeta(n.numero, token)), detalle: '' }; }
        catch (e) { nuevo = { estado: 'error', verificado: '', calidad: '', detalle: texto(e.message, 200) }; }
      }
      await client.query(`INSERT INTO whatsapp_estado (numero_id, slug, estado, verificado, calidad, detalle, revisado)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (numero_id) DO UPDATE SET slug = EXCLUDED.slug, estado = EXCLUDED.estado, verificado = EXCLUDED.verificado,
          calidad = EXCLUDED.calidad, detalle = EXCLUDED.detalle, revisado = NOW()`,
        [n.numero, n.slug, nuevo.estado, nuevo.verificado, nuevo.calidad, nuevo.detalle]);
      for (const a of alertasDe(previo, nuevo)) {
        await client.query('INSERT INTO whatsapp_alertas (numero_id, slug, nivel, texto) VALUES ($1, $2, $3, $4)', [n.numero, n.slug, a.nivel, a.texto]);
      }
      revisados++;
    }
    return { revisados };
  }
  async function estadoWhatsapp() {
    const numeros = (await client.query(`SELECT e.numero_id, e.slug, e.estado, e.verificado, e.calidad, e.detalle,
        TO_CHAR(e.revisado, 'YYYY-MM-DD HH24:MI') AS revisado FROM whatsapp_estado e ORDER BY e.slug`)).rows;
    const alertas = (await client.query(`SELECT numero_id, slug, nivel, texto, TO_CHAR(creado, 'YYYY-MM-DD HH24:MI') AS creado
      FROM whatsapp_alertas ORDER BY creado DESC LIMIT 30`)).rows;
    return { numeros, alertas };
  }

  // ---------- Envío de plantillas desde Oficina ----------
  // Guarda el token de acceso de un número (cifrado). Nunca vuelve a mostrarse.
  async function guardarTokenNumero(u, f) {
    const numero = String(f.numero_id || '').trim();
    const token = String(f.token || '').trim();
    if (!/^\d{6,25}$/.test(numero)) throw Object.assign(new Error('El ID del número debe ser solo números.'), { codigo: 400 });
    if (token.length < 20 || /\s/.test(token)) throw Object.assign(new Error('El token de acceso no parece válido.'), { codigo: 400 });
    await client.query(`INSERT INTO automatizacion_config (clave, valor) VALUES ($1, $2)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, ['token_wa_' + numero, cifrarAuto(token)]);
    await registrar(u, 'guardar_token_wa', 'whatsapp', numero, '', '', 'token guardado (cifrado)');
    return { ok: true };
  }
  // Envía una plantilla aprobada a un número de WhatsApp, usando la API de Meta.
  async function enviarPlantillaWa(u, f) {
    const numero = String(f.numero_id || '').trim();
    const destino = String(f.destino || '').replace(/\D/g, '');
    const plantilla = String(f.plantilla || '').trim();
    const idioma = String(f.idioma || 'es_PE').trim();
    if (!/^\d{6,25}$/.test(numero)) throw Object.assign(new Error('Escribe el ID del número de teléfono.'), { codigo: 400 });
    if (!/^\d{8,15}$/.test(destino)) throw Object.assign(new Error('El destinatario debe llevar código de país, solo números (ej.: 51979000000).'), { codigo: 400 });
    if (!/^[a-z0-9_]{3,512}$/.test(plantilla)) throw Object.assign(new Error('Nombre de plantilla no válido.'), { codigo: 400 });
    const token = await tokenNumero(numero);
    if (!token) throw Object.assign(new Error('Ese número todavía no tiene token de acceso. Guárdalo primero.'), { codigo: 400 });
    let respuesta, ok = false, texto_r = '';
    try {
      const r = await fetch(`https://graph.facebook.com/${VERSION_META}/${encodeURIComponent(numero)}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: destino, type: 'template', template: { name: plantilla, language: { code: idioma } } }),
        signal: AbortSignal.timeout(20000)
      });
      respuesta = await r.json().catch(() => ({}));
      ok = r.ok;
      texto_r = ok ? ('id: ' + ((respuesta.messages || [])[0] || {}).id) : ((respuesta.error && respuesta.error.message) || ('Meta respondió ' + r.status));
    } catch (e) {
      texto_r = 'No hay conexión con Meta: ' + texto(e.message, 150);
    }
    await client.query('INSERT INTO whatsapp_envios (numero_id, destino, plantilla, idioma, estado, respuesta) VALUES ($1, $2, $3, $4, $5, $6)',
      [numero, destino, plantilla, idioma, ok ? 'enviado' : 'error', texto(texto_r, 400)]);
    await registrar(u, 'enviar_plantilla_wa', 'whatsapp', plantilla, '', '', ok ? 'enviada' : 'error');
    if (!ok) throw Object.assign(new Error('Meta no envió el mensaje: ' + texto_r), { codigo: 502 });
    return { ok: true, respuesta: texto_r };
  }

  // ---------- Plantillas en Meta (Video 2): crear y consultar el estado con la API de WhatsApp ----------
  const CATEGORIA_META = { utilidad: 'UTILITY', marketing: 'MARKETING' };
  // Mayor número de variable usado: {{1}}, {{2}}… (Meta exige que vayan en orden desde 1).
  function variablesDe(cuerpo) {
    const nums = [...String(cuerpo || '').matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
  }
  // Cuerpo de la plantilla en el formato de la API de Meta. Con variables, Meta pide ejemplos.
  function payloadPlantillaMeta(p, idioma = 'es_PE') {
    const n = variablesDe(p.cuerpo);
    const cuerpo = { type: 'BODY', text: String(p.cuerpo || '') };
    if (n) cuerpo.example = { body_text: [Array.from({ length: n }, (_, i) => 'ejemplo' + (i + 1))] };
    return { name: p.nombre, language: idioma, category: CATEGORIA_META[p.categoria] || 'UTILITY', components: [cuerpo] };
  }
  async function wabaId() {
    return String(await leerConfigAuto('waba_id_whatsapp') || '').trim();
  }
  // Número que usamos para hablar con Meta: el indicado, o el primero que tenga token guardado.
  async function numeroParaMeta(preferido) {
    if (preferido) return preferido;
    const fila = (await client.query("SELECT clave FROM automatizacion_config WHERE clave LIKE 'token_wa_%' ORDER BY clave LIMIT 1")).rows[0];
    return fila ? fila.clave.replace(/^token_wa_/, '') : '';
  }
  async function credencialesMeta(numeroPreferido) {
    const waba = await wabaId();
    if (!waba) throw Object.assign(new Error('Falta el ID de la cuenta de WhatsApp Business. Guárdalo en Conexión con WhatsApp (Meta).'), { codigo: 400 });
    const numero = await numeroParaMeta(numeroPreferido);
    const token = numero ? await tokenNumero(numero) : '';
    if (!token) throw Object.assign(new Error('Guarda primero el token de acceso de un número de WhatsApp.'), { codigo: 400 });
    return { waba, token };
  }
  function mensajeErrorMeta(d, status) {
    return (d && d.error && (d.error.error_user_msg || d.error.message)) || ('Meta respondió ' + status);
  }
  async function llamarMeta(url, opciones) {
    try {
      return await fetch(url, { ...opciones, signal: AbortSignal.timeout(20000) });
    } catch (e) {
      throw Object.assign(new Error('No hay conexión con Meta: ' + texto(e.message, 150)), { codigo: 502 });
    }
  }
  async function guardarWabaId(u, f) {
    const id = String(f.waba_id || '').replace(/\s/g, '');
    if (!/^\d{6,25}$/.test(id)) throw Object.assign(new Error('El ID de la cuenta de WhatsApp Business solo lleva números.'), { codigo: 400 });
    await client.query(`INSERT INTO automatizacion_config (clave, valor) VALUES ('waba_id_whatsapp', $1)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [id]);
    await registrar(u, 'configurar_whatsapp_meta', 'whatsapp', 'waba', '', '', 'ID de la cuenta de WhatsApp Business guardado');
    return { ok: true };
  }
  // Manda la plantilla local a Meta para revisión. Antes pasa las reglas locales.
  async function crearPlantillaEnMeta(u, f) {
    const id = Number(f.id) || 0;
    const p = (await client.query('SELECT id, nombre, categoria, cuerpo, meta_id FROM plantillas_wa WHERE id = $1', [id])).rows[0];
    if (!p) throw Object.assign(new Error('Esa plantilla ya no existe.'), { codigo: 404 });
    const fallos = revisarPlantilla(p).filter(c => !c.ok);
    if (fallos.length) throw Object.assign(new Error('Corrige la plantilla antes de enviarla a Meta: ' + fallos.map(c => c.texto).join('; ') + '.'), { codigo: 400 });
    const idioma = String(f.idioma || 'es_PE').trim();
    if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(idioma)) throw Object.assign(new Error('Idioma no válido. Ejemplo: es_PE.'), { codigo: 400 });
    const { waba, token } = await credencialesMeta(String(f.numero_id || '').trim());
    const r = await llamarMeta(`https://graph.facebook.com/${VERSION_META}/${encodeURIComponent(waba)}/message_templates`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadPlantillaMeta(p, idioma))
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error('Meta no aceptó la plantilla: ' + mensajeErrorMeta(d, r.status)), { codigo: 502 });
    const estado = String(d.status || 'PENDING');
    await client.query(`UPDATE plantillas_wa SET meta_id = $2, meta_estado = $3, meta_motivo = '', actualizada = NOW() WHERE id = $1`, [id, String(d.id || ''), estado]);
    await registrar(u, 'enviar_plantilla_meta', 'plantilla', p.nombre, '', '', estado);
    return { ok: true, estado };
  }
  // Pide a Meta el estado de todas las plantillas de la cuenta y lo guarda junto a cada plantilla local.
  async function sincronizarPlantillasMeta(u, f) {
    const { waba, token } = await credencialesMeta(String(f.numero_id || '').trim());
    let url = `https://graph.facebook.com/${VERSION_META}/${encodeURIComponent(waba)}/message_templates?fields=id,name,status,rejected_reason&limit=100`;
    const enMeta = [];
    for (let pagina = 0; url && pagina < 10; pagina++) {
      const r = await llamarMeta(url, { headers: { Authorization: 'Bearer ' + token } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error('Meta no devolvió las plantillas: ' + mensajeErrorMeta(d, r.status)), { codigo: 502 });
      enMeta.push(...(d.data || []));
      url = (d.paging && d.paging.next) || '';
    }
    const locales = (await client.query('SELECT id, nombre FROM plantillas_wa')).rows;
    const sinEnMeta = [];
    let actualizadas = 0;
    for (const p of locales) {
      const m = enMeta.find(x => x.name === p.nombre);
      if (!m) { sinEnMeta.push(p.nombre); continue; }
      await client.query(`UPDATE plantillas_wa SET meta_id = $2, meta_estado = $3, meta_motivo = $4, actualizada = NOW() WHERE id = $1`,
        [p.id, String(m.id || ''), String(m.status || ''), texto(m.rejected_reason, 300)]);
      actualizadas++;
    }
    await registrar(u, 'sincronizar_plantillas_meta', 'whatsapp', 'plantillas', '', '', `${actualizadas} actualizadas`);
    return { ok: true, actualizadas, sin_en_meta: sinEnMeta };
  }

  // Configuración de la conexión con Meta (solo Programador, desde Oficina).
  async function configWhatsapp() {
    return { verify_token: await leerConfigAuto('verify_token_whatsapp'), app_secret_configurada: Boolean(descifrarAuto(await leerConfigAuto('app_secret_whatsapp_enc'))), waba_id: await wabaId() };
  }
  async function guardarSecretoWhatsapp(u, f) {
    const secreto = String(f.app_secret || '').trim();
    if (!/^[a-f0-9]{16,64}$/i.test(secreto)) throw Object.assign(new Error('La clave de la app debe ser el código de 32 caracteres de Meta.'), { codigo: 400 });
    await client.query(`INSERT INTO automatizacion_config (clave, valor) VALUES ('app_secret_whatsapp_enc', $1)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [cifrarAuto(secreto)]);
    await registrar(u, 'configurar_whatsapp_meta', 'whatsapp', 'app', '', '', 'clave de la app guardada (cifrada)');
    return { ok: true };
  }

  // Lo usa el flujo de n8n de cada cliente: entrega el prompt armado y la clave de OpenRouter del cliente.
  // No tiene sesión: se protege con la clave de n8n (cabecera x-clave-n8n).
  async function manejarN8n(req, res, url, { json }) {
    const esperada = await claveN8n();
    const dada = String(req.headers['x-clave-n8n'] || '');
    const ok = Boolean(esperada) && dada.length === esperada.length && crypto.timingSafeEqual(Buffer.from(dada), Buffer.from(esperada));
    if (!ok) return json(res, 401, { error: 'Clave de n8n no válida.' });
    if (req.method !== 'GET' || url !== '/api/n8n/automatizacion') return json(res, 404, { error: 'No existe esa ruta.' });
    const slug = texto(new URL(req.url, 'http://x').searchParams.get('slug'), 30).toLowerCase();
    const fila = (await client.query('SELECT nombre, slug, perfil FROM automatizacion_clientes WHERE slug = $1', [slug])).rows[0];
    if (!fila) return json(res, 404, { error: 'No hay cliente de automatización con ese subdominio.' });
    const perfil = fila.perfil || {};
    const ia = perfil.ia || {};
    const modelo = /sonnet/i.test(ia.modelo || '') ? 'anthropic/claude-sonnet-5.5' : 'anthropic/claude-haiku-5.5';
    return json(res, 200, {
      activo: ia.activa === true,
      nombre: fila.nombre, slug: fila.slug, modelo,
      prompt: armarPrompt(perfil, fila.nombre, await promptsList()),
      openrouter_key: descifrarAuto(ia.clave_openrouter_enc) || await claveIAGeneral()
    });
  }

  async function promptsList() {
    return (await client.query('SELECT clave, nombre, texto, orden FROM automatizacion_prompts ORDER BY orden, clave')).rows;
  }

  // Arma el prompt final de un cliente: reglas generales + tipo de negocio + datos del cliente.
  function armarPrompt(perfil, nombreCliente, prompts) {
    const ia = perfil.ia || {};
    const mapa = Object.fromEntries(prompts.map(p => [p.clave, p.texto]));
    const cambios = { negocio: nombreCliente || 'el negocio', tono: ia.tono || 'amable y directo' };
    const base = (mapa.maestro || '').replace(/\{(\w+)\}/g, (_, k) => (cambios[k] !== undefined ? cambios[k] : ''));
    const tipo = mapa[ia.tipo] || mapa.otro || '';
    const datos = [
      ['Qué vende o qué ofrece', ia.que_ofrece], ['Zona y horario', ia.zona_horario], ['Formas de pago', ia.pagos],
      ['La IA NO puede prometer', ia.no_prometer], ['Cuándo pasar a una persona', ia.pasar_persona]
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
    return [base, tipo && 'Tipo de negocio: ' + tipo, datos && 'Datos del cliente:\n' + datos].filter(Boolean).join('\n\n');
  }

  // Cifrado de la clave de OpenRouter de cada cliente (misma técnica que Operaciones; la clave nunca vuelve al navegador).
  const llaveAuto = () => crypto.createHash('sha256').update('automatizacion|' + String((config.sesion && config.sesion.secreto) || '')).digest();
  function cifrarAuto(t) {
    if (!t) return '';
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', llaveAuto(), iv);
    const d = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64');
  }
  function descifrarAuto(b) {
    if (!b) return '';
    try {
      const x = Buffer.from(b, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', llaveAuto(), x.subarray(0, 12));
      d.setAuthTag(x.subarray(12, 28));
      return Buffer.concat([d.update(x.subarray(28)), d.final()]).toString('utf8');
    } catch (e) { return ''; }
  }
  async function claveN8n() {
    return (await client.query("SELECT valor FROM automatizacion_config WHERE clave = 'clave_n8n'")).rows[0]?.valor || '';
  }
  // Clave de OpenRouter de Kaizen: la usan los clientes que no tengan una propia.
  async function claveIAGeneral() {
    return descifrarAuto(await leerConfigAuto('openrouter_enc'));
  }
  async function guardarClaveIA(u, f) {
    const clave = String(f.clave || '').trim();
    if (!clave) throw Object.assign(new Error('Escribe la clave de OpenRouter.'), { codigo: 400 });
    await client.query(`INSERT INTO automatizacion_config (clave, valor) VALUES ('openrouter_enc', $1)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [cifrarAuto(clave)]);
    await registrar(u, 'editar_clave_ia', 'automatizacion', 'openrouter', '', '', '');
    return { ok: true };
  }

  function claveDe(t) {
    return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '').slice(0, 36) || 'tipo';
  }
  // Busca una plantilla por nombre (sin distinguir mayúsculas) o por clave. Devuelve la clave o null.
  function tipoExistente(nombre, prompts) {
    const n = String(nombre || '').trim().toLowerCase();
    if (!n || n === 'maestro') return null;
    const p = prompts.find(x => x.clave !== 'maestro' && (x.nombre.toLowerCase() === n || x.clave === n));
    return p ? p.clave : null;
  }
  // Crea una plantilla nueva. Si no se escribe texto, empieza con el de "otro negocio" para que la edites después.
  async function insertarPlantilla(u, nombre, textoPlantilla) {
    const prompts = await promptsList();
    const base = claveDe(nombre);
    let clave = base, n = 2;
    while (prompts.some(p => p.clave === clave)) clave = base + '_' + (n++);
    const orden = Math.max(0, ...prompts.map(p => Number(p.orden) || 0)) + 1;
    await client.query('INSERT INTO automatizacion_prompts (clave, nombre, texto, orden) VALUES ($1, $2, $3, $4)', [clave, nombre, textoPlantilla, orden]);
    await registrar(u, 'crear_plantilla_ia', 'prompt', clave, '', '', nombre);
    return clave;
  }
  // Al guardar un cliente: si el tipo escrito no existe, se crea su plantilla.
  async function resolverTipo(u, nombre) {
    const n = texto(nombre, 80);
    if (!n) return 'otro';
    const existente = tipoExistente(n, await promptsList());
    if (existente) return existente;
    const otro = (await promptsList()).find(p => p.clave === 'otro');
    return insertarPlantilla(u, n, otro ? otro.texto : '');
  }
  async function crearPrompt(u, f) {
    const nombre = texto(f.nombre, 80);
    const nuevo = String(f.texto ?? '').trim().slice(0, 4000);
    if (!nombre) throw Object.assign(new Error('Escribe el nombre del tipo de negocio.'), { codigo: 400 });
    if (!nuevo) throw Object.assign(new Error('Escribe el texto de la plantilla.'), { codigo: 400 });
    if (tipoExistente(nombre, await promptsList())) throw Object.assign(new Error('Ya existe una plantilla con ese nombre. Edítala abajo.'), { codigo: 400 });
    return { clave: await insertarPlantilla(u, nombre, nuevo) };
  }

  // Solo el Programador edita los prompts (la ruta ya lo exige: Empresas es solo Programador).
  async function guardarPrompt(u, f) {
    const clave = texto(f.clave, 40);
    const nuevo = String(f.texto ?? '').trim().slice(0, 4000);
    if (!nuevo) throw Object.assign(new Error('El texto del prompt no puede quedar vacío.'), { codigo: 400 });
    const r = await client.query('UPDATE automatizacion_prompts SET texto = $2, actualizado = NOW() WHERE clave = $1 RETURNING clave', [clave, nuevo]);
    if (!r.rowCount) throw Object.assign(new Error('Ese prompt no existe.'), { codigo: 404 });
    await registrar(u, 'editar_prompt_ia', 'prompt', clave, '', '', '');
    return { ok: true };
  }

  async function guardarAutomatizacion(u, f) {
    const nombre = texto(f.nombre, 120);
    const slug = texto(f.slug, 30).toLowerCase();
    if (!nombre) throw Object.assign(new Error('Falta el nombre del cliente.'), { codigo: 400 });
    if (!SLUG.test(slug) || RESERVADOS.has(slug) || slug === 'demo') {
      throw Object.assign(new Error(`Subdominio: "${slug}" no sirve o está reservado. Usa de 3 a 30 letras minúsculas, números o guiones (ej.: premios-carrasco).`), { codigo: 400, campo: 'slug' });
    }
    const id = Number(f.id) || 0;
    const ocupado = (await client.query('SELECT id FROM automatizacion_clientes WHERE slug = $1', [slug])).rows[0];
    if (ocupado && ocupado.id !== id) throw Object.assign(new Error('Ya hay un cliente de automatización con ese subdominio.'), { codigo: 400, campo: 'slug' });
    if ((await client.query('SELECT 1 FROM empresas WHERE slug = $1', [slug])).rowCount) {
      throw Object.assign(new Error('Ese subdominio ya lo usa una empresa del panel de correo.'), { codigo: 400, campo: 'slug' });
    }
    const entrada = f.perfil || {};
    const claveTipo = await resolverTipo(u, (entrada.ia || {}).tipo_nombre);
    const previo = id ? (await client.query('SELECT perfil FROM automatizacion_clientes WHERE id = $1', [id])).rows[0] : null;
    const claveNueva = String((entrada.ia || {}).clave_openrouter || '').trim();
    const encPrevio = previo && previo.perfil && previo.perfil.ia ? previo.perfil.ia.clave_openrouter_enc : '';
    const perfilLimpio = limpiarPerfil({ ...entrada, ia: { ...(entrada.ia || {}), tipo: claveTipo } });
    perfilLimpio.ia.clave_openrouter_enc = claveNueva ? cifrarAuto(claveNueva) : (encPrevio || '');
    const perfil = JSON.stringify(perfilLimpio);
    if (id) {
      const r = await client.query('UPDATE automatizacion_clientes SET slug = $1, nombre = $2, perfil = $3::jsonb, actualizado = NOW() WHERE id = $4 RETURNING id',
        [slug, nombre, perfil, id]);
      if (!r.rows[0]) throw Object.assign(new Error('Ese cliente ya no existe.'), { codigo: 404 });
    } else {
      const r = await client.query('INSERT INTO automatizacion_clientes (slug, nombre, perfil) VALUES ($1, $2, $3::jsonb) RETURNING id', [slug, nombre, perfil]);
      await registrar(u, 'crear_automatizacion', 'cliente', slug, '', '', nombre);
      return { id: r.rows[0].id };
    }
    await registrar(u, 'editar_automatizacion', 'cliente', slug, '', '', nombre);
    return { id };
  }

  async function crearEmpresa(u, f, esDemo) {
    const slug = esDemo ? 'demo' : texto(f.slug, 30).toLowerCase();
    const nombre = esDemo ? 'Demo de ventas' : texto(f.nombre, 120);
    if (!nombre) throw Object.assign(new Error('Falta el nombre de la empresa.'), { codigo: 400 });
    if (!SLUG.test(slug) || (!esDemo && (RESERVADOS.has(slug) || slug === 'demo'))) {
      const motivo = RESERVADOS.has(slug) || slug === 'demo'
        ? `"${slug}" es una palabra reservada. Usa otra (ej.: ${slug}-viajes).`
        : `"${slug}" no sirve: usa de 3 a 30 letras minúsculas, números o guiones, sin espacios ni acentos (ej.: viajes-caribe).`;
      throw Object.assign(new Error('Subdominio: ' + motivo), { codigo: 400, campo: 'slug' });
    }
    if ((await client.query('SELECT 1 FROM empresas WHERE slug = $1', [slug])).rowCount) {
      throw Object.assign(new Error('Ya existe una empresa con ese subdominio.'), { codigo: 400 });
    }
    const admin = esDemo ? null : { usuario: texto(f.admin && f.admin.usuario, 50).toLowerCase(), nombre: texto(f.admin && f.admin.nombre, 100) };
    if (admin && (!/^[a-z0-9._-]{3,50}$/.test(admin.usuario) || !admin.nombre)) {
      throw Object.assign(new Error('El usuario principal necesita nombre y un usuario de 3 a 50 letras o números (sin espacios).'), { codigo: 400 });
    }
    if (admin && admin.usuario === u.usuario) throw Object.assign(new Error('El usuario principal no puede llamarse igual que el programador.'), { codigo: 400 });

    const base = 'panel_' + slug.replace(/-/g, '_');
    const existe = (await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [base])).rowCount;
    if (existe) throw Object.assign(new Error(`Ya hay una base de datos llamada ${base}. Elige otro subdominio.`), { codigo: 400 });
    const puerto = await siguientePuerto();
    await client.query(`CREATE DATABASE "${base}"`);
    let e = { slug, base_datos: base, puerto };
    try {
      e = (await client.query(
        "INSERT INTO empresas (slug, nombre, base_datos, puerto, es_demo, estado) VALUES ($1, $2, $3, $4, $5, 'creando') RETURNING *", [slug, nombre, base, puerto, !!esDemo])).rows[0];
      const r = await terminarCreacion(u, f, esDemo, e, admin);
      await client.query("UPDATE empresas SET estado = 'activa' WHERE id = $1", [e.id]);
      return r;
    } catch (err) {
      // Si algo falla a mitad, se deshace todo: no quedan empresas a medias.
      await borrarTodo(e).catch(x => console.log('No se pudo deshacer la empresa', slug, x.message));
      throw Object.assign(new Error('No se creó la empresa (se deshizo todo, puedes volver a intentarlo): ' + err.message), { codigo: err.codigo || 500 });
    }
  }

  async function terminarCreacion(u, f, esDemo, e, admin) {
    const { slug, nombre, base_datos: base, puerto } = e;
    const ajustes = ajustesDesde(e, esDemo ? {} : f);
    escribirAjustes(e, ajustes);
    await client.query('UPDATE empresas SET correo = $1 WHERE id = $2', [resumenCorreo(ajustes), e.id]);

    if (!(await encender(e))) {
      let detalle = '';
      try { detalle = fs.readFileSync(path.join(carpetaDe(e), 'panel-error.log'), 'utf8').trim().split('\n').slice(-3).join(' ').slice(0, 300); } catch (err) {}
      throw Object.assign(new Error('su panel no encendió.' + (detalle ? ' Detalle: ' + detalle : ' Revisa que Postgres (Docker) esté encendido.')), { codigo: 500 });
    }
    // El panel nuevo ya creó sus tablas. Ahora: grupos, usuarios, nombre y módulos.
    const yo = (await client.query('SELECT usuario, nombre, password_hash FROM usuarios WHERE usuario = $1', [u.usuario])).rows[0];
    const claveAdmin = claveAleatoria(10);
    await conEmpresa(e, async db => {
      for (const [g, permisos] of Object.entries(GRUPOS)) {
        if (!esDemo && g.startsWith('Visitante')) continue;
        await db.query('INSERT INTO grupos (nombre, permisos, protegido) VALUES ($1, $2, FALSE) ON CONFLICT (nombre) DO NOTHING', [g, permisos]);
      }
      // El programador entra a todas las empresas con su mismo usuario y clave del central.
      await db.query(`INSERT INTO usuarios (usuario, nombre, grupo, empresa, password_hash, activo, debe_cambiar, permisos)
        VALUES ($1, $2, 'Programador', 'todas', $3, TRUE, FALSE, '{}') ON CONFLICT (usuario) DO NOTHING`, [yo.usuario, yo.nombre, yo.password_hash]);
      if (admin) {
        await db.query(`INSERT INTO usuarios (usuario, nombre, grupo, empresa, password_hash, activo, debe_cambiar, permisos)
          VALUES ($1, $2, 'Gerencia', 'todas', $3, TRUE, TRUE, '{}')`, [admin.usuario, admin.nombre, bcrypt.hashSync(claveAdmin, 10)]);
      }
      await db.query('UPDATE empresa_datos SET nombre = $1 WHERE id = 1', [esDemo ? 'Agencia Demo Caribe' : nombre]);
      const modulos = Object.fromEntries(Object.keys(MODULOS).map(k => [k, f.modulos ? f.modulos[k] === true : MODULOS[k].porDefecto]));
      await db.query('UPDATE cuenta SET modulos = $1, pago = $2 WHERE id = 1', [modulos, admin ? { usuario: admin.usuario } : {}]);
      if (esDemo) await sembrarDemo(db);
    });
    await registrar(u, esDemo ? 'crear_demo' : 'crear_empresa', 'empresa', slug, '', base, `${nombre} en el puerto ${puerto}`);
    return { ok: true, url: urlDe(e), puerto, admin: admin ? { usuario: admin.usuario, clave: claveAdmin } : null };
  }

  // ---------- Lista y detalle ----------

  async function detalle(e) {
    const vivo = await responde(e);
    let info = {};
    try {
      info = await conEmpresa(e, async db => {
        const c = (await db.query('SELECT estado, motivo, modulos, pago, pagado FROM cuenta WHERE id = 1')).rows[0] || {};
        const n = (await db.query(`SELECT
            (SELECT COUNT(*)::int FROM usuarios WHERE activo = TRUE AND grupo <> 'Programador' AND vence IS NULL) AS usuarios,
            (SELECT COUNT(*)::int FROM clasificacion WHERE creado >= date_trunc('day', NOW())) AS correos_hoy,
            (SELECT MAX(creado) FROM clasificacion) AS ultimo_correo`)).rows[0];
        const motor = (await db.query("SELECT mensaje, fin FROM motor_estado WHERE id = 1").catch(() => ({ rows: [] }))).rows[0] || null;
        const usuarios = (await db.query("SELECT usuario, nombre, grupo FROM usuarios WHERE activo = TRUE AND grupo <> 'Programador' AND vence IS NULL ORDER BY nombre")).rows;
        return { cuenta: c, numeros: n, motor, usuarios };
      });
    } catch (err) { info = { error: 'Sin conexión con su base de datos: ' + err.message }; }
    const c = info.cuenta || {};
    const etapa = c.pago ? etapaPago({ ...c.pago, activo: c.pago.activo }, c.pagado) : null;
    return {
      id: e.id, slug: e.slug, nombre: e.nombre, puerto: e.puerto, estado: e.estado, es_demo: e.es_demo, url: urlDe(e),
      externa: e.externa, base_datos: e.base_datos,
      creado: e.creado, correo: e.correo, pagoCentral: e.pago, vivo, ...info, etapaPago: etapa,
      modulos: Object.fromEntries(Object.keys(MODULOS).map(k => [k, c.modulos && typeof c.modulos[k] === 'boolean' ? c.modulos[k] : MODULOS[k].porDefecto]))
    };
  }

  async function empresa(id) {
    const e = (await client.query('SELECT * FROM empresas WHERE id = $1', [Number(id)])).rows[0];
    if (!e) throw Object.assign(new Error('Empresa no encontrada.'), { codigo: 404 });
    return e;
  }

  async function plantillasPorId() {
    return new Map((await client.query('SELECT * FROM plantillas_mensaje')).rows.map(x => [x.id, x]));
  }

  // Lleva el ajuste de cobro (con los textos de las plantillas elegidas) a la base de la empresa.
  async function aplicarPago(e) {
    const p = e.pago || {};
    const plantillas = await plantillasPorId();
    const mensajes = {};
    for (const etapa of ['antes', 'dia', 'vencido']) {
      const t = p.plantillas && plantillas.get(Number(p.plantillas[etapa]));
      mensajes[etapa] = t ? t.texto : TEXTOS_PAGO[etapa];
    }
    await conEmpresa(e, db => db.query('UPDATE cuenta SET pago = $1, actualizado = NOW() WHERE id = 1', [{
      activo: !!p.activo, dia: p.dia, monto: p.monto, moneda: p.moneda, diasAntes: p.diasAntes, usuario: p.usuario, desde: p.desde, mensajes
    }]));
  }

  // ---------- Demo: accesos de 48 horas ----------

  async function demo() {
    return (await client.query('SELECT * FROM empresas WHERE es_demo = TRUE LIMIT 1')).rows[0] || null;
  }

  // ---------- Inteligencia artificial (OpenRouter) ----------

  const OPENROUTER = (aj.openrouterUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  let modelosGuardados = null;

  // Modelos de OpenRouter que leen imágenes (el motor manda las capturas de reservas), con su precio.
  async function modelos() {
    if (modelosGuardados && Date.now() - modelosGuardados.en < 3600000) return modelosGuardados.lista;
    try {
      const control = new AbortController();
      const reloj = setTimeout(() => control.abort(), 15000);
      const r = await fetch(OPENROUTER + '/models', { signal: control.signal }).finally(() => clearTimeout(reloj));
      const d = await r.json();
      const porMillon = v => (Number(v) > 0 ? Math.round(Number(v) * 1e6 * 100) / 100 : 0);
      const lista = (d.data || [])
        .filter(m => MODELO_VALIDO.test(m.id || '') && ((m.architecture && (m.architecture.input_modalities || []).includes('image')) || /image/.test((m.architecture && m.architecture.modality) || '')))
        .map(m => ({ id: m.id, nombre: m.name || m.id, imagenes: true, entrada: porMillon(m.pricing && m.pricing.prompt), salida: porMillon(m.pricing && m.pricing.completion) }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre));
      if (!lista.length) throw new Error('lista vacía');
      modelosGuardados = { en: Date.now(), lista };
      return lista;
    } catch (err) {
      return MODELOS_RESPALDO;
    }
  }

  // Prueba real: una pregunta mínima al modelo con esa clave (cuesta una fracción de centavo).
  async function probarIA(apiKey, modelo) {
    if (!apiKey) return { ok: false, error: 'Falta la clave de OpenRouter.' };
    if (!MODELO_VALIDO.test(modelo || '')) return { ok: false, error: 'El nombre del modelo no es válido (ej.: anthropic/claude-haiku-5.5).' };
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 30000);
    try {
      const r = await fetch(OPENROUTER + '/chat/completions', {
        method: 'POST', signal: control.signal,
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelo, max_tokens: 5, messages: [{ role: 'user', content: 'Responde solo: OK' }] })
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.choices) {
        let saldo = null;
        try {
          const k = await (await fetch(OPENROUTER + '/key', { headers: { Authorization: 'Bearer ' + apiKey } })).json();
          if (k && k.data && k.data.limit_remaining !== undefined && k.data.limit_remaining !== null) saldo = Math.round(k.data.limit_remaining * 100) / 100;
        } catch (err) {}
        return { ok: true, mensaje: `La clave funciona y el modelo ${modelo} respondió.` + (saldo !== null ? ` Le quedan US$ ${saldo} de límite.` : '') };
      }
      const detalle = (d.error && (d.error.message || d.error)) || ('código ' + r.status);
      const motivo = r.status === 401 ? 'La clave de OpenRouter no es válida.'
        : r.status === 402 ? 'La cuenta de OpenRouter no tiene saldo.'
        : r.status === 404 || /model/i.test(String(detalle)) ? `OpenRouter no encontró el modelo "${modelo}".`
        : 'OpenRouter respondió con error: ' + String(detalle).slice(0, 200);
      return { ok: false, error: motivo };
    } catch (err) {
      return { ok: false, error: err.name === 'AbortError' ? 'OpenRouter tardó demasiado en responder.' : 'No hay conexión con OpenRouter: ' + err.message };
    } finally {
      clearTimeout(reloj);
    }
  }

  // ---------- Rutas ----------

  async function manejar(req, res, url, u, { json, leerCuerpo, permisos = {} }) {
    if (!activo) return json(res, 404, { error: 'Este panel no es el central.' });
    // Solo la empresa demo: quien tenga el permiso "oficina_demo" puede crearla y verla. Lo demás es del programador.
    const demoPermitida = Boolean(permisos.oficina_demo) && ((url === '/api/central/demo' && req.method === 'GET') || (url === '/api/central/demo/crear' && req.method === 'POST'));
    if (u.grupo !== 'Programador' && !demoPermitida) return json(res, 403, { error: 'Solo el programador puede usar Empresas.' });
    // Acciones delicadas: se vuelve a pedir la contraseña del programador.
    const confirmar = async clave => {
      const r = (await client.query('SELECT password_hash FROM usuarios WHERE id = $1', [u.id])).rows[0];
      if (!r || !(await bcrypt.compare(String(clave || ''), r.password_hash))) {
        throw Object.assign(new Error('Contraseña incorrecta. Para esta acción hay que confirmar tu contraseña.'), { codigo: 403 });
      }
    };
    try {
      const m = url.match(/^\/api\/central\/empresas\/(\d+)\/([a-z-]+)$/);

      if (req.method === 'GET' && url === '/api/central/empresas') {
        const lista = (await client.query('SELECT * FROM empresas ORDER BY es_demo, nombre')).rows;
        const detalles = await Promise.all(lista.map(detalle));
        return json(res, 200, { empresas: detalles, modulos: MODULOS, ip: ipLocal(), dominio: aj.dominio, hoy: hoyLocal() });
      }

      if (req.method === 'POST' && url === '/api/central/empresas') {
        const f = await leerCuerpo(req);
        await confirmar(f.confirmar);
        return json(res, 200, await crearEmpresa(u, f, false));
      }

      // Clientes de automatización (redes y CRM), separados del motor de correo.
      if (req.method === 'GET' && url === '/api/central/automatizacion') {
        const clientes = (await client.query('SELECT id, slug, nombre, perfil, estado, TO_CHAR(actualizado, \'YYYY-MM-DD HH24:MI\') AS actualizado FROM automatizacion_clientes ORDER BY nombre')).rows;
        const sinClave = clientes.map(c => {
          const p = { ...(c.perfil || {}), ia: { ...((c.perfil || {}).ia || {}) } };
          p.ia.clave_configurada = Boolean(p.ia.clave_openrouter_enc);
          delete p.ia.clave_openrouter_enc;
          return { ...c, perfil: p };
        });
        return json(res, 200, { clientes: sinClave, clave_general_configurada: Boolean(await leerConfigAuto('openrouter_enc')) });
      }
      if (req.method === 'POST' && url === '/api/central/automatizacion/clave-ia/guardar') {
        return json(res, 200, await guardarClaveIA(u, await leerCuerpo(req)));
      }
      if (req.method === 'GET' && url === '/api/central/whatsapp/config') return json(res, 200, await configWhatsapp());
      if (req.method === 'GET' && url === '/api/central/whatsapp/estado') return json(res, 200, await estadoWhatsapp());
      if (req.method === 'POST' && url === '/api/central/whatsapp/token/guardar') return json(res, 200, await guardarTokenNumero(u, await leerCuerpo(req)));
      if (req.method === 'POST' && url === '/api/central/whatsapp/enviar') return json(res, 200, await enviarPlantillaWa(u, await leerCuerpo(req)));
      if (req.method === 'GET' && url === '/api/central/whatsapp/plantillas') return json(res, 200, { plantillas: await plantillasWa() });
      if (req.method === 'POST' && url === '/api/central/whatsapp/plantillas/guardar') return json(res, 200, await guardarPlantillaWa(u, await leerCuerpo(req)));
      if (req.method === 'POST' && url === '/api/central/whatsapp/plantillas/marcar') return json(res, 200, await marcarPlantillaWa(u, await leerCuerpo(req)));
      if (req.method === 'POST' && url === '/api/central/whatsapp/plantillas/meta/crear') return json(res, 200, await crearPlantillaEnMeta(u, await leerCuerpo(req)));
      if (req.method === 'POST' && url === '/api/central/whatsapp/plantillas/meta/sincronizar') return json(res, 200, await sincronizarPlantillasMeta(u, await leerCuerpo(req)));
      if (req.method === 'POST' && url === '/api/central/whatsapp/waba/guardar') return json(res, 200, await guardarWabaId(u, await leerCuerpo(req)));
      if (req.method === 'POST' && url === '/api/central/whatsapp/revisar') return json(res, 200, await revisarWhatsapp());
      if (req.method === 'POST' && url === '/api/central/whatsapp/config/guardar') return json(res, 200, await guardarSecretoWhatsapp(u, await leerCuerpo(req)));
      if (req.method === 'GET' && url === '/api/central/automatizacion/clave-n8n') {
        return json(res, 200, { clave: await claveN8n() });
      }
      if (req.method === 'GET' && url === '/api/central/automatizacion/prompts') {
        return json(res, 200, { prompts: await promptsList() });
      }
      if (req.method === 'POST' && url === '/api/central/automatizacion/prompts/crear') {
        return json(res, 200, await crearPrompt(u, await leerCuerpo(req)));
      }
      if (req.method === 'POST' && url === '/api/central/automatizacion/prompts/guardar') {
        return json(res, 200, await guardarPrompt(u, await leerCuerpo(req)));
      }
      // Muestra el prompt final que recibirá la IA de un cliente (sin guardar nada).
      if (req.method === 'POST' && url === '/api/central/automatizacion/prompt-vista') {
        const f = await leerCuerpo(req);
        const prompts = await promptsList();
        const perfil = limpiarPerfil(f.perfil || {});
        perfil.ia.tipo = tipoExistente(perfil.ia.tipo_nombre, prompts) || 'otro';
        return json(res, 200, { texto: armarPrompt(perfil, texto(f.nombre, 120), prompts) });
      }
      if (req.method === 'POST' && url === '/api/central/automatizacion/guardar') {
        return json(res, 200, await guardarAutomatizacion(u, await leerCuerpo(req)));
      }

      // Agregar una empresa que ya funciona (ej. Somos Viajes) para administrarla desde aquí.
      if (req.method === 'POST' && url === '/api/central/existente') {
        const f = await leerCuerpo(req);
        await confirmar(f.confirmar);
        const nombre = texto(f.nombre, 120);
        const slug = texto(f.slug, 30).toLowerCase();
        const base = texto(f.base_datos, 63);
        const puerto = Number(f.puerto);
        const direccion = texto(f.url, 200);
        if (!nombre) return json(res, 400, { error: 'Falta el nombre de la empresa.' });
        if (!SLUG.test(slug) || RESERVADOS.has(slug) || slug === 'demo') return json(res, 400, { error: 'Subdominio: usa de 3 a 30 letras minúsculas, números o guiones (ej.: somosviajes).' });
        if (!/^[A-Za-z0-9_]{1,63}$/.test(base)) return json(res, 400, { error: 'El nombre de la base de datos solo lleva letras, números y _ (ej.: correos).' });
        if (base === (config.db && config.db.database)) return json(res, 400, { error: 'Esa es la base del propio panel central.' });
        if (!Number.isInteger(puerto) || puerto < 1024 || puerto > 65535) return json(res, 400, { error: 'El puerto debe ser un número (ej.: 3001).' });
        if (direccion && !/^https?:\/\/\S+$/i.test(direccion)) return json(res, 400, { error: 'La dirección debe empezar con http:// o https://' });
        if ((await client.query('SELECT 1 FROM empresas WHERE slug = $1 OR base_datos = $2 OR puerto = $3', [slug, base, puerto])).rowCount) {
          return json(res, 400, { error: 'Ya hay una empresa en la lista con ese subdominio, esa base de datos o ese puerto.' });
        }
        if (!(await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [base])).rowCount) {
          return json(res, 400, { error: `No existe la base de datos "${base}" en este Postgres.` });
        }
        const lista = await conEmpresa({ base_datos: base }, async db => (await db.query(
          "SELECT to_regclass('public.cuenta') IS NOT NULL AS cuenta, to_regclass('public.usuarios') IS NOT NULL AS usuarios")).rows[0]);
        if (!lista.usuarios) return json(res, 400, { error: `La base "${base}" no es de un panel de reservas.` });
        if (!lista.cuenta) return json(res, 400, { error: 'Esa empresa todavía tiene una versión vieja del panel. Instálale primero la versión nueva y enciéndela una vez.' });
        await client.query(`INSERT INTO empresas (slug, nombre, base_datos, puerto, estado, externa, url_externa)
          VALUES ($1, $2, $3, $4, 'activa', TRUE, $5)`, [slug, nombre, base, puerto, direccion]);
        await registrar(u, 'agregar_empresa_existente', 'empresa', slug, '', base, `${nombre} (puerto ${puerto})`);
        return json(res, 200, { ok: true });
      }

      if (m && req.method === 'POST') {
        const e = await empresa(m[1]);
        const accion = m[2];
        const f = await leerCuerpo(req);
        if (e.externa && ['encender', 'apagar', 'correo'].includes(accion)) {
          return json(res, 400, { error: 'Esta empresa se maneja en su propia carpeta: la enciende su vigilante y su correo se cambia en su config.js.' });
        }

        if (accion === 'encender') {
          await client.query("UPDATE empresas SET estado = CASE WHEN estado = 'apagada' THEN 'activa' ELSE estado END WHERE id = $1", [e.id]);
          const ok = await encender(e);
          return ok ? json(res, 200, { ok: true }) : json(res, 500, { error: 'No encendió. Revisa ' + path.join(carpetaDe(e), 'panel-error.log') });
        }
        if (accion === 'apagar') {
          await client.query("UPDATE empresas SET estado = 'apagada' WHERE id = $1", [e.id]);
          await apagar(e);
          await registrar(u, 'apagar_empresa', 'empresa', e.slug, '', '', '');
          return json(res, 200, { ok: true });
        }
        if (accion === 'eliminar') {
          await confirmar(f.confirmar);
          if (texto(f.slug, 30).toLowerCase() !== e.slug) {
            return json(res, 400, { error: `Para eliminar escribe exactamente el subdominio: ${e.slug}` });
          }
          await borrarTodo(e);
          await registrar(u, 'eliminar_empresa', 'empresa', e.slug, e.base_datos, '',
            e.externa ? `${e.nombre} quitada de la lista (su base de datos no se tocó)` : `${e.nombre} eliminada con su base de datos`);
          return json(res, 200, { ok: true });
        }
        if (accion === 'pausar' || accion === 'reanudar') {
          const pausar = accion === 'pausar';
          const motivo = texto(f.motivo, 300);
          await conEmpresa(e, db => db.query('UPDATE cuenta SET estado = $1, motivo = $2, actualizado = NOW() WHERE id = 1', [pausar ? 'pausada' : 'activa', pausar ? motivo : '']));
          await client.query('UPDATE empresas SET estado = $1 WHERE id = $2', [pausar ? 'pausada' : 'activa', e.id]);
          await registrar(u, pausar ? 'pausar_empresa' : 'reanudar_empresa', 'empresa', e.slug, '', '', motivo);
          return json(res, 200, { ok: true });
        }
        if (accion === 'modulos') {
          const modulos = Object.fromEntries(Object.keys(MODULOS).map(k => [k, !!(f.modulos && f.modulos[k])]));
          await conEmpresa(e, db => db.query('UPDATE cuenta SET modulos = $1, actualizado = NOW() WHERE id = 1', [modulos]));
          await registrar(u, 'modulos_empresa', 'empresa', e.slug, '', JSON.stringify(modulos), '');
          return json(res, 200, { ok: true });
        }
        if (accion === 'pago') {
          const pago = {
            activo: !!f.activo,
            dia: Math.min(28, Math.max(1, Number(f.dia) || 1)),
            monto: texto(f.monto, 20), moneda: texto(f.moneda, 5) || 'US$',
            diasAntes: Math.min(15, Math.max(0, Number(f.diasAntes) || 0)),
            usuario: texto(f.usuario, 50),
            plantillas: { antes: Number(f.plantillas && f.plantillas.antes) || null, dia: Number(f.plantillas && f.plantillas.dia) || null, vencido: Number(f.plantillas && f.plantillas.vencido) || null },
            // El cobro empieza a contar desde el mes en que se activa (no se cobran meses anteriores).
            desde: (e.pago && e.pago.desde) || hoyLocal().slice(0, 7)
          };
          e.pago = pago;
          await client.query('UPDATE empresas SET pago = $1 WHERE id = $2', [pago, e.id]);
          await aplicarPago(e);
          await registrar(u, 'pago_empresa', 'empresa', e.slug, '', JSON.stringify(pago), '');
          return json(res, 200, { ok: true });
        }
        if (accion === 'pagado') {
          // Marca pagado el mes que se está cobrando (o el actual) y apaga el aviso.
          const info = await conEmpresa(e, async db => (await db.query('SELECT pago, pagado FROM cuenta WHERE id = 1')).rows[0]);
          const etapa = etapaPago(info.pago, info.pagado);
          const periodo = /^\d{4}-\d{2}$/.test(f.periodo || '') ? f.periodo : (etapa ? etapa.periodo : hoyLocal().slice(0, 7));
          await conEmpresa(e, db => db.query("UPDATE cuenta SET pagado = $1, aviso_pago = '', actualizado = NOW() WHERE id = 1", [periodo]));
          await registrar(u, 'pago_recibido', 'empresa', e.slug, info.pagado || '', periodo, '');
          return json(res, 200, { ok: true, periodo });
        }
        if (accion === 'anuncio') {
          let textoAnuncio = texto(f.texto, 2000);
          if (!textoAnuncio && f.plantilla) {
            const p = (await client.query('SELECT texto FROM plantillas_mensaje WHERE id = $1', [Number(f.plantilla)])).rows[0];
            textoAnuncio = p ? p.texto : '';
          }
          if (!textoAnuncio) return json(res, 400, { error: 'Escribe el mensaje o elige uno del banco.' });
          const n = await conEmpresa(e, async db => {
            const destino = f.para === '*'
              ? (await db.query("SELECT usuario, nombre FROM usuarios WHERE activo = TRUE AND grupo <> 'Programador'")).rows
              : (await db.query('SELECT usuario, nombre FROM usuarios WHERE activo = TRUE AND usuario = $1', [texto(f.para, 50)])).rows;
            const empresaNombre = ((await db.query('SELECT nombre FROM empresa_datos WHERE id = 1')).rows[0] || {}).nombre || e.nombre;
            for (const d of destino) {
              const t = textoAnuncio.replace(/\{usuario\}/g, d.nombre || d.usuario).replace(/\{empresa\}/g, empresaNombre);
              await db.query('INSERT INTO anuncios (para, titulo, texto, por) VALUES ($1, $2, $3, $4)', [d.usuario, texto(f.titulo, 120) || 'Aviso de Kaizen IA', t, u.usuario]);
              await db.query('INSERT INTO avisos (para, texto) VALUES ($1, $2)', [d.usuario, (texto(f.titulo, 120) || 'Aviso de Kaizen IA') + ': ' + t.slice(0, 200)]);
            }
            return destino.length;
          });
          await registrar(u, 'anuncio_empresa', 'empresa', e.slug, '', String(n), textoAnuncio.slice(0, 200));
          return json(res, 200, { ok: true, enviados: n });
        }
        if (accion === 'correo') {
          await confirmar(f.confirmar);
          const previo = leerAjustes(e) || {};
          const nuevos = ajustesDesde(e, { ...f, sedes: f.sedes !== undefined ? f.sedes : (previo.sedes || []).join(', ') }, previo);
          escribirAjustes(e, nuevos);
          await client.query('UPDATE empresas SET correo = $1 WHERE id = $2', [resumenCorreo(nuevos), e.id]);
          await apagar(e);
          await new Promise(r => setTimeout(r, 800));
          const ok = await encender(e);
          await registrar(u, 'correo_empresa', 'empresa', e.slug, '', resumenCorreo(nuevos).proveedor, 'Ajustes de correo/IA cambiados');
          return json(res, 200, { ok, aviso: ok ? '' : 'Se guardó, pero el panel no volvió a encender.' });
        }
        return json(res, 404, { error: 'Acción no válida.' });
      }

      // Modelos de IA y prueba de la clave
      if (url === '/api/central/modelos' && req.method === 'GET') {
        return json(res, 200, { defecto: MODELO_DEFECTO, modelos: await modelos() });
      }
      if (url === '/api/central/probar-ia' && req.method === 'POST') {
        const f = await leerCuerpo(req);
        let apiKey = texto(f.apiKey, 200);
        // Sin clave escrita: se prueba la que ya tiene guardada esa empresa (sin mostrarla).
        if (!apiKey && f.empresa) {
          const e = await empresa(f.empresa);
          apiKey = ((leerAjustes(e) || {}).openrouter || {}).apiKey || '';
        }
        return json(res, 200, await probarIA(apiKey, texto(f.modelo, 100) || MODELO_DEFECTO));
      }

      // Banco de mensajes
      if (url === '/api/central/plantillas') {
        if (req.method === 'GET') return json(res, 200, (await client.query('SELECT * FROM plantillas_mensaje ORDER BY tipo, id')).rows);
        const f = await leerCuerpo(req);
        const tipo = ['antes', 'dia', 'vencido', 'general'].includes(f.tipo) ? f.tipo : 'general';
        if (f.borrar && f.id) {
          await client.query('DELETE FROM plantillas_mensaje WHERE id = $1', [Number(f.id)]);
          return json(res, 200, { ok: true });
        }
        if (!texto(f.titulo) || !texto(f.texto, 2000)) return json(res, 400, { error: 'Pon un título y el texto del mensaje.' });
        if (f.id) {
          await client.query('UPDATE plantillas_mensaje SET tipo = $1, titulo = $2, texto = $3 WHERE id = $4', [tipo, texto(f.titulo, 120), texto(f.texto, 2000), Number(f.id)]);
          // Las empresas que usan este mensaje reciben el texto nuevo.
          const usan = (await client.query("SELECT * FROM empresas WHERE pago->'plantillas' IS NOT NULL")).rows
            .filter(e => Object.values(e.pago.plantillas || {}).map(Number).includes(Number(f.id)));
          for (const e of usan) await aplicarPago(e).catch(() => {});
        } else {
          await client.query('INSERT INTO plantillas_mensaje (tipo, titulo, texto) VALUES ($1, $2, $3)', [tipo, texto(f.titulo, 120), texto(f.texto, 2000)]);
        }
        return json(res, 200, { ok: true });
      }

      // Demo de ventas
      if (url === '/api/central/demo' && req.method === 'GET') {
        const e = await demo();
        if (!e) return json(res, 200, { existe: false });
        const accesos = await conEmpresa(e, async db => (await db.query(
          "SELECT id, usuario, nombre, grupo, vence, nota, activo FROM usuarios WHERE vence IS NOT NULL ORDER BY vence DESC LIMIT 50")).rows).catch(() => []);
        return json(res, 200, { existe: true, url: urlDe(e), vivo: await responde(e), accesos });
      }
      if (url === '/api/central/demo/crear' && req.method === 'POST') {
        if (await demo()) return json(res, 400, { error: 'La demo ya existe.' });
        const r = await crearEmpresa(u, {}, true);
        return json(res, 200, r);
      }
      if (url === '/api/central/demo/reiniciar' && req.method === 'POST') {
        const e = await demo();
        if (!e) return json(res, 400, { error: 'Primero crea la demo.' });
        const n = await conEmpresa(e, db => sembrarDemo(db));
        await registrar(u, 'reiniciar_demo', 'empresa', 'demo', '', String(n), 'Datos de ejemplo reiniciados');
        return json(res, 200, { ok: true });
      }
      if (url === '/api/central/demo/acceso' && req.method === 'POST') {
        const e = await demo();
        if (!e) return json(res, 400, { error: 'Primero crea la demo.' });
        const f = await leerCuerpo(req);
        if (f.borrar) {
          await conEmpresa(e, db => db.query('DELETE FROM usuarios WHERE id = $1 AND vence IS NOT NULL', [Number(f.borrar)]));
          await registrar(u, 'borrar_acceso_demo', 'usuario', String(f.borrar), '', '', '');
          return json(res, 200, { ok: true });
        }
        const para = texto(f.nombre, 100);
        if (!para) return json(res, 400, { error: 'Escribe para quién es el acceso (ej.: Viajes del Mar - Pedro).' });
        const horas = Math.min(24 * 14, Math.max(1, Number(f.horas) || 48));
        const grupo = f.rol === 'asesora' ? 'Visitante asesora' : 'Visitante gerencia';
        const clave = claveAleatoria(10);
        const acceso = await conEmpresa(e, async db => {
          for (let i = 0; i < 5; i++) {
            const usuario = 'demo' + crypto.randomInt(1000, 9999);
            const r = await db.query(`INSERT INTO usuarios (usuario, nombre, grupo, empresa, password_hash, activo, debe_cambiar, permisos, vence, nota)
              VALUES ($1, $2, $3, 'todas', $4, TRUE, FALSE, '{}', NOW() + make_interval(hours => $5), $6)
              ON CONFLICT (usuario) DO NOTHING RETURNING usuario, vence`, [usuario, para, grupo, bcrypt.hashSync(clave, 10), horas, texto(f.nota, 200)]);
            if (r.rows[0]) return r.rows[0];
          }
          throw new Error('No se pudo crear el usuario. Intenta otra vez.');
        });
        await registrar(u, 'crear_acceso_demo', 'usuario', acceso.usuario, '', String(horas) + ' h', para);
        return json(res, 200, { ok: true, url: urlDe(e), usuario: acceso.usuario, clave, vence: acceso.vence });
      }

      return json(res, 404, { error: 'No encontrado' });
    } catch (err) {
      return json(res, err.codigo || 500, { error: err.message, campo: err.campo || '' });
    }
  }

  // Lo que usa Oficina (plataforma/oficina.js) para leer cada empresa sin repetir código.
  const ayudantes = { urlDe, responde, conEmpresa, leerAjustes, empresa, detalle, OPENROUTER, aplicarPago };
  return { activo, preparar, iniciar, manejar, manejarN8n, manejarWhatsapp, ayudantes, _probar: { alertasDe, revisarPlantilla, variablesDe, payloadPlantillaMeta } };
};
