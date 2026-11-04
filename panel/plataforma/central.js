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

const RESERVADOS = new Set(['admin', 'www', 'api', 'app', 'mail', 'correo', 'central', 'kaizen', 'panel', 'chat', 'n8n', 'pruebas']);
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

  async function preparar() {
    if (!activo) return;
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

  async function manejar(req, res, url, u, { json, leerCuerpo }) {
    if (!activo) return json(res, 404, { error: 'Este panel no es el central.' });
    if (u.grupo !== 'Programador') return json(res, 403, { error: 'Solo el programador puede usar Empresas.' });
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

  return { activo, preparar, iniciar, manejar };
};
