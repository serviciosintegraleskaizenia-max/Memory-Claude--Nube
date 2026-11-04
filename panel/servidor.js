const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const nodemailer = require('nodemailer');
// Cada empresa tiene su propio archivo de ajustes (la pestaña Empresas lo crea); sin indicar, se usa config.js.
const config = require(process.env.PANEL_CONFIG ? require('path').resolve(process.env.PANEL_CONFIG) : './config');
const crearCuenta = require('./plataforma/cuenta');
const { revisarReservas } = require('./revision');
const crearCentral = require('./plataforma/central');
const crearMotor = require('./motor');

const client = new Client(config.db);
// Motor de correo dentro del panel (reemplaza al flujo de n8n cuando se active en config.js).
const motorCorreo = crearMotor({
  client, config, registrar: (...a) => registrar(...a), SISTEMA: { usuario: 'sistema', nombre: 'Sistema' },
  // La demo nunca lee buzones reales; y solo lee si la empresa tiene el módulo de correo.
  habilitado: async () => !config.demo && await cuenta.tiene('correo')
});

const ESTADOS = ['pendiente de transcribir', 'transcrita', 'registrada', 'revisar', 'sin accion', 'actualizada', 'historico'];
// Estados en los que una reserva todavía necesita trabajo (se reparte y cuenta tiempo).
const ESTADOS_ABIERTOS = ['pendiente de transcribir', 'revisar', 'actualizada'];
const SISTEMA = { usuario: 'sistema', nombre: 'Sistema' };
const cuenta = crearCuenta({ client, config, avisar: (...a) => avisar(...a), registrar: (...a) => registrar(...a), SISTEMA });
// Panel central de Kaizen IA (pestaña Empresas): solo si config.central.activo es true.
const central = crearCentral({ client, config, registrar: (...a) => registrar(...a), CARPETA: __dirname });
const ZONA_HORARIA = 'America/Santo_Domingo';
const PERMISOS = ['ver_reservas', 'cambiar_estado', 'responder_correo', 'enviar_correo', 'editar_reservas', 'ver_todas_empresas', 'administrar_usuarios', 'ver_auditoria', 'usar_chat', 'exportar_datos', 'ver_correo_completo', 'mostrar_imagenes', 'descargar_adjuntos', 'guardar_copia', 'recibir_reservas', 'supervisar', 'ver_control', 'configurar_empresa'];
const TODOS = Object.fromEntries(PERMISOS.map(p => [p, true]));
const NINGUNO = Object.fromEntries(PERMISOS.map(p => [p, false]));
// Sedes de la empresa (para separar usuarios por oficina). Sin ajuste: las de Somos Viajes.
const SEDES = Array.isArray(config.sedes) ? config.sedes : ['Republica Dominicana', 'Orlando'];
const EMPRESAS = ['todas', ...SEDES];
// En una misma PC cada panel va en otro puerto y el navegador comparte las cookies entre puertos:
// cada panel usa su propia cookie para que entrar a una empresa no cierre la sesión de otra.
const COOKIE = config.puerto === 3001 ? 'sesion' : 'sesion' + config.puerto;
const sesiones = new Map();
// Se pone en true cuando el panel terminó de preparar todas sus tablas (lo espera el panel central).
let panelListo = false;
const presencia = new Map();
const CARPETA = __dirname;
// Archivos propios de cada empresa (caché de correos): en su carpeta, no en la del programa.
const DATOS = config.carpetaDatos ? path.resolve(config.carpetaDatos) : CARPETA;
// Caché de correos completos: se puede vaciar en cualquier momento; si falta una copia, el correo se trae en vivo.
const CACHE = path.join(DATOS, 'cache-correos');
const CACHE_ARCHIVOS = path.join(CACHE, 'archivos');
// Adjuntos que se pueden abrir o descargar. Los demás (.exe, .js, .html...) se bloquean.
const TIPOS_ADJUNTO = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv'
};
const SE_ABREN = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
// Archivos que se pueden adjuntar al responder o enviar un correo (máximo 10 y 20 MB en total).
const SE_ADJUNTAN = new Set([...Object.keys(TIPOS_ADJUNTO), 'zip']);
const MAX_ADJUNTOS = 10;
const MAX_BYTES_ADJUNTOS = 20 * 1024 * 1024;
// Microsoft 365 acepta hasta unos 3 MB de adjuntos por correo en el envío simple.
const MAX_BYTES_MICROSOFT = 3 * 1024 * 1024;

const MINUTOS_SIN_LATIDO = 2;
const MINUTOS_AUSENTE = 5;
const MINUTOS_DESCONECTADO = 20;
const MINUTOS_REVISION = 15;
// Tiempo máximo por reserva: al pasarlo, el contador se pone rojo y se avisa a quienes tienen el permiso de control.
const MINUTOS_LIMITE_RESERVA = 25;
// Un tramo de trabajo sin señal del navegador por más de estos minutos se cierra en el último momento visto.
const MINUTOS_TRAMO_SIN_SENAL = 3;
// Historial: correos por página que se piden a Microsoft 365 y páginas por vuelta.
const HISTORICO_POR_PAGINA = 25;
const HISTORICO_PAGINAS_POR_VUELTA = 8;
// El flujo principal lee los últimos 2 días: el historial empieza justo antes.
const HISTORICO_DIAS_RECIENTES = 2;
const MAX_FALLOS_USUARIO = 5;
const MAX_FALLOS_IP = 20;
const MINUTOS_BLOQUEO = 15;
const fallosLogin = new Map();

const MESES = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };

async function inicializarTablas() {
  // Tablas base: en una empresa nueva (base vacía) el panel las crea solo. En Somos Viajes ya existen y no se tocan.
  await client.query(`CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    usuario VARCHAR(50) UNIQUE,
    nombre VARCHAR(100),
    grupo VARCHAR(50),
    empresa VARCHAR(50),
    password_hash TEXT,
    activo BOOLEAN DEFAULT TRUE,
    debe_cambiar BOOLEAN DEFAULT FALSE,
    permisos JSONB DEFAULT '{}'::jsonb)`);
  await client.query(`CREATE TABLE IF NOT EXISTS grupos (
    id SERIAL PRIMARY KEY,
    nombre VARCHAR(40) UNIQUE,
    permisos JSONB DEFAULT '{}'::jsonb,
    protegido BOOLEAN DEFAULT FALSE)`);
  // Sin ON CONFLICT: en bases antiguas la columna nombre puede no tener índice único.
  await client.query("INSERT INTO grupos (nombre, permisos, protegido) SELECT 'Programador', '{}', TRUE WHERE NOT EXISTS (SELECT 1 FROM grupos WHERE nombre = 'Programador')");
  await client.query(`CREATE TABLE IF NOT EXISTS auditoria (
    id SERIAL PRIMARY KEY,
    fecha TIMESTAMP DEFAULT NOW(),
    usuario TEXT, nombre TEXT, accion TEXT, entidad TEXT, entidad_id TEXT, anterior TEXT, nuevo TEXT, detalle TEXT)`);
  await client.query(`CREATE TABLE IF NOT EXISTS clasificacion (
    id SERIAL PRIMARY KEY,
    categoria TEXT, remitente TEXT, asunto TEXT, estado TEXT, fecha TEXT,
    creado TIMESTAMP DEFAULT NOW(),
    message_id TEXT, buzon TEXT, agencia TEXT, tipo_servicio TEXT, nombre_cliente TEXT, hora_servicio TEXT, vuelo TEXT,
    hotel TEXT, punto_partida TEXT, punto_llegada TEXT, fecha_servicio TEXT,
    adultos INTEGER, ninos INTEGER, infantes INTEGER, numero_servicio INTEGER,
    error_ia BOOLEAN DEFAULT FALSE, motivo TEXT, cuerpo TEXT, aeropuerto TEXT, actividad TEXT, telefono TEXT,
    aviso_procesado BOOLEAN NOT NULL DEFAULT FALSE)`);
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
  await client.query('ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS cache_dias INTEGER NOT NULL DEFAULT 30');
  // Pantalla de inicio de sesión personalizable: foto de fondo, título, subtítulo y redes sociales.
  await client.query('ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS fondo_login TEXT');
  await client.query("ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS login_titulo VARCHAR(80) NOT NULL DEFAULT ''");
  await client.query("ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS login_subtitulo VARCHAR(160) NOT NULL DEFAULT ''");
  await client.query("ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS redes JSONB NOT NULL DEFAULT '{}'::jsonb");
  await client.query('ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS copia_automatica BOOLEAN NOT NULL DEFAULT TRUE');
  await client.query(`CREATE TABLE IF NOT EXISTS correo_copia (
    message_id TEXT PRIMARY KEY,
    buzon TEXT NOT NULL,
    asunto TEXT NOT NULL DEFAULT '',
    de TEXT NOT NULL DEFAULT '',
    para TEXT NOT NULL DEFAULT '',
    cc TEXT NOT NULL DEFAULT '',
    fecha TEXT NOT NULL DEFAULT '',
    html TEXT NOT NULL DEFAULT '',
    automatica BOOLEAN NOT NULL DEFAULT FALSE,
    usuario VARCHAR(50) NOT NULL DEFAULT '',
    guardado TIMESTAMP NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS correo_adjunto (
    message_id TEXT NOT NULL,
    adjunto_id TEXT NOT NULL,
    nombre TEXT NOT NULL DEFAULT '',
    tipo TEXT NOT NULL DEFAULT '',
    tamano BIGINT NOT NULL DEFAULT 0,
    en_linea BOOLEAN NOT NULL DEFAULT FALSE,
    content_id TEXT NOT NULL DEFAULT '',
    hash VARCHAR(64),
    PRIMARY KEY (message_id, adjunto_id))`);
  await client.query(`CREATE TABLE IF NOT EXISTS avisos (
    id SERIAL PRIMARY KEY,
    para VARCHAR(50) NOT NULL,
    texto TEXT NOT NULL,
    reserva_id INTEGER,
    creado TIMESTAMP NOT NULL DEFAULT NOW(),
    leido BOOLEAN NOT NULL DEFAULT FALSE)`);
  await client.query(`CREATE TABLE IF NOT EXISTS agencias_conocidas (
    remitente VARCHAR(200) PRIMARY KEY,
    agencia VARCHAR(150) NOT NULL,
    usuario VARCHAR(50) NOT NULL,
    actualizado TIMESTAMP NOT NULL DEFAULT NOW())`);
  // Las filas que ya existían quedan como procesadas; solo las nuevas generan aviso.
  await client.query('ALTER TABLE clasificacion ADD COLUMN IF NOT EXISTS aviso_procesado BOOLEAN NOT NULL DEFAULT TRUE');
  await client.query('ALTER TABLE clasificacion ALTER COLUMN aviso_procesado SET DEFAULT FALSE');
  // Un mismo correo no se puede guardar dos veces aunque dos ejecuciones de n8n se crucen.
  try {
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS clasificacion_correo_unico
      ON clasificacion (message_id, numero_servicio) WHERE COALESCE(message_id, '') <> ''`);
  } catch (e) {
    console.log('Aviso: no se pudo crear la protección contra duplicados (¿hay correos repetidos?):', e.message);
  }

  // Hito 3: historial. Los correos importados quedan marcados aquí; cuando n8n los analiza y los vuelve
  // a guardar, la base de datos los deja como 'historico' y sin aviso (no se reparten ni suenan).
  await client.query(`CREATE TABLE IF NOT EXISTS correo_historico (
    message_id TEXT PRIMARY KEY,
    importado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS historico_importacion (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    buzon TEXT NOT NULL DEFAULT '',
    desde TEXT NOT NULL DEFAULT '',
    cursor TEXT NOT NULL DEFAULT '',
    activo BOOLEAN NOT NULL DEFAULT FALSE,
    terminado BOOLEAN NOT NULL DEFAULT FALSE,
    importados INTEGER NOT NULL DEFAULT 0,
    paginas INTEGER NOT NULL DEFAULT 0,
    ultimo_error TEXT NOT NULL DEFAULT '',
    usuario VARCHAR(50) NOT NULL DEFAULT '',
    iniciado TIMESTAMPTZ,
    actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  // El análisis con IA del historial cuesta dinero: empieza en pausa hasta que el programador lo active.
  await client.query('ALTER TABLE historico_importacion ADD COLUMN IF NOT EXISTS analizar BOOLEAN NOT NULL DEFAULT FALSE');
  await client.query(`CREATE OR REPLACE FUNCTION clasificacion_historico() RETURNS trigger AS $$
    BEGIN
      IF COALESCE(NEW.message_id, '') <> '' AND EXISTS (SELECT 1 FROM correo_historico h WHERE h.message_id = NEW.message_id) THEN
        NEW.estado := 'historico';
        NEW.aviso_procesado := TRUE;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await client.query('DROP TRIGGER IF EXISTS clasificacion_historico ON clasificacion');
  await client.query(`CREATE TRIGGER clasificacion_historico BEFORE INSERT ON clasificacion
    FOR EACH ROW EXECUTE PROCEDURE clasificacion_historico()`);
  // Reanálisis seguro: las filas viejas con error de un correo se borran justo cuando llega su análisis nuevo
  // (en el mismo guardado), no antes. Si la IA o n8n fallan a mitad, el correo sigue marcado y se reintenta.
  await client.query(`CREATE OR REPLACE FUNCTION clasificacion_reemplazo() RETURNS trigger AS $$
    BEGIN
      IF COALESCE(NEW.message_id, '') <> '' THEN
        DELETE FROM clasificacion c
        WHERE c.message_id = NEW.message_id AND c.error_ia = TRUE AND c.creado < COALESCE(NEW.creado, NOW());
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await client.query('DROP TRIGGER IF EXISTS clasificacion_reemplazo ON clasificacion');
  await client.query(`CREATE TRIGGER clasificacion_reemplazo BEFORE INSERT ON clasificacion
    FOR EACH ROW EXECUTE PROCEDURE clasificacion_reemplazo()`);
  await client.query('CREATE INDEX IF NOT EXISTS clasificacion_estado ON clasificacion (estado)');
  await client.query("CREATE INDEX IF NOT EXISTS clasificacion_clave ON clasificacion ((COALESCE(NULLIF(message_id, ''), 'id:' || id)))");

  // Hito 4: reparto. Se asigna el correo completo (todos sus servicios) a un asesor.
  await client.query(`CREATE TABLE IF NOT EXISTS asignaciones (
    clave TEXT PRIMARY KEY,
    usuario VARCHAR(50) NOT NULL,
    por VARCHAR(50) NOT NULL DEFAULT 'sistema',
    asignado_en TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query('CREATE INDEX IF NOT EXISTS asignaciones_usuario ON asignaciones (usuario)');
  await client.query('ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS reparto_activo BOOLEAN NOT NULL DEFAULT TRUE');
  await client.query('ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS reparto_desde TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  // Reparto por cupos: cuántas reservas por día le tocan a cada persona (modo 'cupos').
  await client.query("ALTER TABLE empresa_datos ADD COLUMN IF NOT EXISTS reparto_modo VARCHAR(12) NOT NULL DEFAULT 'automatico'");
  await client.query(`CREATE TABLE IF NOT EXISTS reparto_cupos (
    usuario VARCHAR(50) PRIMARY KEY,
    cupo INTEGER NOT NULL DEFAULT 0,
    actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

  // Hito 5: tiempo por reserva. Cada vez que alguien la tiene abierta es un tramo (inicio a fin).
  await client.query(`CREATE TABLE IF NOT EXISTS tiempo_reserva (
    id SERIAL PRIMARY KEY,
    reserva_id INTEGER NOT NULL,
    usuario VARCHAR(50) NOT NULL,
    inicio TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    visto TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fin TIMESTAMPTZ)`);
  await client.query('CREATE INDEX IF NOT EXISTS tiempo_reserva_reserva ON tiempo_reserva (reserva_id)');
  await client.query('CREATE INDEX IF NOT EXISTS tiempo_reserva_usuario ON tiempo_reserva (usuario, inicio)');
  // Alertas de fallos: n8n escribe aquí en cada ejecución (nodo "Reintentar fallidos"); el panel vigila.
  await client.query(`CREATE TABLE IF NOT EXISTS salud_n8n (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    visto TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await client.query(`CREATE TABLE IF NOT EXISTS alertas (
    id SERIAL PRIMARY KEY,
    clave VARCHAR(30) NOT NULL,
    texto TEXT NOT NULL,
    correo TEXT NOT NULL DEFAULT '',
    creada TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resuelta TIMESTAMPTZ)`);
  await client.query(`CREATE TABLE IF NOT EXISTS tiempo_aviso (
    reserva_id INTEGER PRIMARY KEY,
    creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
}

client.connect()
  .then(inicializarTablas)
  // Las partes nuevas no pueden tumbar el panel: si una falla, se anota y el resto sigue funcionando.
  .then(() => cuenta.preparar().catch(e => console.log('Cuenta (módulos y avisos):', e.message)))
  .then(() => motorCorreo.preparar().catch(e => console.log('Motor de correo:', e.message)))
  .then(() => central.preparar().catch(e => console.log('Panel central:', e.message)))
  .then(() => {
    motorCorreo.iniciar();
    central.iniciar();
    setTimeout(() => cuenta.revisarPago().catch(e => console.log('Pago:', e.message)), 30 * 1000);
    setInterval(() => cuenta.revisarPago().catch(e => console.log('Pago:', e.message)), 60 * 60 * 1000);
    setInterval(() => cuenta.desactivarVencidos().catch(e => console.log('Accesos:', e.message)), 60 * 1000);
    if (config.demo) setInterval(() => reiniciarDemoDeMadrugada().catch(e => console.log('Demo:', e.message)), 10 * 60 * 1000);
    procesarModificaciones();
    setInterval(procesarModificaciones, 30 * 1000);
    setTimeout(mantenerCache, 60 * 1000);
    setInterval(mantenerCache, 10 * 60 * 1000);
    setInterval(revisarTiempos, 30 * 1000);
    setInterval(repartir, 10 * 1000);
    setInterval(importarHistorico, 20 * 1000);
    setTimeout(revisarSalud, 60 * 1000);
    setTimeout(() => avisarArranqueDelVigilante().catch(e => console.log('Aviso de arranque:', e.message)), 20 * 1000);
    setInterval(revisarSalud, 5 * 60 * 1000);
    panelListo = true;
  })
  .catch(e => console.log('Error preparando tablas:', e.message));

// Demo de ventas: cada día después de las 3:00 a. m. los datos de ejemplo vuelven a empezar (fechas de hoy).
async function reiniciarDemoDeMadrugada() {
  const { sembrarDemo } = require('./plataforma/demo');
  const { hoyLocal } = require('./plataforma/cuenta');
  const hoy = hoyLocal();
  const hora = Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONA_HORARIA, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (hora < 3) return;
  const c = (await client.query('SELECT demo_dia FROM cuenta WHERE id = 1')).rows[0];
  if (c && c.demo_dia === hoy) return;
  await client.query('UPDATE cuenta SET demo_dia = $1 WHERE id = 1', [hoy]);
  await sembrarDemo(client);
  await registrar(SISTEMA, 'reiniciar_demo', 'empresa', 'demo', '', hoy, 'Reinicio automático de la madrugada');
}

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

/* ---------- Correo completo (Microsoft 365) y caché ---------- */

// Buzón que responde por Microsoft 365. Si el buzón tiene cuenta SMTP en config.correo (Gmail, dominio propio), va por SMTP.
function esMicrosoft(buzon) {
  return Boolean(buzon) && !/@gmail\.com$/i.test(buzon) && !(config.correo || {})[buzon];
}

function extension(nombre) {
  const m = String(nombre || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

// Llama a un flujo de n8n (webhook) y devuelve su respuesta { ok: true, ... }.
async function llamarN8n(clave, datos, flujo) {
  const destino = config.n8n && config.n8n[clave];
  if (!destino) throw new Error(`Falta configurar n8n.${clave} en config.js.`);
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), 60 * 1000);
  try {
    const r = await fetch(destino, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos),
      signal: control.signal
    });
    if (!r.ok) throw new Error(`n8n respondió ${r.status}. ¿Está activo el flujo "${flujo}"?`);
    const respuesta = await r.json();
    if (!respuesta || respuesta.ok !== true) throw new Error((respuesta && respuesta.error) || `El flujo "${flujo}" no respondió bien.`);
    return respuesta;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Microsoft 365 tardó demasiado en responder.');
    if (e.cause && e.cause.code === 'ECONNREFUSED') throw new Error('No se pudo conectar con n8n. ¿Está encendido?');
    throw e;
  } finally {
    clearTimeout(reloj);
  }
}

// Pide a n8n el correo (o un adjunto) en vivo desde Microsoft 365.
function pedirCorreoEnVivo(datos) {
  return llamarN8n('correoCompleto', datos, 'Correo completo');
}

// Buzones de Microsoft 365 desde los que se envía por n8n (flujo "Enviar correo").
function buzonesMicrosoftEnvio() {
  return config.n8n && config.n8n.enviarCorreo ? (config.n8n.buzonesMicrosoft || []) : [];
}

function enviarPorMicrosoft(datos, adjuntos) {
  if (config.demo) return Promise.resolve({ ok: true, demo: true });
  const total = adjuntos.reduce((s, a) => s + a.content.length, 0);
  if (total > MAX_BYTES_MICROSOFT) {
    throw Object.assign(new Error('Desde Microsoft 365 los adjuntos no pueden pasar de 3 MB en total por correo.'), { codigo: 400 });
  }
  return llamarN8n('enviarCorreo', { ...datos, adjuntos: adjuntos.map(a => ({ nombre: a.filename, datos: a.content.toString('base64') })) }, 'Enviar correo');
}

// Envía por SMTP (cuentas de config.correo) con un mensaje claro si la cuenta rechaza la clave.
async function enviarPorSmtp(salida, mensaje) {
  if (config.demo) return;
  try {
    await salida.transporte.sendMail(mensaje);
  } catch (e) {
    if (e.responseCode === 535 || /Username and Password not accepted|BadCredentials/i.test(e.message)) {
      throw Object.assign(new Error('La cuenta de correo rechazó la clave. En Gmail hace falta una "contraseña de aplicación" en config.js.'), { codigo: 400 });
    }
    throw new Error('No se pudo enviar el correo: ' + e.message);
  }
}

function rutaArchivo(hash) {
  if (!/^[a-f0-9]{64}$/.test(hash || '')) return null;
  return path.join(CACHE_ARCHIVOS, hash);
}

// Guarda los bytes una sola vez por contenido (las firmas repetidas no ocupan más espacio).
function guardarArchivo(base64) {
  const datos = Buffer.from(base64, 'base64');
  const hash = crypto.createHash('sha256').update(datos).digest('hex');
  const ruta = rutaArchivo(hash);
  if (!fs.existsSync(ruta)) {
    fs.mkdirSync(CACHE_ARCHIVOS, { recursive: true });
    const avisoCache = path.join(CACHE, 'LEEME.txt');
    if (!fs.existsSync(avisoCache)) {
      fs.writeFileSync(avisoCache, 'Esta carpeta es CACHÉ del panel: copias de correos y adjuntos.\r\n' +
        'Se puede vaciar desde Herramientas > Caché de correos. Si se borra, el panel trae los correos en vivo de Microsoft 365.\r\n');
    }
    fs.writeFileSync(ruta, datos);
  }
  return hash;
}

async function guardarCopia(fila, correo, automatica, usuario) {
  const adjuntos = (correo.adjuntos || []).map(a => ({ ...a, hash: a.datos ? guardarArchivo(a.datos) : null }));
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM correo_adjunto WHERE message_id = $1', [fila.message_id]);
    await client.query(
      `INSERT INTO correo_copia (message_id, buzon, asunto, de, para, cc, fecha, html, automatica, usuario, guardado)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (message_id) DO UPDATE SET asunto = EXCLUDED.asunto, de = EXCLUDED.de, para = EXCLUDED.para, cc = EXCLUDED.cc,
         fecha = EXCLUDED.fecha, html = EXCLUDED.html, automatica = EXCLUDED.automatica, usuario = EXCLUDED.usuario, guardado = NOW()`,
      [fila.message_id, fila.buzon, correo.asunto || '', JSON.stringify(correo.de || null), JSON.stringify(correo.para || []),
        JSON.stringify(correo.cc || []), correo.fecha || '', correo.html || '', automatica, usuario]
    );
    for (const a of adjuntos) {
      await client.query(
        `INSERT INTO correo_adjunto (message_id, adjunto_id, nombre, tipo, tamano, en_linea, content_id, hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fila.message_id, a.id, a.nombre || '', a.tipo || '', Number(a.tamano) || 0, Boolean(a.inline), a.contentId || '', a.hash]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

// Lee la copia guardada. Si falta algún archivo (la caché se vació a mano), devuelve null y se trae en vivo.
async function leerCopia(messageId) {
  const copia = (await client.query('SELECT * FROM correo_copia WHERE message_id = $1', [messageId])).rows[0];
  if (!copia) return null;
  const filas = (await client.query('SELECT * FROM correo_adjunto WHERE message_id = $1 ORDER BY nombre', [messageId])).rows;
  const adjuntos = [];
  for (const a of filas) {
    const ruta = a.hash ? rutaArchivo(a.hash) : null;
    if (a.en_linea && (!ruta || !fs.existsSync(ruta))) return null;
    adjuntos.push({
      id: a.adjunto_id, nombre: a.nombre, tipo: a.tipo, tamano: Number(a.tamano), inline: a.en_linea, contentId: a.content_id,
      datos: a.en_linea ? fs.readFileSync(ruta).toString('base64') : ''
    });
  }
  const leer = t => { try { return JSON.parse(t); } catch (e) { return null; } };
  return {
    asunto: copia.asunto, de: leer(copia.de), para: leer(copia.para) || [], cc: leer(copia.cc) || [], fecha: copia.fecha,
    html: copia.html, adjuntos, guardado: copia.guardado, automatica: copia.automatica
  };
}

// Prepara el correo para el navegador: imágenes del cuerpo como datos, sin scripts ni redirecciones.
function correoParaPanel(correo, origen) {
  const enLinea = new Map();
  for (const a of correo.adjuntos || []) {
    if (a.inline && a.contentId && a.datos) {
      const tipo = /^image\/[a-z0-9.+-]+$/i.test(a.tipo) ? a.tipo : 'image/png';
      enLinea.set(a.contentId.replace(/^<|>$/g, '').toLowerCase(), `data:${tipo};base64,${a.datos}`);
    }
  }
  const html = String(correo.html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]+http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/(["'(])cid:([^"')\s>]+)/gi, (todo, antes, cid) => antes + (enLinea.get(cid.toLowerCase()) || ''));
  return {
    origen,
    guardado: correo.guardado || null,
    asunto: correo.asunto || '',
    de: correo.de || null,
    para: correo.para || [],
    cc: correo.cc || [],
    fecha: correo.fecha || '',
    html,
    imagenesExternas: /\b(?:src|background)\s*=\s*["']?\s*https?:|url\(\s*["']?https?:/i.test(html),
    adjuntos: (correo.adjuntos || []).filter(a => !a.inline).map(a => ({
      id: a.id, nombre: a.nombre, tamano: a.tamano,
      permitido: Boolean(TIPOS_ADJUNTO[extension(a.nombre)]),
      seAbre: SE_ABREN.includes(extension(a.nombre))
    }))
  };
}

function tamanoCarpeta(carpeta) {
  if (!fs.existsSync(carpeta)) return { archivos: 0, bytes: 0 };
  let archivos = 0, bytes = 0;
  for (const nombre of fs.readdirSync(carpeta)) {
    const st = fs.statSync(path.join(carpeta, nombre));
    if (st.isFile()) { archivos += 1; bytes += st.size; }
  }
  return { archivos, bytes };
}

// Borra los archivos que ya no usa ninguna copia.
async function limpiarArchivosSueltos() {
  if (!fs.existsSync(CACHE_ARCHIVOS)) return;
  const usados = new Set((await client.query('SELECT DISTINCT hash FROM correo_adjunto WHERE hash IS NOT NULL')).rows.map(x => x.hash));
  for (const nombre of fs.readdirSync(CACHE_ARCHIVOS)) {
    if (/^[a-f0-9]{64}$/.test(nombre) && !usados.has(nombre)) fs.unlinkSync(path.join(CACHE_ARCHIVOS, nombre));
  }
}

async function borrarCopias(dias) {
  const r = dias === null
    ? await client.query('DELETE FROM correo_copia RETURNING message_id')
    : await client.query(`DELETE FROM correo_copia WHERE guardado < NOW() - ($1 || ' days')::interval RETURNING message_id`, [String(dias)]);
  const ids = r.rows.map(x => x.message_id);
  if (ids.length) await client.query('DELETE FROM correo_adjunto WHERE message_id = ANY($1::text[])', [ids]);
  await limpiarArchivosSueltos();
  return ids.length;
}

// Cada 10 minutos: borra copias vencidas y guarda copia de reservas y cambios recientes de Microsoft 365.
const fallosCopia = new Map();
let manteniendoCache = false;
async function mantenerCache() {
  if (manteniendoCache) return;
  manteniendoCache = true;
  try {
    const ajustes = (await client.query('SELECT cache_dias, copia_automatica FROM empresa_datos WHERE id = 1')).rows[0];
    if (!ajustes) return;
    await borrarCopias(ajustes.cache_dias);
    if (!ajustes.copia_automatica || !config.n8n || !config.n8n.correoCompleto) return;
    const pendientes = (await client.query(
      `SELECT DISTINCT ON (c.message_id) c.message_id, c.buzon FROM clasificacion c
       WHERE c.categoria IN ('RESERVA', 'MODIFICACION') AND c.error_ia IS NOT TRUE
         AND COALESCE(c.message_id, '') <> '' AND c.buzon NOT ILIKE '%@gmail.com'
         AND c.creado > NOW() - ($1 || ' days')::interval AND c.estado <> 'historico'
         AND NOT EXISTS (SELECT 1 FROM correo_copia k WHERE k.message_id = c.message_id)
       ORDER BY c.message_id`, [String(ajustes.cache_dias)]
    )).rows.filter(f => (fallosCopia.get(f.message_id) || 0) < 3).slice(0, 10);
    for (const fila of pendientes) {
      try {
        const correo = await pedirCorreoEnVivo({ accion: 'correo', message_id: fila.message_id, buzon: fila.buzon, incluir_adjuntos: true });
        await guardarCopia(fila, correo, true, 'sistema');
      } catch (e) {
        fallosCopia.set(fila.message_id, (fallosCopia.get(fila.message_id) || 0) + 1);
        console.log('No se pudo guardar copia automática:', e.message);
      }
    }
  } catch (e) {
    console.log('Error manteniendo la caché de correos:', e.message);
  } finally {
    manteniendoCache = false;
  }
}

function enviarArchivo(res, datos, nombre, abrir) {
  const ext = extension(nombre);
  const tipo = abrir && SE_ABREN.includes(ext) ? TIPOS_ADJUNTO[ext] : 'application/octet-stream';
  const seguro = String(nombre || 'adjunto').replace(/[\r\n"\\]/g, '_');
  const cabeceras = {
    'Content-Type': tipo,
    'Content-Length': datos.length,
    'Content-Disposition': `${abrir ? 'inline' : 'attachment'}; filename="${seguro.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(seguro)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store'
  };
  // El visor de PDF del navegador necesita su propia política; a las imágenes se les cierra todo.
  if (ext !== 'pdf') cabeceras['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
  res.writeHead(200, cabeceras);
  res.end(datos);
}

function adjuntosParaEnviar(lista) {
  if (lista === undefined || lista === null) return { adjuntos: [] };
  if (!Array.isArray(lista) || lista.length > MAX_ADJUNTOS) return { error: `Puedes adjuntar hasta ${MAX_ADJUNTOS} archivos.` };
  let total = 0;
  const adjuntos = [];
  for (const a of lista) {
    const nombre = String((a && a.nombre) || '').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 150);
    if (!nombre || !SE_ADJUNTAN.has(extension(nombre))) {
      return { error: `El archivo "${nombre || 'sin nombre'}" no se puede adjuntar por seguridad.` };
    }
    if (typeof a.datos !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(a.datos)) return { error: `El archivo "${nombre}" llegó dañado.` };
    const contenido = Buffer.from(a.datos, 'base64');
    total += contenido.length;
    if (total > MAX_BYTES_ADJUNTOS) return { error: 'Los adjuntos no pueden pasar de 20 MB en total.' };
    adjuntos.push({ filename: nombre, content: contenido });
  }
  return { adjuntos };
}

function imagenValida(s, maximo = 3000000) {
  return typeof s === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(s) && s.length <= maximo;
}
// La foto de fondo del login puede pesar más (hasta ~4 MB).
const MAX_FONDO = 5600000;
const REDES = ['instagram', 'facebook', 'whatsapp', 'tiktok', 'web'];
// Convierte lo que escriba el usuario en un enlace válido (ej.: "@somosviajes", "8095550000", "somosviajes.com").
function enlaceRed(red, valor) {
  const v = String(valor || '').trim().slice(0, 200);
  if (!v) return '';
  if (/^https?:\/\/\S+$/i.test(v)) return v;
  if (red === 'whatsapp') { const n = v.replace(/\D/g, ''); return n.length >= 8 ? 'https://wa.me/' + n : ''; }
  if (red === 'instagram' && /^@?[\w.]{2,40}$/.test(v) && !/\.[a-z]{2,}$/i.test(v)) return 'https://instagram.com/' + v.replace(/^@/, '');
  if (red === 'tiktok' && /^@?[\w.]{2,40}$/.test(v) && !/\.[a-z]{2,}$/i.test(v)) return 'https://www.tiktok.com/@' + v.replace(/^@/, '');
  if (red === 'facebook' && /^[\w]{2,60}$/.test(v)) return 'https://facebook.com/' + v;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return 'https://' + v;
  return '';
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

function fechaOrden(x) {
  const t = Date.parse(x.fecha);
  return isNaN(t) ? 0 : t;
}

// Reservas agrupadas por nombre de cliente, para encontrar rápido la original de un cambio.
function indiceReservas(reservas) {
  const indice = new Map();
  for (const x of reservas) {
    const clave = normalizarNombre(x.nombre_cliente);
    if (!clave) continue;
    if (!indice.has(clave)) indice.set(clave, []);
    indice.get(clave).push(x);
  }
  return indice;
}

// La reserva original de una modificación: la última RESERVA del mismo cliente recibida antes.
// Se ordena por fecha de recibido (no por número), porque el historial importado tiene números más altos.
function originalDe(mod, indice) {
  const lista = indice.get(normalizarNombre(mod.nombre_cliente));
  if (!lista) return null;
  const fm = fechaOrden(mod);
  let original = null;
  let fo = 0;
  for (const x of lista) {
    if (x.id === mod.id || (mod.message_id && x.message_id === mod.message_id)) continue;
    const fx = fechaOrden(x);
    if (!(fx < fm || (fx === fm && x.id < mod.id))) continue;
    if (!original || fx > fo || (fx === fo && x.id > original.id)) {
      original = x;
      fo = fx;
    }
  }
  return original;
}

async function quienTrabaja(ids) {
  const abierta = await client.query(
    'SELECT usuario FROM revisiones WHERE reserva_id = ANY($1::int[]) ORDER BY actualizado DESC LIMIT 1', [ids]
  );
  if (abierta.rows[0]) return abierta.rows[0].usuario;
  const ultima = await client.query(
    `SELECT usuario FROM auditoria
     WHERE entidad = 'reserva' AND entidad_id = ANY($1::text[]) AND usuario <> 'sistema'
       AND accion IN ('abrir_reserva', 'cambiar_estado', 'responder_correo')
     ORDER BY fecha DESC, id DESC LIMIT 1`,
    [ids.map(String)]
  );
  return ultima.rows[0] ? ultima.rows[0].usuario : null;
}

// Cuando llega un cambio a una reserva, la original pasa a "actualizada" y se avisa a quien la trabaja.
let procesandoModificaciones = false;
async function procesarModificaciones() {
  if (procesandoModificaciones) return;
  procesandoModificaciones = true;
  try {
    const mods = (await client.query(
      "SELECT id, nombre_cliente, message_id, fecha FROM clasificacion WHERE categoria = 'MODIFICACION' AND aviso_procesado = FALSE ORDER BY id"
    )).rows;
    if (!mods.length) return;
    const reservas = (await client.query(
      "SELECT id, nombre_cliente, message_id, estado, fecha FROM clasificacion WHERE categoria = 'RESERVA' ORDER BY id DESC LIMIT 50000"
    )).rows;
    const indice = indiceReservas(reservas);
    const vistos = new Set();
    for (const mod of mods) {
      if (mod.message_id && vistos.has(mod.message_id)) continue;
      if (mod.message_id) vistos.add(mod.message_id);
      const original = originalDe(mod, indice);
      if (original) {
        const ids = reservas
          .filter(x => original.message_id ? x.message_id === original.message_id : x.id === original.id)
          .map(x => x.id);
        const quien = await quienTrabaja(ids);
        await client.query("UPDATE clasificacion SET estado = 'actualizada' WHERE id = ANY($1::int[])", [ids]);
        if (quien) {
          await client.query('INSERT INTO avisos (para, texto, reserva_id) VALUES ($1, $2, $3)', [
            quien,
            `Llegó un cambio para la reserva de ${original.nombre_cliente} (#${original.id}). Revisa el correo #${mod.id} antes de seguir.`,
            original.id
          ]);
        }
        await registrar(SISTEMA, 'modificacion_recibida', 'reserva', original.id, original.estado, 'actualizada',
          'Cambio en el correo #' + mod.id + (quien ? '. Aviso a ' + quien : '. Nadie la tenía abierta'));
      }
      await client.query(
        'UPDATE clasificacion SET aviso_procesado = TRUE WHERE id = $1 OR (message_id IS NOT NULL AND message_id = $2)',
        [mod.id, mod.message_id]
      );
    }
  } catch (e) {
    console.log('Error procesando modificaciones:', e.message);
  } finally {
    procesandoModificaciones = false;
  }
}

// Día (AAAA-MM-DD) en hora de República Dominicana de un texto de fecha; vacío si no se entiende.
function diaLocal(texto) {
  const d = new Date(texto);
  return isNaN(d) ? '' : d.toLocaleDateString('sv-SE', { timeZone: ZONA_HORARIA });
}

function filtrarPermisos(p) {
  return Object.fromEntries(PERMISOS.map(k => [k, k !== 'administrar_usuarios' && Boolean(p && p[k])]));
}

// IP real de quien entra. Si la conexión viene de esta misma máquina (Cloudflare Tunnel o el proxy
// del servidor), se usa la IP que ese intermediario informa; si no, la de la conexión.
// Así el bloqueo por intentos fallidos no bloquea a todos a la vez detrás del túnel.
function esLocal(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}
function ipCliente(req) {
  if (esLocal(req)) {
    const reenviada = String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
    if (/^[0-9a-fA-F.:]{3,45}$/.test(reenviada)) return reenviada;
  }
  return (req.socket.remoteAddress || 'desconocida').replace('::ffff:', '');
}
// Si se entró por HTTPS (túnel o proxy), la cookie de sesión solo viaja cifrada.
function cookieSegura(req) {
  return esLocal(req) && (req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(String(req.headers['cf-visitor'] || ''))) ? '; Secure' : '';
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

const MAX_CUERPO = 30 * 1024 * 1024;

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > MAX_CUERPO) {
        req.destroy();
        reject(new Error('El envío es demasiado grande.'));
      }
    });
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
    // Las páginas del panel no se guardan en el navegador: tras una actualización se ve siempre la versión nueva.
    const cabeceras = { 'Content-Type': tipo };
    if (/text\/html/.test(tipo)) cabeceras['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, cabeceras);
    res.end(data);
  });
}

async function mapaGrupos() {
  const r = await client.query('SELECT nombre, permisos FROM grupos');
  return new Map(r.rows.map(g => [g.nombre, { ...NINGUNO, ...g.permisos }]));
}

// Crear y editar usuarios es solo del Programador: no se puede dar por grupo ni por usuario
// (igual que Estado del sistema, Historial, Grupos, Bloqueos y Empresas).
function permisosDe(u, mapa) {
  if (u.grupo === 'Programador') return { ...TODOS };
  return { ...NINGUNO, ...(mapa.get(u.grupo) || {}), ...(u.permisos || {}), administrar_usuarios: false };
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

/* ---------- Usuarios por permiso ---------- */

async function usuariosConPermiso(permiso) {
  const mapa = await mapaGrupos();
  const r = await client.query('SELECT usuario, nombre, grupo, permisos FROM usuarios WHERE activo = TRUE');
  return r.rows.filter(x => permisosDe(x, mapa)[permiso]);
}

// Clave de un correo: todos sus servicios (filas) comparten la asignación.
const CLAVE_SQL = "COALESCE(NULLIF(c.message_id, ''), 'id:' || c.id)";
function claveDe(x) {
  return x.message_id ? x.message_id : 'id:' + x.id;
}

async function avisar(usuarios, texto, reservaId) {
  for (const para of new Set(usuarios)) {
    await client.query('INSERT INTO avisos (para, texto, reserva_id) VALUES ($1, $2, $3)', [para, texto, reservaId || null]);
  }
}

/* ---------- Hito 5: tiempo por reserva ---------- */

function cuentaTiempo(fila) {
  return Boolean(fila) && ['RESERVA', 'MODIFICACION'].includes(fila.categoria) && ESTADOS_ABIERTOS.includes(fila.estado);
}

async function tiempoReserva(reservaId, usuario) {
  const r = (await client.query(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(fin, NOW()) - inicio))), 0)::float AS segundos,
            COALESCE(BOOL_OR(fin IS NULL AND usuario = $2), FALSE) AS corriendo
     FROM tiempo_reserva WHERE reserva_id = $1`, [reservaId, usuario || '']
  )).rows[0];
  return { segundos: Math.max(0, Math.round(r.segundos)), corriendo: r.corriendo, limite: MINUTOS_LIMITE_RESERVA * 60 };
}

// Abre o mantiene el tramo de trabajo de este usuario. Si está inactivo, el tramo se deja cerrar solo.
async function marcarTramo(reservaId, usuario, activo) {
  const abierto = (await client.query(
    'SELECT id FROM tiempo_reserva WHERE reserva_id = $1 AND usuario = $2 AND fin IS NULL ORDER BY id DESC LIMIT 1',
    [reservaId, usuario]
  )).rows[0];
  if (!activo) return;
  if (abierto) await client.query('UPDATE tiempo_reserva SET visto = NOW() WHERE id = $1', [abierto.id]);
  else await client.query('INSERT INTO tiempo_reserva (reserva_id, usuario) VALUES ($1, $2)', [reservaId, usuario]);
}

async function cerrarTramos(reservaId, usuario) {
  if (usuario) {
    await client.query('UPDATE tiempo_reserva SET fin = NOW(), visto = NOW() WHERE reserva_id = $1 AND usuario = $2 AND fin IS NULL', [reservaId, usuario]);
  } else {
    await client.query('UPDATE tiempo_reserva SET fin = NOW(), visto = NOW() WHERE reserva_id = $1 AND fin IS NULL', [reservaId]);
  }
}

// Cada 30 segundos: cierra tramos sin señal y avisa de las reservas que pasan de 25 minutos.
let revisandoTiempos = false;
async function revisarTiempos() {
  if (revisandoTiempos) return;
  revisandoTiempos = true;
  try {
    await client.query(
      `UPDATE tiempo_reserva SET fin = visto WHERE fin IS NULL AND visto < NOW() - ($1 || ' minutes')::interval`,
      [String(MINUTOS_TRAMO_SIN_SENAL)]
    );
    // Si la reserva ya no está abierta (registrada, borrada al reanalizar...), su tramo termina.
    await client.query(
      `UPDATE tiempo_reserva t SET fin = NOW(), visto = NOW() WHERE t.fin IS NULL AND NOT EXISTS (
         SELECT 1 FROM clasificacion c WHERE c.id = t.reserva_id AND c.estado = ANY($1::text[]))`,
      [ESTADOS_ABIERTOS]
    );
    const pasadas = (await client.query(
      `SELECT t.reserva_id, SUM(EXTRACT(EPOCH FROM (COALESCE(t.fin, t.visto) - t.inicio)))::float AS segundos
       FROM tiempo_reserva t JOIN clasificacion c ON c.id = t.reserva_id
       WHERE c.estado = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM tiempo_aviso a WHERE a.reserva_id = t.reserva_id)
       GROUP BY t.reserva_id HAVING SUM(EXTRACT(EPOCH FROM (COALESCE(t.fin, t.visto) - t.inicio))) > $2`,
      [ESTADOS_ABIERTOS, MINUTOS_LIMITE_RESERVA * 60]
    )).rows;
    if (!pasadas.length) return;
    const jefes = (await usuariosConPermiso('ver_control')).map(x => x.usuario);
    for (const p of pasadas) {
      const nueva = await client.query('INSERT INTO tiempo_aviso (reserva_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING reserva_id', [p.reserva_id]);
      if (!nueva.rowCount) continue;
      const info = (await client.query(
        `SELECT c.nombre_cliente, c.asunto, t.usuario, COALESCE(u.nombre, t.usuario) AS nombre
         FROM clasificacion c
         LEFT JOIN LATERAL (SELECT usuario FROM tiempo_reserva WHERE reserva_id = c.id ORDER BY visto DESC LIMIT 1) t ON TRUE
         LEFT JOIN usuarios u ON u.usuario = t.usuario
         WHERE c.id = $1`, [p.reserva_id]
      )).rows[0] || {};
      const cliente = info.nombre_cliente || info.asunto || 'sin nombre';
      await avisar(jefes,
        `⏱ ${info.nombre || 'Un asesor'} lleva más de ${MINUTOS_LIMITE_RESERVA} minutos con la reserva de ${cliente} (#${p.reserva_id}).`,
        p.reserva_id);
      await registrar(SISTEMA, 'reserva_pasada_de_tiempo', 'reserva', p.reserva_id, '', Math.round(p.segundos / 60) + ' min',
        (info.nombre || '') + ' · ' + cliente);
    }
  } catch (e) {
    console.log('Error revisando tiempos:', e.message);
  } finally {
    revisandoTiempos = false;
  }
}

/* ---------- Hito 4: reparto automático entre asesores conectados ---------- */

async function ajustesReparto() {
  return (await client.query('SELECT reparto_activo, reparto_desde, reparto_modo FROM empresa_datos WHERE id = 1')).rows[0]
    || { reparto_activo: false, reparto_desde: new Date(), reparto_modo: 'automatico' };
}

// Quienes reciben reservas: permiso "Recibir reservas" (el programador no entra en el reparto).
async function receptores() {
  return (await usuariosConPermiso('recibir_reservas')).filter(x => x.grupo !== 'Programador');
}

// Reservas abiertas que tiene cada asesor ahora mismo.
async function cargaDeAsesores() {
  const r = await client.query(
    `SELECT a.usuario, COUNT(DISTINCT a.clave)::int AS carga, MAX(a.asignado_en) AS ultima
     FROM asignaciones a
     WHERE EXISTS (SELECT 1 FROM clasificacion c WHERE ${CLAVE_SQL} = a.clave AND c.estado = ANY($1::text[]))
     GROUP BY a.usuario`, [ESTADOS_ABIERTOS]
  );
  return new Map(r.rows.map(x => [x.usuario, { carga: x.carga, ultima: x.ultima ? new Date(x.ultima).getTime() : 0 }]));
}

// Cupo diario de cada persona y cuántas reservas (correos) se le asignaron hoy (hora de RD).
async function cuposDeHoy() {
  const cupos = new Map((await client.query('SELECT usuario, cupo FROM reparto_cupos WHERE cupo > 0')).rows.map(x => [x.usuario, x.cupo]));
  const hoy = new Map((await client.query(
    `SELECT usuario, COUNT(DISTINCT clave)::int AS n FROM asignaciones
     WHERE asignado_en >= (date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1)
     GROUP BY usuario`, [ZONA_HORARIA])).rows.map(x => [x.usuario, x.n]));
  return { cupos, hoy };
}

let repartiendo = false;
async function repartir() {
  if (repartiendo) return;
  if (!(await cuenta.tiene('reparto').catch(() => true))) return;
  repartiendo = true;
  try {
    const ajustes = await ajustesReparto();
    if (!ajustes.reparto_activo) return;
    const lista = await receptores();
    if (!lista.length) return;
    const conectados = estadosConectados();
    const nombres = new Map(lista.map(x => [x.usuario, x.nombre || x.usuario]));

    // 1) Lo que el sistema asignó a alguien que ya se desconectó y que nunca se abrió vuelve a repartirse.
    const devueltas = await client.query(
      `DELETE FROM asignaciones a
       WHERE a.por = 'sistema' AND NOT (a.usuario = ANY($1::text[]))
         AND EXISTS (SELECT 1 FROM clasificacion c WHERE ${CLAVE_SQL} = a.clave AND c.estado = ANY($2::text[]))
         AND NOT EXISTS (SELECT 1 FROM clasificacion c JOIN tiempo_reserva t ON t.reserva_id = c.id WHERE ${CLAVE_SQL} = a.clave)
       RETURNING a.clave, a.usuario`,
      [Array.from(conectados.keys()), ESTADOS_ABIERTOS]
    );
    for (const d of devueltas.rows) {
      await registrar(SISTEMA, 'reparto_devuelta', 'correo', d.clave, d.usuario, '', 'El asesor se desconectó sin abrirla');
    }

    // 2) Reservas y cambios nuevos sin asignar, entre los asesores en línea.
    const listos = lista.filter(x => (conectados.get(x.usuario) || {}).estado === 'en linea').map(x => x.usuario);
    if (!listos.length) return;
    const pendientes = (await client.query(
      `SELECT c.id, c.categoria, c.nombre_cliente, c.asunto, c.message_id, c.fecha, c.estado FROM clasificacion c
       WHERE c.categoria IN ('RESERVA', 'MODIFICACION') AND c.estado = ANY($1::text[]) AND c.error_ia IS NOT TRUE
         AND c.creado >= $2
         AND NOT EXISTS (SELECT 1 FROM asignaciones a WHERE a.clave = ${CLAVE_SQL})
       ORDER BY c.id`, [ESTADOS_ABIERTOS, ajustes.reparto_desde]
    )).rows;
    if (!pendientes.length) return;

    const grupos = new Map();
    for (const f of pendientes) {
      const k = claveDe(f);
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k).push(f);
    }
    // Los cambios primero: así su reserva original queda con el mismo asesor.
    const orden = Array.from(grupos.entries()).sort((a, b) =>
      (b[1][0].categoria === 'MODIFICACION') - (a[1][0].categoria === 'MODIFICACION') || a[1][0].id - b[1][0].id);

    const carga = await cargaDeAsesores();
    const porCupos = ajustes.reparto_modo === 'cupos';
    const { cupos, hoy } = porCupos ? await cuposDeHoy() : { cupos: new Map(), hoy: new Map() };
    let indice = null;
    const asignar = async (clave, usuario, filas) => {
      const hecho = await client.query(
        "INSERT INTO asignaciones (clave, usuario, por) VALUES ($1, $2, 'sistema') ON CONFLICT (clave) DO NOTHING RETURNING clave",
        [clave, usuario]
      );
      if (!hecho.rowCount) return false;
      const c = carga.get(usuario) || { carga: 0, ultima: 0 };
      carga.set(usuario, { carga: c.carga + 1, ultima: Date.now() });
      hoy.set(usuario, (hoy.get(usuario) || 0) + 1);
      const primera = filas[0];
      const cliente = primera.nombre_cliente || primera.asunto || 'sin nombre';
      await avisar([usuario],
        `${primera.categoria === 'MODIFICACION' ? 'Te llegó un cambio' : 'Te llegó una reserva nueva'}: ${cliente} (#${primera.id}).`,
        primera.id);
      await registrar(SISTEMA, 'reparto_asignada', 'reserva', primera.id, '', usuario, cliente);
      return true;
    };
    const porPendientes = (a, b) => {
      const x = carga.get(a) || { carga: 0, ultima: 0 };
      const y = carga.get(b) || { carga: 0, ultima: 0 };
      return x.carga - y.carga || x.ultima - y.ultima || a.localeCompare(b);
    };
    // Automático: a quien tiene menos pendientes. Por cupos: en proporción al cupo (30/15/20...);
    // quien llegó a su cupo deja de recibir y, si todos llegaron, se vuelve a "menos pendientes".
    const elegir = () => {
      if (porCupos) {
        const conCupo = listos.filter(x => (cupos.get(x) || 0) > (hoy.get(x) || 0));
        if (conCupo.length) {
          return conCupo.sort((a, b) => ((hoy.get(a) || 0) / cupos.get(a)) - ((hoy.get(b) || 0) / cupos.get(b)) || porPendientes(a, b))[0];
        }
      }
      return listos.slice().sort(porPendientes)[0];
    };

    for (const [clave, filas] of orden) {
      let destino = null;
      if (filas[0].categoria === 'MODIFICACION') {
        if (!indice) {
          indice = indiceReservas((await client.query(
            "SELECT id, nombre_cliente, message_id, fecha, estado FROM clasificacion WHERE categoria = 'RESERVA' ORDER BY id DESC LIMIT 50000"
          )).rows);
        }
        const original = originalDe(filas[0], indice);
        if (original) {
          const claveOriginal = claveDe(original);
          const previa = (await client.query('SELECT usuario FROM asignaciones WHERE clave = $1', [claveOriginal])).rows[0];
          if (previa && conectados.has(previa.usuario) && nombres.has(previa.usuario)) destino = previa.usuario;
          if (!destino) destino = elegir();
          if (!previa && ESTADOS_ABIERTOS.includes(original.estado)) {
            await client.query(
              "INSERT INTO asignaciones (clave, usuario, por) VALUES ($1, $2, 'sistema') ON CONFLICT (clave) DO NOTHING",
              [claveOriginal, destino]
            );
          }
        }
      }
      await asignar(clave, destino || elegir(), filas);
    }
  } catch (e) {
    console.log('Error en el reparto:', e.message);
  } finally {
    repartiendo = false;
  }
}

/* ---------- Hito 3: importar el historial de Microsoft 365 ---------- */

const MALAS = { 'Ã¡': 'á', 'Ã©': 'é', 'Ã­': 'í', 'Ã³': 'ó', 'Ãº': 'ú', 'Ã±': 'ñ', 'Ã‘': 'Ñ', 'Ã‰': 'É', 'Ã“': 'Ó', 'Ãš': 'Ú', 'Ã¼': 'ü', 'â€¢': '•', 'â€“': '–', 'â€œ': '"', 'â€\x9d': '"' };
function arreglarTexto(s) {
  return String(s || '')
    .replace(/Ã[¡©­³º±‘‰“š¼]|â€[¢“œ\x9d]/g, m => MALAS[m] || m)
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function isoSinMs(fecha) {
  return new Date(fecha).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

let importando = false;
async function importarHistorico() {
  if (importando) return;
  if (!(await cuenta.tiene('historial').catch(() => true))) return;
  importando = true;
  try {
    for (let pagina = 0; pagina < HISTORICO_PAGINAS_POR_VUELTA; pagina++) {
      const est = (await client.query('SELECT * FROM historico_importacion WHERE id = 1')).rows[0];
      if (!est || !est.activo || est.terminado) return;
      let respuesta;
      try {
        respuesta = await llamarN8n('correoCompleto', {
          accion: 'listar', buzon: est.buzon, desde: est.desde, hasta: est.cursor, top: HISTORICO_POR_PAGINA
        }, 'Correo completo');
      } catch (e) {
        await client.query('UPDATE historico_importacion SET ultimo_error = $1, actualizado = NOW() WHERE id = 1', [e.message.slice(0, 300)]);
        return;
      }
      const correos = Array.isArray(respuesta.correos) ? respuesta.correos : null;
      if (!correos) {
        await client.query('UPDATE historico_importacion SET ultimo_error = $1, actualizado = NOW() WHERE id = 1',
          ['El flujo "Correo completo" todavía no sabe listar correos. Actualiza sus dos nodos (paso del Hito 3).']);
        return;
      }
      let nuevos = 0;
      let menor = null;
      for (const m of correos) {
        if (!m || !m.id || !m.fecha) continue;
        const t = Date.parse(m.fecha);
        if (!isNaN(t) && (menor === null || t < menor)) menor = t;
        // Una sola instrucción: si el correo ya está en el panel, no se toca.
        const r = await client.query(
          `WITH marca AS (
             INSERT INTO correo_historico (message_id)
             SELECT $4 WHERE NOT EXISTS (SELECT 1 FROM clasificacion WHERE message_id = $4)
             ON CONFLICT DO NOTHING RETURNING message_id)
           INSERT INTO clasificacion (categoria, remitente, asunto, estado, fecha, message_id, buzon, cuerpo, error_ia, motivo,
             numero_servicio, aviso_procesado, adultos, ninos, infantes)
           SELECT 'NO_ENTENDIDO', $1, $2, 'historico', $3, message_id, $5, $6, $7, 'Histórico: pendiente de análisis', 1, TRUE, 0, 0, 0
           FROM marca RETURNING id`,
          [arreglarTexto(m.de).slice(0, 500), arreglarTexto(m.asunto).slice(0, 1000), m.fecha, m.id, est.buzon,
            arreglarTexto(m.texto).slice(0, 60000), est.analizar]
        );
        nuevos += r.rowCount;
      }
      // Se sigue hacia atrás desde el correo más viejo de esta página.
      let siguiente = menor === null ? null : isoSinMs(menor);
      if (siguiente && siguiente === est.cursor) siguiente = isoSinMs(menor - 1000);
      const terminado = correos.length < HISTORICO_POR_PAGINA || !siguiente || siguiente < est.desde;
      await client.query(
        `UPDATE historico_importacion SET cursor = COALESCE($1, cursor), importados = importados + $2, paginas = paginas + 1,
           terminado = $3, activo = NOT $3, ultimo_error = '', actualizado = NOW() WHERE id = 1`,
        [siguiente, nuevos, terminado]
      );
      if (terminado) {
        await registrar(SISTEMA, 'historico_terminado', 'historico', est.buzon, '', '', 'Importación del historial terminada');
        return;
      }
    }
  } catch (e) {
    console.log('Error importando el historial:', e.message);
    await client.query('UPDATE historico_importacion SET ultimo_error = $1, actualizado = NOW() WHERE id = 1', [e.message.slice(0, 300)]).catch(() => {});
  } finally {
    importando = false;
  }
}

async function estadoHistorico() {
  const est = (await client.query('SELECT * FROM historico_importacion WHERE id = 1')).rows[0] || null;
  const c = (await client.query(
    `SELECT COUNT(DISTINCT c.message_id) FILTER (WHERE c.motivo LIKE 'Histórico: pendiente%')::int AS por_analizar,
            COUNT(DISTINCT c.message_id) FILTER (WHERE COALESCE(c.motivo, '') NOT LIKE 'Histórico: pendiente%')::int AS analizados,
            COUNT(DISTINCT c.message_id) FILTER (WHERE c.error_ia IS NOT TRUE AND c.categoria IN ('RESERVA', 'MODIFICACION'))::int AS reservas
     FROM clasificacion c JOIN correo_historico h ON h.message_id = c.message_id`
  )).rows[0];
  return { importacion: est, ...c };
}

/* ---------- Alertas de fallos: vigila n8n, el flujo de correos, la IA y el saldo de OpenRouter ---------- */

const AJUSTES_ALERTAS = Object.assign({ correos: [], saldoMinimo: 3, minutosSinFlujo: 30, erroresIaPorHora: 5 }, config.alertas || {});
const estadoSalud = { revisado: null, chequeos: [] };

async function conTiempo(url, opciones = {}, ms = 10000) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), ms);
  try {
    return await fetch(url, { ...opciones, signal: control.signal });
  } finally {
    clearTimeout(reloj);
  }
}

function origenN8n() {
  const url = config.n8n && (config.n8n.correoCompleto || config.n8n.marcarLeido || config.n8n.enviarCorreo);
  try { return url ? new URL(url).origin : null; } catch (e) { return null; }
}

async function chequearN8n() {
  const origen = origenN8n();
  if (!origen) return { clave: 'n8n', nombre: 'n8n encendido', estado: 'sin datos', detalle: 'No hay direcciones de n8n en config.js.' };
  try {
    const r = await conTiempo(origen + '/healthz', {}, 8000);
    if (r.ok) return { clave: 'n8n', nombre: 'n8n encendido', estado: 'bien', detalle: 'n8n responde.' };
    return { clave: 'n8n', nombre: 'n8n encendido', estado: 'falla', detalle: `n8n respondió con error ${r.status}.` };
  } catch (e) {
    return { clave: 'n8n', nombre: 'n8n encendido', estado: 'falla', detalle: 'n8n no responde. ¿Está abierto en la computadora?' };
  }
}

async function chequearFlujo() {
  const conMotor = config.motor && config.motor.activo && config.motor.sombra === false;
  const nombre = conMotor ? 'Lectura de correos (motor)' : 'Lectura de correos (n8n)';
  const fila = (await client.query('SELECT visto, NOW() - visto AS hace FROM salud_n8n WHERE id = 1')).rows[0];
  if (!fila) {
    return { clave: 'flujo', nombre, estado: 'sin datos', detalle: 'Falta el aviso de vida en el nodo "Reintentar fallidos" (paso de instalación de las alertas).' };
  }
  const minutos = Math.round((Date.now() - new Date(fila.visto).getTime()) / 60000);
  const cuando = new Date(fila.visto).toLocaleString('es-DO', { timeZone: ZONA_HORARIA, dateStyle: 'short', timeStyle: 'short' });
  if (minutos > AJUSTES_ALERTAS.minutosSinFlujo) {
    return { clave: 'flujo', nombre, estado: 'falla', detalle: `${conMotor ? 'El motor de correo no lee' : 'El flujo "Correos - leer y clasificar" no corre'} desde ${cuando} (hace ${minutos} min). No están entrando correos nuevos.` };
  }
  return { clave: 'flujo', nombre, estado: 'bien', detalle: `Última lectura: ${cuando}.` };
}

async function chequearIa() {
  const r = (await client.query(
    `SELECT COUNT(DISTINCT message_id)::int AS n, MAX(motivo) AS ejemplo FROM clasificacion
     WHERE error_ia = TRUE AND motivo LIKE 'Error de la IA%' AND creado > NOW() - INTERVAL '1 hour'`
  )).rows[0];
  if (r.n >= AJUSTES_ALERTAS.erroresIaPorHora) {
    const sinSaldo = /402|credit|insufficient|saldo/i.test(r.ejemplo || '');
    return { clave: 'ia', nombre: 'IA (OpenRouter)', estado: 'falla',
      detalle: `${r.n} correos fallaron con la IA en la última hora${sinSaldo ? ' por falta de saldo en OpenRouter' : ''}. Ejemplo: ${String(r.ejemplo || '').slice(0, 160)}` };
  }
  return { clave: 'ia', nombre: 'IA (OpenRouter)', estado: 'bien', detalle: r.n ? `${r.n} error(es) aislados en la última hora; se reintentan solos.` : 'Sin errores en la última hora.' };
}

async function chequearSaldo() {
  const clave = config.openrouter && config.openrouter.apiKey;
  if (!clave) return { clave: 'saldo', nombre: 'Saldo de OpenRouter', estado: 'sin datos', detalle: 'Para vigilar el saldo, agrega openrouter.apiKey en config.js.' };
  try {
    const r = await conTiempo('https://openrouter.ai/api/v1/credits', { headers: { Authorization: 'Bearer ' + clave } }, 10000);
    const d = (await r.json().catch(() => ({}))).data || {};
    if (!r.ok || d.total_credits === undefined) {
      return { clave: 'saldo', nombre: 'Saldo de OpenRouter', estado: 'sin datos', detalle: `OpenRouter no devolvió el saldo (código ${r.status}).` };
    }
    const saldo = Number(d.total_credits) - Number(d.total_usage || 0);
    const texto = `Saldo disponible: US$ ${saldo.toFixed(2)}.`;
    if (saldo < AJUSTES_ALERTAS.saldoMinimo) {
      return { clave: 'saldo', nombre: 'Saldo de OpenRouter', estado: 'falla', detalle: `${texto} Recarga en openrouter.ai → Credits (mínimo configurado: US$ ${AJUSTES_ALERTAS.saldoMinimo}).` };
    }
    return { clave: 'saldo', nombre: 'Saldo de OpenRouter', estado: 'bien', detalle: texto };
  } catch (e) {
    return { clave: 'saldo', nombre: 'Saldo de OpenRouter', estado: 'sin datos', detalle: 'No se pudo consultar OpenRouter (¿sin internet?).' };
  }
}

// Avisa por correo a las direcciones de config.alertas.correos: primero por Microsoft 365 (n8n) y, si no, por SMTP.
async function correoDeAlerta(asunto, texto) {
  const para = (AJUSTES_ALERTAS.correos || []).filter(x => /@/.test(x));
  if (!para.length) return 'sin destinatarios';
  const errores = [];
  const ms = buzonesMicrosoftEnvio()[0];
  if (ms && config.n8n && config.n8n.enviarCorreo) {
    try {
      for (const destino of para) await llamarN8n('enviarCorreo', { accion: 'nuevo', buzon: ms, para: destino, asunto, texto, adjuntos: [] }, 'Enviar correo');
      return 'enviado por ' + ms;
    } catch (e) { errores.push(e.message); }
  }
  for (const buzon of Object.keys(config.correo || {})) {
    const salida = transporteDe(buzon);
    if (!salida) continue;
    try {
      await enviarPorSmtp(salida, { from: `"${salida.nombre}" <${buzon}>`, to: para.join(', '), subject: asunto, text: texto });
      return 'enviado por ' + buzon;
    } catch (e) { errores.push(e.message); }
  }
  return 'no enviado: ' + (errores.join(' | ') || 'no hay cuenta para enviar');
}

let revisandoSalud = false;
async function programadores() {
  return (await client.query("SELECT usuario FROM usuarios WHERE activo = TRUE AND grupo = 'Programador'")).rows.map(x => x.usuario);
}

// Si el vigilante de Windows tuvo que volver a encender el panel, se le avisa al programador.
async function avisarArranqueDelVigilante() {
  if (process.env.ARRANQUE_VIGILANTE !== '1') return;
  const texto = 'El panel se había caído y el vigilante de Windows lo volvió a encender solo.';
  await client.query("INSERT INTO alertas (clave, texto, resuelta) VALUES ('panel', $1, NOW())", [texto]);
  await avisar(await programadores(), '⚠ ' + texto, null);
  const envio = await correoDeAlerta('⚠ Panel de reservas: se reinició solo', texto + '\n\nRevisa C:\\panel-correos\\vigilante.log y panel-error.log para ver qué pasó.');
  await client.query("UPDATE alertas SET correo = $1 WHERE id = (SELECT MAX(id) FROM alertas WHERE clave = 'panel')", [envio]);
  await registrar(SISTEMA, 'panel_reiniciado', 'sistema', 'panel', '', '', texto + ' · Correo: ' + envio);
}

async function revisarSalud() {
  if (revisandoSalud) return;
  revisandoSalud = true;
  try {
    const chequeos = [await chequearN8n(), await chequearFlujo(), await chequearIa(), await chequearSaldo()];
    estadoSalud.revisado = new Date().toISOString();
    estadoSalud.chequeos = chequeos;
    // Las alertas del sistema son solo para el programador (Kaizen IA).
    const destinatarios = await programadores();
    for (const c of chequeos) {
      const activa = (await client.query('SELECT id FROM alertas WHERE clave = $1 AND resuelta IS NULL', [c.clave])).rows[0];
      if (c.estado === 'falla' && !activa) {
        const nueva = (await client.query('INSERT INTO alertas (clave, texto) VALUES ($1, $2) RETURNING id', [c.clave, c.detalle])).rows[0];
        await avisar(destinatarios, `⚠ Falla en el sistema — ${c.nombre}: ${c.detalle}`, null);
        const envio = await correoDeAlerta(`⚠ Panel de reservas: falla en ${c.nombre}`,
          `Se detectó un problema en el Panel de Reservas.\n\n${c.nombre}: ${c.detalle}\n\nRevisa Herramientas → Estado del sistema en el panel.`);
        await client.query('UPDATE alertas SET correo = $2 WHERE id = $1', [nueva.id, envio]);
        await registrar(SISTEMA, 'alerta_falla', 'sistema', c.clave, '', 'falla', c.detalle + ' · Correo: ' + envio);
      } else if (c.estado === 'bien' && activa) {
        await client.query('UPDATE alertas SET resuelta = NOW() WHERE id = $1', [activa.id]);
        await avisar(destinatarios, `✅ Resuelto — ${c.nombre}: ${c.detalle}`, null);
        const envio = await correoDeAlerta(`✅ Panel de reservas: se resolvió ${c.nombre}`, `${c.nombre} volvió a funcionar.\n\n${c.detalle}`);
        await registrar(SISTEMA, 'alerta_resuelta', 'sistema', c.clave, 'falla', 'bien', c.detalle + ' · Correo: ' + envio);
      }
    }
  } catch (e) {
    console.log('Error revisando la salud del sistema:', e.message);
  } finally {
    revisandoSalud = false;
  }
}

// Para quien recibe reservas sin supervisar: devuelve el nombre de otro asesor si la reserva es de él.
async function asignadaAOtro(reservaId, u, puede) {
  if (!puede('recibir_reservas') || puede('supervisar')) return null;
  const r = (await client.query(
    `SELECT a.usuario, COALESCE(us.nombre, a.usuario) AS nombre FROM clasificacion c
     JOIN asignaciones a ON a.clave = ${CLAVE_SQL} LEFT JOIN usuarios us ON us.usuario = a.usuario
     WHERE c.id = $1`, [reservaId]
  )).rows[0];
  return r && r.usuario !== u.usuario ? r.nombre : null;
}

async function limpiarRevisiones() {
  await client.query(`DELETE FROM revisiones WHERE actualizado < NOW() - INTERVAL '${MINUTOS_REVISION} minutes'`);
}

async function usuarioDeSesion(req) {
  const token = leerCookie(req, COOKIE);
  if (!token || !sesiones.has(token)) return null;
  const s = sesiones.get(token);
  const limite = config.sesion.minutosInactividad * 60 * 1000;
  if (Date.now() - s.ultima > limite) {
    sesiones.delete(token);
    return null;
  }
  s.ultima = Date.now();
  const r = await client.query(
    'SELECT id, usuario, nombre, grupo, empresa, debe_cambiar, activo, permisos, vence FROM usuarios WHERE usuario = $1',
    [s.usuario]
  );
  const u = r.rows[0];
  if (!u || !u.activo || await cuenta.motivoBloqueo(u)) {
    sesiones.delete(token);
    return null;
  }
  return u;
}

http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    // El panel central espera a que este panel esté completamente listo antes de configurarlo.
    if (req.method === 'GET' && url === '/api/listo') {
      return json(res, panelListo ? 200 : 503, { listo: panelListo });
    }

    // El panel central apaga este panel con su clave secreta (solo desde la misma máquina).
    if (req.method === 'POST' && url === '/api/interno/apagar') {
      // Solo desde esta misma máquina y sin pasar por el túnel o un proxy (esos traen la IP de afuera).
      const local = esLocal(req) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
      const clave = String(req.headers['x-kaizen'] || '');
      const secreto = String((config.sesion && config.sesion.secreto) || '');
      const ok = local && secreto.length >= 32 && clave.length === secreto.length &&
        crypto.timingSafeEqual(Buffer.from(clave), Buffer.from(secreto));
      if (!ok) return json(res, 403, { error: 'No autorizado' });
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 300);
      return;
    }

    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return archivo(res, path.join(CARPETA, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url === '/control') {
      return archivo(res, path.join(CARPETA, 'control.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url === '/inteligencia-artificial.png') {
      return archivo(res, path.join(CARPETA, 'inteligencia-artificial.png'), 'image/png');
    }

    if (req.method === 'GET' && url === '/empresa/logo') return imagenEmpresa(res, 'logo');
    if (req.method === 'GET' && url === '/empresa/banner') return imagenEmpresa(res, 'banner');
    if (req.method === 'GET' && url === '/empresa/fondo') return imagenEmpresa(res, 'fondo_login');

    if (req.method === 'GET' && url === '/api/empresa') {
      const r = await client.query(
        `SELECT nombre, rnc, direccion, banner_enlace, logo IS NOT NULL AS "tieneLogo", banner IS NOT NULL AS "tieneBanner",
                fondo_login IS NOT NULL AS "tieneFondo", login_titulo, login_subtitulo, redes,
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
      const bloqueoCuenta = await cuenta.motivoBloqueo(u);
      if (bloqueoCuenta) {
        await registrar(u, 'login_rechazado', 'sesion', u.usuario, '', '', bloqueoCuenta);
        return json(res, 403, { error: bloqueoCuenta });
      }
      const token = crypto.randomBytes(32).toString('hex');
      sesiones.set(token, { usuario: u.usuario, ultima: Date.now() });
      fallosLogin.delete('usuario:' + nombreIntento);
      await registrar(u, 'login', 'sesion', u.usuario, '', '', 'Inicio de sesión');
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict${cookieSegura(req)}` });
    }

    if (req.method === 'POST' && url === '/api/logout') {
      const token = leerCookie(req, COOKIE);
      const actual = await usuarioDeSesion(req);
      if (token) sesiones.delete(token);
      if (actual) {
        presencia.delete(actual.usuario);
        await client.query('DELETE FROM revisiones WHERE usuario = $1', [actual.usuario]);
        await client.query('UPDATE tiempo_reserva SET fin = NOW(), visto = NOW() WHERE usuario = $1 AND fin IS NULL', [actual.usuario]);
        await registrar(actual, 'logout', 'sesion', actual.usuario, '', '', 'Cierre de sesión');
      }
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; Path=/; Max-Age=0${cookieSegura(req)}` });
    }

    const u = await usuarioDeSesion(req);

    if (req.method === 'GET' && url === '/api/sesion') {
      if (!u) return json(res, 401, { error: 'Sin sesión' });
      const permisos = permisosDe(u, await mapaGrupos());
      return json(res, 200, {
        usuario: u.usuario, nombre: u.nombre, grupo: u.grupo,
        permisos, debe_cambiar: u.debe_cambiar,
        modulos: await cuenta.modulos(), sedes: EMPRESAS, demo: !!config.demo, central: central.activo,
        vence: u.vence || null
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

    // Módulos que la empresa no tiene contratados.
    const mods = await cuenta.modulos();
    if ((!mods.chat && url.startsWith('/api/chat/')) || (!mods.control && url === '/api/control') ||
        (!mods.reparto && (url === '/api/reparto' || url === '/api/reserva/asignar')) || (!mods.historial && url.startsWith('/api/historico'))) {
      return json(res, 403, { error: 'Este módulo no está activo en tu plan. Comunícate con Kaizen IA.' });
    }

    if (req.method === 'GET' && url === '/api/franjas') {
      return json(res, 200, await cuenta.franjas(u));
    }
    if (req.method === 'POST' && url === '/api/anuncio/cerrar') {
      const { id } = await leerCuerpo(req);
      await cuenta.cerrarAnuncio(u, id);
      return json(res, 200, { ok: true });
    }

    // Pestaña Empresas: solo en el panel central y solo para el programador (lo revisa el módulo).
    if (url.startsWith('/api/central/')) {
      return central.manejar(req, res, url, u, { json, leerCuerpo });
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
      const p = new URL(req.url, 'http://localhost').searchParams;
      const historico = p.get('historico') === '1';
      const columnas = `c.id, c.categoria, c.agencia, c.remitente, c.asunto, c.fecha, c.estado, c.error_ia, c.motivo, c.message_id, c.buzon,
        c.aeropuerto, c.actividad, c.nombre_cliente, c.telefono, c.tipo_servicio, c.fecha_servicio, c.hora_servicio, c.vuelo, c.hotel,
        c.punto_partida, c.punto_llegada, c.adultos, c.ninos, c.infantes, c.numero_servicio,
        c.creado >= (SELECT reparto_desde FROM empresa_datos WHERE id = 1) AS tras_reparto,
        a.usuario AS asignado_a, COALESCE(us.nombre, a.usuario) AS asignado_nombre`;
      const uniones = `LEFT JOIN asignaciones a ON a.clave = ${CLAVE_SQL} LEFT JOIN usuarios us ON us.usuario = a.usuario`;
      let filas;
      let revisiones = new Map();
      if (historico) {
        // Historial: se busca en el servidor (pueden ser miles) y se devuelven los 2000 más recientes que coinciden.
        const q = String(p.get('q') || '').trim().slice(0, 100);
        const desde = /^\d{4}-\d{2}-\d{2}$/.test(p.get('desde') || '') ? p.get('desde') : '';
        const hasta = /^\d{4}-\d{2}-\d{2}$/.test(p.get('hasta') || '') ? p.get('hasta') : '';
        const r = await client.query(
          `SELECT ${columnas} FROM clasificacion c ${uniones}
           WHERE c.estado = 'historico' ${q ? `AND (c.asunto ILIKE $1 OR c.remitente ILIKE $1 OR c.nombre_cliente ILIKE $1 OR c.agencia ILIKE $1
             OR c.hotel ILIKE $1 OR c.vuelo ILIKE $1 OR c.telefono ILIKE $1 OR c.cuerpo ILIKE $1
             OR c.id::text = $2)` : ''}`,
          q ? ['%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%', q.replace(/^#/, '')] : []
        );
        filas = r.rows
          .filter(x => {
            const dia = diaLocal(x.fecha);
            return (!desde || dia >= desde) && (!hasta || dia <= hasta);
          })
          .sort((x, y) => fechaOrden(y) - fechaOrden(x))
          .slice(0, 2000);
      } else {
        filas = (await client.query(
          `SELECT ${columnas} FROM clasificacion c ${uniones} WHERE c.estado <> 'historico' ORDER BY c.id DESC LIMIT 5000`
        )).rows;
        // Revisión automática sobre todas (antes de filtrar), para encontrar duplicados entre asesores.
        try {
          revisiones = revisarReservas(filas, { isoDe: x => fechaServicioISO(x.fecha_servicio, x.fecha), claveDe, hoy: require('./plataforma/cuenta').hoyLocal() });
        } catch (e) { console.log('Revisión automática:', e.message); }
        // Quien recibe reservas del reparto (y no supervisa) ve solo las suyas y lo que no se reparte.
        if (puede('recibir_reservas') && !puede('supervisar')) {
          const ajustes = await ajustesReparto();
          filas = filas.filter(x => {
            if (x.asignado_a) return x.asignado_a === u.usuario;
            const enReparto = ajustes.reparto_activo && ['RESERVA', 'MODIFICACION'].includes(x.categoria)
              && ESTADOS_ABIERTOS.includes(x.estado) && !x.error_ia && x.tras_reparto;
            return !enReparto;
          });
        }
      }
      const conocidas = new Map((await client.query('SELECT remitente, agencia FROM agencias_conocidas')).rows
        .map(x => [x.remitente, x.agencia]));
      for (const x of filas) {
        delete x.tras_reparto;
        if (x.agencia) continue;
        const correo = (emailDeRemitente(x.remitente) || '').toLowerCase();
        if (conocidas.has(correo)) x.agencia = conocidas.get(correo);
      }
      // La reserva original de un cambio puede estar en el historial.
      const reservas = filas.filter(x => x.categoria === 'RESERVA');
      const historicas = historico ? [] : (await client.query(
        "SELECT id, nombre_cliente, message_id, fecha, TRUE AS historica FROM clasificacion WHERE categoria = 'RESERVA' AND estado = 'historico'"
      )).rows;
      const indice = indiceReservas([...reservas, ...historicas]);
      const originales = new Map();
      const cambios = new Map();
      for (const x of filas) {
        if (x.categoria !== 'MODIFICACION') continue;
        const original = originalDe(x, indice);
        originales.set(x.id, original);
        if (original) cambios.set(claveDe(original), Math.max(cambios.get(claveDe(original)) || 0, x.id));
      }
      return json(res, 200, filas.map(x => {
        const base = { ...x, fecha_servicio_iso: fechaServicioISO(x.fecha_servicio, x.fecha) };
        const rev = revisiones.get(x.id);
        if (rev && (rev.puntos.length || rev.urgente)) base.revision = rev;
        if (x.categoria === 'MODIFICACION') {
          const o = originales.get(x.id);
          base.original_id = o ? o.id : null;
          if (o && o.historica) base.original_historico = true;
        }
        if (x.categoria === 'RESERVA' && cambios.has(claveDe(x))) base.cambio_id = cambios.get(claveDe(x));
        return base;
      }));
    }

    if (req.method === 'GET' && url === '/api/avisos') {
      const r = await client.query(
        'UPDATE avisos SET leido = TRUE WHERE para = $1 AND leido = FALSE RETURNING id, texto, reserva_id, creado',
        [u.usuario]
      );
      return json(res, 200, r.rows);
    }

    if (req.method === 'POST' && url === '/api/estado') {
      if (!puede('cambiar_estado')) return json(res, 403, { error: 'No tienes permiso para cambiar el estado.' });
      const { id, estado } = await leerCuerpo(req);
      if (!ESTADOS.includes(estado)) return json(res, 400, { error: 'Estado no válido' });
      const previa = (await client.query('SELECT estado, nombre_cliente FROM clasificacion WHERE id = $1', [Number(id)])).rows[0];
      if (!previa) return json(res, 404, { error: 'Reserva no encontrada' });
      const ajena = await asignadaAOtro(Number(id), u, puede);
      if (ajena) return json(res, 409, { error: `Esta reserva está asignada a ${ajena}.` });
      await client.query('UPDATE clasificacion SET estado = $1 WHERE id = $2', [estado, Number(id)]);
      // El contador se detiene al registrarla (o al sacarla de los estados abiertos).
      if (!ESTADOS_ABIERTOS.includes(estado)) await cerrarTramos(Number(id));
      await registrar(u, 'cambiar_estado', 'reserva', id, previa.estado, estado, previa.nombre_cliente || '');
      if (estado === 'registrada' && previa.estado !== 'registrada') {
        marcarLeidoSiCompleto(Number(id), u).catch(e => console.log('Error marcando como leído:', e.message));
      }
      return json(res, 200, { ok: true });
    }

    // El texto del correo se pide al abrir la reserva, no en la lista que se recarga cada 15 segundos.
    if (req.method === 'GET' && url === '/api/reserva/cuerpo') {
      if (!puede('ver_reservas')) return json(res, 403, { error: 'No tienes permiso para ver las reservas.' });
      const id = Number(new URL(req.url, 'http://localhost').searchParams.get('id'));
      const fila = (await client.query('SELECT cuerpo FROM clasificacion WHERE id = $1', [id])).rows[0];
      if (!fila) return json(res, 404, { error: 'Reserva no encontrada' });
      return json(res, 200, { cuerpo: fila.cuerpo || '' });
    }

    if (req.method === 'POST' && url === '/api/reserva/agencia') {
      if (!puede('editar_reservas')) return json(res, 403, { error: 'No tienes permiso para editar reservas.' });
      const { id, agencia, recordar } = await leerCuerpo(req);
      const nueva = String(agencia || '').trim();
      if (nueva.length > 150) return json(res, 400, { error: 'El nombre de la agencia es muy largo (máximo 150 caracteres).' });
      const fila = (await client.query('SELECT id, agencia, remitente, message_id FROM clasificacion WHERE id = $1', [Number(id)])).rows[0];
      if (!fila) return json(res, 404, { error: 'Reserva no encontrada' });
      // Todos los servicios del mismo correo llevan la misma agencia.
      await client.query(
        'UPDATE clasificacion SET agencia = $1 WHERE id = $2 OR (message_id IS NOT NULL AND message_id = $3)',
        [nueva, fila.id, fila.message_id]
      );
      const correo = (emailDeRemitente(fila.remitente) || '').toLowerCase();
      if (recordar && correo && nueva) {
        await client.query(
          `INSERT INTO agencias_conocidas (remitente, agencia, usuario) VALUES ($1, $2, $3)
           ON CONFLICT (remitente) DO UPDATE SET agencia = EXCLUDED.agencia, usuario = EXCLUDED.usuario, actualizado = NOW()`,
          [correo, nueva, u.usuario]
        );
      }
      await registrar(u, 'editar_agencia', 'reserva', fila.id, fila.agencia || '', nueva,
        recordar && correo && nueva ? 'Recordada para ' + correo : '');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/api/reserva/reanalizar') {
      if (!puede('cambiar_estado')) return json(res, 403, { error: 'No tienes permiso para volver a analizar correos.' });
      const { id } = await leerCuerpo(req);
      const fila = (await client.query('SELECT id, message_id, asunto FROM clasificacion WHERE id = $1', [Number(id)])).rows[0];
      if (!fila) return json(res, 404, { error: 'Reserva no encontrada' });
      if (!fila.message_id) return json(res, 400, { error: 'Este correo no tiene identificador; no se puede volver a analizar.' });
      const registradas = (await client.query(
        "SELECT COUNT(*)::int AS n FROM clasificacion WHERE message_id = $1 AND estado = 'registrada'", [fila.message_id]
      )).rows[0].n;
      if (registradas) {
        return json(res, 409, { error: 'Este correo ya tiene servicios registrados. Para no perder ese trabajo, no se puede volver a analizar.' });
      }
      // n8n lo toma en su próxima ejecución (nodo "Reintentar fallidos") y reemplaza estas filas por las nuevas.
      await client.query('UPDATE clasificacion SET error_ia = TRUE, motivo = $2 WHERE message_id = $1',
        [fila.message_id, 'Reanálisis pedido por ' + (u.nombre || u.usuario)]);
      await registrar(u, 'pedir_reanalisis', 'reserva', fila.id, '', '', fila.asunto || '');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url === '/api/revisiones') {
      await limpiarRevisiones();
      const r = await client.query(
        `SELECT v.reserva_id, v.usuario, v.nombre, v.desde,
                COALESCE((SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(t.fin, NOW()) - t.inicio))) FROM tiempo_reserva t
                          WHERE t.reserva_id = v.reserva_id), 0)::int AS segundos
         FROM revisiones v`);
      return json(res, 200, r.rows.map(x => ({ ...x, limite: MINUTOS_LIMITE_RESERVA * 60 })));
    }

    if (req.method === 'POST' && url === '/api/revision/tomar') {
      if (!puede('cambiar_estado')) return json(res, 403, { error: 'No tienes permiso para atender reservas.' });
      const { id, activo } = await leerCuerpo(req);
      const reservaId = Number(id);
      const fila = (await client.query('SELECT id, categoria, estado FROM clasificacion WHERE id = $1', [reservaId])).rows[0];
      if (!fila) return json(res, 404, { error: 'Reserva no encontrada' });
      const ajena = await asignadaAOtro(reservaId, u, puede);
      if (ajena) return json(res, 409, { error: `Esta reserva está asignada a ${ajena}.` });
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
      // Contador: corre mientras la ventana está abierta y la persona está activa.
      // El programador no cuenta en las estadísticas de los asesores (sus pruebas no ensucian el control).
      if (cuentaTiempo(fila) && u.grupo !== 'Programador') await marcarTramo(reservaId, u.usuario, activo !== false);
      return json(res, 200, { ok: true, tiempo: { ...(await tiempoReserva(reservaId, u.usuario)), cuenta: cuentaTiempo(fila) } });
    }

    if (req.method === 'POST' && url === '/api/revision/liberar') {
      const { id } = await leerCuerpo(req);
      const reservaId = Number(id);
      const borrado = await client.query(
        'DELETE FROM revisiones WHERE reserva_id = $1 AND usuario = $2 RETURNING reserva_id',
        [reservaId, u.usuario]
      );
      if (borrado.rowCount) await registrar(u, 'cerrar_reserva', 'reserva', reservaId, '', '', '');
      await cerrarTramos(reservaId, u.usuario);
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
      if (!puede('configurar_empresa') && !puede('administrar_usuarios')) return json(res, 403, { error: 'No tienes permiso para cambiar los datos de la empresa.' });
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
      if (b.fondo && !imagenValida(b.fondo, MAX_FONDO)) {
        return json(res, 400, { error: 'La foto de fondo debe ser JPG, PNG o WEBP de menos de 4 MB.' });
      }
      const loginTitulo = String(b.login_titulo || '').trim().slice(0, 80);
      const loginSubtitulo = String(b.login_subtitulo || '').trim().slice(0, 160);
      const redes = {};
      for (const red of REDES) {
        const valor = b.redes && b.redes[red];
        if (!valor) continue;
        const enlaceValido = enlaceRed(red, valor);
        if (!enlaceValido) return json(res, 400, { error: `No entendí el enlace de ${red}. Pega la dirección completa (https://...).` });
        redes[red] = enlaceValido;
      }
      const previa = (await client.query(
        'SELECT nombre, rnc, direccion, banner_enlace, logo IS NOT NULL AS logo, banner IS NOT NULL AS banner FROM empresa_datos WHERE id = 1'
      )).rows[0];
      const valores = [nombre, rnc, direccion, enlace, loginTitulo, loginSubtitulo, redes];
      const cambios = ['nombre = $1', 'rnc = $2', 'direccion = $3', 'banner_enlace = $4', 'login_titulo = $5', 'login_subtitulo = $6', 'redes = $7', 'actualizado = NOW()'];
      if (b.fondo !== undefined) {
        valores.push(b.fondo || null);
        cambios.push(`fondo_login = $${valores.length}`);
      }
      for (const campo of ['logo', 'banner']) {
        if (b[campo] === undefined) continue;
        valores.push(b[campo] || null);
        cambios.push(`${campo} = $${valores.length}`);
      }
      await client.query(`UPDATE empresa_datos SET ${cambios.join(', ')} WHERE id = 1`, valores);
      await registrar(u, 'editar_empresa', 'empresa', 1, previa, {
        nombre, rnc, direccion, banner_enlace: enlace,
        logo: b.logo === undefined ? 'sin cambio' : (b.logo ? 'nuevo' : 'quitado'),
        banner: b.banner === undefined ? 'sin cambio' : (b.banner ? 'nuevo' : 'quitado'),
        fondo: b.fondo === undefined ? 'sin cambio' : (b.fondo ? 'nuevo' : 'quitado'),
        login_titulo: loginTitulo, login_subtitulo: loginSubtitulo, redes
      });
      return json(res, 200, { ok: true });
    }

    /* ---------- Estado del sistema (alertas de fallos) ---------- */

    if (url === '/api/motor' || url === '/api/motor/ciclo') {
      if (u.grupo !== 'Programador') return json(res, 403, { error: 'Solo el programador puede ver el motor de correo.' });
      if (req.method === 'POST' && url === '/api/motor/ciclo') {
        motorCorreo.ciclo().catch(e => console.log('Motor:', e.message));
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { estado: await motorCorreo.estado(), comparacion: await motorCorreo.comparar() });
    }

    if (url === '/api/salud' || url === '/api/salud/revisar') {
      if (u.grupo !== 'Programador') {
        return json(res, 403, { error: 'Solo el programador puede ver el estado del sistema.' });
      }
      if (req.method === 'POST' && url === '/api/salud/revisar') await revisarSalud();
      const activas = (await client.query('SELECT clave, texto, creada FROM alertas WHERE resuelta IS NULL ORDER BY creada')).rows;
      const historial = (await client.query('SELECT clave, texto, correo, creada, resuelta FROM alertas ORDER BY id DESC LIMIT 20')).rows;
      return json(res, 200, { ...estadoSalud, activas, historial,
        correos: (AJUSTES_ALERTAS.correos || []).length, saldoMinimo: AJUSTES_ALERTAS.saldoMinimo, minutosSinFlujo: AJUSTES_ALERTAS.minutosSinFlujo });
    }

    /* ---------- Hito 4: asesores y reasignación ---------- */

    if (req.method === 'GET' && url === '/api/asesores') {
      if (!puede('supervisar') && !puede('ver_control') && !puede('administrar_usuarios') && !puede('configurar_empresa')) {
        return json(res, 403, { error: 'No tienes permiso para ver los asesores.' });
      }
      const conectados = estadosConectados();
      const carga = await cargaDeAsesores();
      const ajustes = await ajustesReparto();
      const { cupos, hoy } = await cuposDeHoy();
      const lista = (await receptores()).map(x => ({
        usuario: x.usuario, nombre: x.nombre || x.usuario, grupo: x.grupo,
        estado: (conectados.get(x.usuario) || {}).estado || 'desconectado',
        carga: (carga.get(x.usuario) || {}).carga || 0,
        cupo: cupos.get(x.usuario) || 0, hoy: hoy.get(x.usuario) || 0
      })).sort((a, b) => a.nombre.localeCompare(b.nombre));
      return json(res, 200, { activo: ajustes.reparto_activo, modo: ajustes.reparto_modo || 'automatico', asesores: lista });
    }

    if (req.method === 'POST' && url === '/api/reserva/asignar') {
      if (!puede('supervisar')) return json(res, 403, { error: 'Solo quien supervisa puede reasignar reservas.' });
      const { id, usuario } = await leerCuerpo(req);
      const fila = (await client.query('SELECT id, message_id, nombre_cliente, asunto FROM clasificacion WHERE id = $1', [Number(id)])).rows[0];
      if (!fila) return json(res, 404, { error: 'Reserva no encontrada' });
      const clave = claveDe(fila);
      const previa = (await client.query('SELECT usuario FROM asignaciones WHERE clave = $1', [clave])).rows[0];
      const cliente = fila.nombre_cliente || fila.asunto || 'sin nombre';
      if (!usuario) {
        // Sin asignar: si el reparto está activo, se vuelve a repartir entre los conectados.
        await client.query('DELETE FROM asignaciones WHERE clave = $1', [clave]);
        if (previa) await avisar([previa.usuario], `${u.nombre || u.usuario} te quitó la reserva de ${cliente} (#${fila.id}).`, fila.id);
        await registrar(u, 'reasignar_reserva', 'reserva', fila.id, previa ? previa.usuario : '', '', cliente);
        return json(res, 200, { ok: true });
      }
      const destino = (await receptores()).find(x => x.usuario === usuario);
      if (!destino) return json(res, 400, { error: 'Ese usuario no tiene el permiso "Recibir reservas" o está desactivado.' });
      await client.query(
        `INSERT INTO asignaciones (clave, usuario, por) VALUES ($1, $2, $3)
         ON CONFLICT (clave) DO UPDATE SET usuario = EXCLUDED.usuario, por = EXCLUDED.por, asignado_en = NOW()`,
        [clave, destino.usuario, u.usuario]
      );
      if (!previa || previa.usuario !== destino.usuario) {
        await avisar([destino.usuario], `${u.nombre || u.usuario} te asignó la reserva de ${cliente} (#${fila.id}).`, fila.id);
        if (previa) await avisar([previa.usuario], `La reserva de ${cliente} (#${fila.id}) pasó a ${destino.nombre || destino.usuario}.`, fila.id);
      }
      await registrar(u, 'reasignar_reserva', 'reserva', fila.id, previa ? previa.usuario : '', destino.usuario, cliente);
      return json(res, 200, { ok: true });
    }

    if (url === '/api/reparto') {
      if (!puede('configurar_empresa') && !puede('administrar_usuarios')) return json(res, 403, { error: 'No tienes permiso para cambiar el reparto.' });
      if (req.method === 'POST') {
        const { activo, modo, cupos } = await leerCuerpo(req);
        // Al volver a activarlo se reparte solo lo que llegue desde ahora (no lo acumulado mientras estuvo apagado).
        await client.query(
          'UPDATE empresa_datos SET reparto_desde = CASE WHEN reparto_activo THEN reparto_desde ELSE NOW() END, reparto_activo = $1 WHERE id = 1',
          [Boolean(activo)]);
        const nuevoModo = modo === 'cupos' ? 'cupos' : 'automatico';
        await client.query('UPDATE empresa_datos SET reparto_modo = $1 WHERE id = 1', [nuevoModo]);
        const validos = new Set((await receptores()).map(x => x.usuario));
        const detalle = [];
        for (const [usuario, valor] of Object.entries(cupos && typeof cupos === 'object' ? cupos : {})) {
          if (!validos.has(usuario)) continue;
          const n = Math.max(0, Math.min(1000, Math.floor(Number(valor) || 0)));
          await client.query(`INSERT INTO reparto_cupos (usuario, cupo) VALUES ($1, $2)
            ON CONFLICT (usuario) DO UPDATE SET cupo = EXCLUDED.cupo, actualizado = NOW()`, [usuario, n]);
          detalle.push(`${usuario}=${n}`);
        }
        await registrar(u, 'cambiar_reparto', 'empresa', 1, '', (activo ? 'activado' : 'desactivado') + ' · ' + nuevoModo, detalle.join(', '));
        return json(res, 200, { ok: true });
      }
    }

    /* ---------- Hito 3: historial (solo el programador) ---------- */

    if (url.startsWith('/api/historico')) {
      if (u.grupo !== 'Programador') return json(res, 403, { error: 'Solo el programador puede importar el historial.' });
      if (req.method === 'GET' && url === '/api/historico') {
        return json(res, 200, { ...(await estadoHistorico()), buzones: buzonesMicrosoftEnvio(), costoPorCorreo: 0.001 });
      }
      if (req.method === 'POST' && url === '/api/historico/iniciar') {
        const { meses, buzon } = await leerCuerpo(req);
        const n = Math.round(Number(meses));
        if (!(n >= 1 && n <= 24)) return json(res, 400, { error: 'Elige de 1 a 24 meses.' });
        const buzones = buzonesMicrosoftEnvio();
        const elegido = String(buzon || buzones[0] || '').toLowerCase();
        if (!buzones.includes(elegido)) return json(res, 400, { error: 'Ese buzón no está en n8n.buzonesMicrosoft de config.js.' });
        if (!config.n8n || !config.n8n.correoCompleto) return json(res, 400, { error: 'Falta n8n.correoCompleto en config.js.' });
        const desde = new Date();
        desde.setMonth(desde.getMonth() - n);
        const hasta = new Date(Date.now() - HISTORICO_DIAS_RECIENTES * 24 * 60 * 60 * 1000);
        await client.query(
          `INSERT INTO historico_importacion (id, buzon, desde, cursor, activo, terminado, importados, paginas, ultimo_error, usuario, iniciado, actualizado)
           VALUES (1, $1, $2, $3, TRUE, FALSE, 0, 0, '', $4, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET buzon = $1, desde = $2, cursor = $3, activo = TRUE, terminado = FALSE, importados = 0,
             paginas = 0, ultimo_error = '', usuario = $4, iniciado = NOW(), actualizado = NOW()`,
          [elegido, isoSinMs(desde), isoSinMs(hasta), u.usuario]
        );
        await registrar(u, 'historico_iniciar', 'historico', elegido, '', n + ' meses', `Desde ${isoSinMs(desde)} hasta ${isoSinMs(hasta)}`);
        setTimeout(importarHistorico, 500);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/historico/analizar') {
        // Encender o apagar el análisis con IA: n8n solo toma los correos marcados con error_ia.
        const { activo } = await leerCuerpo(req);
        const encender = Boolean(activo);
        await client.query(`INSERT INTO historico_importacion (id, analizar) VALUES (1, $1)
          ON CONFLICT (id) DO UPDATE SET analizar = $1, actualizado = NOW()`, [encender]);
        const r = await client.query(
          "UPDATE clasificacion SET error_ia = $1 WHERE estado = 'historico' AND motivo LIKE 'Histórico: pendiente%' AND error_ia IS DISTINCT FROM $1",
          [encender]
        );
        await registrar(u, encender ? 'historico_analizar' : 'historico_pausar_analisis', 'historico', '', '', '', r.rowCount + ' correos');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (url === '/api/historico/pausar' || url === '/api/historico/reanudar')) {
        const activar = url.endsWith('reanudar');
        await client.query('UPDATE historico_importacion SET activo = $1, actualizado = NOW() WHERE id = 1 AND terminado = FALSE', [activar]);
        await registrar(u, activar ? 'historico_reanudar' : 'historico_pausar', 'historico', '', '', '', '');
        if (activar) setTimeout(importarHistorico, 500);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Ruta no encontrada' });
    }

    /* ---------- Hito 5: pantalla de control ---------- */

    if (req.method === 'GET' && url === '/api/control') {
      if (!puede('ver_control')) return json(res, 403, { error: 'No tienes permiso para ver la pantalla de control.' });
      const p = new URL(req.url, 'http://localhost').searchParams;
      const fechaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(f || '');
      const hoy = diaLocal(new Date().toISOString());
      const hasta = fechaValida(p.get('hasta')) ? p.get('hasta') : hoy;
      const desde = fechaValida(p.get('desde')) ? p.get('desde') : hasta;
      if (desde > hasta) return json(res, 400, { error: 'La fecha "desde" es posterior a "hasta".' });
      // Las gráficas muestran siempre los 30 días que terminan en "hasta".
      const d30 = new Date(hasta + 'T12:00:00Z');
      d30.setUTCDate(d30.getUTCDate() - 29);
      const desdeSerie = d30.toISOString().slice(0, 10);
      const inicio = desde < desdeSerie ? desde : desdeSerie;
      const zona = ZONA_HORARIA;
      const limite = MINUTOS_LIMITE_RESERVA * 60;

      const nombres = new Map((await client.query('SELECT usuario, nombre, grupo FROM usuarios')).rows.map(x => [x.usuario, x]));
      const tramos = (await client.query(
        `SELECT t.reserva_id, t.usuario, TO_CHAR(t.inicio AT TIME ZONE '${zona}', 'YYYY-MM-DD') AS dia,
                EXTRACT(EPOCH FROM (COALESCE(t.fin, NOW()) - t.inicio))::float AS segundos, t.fin IS NULL AS abierto
         FROM tiempo_reserva t
         WHERE TO_CHAR(t.inicio AT TIME ZONE '${zona}', 'YYYY-MM-DD') BETWEEN $1 AND $2`, [inicio, hasta]
      )).rows;
      const diaAuditoria = `TO_CHAR((a.fecha AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${zona}', 'YYYY-MM-DD')`;
      const registros = (await client.query(
        `SELECT DISTINCT ON (a.entidad_id) a.entidad_id::int AS reserva_id, a.usuario, ${diaAuditoria} AS dia
         FROM auditoria a
         WHERE a.accion = 'cambiar_estado' AND a.nuevo = 'registrada' AND a.entidad = 'reserva'
           AND a.entidad_id ~ '^[0-9]+$' AND ${diaAuditoria} BETWEEN $1 AND $2
         ORDER BY a.entidad_id, a.fecha DESC`, [inicio, hasta]
      )).rows;
      // Tiempo total de cada reserva registrada (todos sus tramos, aunque empezaran antes del rango).
      const idsRegistradas = registros.map(x => x.reserva_id);
      const tiempoTotal = new Map((await client.query(
        `SELECT reserva_id, usuario, SUM(EXTRACT(EPOCH FROM (COALESCE(fin, NOW()) - inicio)))::float AS segundos
         FROM tiempo_reserva WHERE reserva_id = ANY($1::int[]) GROUP BY reserva_id, usuario`, [idsRegistradas]
      )).rows.map(x => [x.reserva_id + '|' + x.usuario, x.segundos]));
      const datosReserva = new Map((await client.query(
        'SELECT id, nombre_cliente, asunto, categoria FROM clasificacion WHERE id = ANY($1::int[])', [idsRegistradas]
      )).rows.map(x => [x.id, x]));
      const correos = (await client.query('SELECT id, fecha, message_id, categoria FROM clasificacion')).rows;

      // Por día: correos y reservas que entraron, reservas registradas y tiempo trabajado.
      const dias = [];
      for (const d = new Date(inicio + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= hasta; d.setUTCDate(d.getUTCDate() + 1)) {
        dias.push(d.toISOString().slice(0, 10));
      }
      const porDia = new Map(dias.map(d => [d, { dia: d, correos: new Set(), reservas: new Set(), registradas: 0, segundos: 0, usuarios: {} }]));
      for (const c of correos) {
        const dia = diaLocal(c.fecha);
        const x = porDia.get(dia);
        if (!x) continue;
        const clave = claveDe(c);
        x.correos.add(clave);
        if (c.categoria === 'RESERVA' || c.categoria === 'MODIFICACION') x.reservas.add(clave);
      }
      const usuarioDia = (x, usuario) => x.usuarios[usuario] || (x.usuarios[usuario] = { registradas: 0, segundos: 0 });
      for (const r of registros) {
        const x = porDia.get(r.dia);
        if (!x) continue;
        x.registradas++;
        usuarioDia(x, r.usuario).registradas++;
      }
      for (const t of tramos) {
        const x = porDia.get(t.dia);
        if (!x) continue;
        x.segundos += t.segundos;
        usuarioDia(x, t.usuario).segundos += t.segundos;
      }

      // Por usuario dentro del rango elegido.
      const porUsuario = new Map();
      const filaUsuario = usuario => porUsuario.get(usuario) || porUsuario.set(usuario, {
        usuario, nombre: (nombres.get(usuario) || {}).nombre || usuario, grupo: (nombres.get(usuario) || {}).grupo || '',
        segundos: 0, registradas: 0, tiempos: [], pasadas: 0, abiertas: 0
      }).get(usuario);
      for (const t of tramos) {
        if (t.dia < desde || t.dia > hasta) continue;
        const f = filaUsuario(t.usuario);
        f.segundos += t.segundos;
        if (t.abierto) f.abiertas++;
      }
      const detalle = [];
      for (const r of registros) {
        if (r.dia < desde || r.dia > hasta) continue;
        const f = filaUsuario(r.usuario);
        f.registradas++;
        const segundos = tiempoTotal.get(r.reserva_id + '|' + r.usuario);
        if (segundos !== undefined) {
          f.tiempos.push(segundos);
          if (segundos > limite) f.pasadas++;
        }
        const info = datosReserva.get(r.reserva_id) || {};
        detalle.push({
          reserva_id: r.reserva_id, usuario: r.usuario, nombre: f.nombre, dia: r.dia,
          cliente: info.nombre_cliente || info.asunto || '', categoria: info.categoria || '',
          segundos: segundos === undefined ? null : Math.round(segundos)
        });
      }
      const usuarios = Array.from(porUsuario.values()).map(f => ({
        usuario: f.usuario, nombre: f.nombre, grupo: f.grupo,
        segundos: Math.round(f.segundos), registradas: f.registradas, abiertas: f.abiertas, pasadas: f.pasadas,
        medidas: f.tiempos.length,
        promedio: f.tiempos.length ? Math.round(f.tiempos.reduce((a, b) => a + b, 0) / f.tiempos.length) : null,
        maximo: f.tiempos.length ? Math.round(Math.max(...f.tiempos)) : null,
        dentro: f.tiempos.length ? Math.round(100 * f.tiempos.filter(x => x <= limite).length / f.tiempos.length) : null
      })).filter(x => x.grupo !== 'Programador').sort((a, b) => b.registradas - a.registradas || b.segundos - a.segundos);
      // Cupo diario del reparto: cuántas lleva hoy cada uno de su cupo (solo si el reparto es por cupos).
      const repartoActual = await ajustesReparto();
      let cuposHoy = null;
      if (repartoActual.reparto_modo === 'cupos') {
        const { cupos, hoy } = await cuposDeHoy();
        cuposHoy = (await receptores()).filter(x => x.grupo !== 'Programador')
          .map(x => ({ usuario: x.usuario, nombre: x.nombre || x.usuario, cupo: cupos.get(x.usuario) || 0, hoy: hoy.get(x.usuario) || 0 }))
          .sort((a, b) => b.cupo - a.cupo || a.nombre.localeCompare(b.nombre));
      }

      // Lo que se está trabajando ahora mismo.
      const enCurso = (await client.query(
        `SELECT t.reserva_id, t.usuario, c.nombre_cliente, c.asunto,
                (SELECT SUM(EXTRACT(EPOCH FROM (COALESCE(x.fin, NOW()) - x.inicio))) FROM tiempo_reserva x WHERE x.reserva_id = t.reserva_id)::int AS segundos
         FROM tiempo_reserva t JOIN clasificacion c ON c.id = t.reserva_id
         WHERE t.fin IS NULL ORDER BY t.inicio`
      )).rows.map(x => ({ ...x, nombre: (nombres.get(x.usuario) || {}).nombre || x.usuario }));

      const serie = dias.filter(d => d >= desdeSerie).map(d => {
        const x = porDia.get(d);
        return { dia: d, correos: x.correos.size, reservas: x.reservas.size, registradas: x.registradas,
          segundos: Math.round(x.segundos), usuarios: x.usuarios };
      });
      const enRango = dias.filter(d => d >= desde).map(d => porDia.get(d));

      // Mejores asesores: del día ("hasta"), del mes elegido y resumen del año. Cada mes empieza en cero;
      // los meses pasados quedan guardados en la auditoría y se consultan con el selector.
      const mesSel = /^\d{4}-\d{2}$/.test(p.get('mes') || '') ? p.get('mes') : hoy.slice(0, 7);
      const anio = mesSel.slice(0, 4);
      const regAnio = (await client.query(
        `SELECT DISTINCT ON (a.entidad_id) a.entidad_id::int AS reserva_id, a.usuario, ${diaAuditoria} AS dia
         FROM auditoria a
         WHERE a.accion = 'cambiar_estado' AND a.nuevo = 'registrada' AND a.entidad = 'reserva'
           AND a.entidad_id ~ '^[0-9]+$' AND ${diaAuditoria} BETWEEN $1 AND $2
         ORDER BY a.entidad_id, a.fecha DESC`, [anio + '-01-01', anio + '-12-31']
      )).rows.filter(r => (nombres.get(r.usuario) || {}).grupo !== 'Programador');
      // El programador no compite en los rankings.
      const regDia = registros.filter(r => r.dia === hasta && (nombres.get(r.usuario) || {}).grupo !== 'Programador');
      const idsRanking = [...new Set([...regAnio, ...regDia].map(r => r.reserva_id))];
      const tiempoRanking = new Map((await client.query(
        `SELECT reserva_id, usuario, SUM(EXTRACT(EPOCH FROM (COALESCE(fin, NOW()) - inicio)))::float AS segundos
         FROM tiempo_reserva WHERE reserva_id = ANY($1::int[]) GROUP BY reserva_id, usuario`, [idsRanking]
      )).rows.map(x => [x.reserva_id + '|' + x.usuario, x.segundos]));
      const nombreDe = usuario => (nombres.get(usuario) || {}).nombre || usuario;
      // Gana quien registró más; si empatan, quien tardó menos en promedio.
      const clasificar = lista => {
        const m = new Map();
        for (const r of lista) {
          const f = m.get(r.usuario) || { usuario: r.usuario, nombre: nombreDe(r.usuario), registradas: 0, tiempos: [] };
          f.registradas++;
          const t = tiempoRanking.get(r.reserva_id + '|' + r.usuario);
          if (t !== undefined) f.tiempos.push(t);
          m.set(r.usuario, f);
        }
        return Array.from(m.values()).map(f => ({
          usuario: f.usuario, nombre: f.nombre, registradas: f.registradas,
          promedio: f.tiempos.length ? Math.round(f.tiempos.reduce((a, b) => a + b, 0) / f.tiempos.length) : null
        })).sort((a, b) => b.registradas - a.registradas
          || (a.promedio === null ? 1 : 0) - (b.promedio === null ? 1 : 0)
          || (a.promedio || 0) - (b.promedio || 0)
          || a.nombre.localeCompare(b.nombre));
      };
      const delMes = clasificar(regAnio.filter(r => r.dia.slice(0, 7) === mesSel));
      const porMes = new Map();
      for (const r of regAnio) {
        const f = porMes.get(r.usuario) || { usuario: r.usuario, nombre: nombreDe(r.usuario), meses: Array(12).fill(0), total: 0 };
        f.meses[Number(r.dia.slice(5, 7)) - 1]++;
        f.total++;
        porMes.set(r.usuario, f);
      }
      const resumenAnio = Array.from(porMes.values()).sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre));
      const meses = (await client.query(
        `SELECT DISTINCT ${diaAuditoria.replace("'YYYY-MM-DD'", "'YYYY-MM'")} AS mes FROM auditoria a
         WHERE a.accion = 'cambiar_estado' AND a.nuevo = 'registrada' AND a.entidad = 'reserva'`
      )).rows.map(x => x.mes);
      const listaMeses = [...new Set([hoy.slice(0, 7), mesSel, ...meses])].sort().reverse();

      return json(res, 200, {
        ranking: {
          dia: hasta, topDia: clasificar(regDia).slice(0, 3),
          mes: mesSel, topMes: delMes.slice(0, 3), totalesMes: delMes,
          anio, resumenAnio, meses: listaMeses
        },
        desde, hasta, limite,
        totales: {
          correos: enRango.reduce((a, x) => a + x.correos.size, 0),
          reservas: enRango.reduce((a, x) => a + x.reservas.size, 0),
          registradas: enRango.reduce((a, x) => a + x.registradas, 0),
          segundos: Math.round(enRango.reduce((a, x) => a + x.segundos, 0)),
          pasadas: usuarios.reduce((a, x) => a + x.pasadas, 0)
        },
        usuarios, serie, enCurso, cuposHoy,
        detalle: detalle.sort((a, b) => (b.segundos || 0) - (a.segundos || 0)).slice(0, 300)
      });
    }

    if (url.startsWith('/api/correo-completo')) {
      const p = new URL(req.url, 'http://localhost').searchParams;
      const idReserva = Number(p.get('id') || 0);

      const filaDe = async id => {
        const fila = (await client.query('SELECT id, message_id, buzon, asunto FROM clasificacion WHERE id = $1', [Number(id)])).rows[0];
        if (!fila) return { error: [404, 'Reserva no encontrada'] };
        if (!fila.message_id) return { error: [400, 'Este correo no tiene identificador en el buzón.'] };
        if (!esMicrosoft(fila.buzon)) return { error: [400, 'El correo completo solo está disponible para el buzón de Microsoft 365.'] };
        return { fila };
      };

      if (req.method === 'GET' && url === '/api/correo-completo') {
        if (!puede('ver_correo_completo')) return json(res, 403, { error: 'No tienes permiso para ver el correo completo.' });
        const { fila, error } = await filaDe(idReserva);
        if (error) return json(res, error[0], { error: error[1] });
        const copia = await leerCopia(fila.message_id);
        if (copia) return json(res, 200, correoParaPanel(copia, 'copia'));
        try {
          const correo = await pedirCorreoEnVivo({ accion: 'correo', message_id: fila.message_id, buzon: fila.buzon });
          return json(res, 200, correoParaPanel(correo, 'vivo'));
        } catch (e) {
          return json(res, 502, { error: e.message });
        }
      }

      if (req.method === 'POST' && url === '/api/correo-completo/guardar') {
        if (!puede('guardar_copia')) return json(res, 403, { error: 'No tienes permiso para guardar copias.' });
        const { id } = await leerCuerpo(req);
        const { fila, error } = await filaDe(id);
        if (error) return json(res, error[0], { error: error[1] });
        try {
          const correo = await pedirCorreoEnVivo({ accion: 'correo', message_id: fila.message_id, buzon: fila.buzon, incluir_adjuntos: true });
          await guardarCopia(fila, correo, false, u.usuario);
        } catch (e) {
          return json(res, 502, { error: e.message });
        }
        await registrar(u, 'guardar_copia', 'reserva', fila.id, '', '', fila.asunto || '');
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url === '/api/correo-completo/adjunto') {
        if (!puede('descargar_adjuntos')) return json(res, 403, { error: 'No tienes permiso para abrir o descargar adjuntos.' });
        const { fila, error } = await filaDe(idReserva);
        if (error) return json(res, error[0], { error: error[1] });
        const adjuntoId = p.get('adjunto') || '';
        const abrir = p.get('modo') === 'ver';
        let guardado = (await client.query('SELECT * FROM correo_adjunto WHERE message_id = $1 AND adjunto_id = $2',
          [fila.message_id, adjuntoId])).rows[0];
        let nombre = guardado ? guardado.nombre : '';
        let datos = null;
        const ruta = guardado && guardado.hash ? rutaArchivo(guardado.hash) : null;
        if (ruta && fs.existsSync(ruta)) {
          datos = fs.readFileSync(ruta);
        } else {
          try {
            const adjunto = await pedirCorreoEnVivo({ accion: 'adjunto', message_id: fila.message_id, buzon: fila.buzon, adjunto_id: adjuntoId });
            nombre = adjunto.nombre;
            if (!TIPOS_ADJUNTO[extension(nombre)]) return json(res, 403, { error: 'Este tipo de archivo está bloqueado por seguridad.' });
            datos = Buffer.from(adjunto.datos || '', 'base64');
            if (guardado) {
              await client.query('UPDATE correo_adjunto SET hash = $3 WHERE message_id = $1 AND adjunto_id = $2',
                [fila.message_id, adjuntoId, guardarArchivo(adjunto.datos || '')]);
            }
          } catch (e) {
            return json(res, 502, { error: e.message });
          }
        }
        if (!TIPOS_ADJUNTO[extension(nombre)]) return json(res, 403, { error: 'Este tipo de archivo está bloqueado por seguridad.' });
        await registrar(u, abrir ? 'abrir_adjunto' : 'descargar_adjunto', 'reserva', fila.id, '', '', nombre);
        return enviarArchivo(res, datos, nombre, abrir);
      }

      return json(res, 404, { error: 'Ruta no encontrada' });
    }

    if (url.startsWith('/api/cache')) {
      if (u.grupo !== 'Programador' && !puede('administrar_usuarios') && !puede('configurar_empresa')) {
        return json(res, 403, { error: 'No tienes permiso para administrar la caché.' });
      }

      if (req.method === 'GET' && url === '/api/cache') {
        const ajustes = (await client.query('SELECT cache_dias, copia_automatica FROM empresa_datos WHERE id = 1')).rows[0] || {};
        const copias = (await client.query(
          'SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE automatica)::int AS automaticas, MIN(guardado) AS primera FROM correo_copia'
        )).rows[0];
        const html = (await client.query('SELECT COALESCE(SUM(LENGTH(html)), 0)::bigint AS b FROM correo_copia')).rows[0];
        const disco = tamanoCarpeta(CACHE_ARCHIVOS);
        const bytes = disco.bytes + Number(html.b);
        return json(res, 200, {
          dias: ajustes.cache_dias, copiaAutomatica: ajustes.copia_automatica,
          correos: copias.n, automaticas: copias.automaticas, primera: copias.primera,
          archivos: disco.archivos, bytes, promedio: copias.n ? Math.round(bytes / copias.n) : 0,
          carpeta: CACHE
        });
      }

      if (req.method === 'POST' && url === '/api/cache/ajustes') {
        const { dias, copiaAutomatica } = await leerCuerpo(req);
        const n = Number(dias);
        if (!Number.isInteger(n) || n < 1 || n > 3650) return json(res, 400, { error: 'Escribe un número de días entre 1 y 3650.' });
        await client.query('UPDATE empresa_datos SET cache_dias = $1, copia_automatica = $2 WHERE id = 1', [n, Boolean(copiaAutomatica)]);
        await registrar(u, 'ajustar_cache', 'cache', '', '', { dias: n, copiaAutomatica: Boolean(copiaAutomatica) });
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/cache/borrar') {
        const { todo } = await leerCuerpo(req);
        const dias = (await client.query('SELECT cache_dias FROM empresa_datos WHERE id = 1')).rows[0].cache_dias;
        const borradas = await borrarCopias(todo ? null : dias);
        await registrar(u, 'borrar_cache', 'cache', '', '', '', todo ? `Toda la caché (${borradas} correos)` : `Copias de más de ${dias} días (${borradas} correos)`);
        return json(res, 200, { ok: true, borradas });
      }

      return json(res, 404, { error: 'Ruta no encontrada' });
    }

    if (url.startsWith('/api/exportar')) {
      if (!puede('exportar_datos')) return json(res, 403, { error: 'No tienes permiso para exportar.' });

      if (req.method === 'GET' && url === '/api/exportar/usuarios') {
        const r = await client.query('SELECT usuario, nombre FROM usuarios ORDER BY nombre');
        return json(res, 200, r.rows);
      }

      if (req.method === 'GET' && url === '/api/exportar') {
        const p = new URL(req.url, 'http://localhost').searchParams;
        const desde = p.get('desde') || '';
        const hasta = p.get('hasta') || '';
        const usuario = p.get('usuario') || '';
        const fechaValida = f => /^\d{4}-\d{2}-\d{2}$/.test(f);
        if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) {
          return json(res, 400, { error: 'Elige un rango de fechas válido.' });
        }
        const columnas = `c.id, c.categoria, c.agencia, c.remitente, c.asunto, c.fecha, c.estado, c.aeropuerto, c.actividad,
          c.nombre_cliente, c.telefono, c.tipo_servicio, c.fecha_servicio, c.hora_servicio, c.vuelo, c.hotel, c.adultos, c.ninos, c.infantes`;
        if (!usuario) {
          // Todos: correos recibidos en esas fechas.
          const r = await client.query(`SELECT ${columnas} FROM clasificacion c ORDER BY c.id`);
          const filas = r.rows.filter(x => {
            const dia = diaLocal(x.fecha);
            return dia && dia >= desde && dia <= hasta;
          });
          await registrar(u, 'exportar', 'reservas', '', '', '', `Todos, ${desde} a ${hasta}, ${filas.length} filas`);
          return json(res, 200, filas);
        }
        // Un usuario: lo que ese usuario hizo en esas fechas (hora de República Dominicana).
        const diaAccion = `TO_CHAR((a.fecha AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${ZONA_HORARIA}', 'YYYY-MM-DD')`;
        const r = await client.query(
          `SELECT ${columnas}, a.usuario AS accion_usuario, a.nombre AS accion_nombre, a.accion, a.anterior, a.nuevo,
                  TO_CHAR((a.fecha AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE '${ZONA_HORARIA}', 'YYYY-MM-DD HH24:MI') AS accion_fecha
           FROM auditoria a
           JOIN clasificacion c ON a.entidad = 'reserva' AND a.entidad_id = c.id::text
           WHERE a.usuario = $1
             AND a.accion IN ('cambiar_estado', 'editar_agencia', 'responder_correo')
             AND ${diaAccion} BETWEEN $2 AND $3
           ORDER BY a.fecha, a.id`,
          [usuario, desde, hasta]
        );
        await registrar(u, 'exportar', 'reservas', '', '', '', `${usuario}, ${desde} a ${hasta}, ${r.rowCount} filas`);
        return json(res, 200, r.rows);
      }

      return json(res, 404, { error: 'Ruta no encontrada' });
    }

    if (url.startsWith('/api/correo')) {
      if (req.method === 'GET' && url === '/api/correo/buzones') {
        if (!puede('responder_correo') && !puede('enviar_correo')) {
          return json(res, 403, { error: 'No tienes permiso para enviar correos.' });
        }
        if (config.demo) return json(res, 200, [require('./plataforma/demo').BUZON]);
        return json(res, 200, [...new Set([...buzonesMicrosoftEnvio(), ...Object.keys(config.correo || {})])]);
      }

      if (req.method === 'POST' && url === '/api/correo/responder') {
        if (!puede('responder_correo')) return json(res, 403, { error: 'No tienes permiso para responder correos.' });
        const { id, texto: respuesta, adjuntos } = await leerCuerpo(req);
        const limpio = String(respuesta || '').trim();
        if (!limpio || limpio.length > 5000) return json(res, 400, { error: 'El mensaje debe tener entre 1 y 5000 caracteres.' });
        const archivos = adjuntosParaEnviar(adjuntos);
        if (archivos.error) return json(res, 400, { error: archivos.error });
        const fila = (await client.query(
          'SELECT id, remitente, asunto, message_id, buzon, cuerpo, fecha FROM clasificacion WHERE id = $1', [Number(id)]
        )).rows[0];
        if (!fila) return json(res, 404, { error: 'Reserva no encontrada' });
        const para = emailDeRemitente(fila.remitente);
        if (!para) return json(res, 400, { error: 'No se encontró un correo válido del remitente.' });
        const detalleAdjuntos = archivos.adjuntos.length ? '. Adjuntos: ' + archivos.adjuntos.map(a => a.filename).join(', ') : '';
        if (esMicrosoft(fila.buzon)) {
          // Microsoft 365: la respuesta va dentro de la misma conversación y queda en Elementos enviados.
          if (!config.demo && !buzonesMicrosoftEnvio().includes(fila.buzon)) {
            return json(res, 400, { error: 'El envío desde ' + fila.buzon + ' no está configurado (flujo "Enviar correo" en config.js).' });
          }
          try {
            await enviarPorMicrosoft({ accion: 'responder', buzon: fila.buzon, message_id: fila.message_id, texto: limpio }, archivos.adjuntos);
          } catch (e) {
            return json(res, e.codigo || 502, { error: e.message });
          }
          await registrar(u, 'responder_correo', 'reserva', fila.id, '', para, 'Respuesta enviada desde ' + fila.buzon + detalleAdjuntos);
          return json(res, 200, { ok: true });
        }
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
        try {
          await enviarPorSmtp(salida, {
            from: `"${salida.nombre}" <${fila.buzon}>`,
            to: para, subject: asunto, text: cuerpoCompleto, headers: cabeceras, attachments: archivos.adjuntos
          });
        } catch (e) {
          return json(res, e.codigo || 502, { error: e.message });
        }
        await registrar(u, 'responder_correo', 'reserva', fila.id, '', para, 'Respuesta enviada desde ' + fila.buzon + detalleAdjuntos);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/correo/nuevo') {
        if (!puede('enviar_correo')) return json(res, 403, { error: 'No tienes permiso para enviar correos nuevos.' });
        const { buzon, para, asunto, texto: cuerpoNuevo, adjuntos } = await leerCuerpo(req);
        const destino = emailDeRemitente(para);
        if (!destino) return json(res, 400, { error: 'Escribe un correo de destino válido.' });
        const limpio = String(cuerpoNuevo || '').trim();
        const tema = String(asunto || '').trim();
        if (!limpio || !tema) return json(res, 400, { error: 'El asunto y el mensaje son obligatorios.' });
        const archivos = adjuntosParaEnviar(adjuntos);
        if (archivos.error) return json(res, 400, { error: archivos.error });
        const detalleAdjuntos = archivos.adjuntos.length ? '. Adjuntos: ' + archivos.adjuntos.map(a => a.filename).join(', ') : '';
        if (config.demo || buzonesMicrosoftEnvio().includes(buzon)) {
          try {
            await enviarPorMicrosoft({ accion: 'nuevo', buzon, para: destino, asunto: tema, texto: limpio }, archivos.adjuntos);
          } catch (e) {
            return json(res, e.codigo || 502, { error: e.message });
          }
          await registrar(u, 'enviar_correo', 'correo', destino, '', tema, 'Enviado desde ' + buzon + detalleAdjuntos);
          return json(res, 200, { ok: true });
        }
        const salida = transporteDe(buzon);
        if (!salida) return json(res, 400, { error: 'Esa cuenta no está configurada para enviar correos.' });
        try {
          await enviarPorSmtp(salida, { from: `"${salida.nombre}" <${buzon}>`, to: destino, subject: tema, text: limpio, attachments: archivos.adjuntos });
        } catch (e) {
          return json(res, e.codigo || 502, { error: e.message });
        }
        await registrar(u, 'enviar_correo', 'correo', destino, '', tema, 'Enviado desde ' + buzon + detalleAdjuntos);
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
