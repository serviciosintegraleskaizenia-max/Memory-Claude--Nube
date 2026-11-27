// Oficina de Kaizen IA: la pantalla de administración del dueño (solo en el panel central, solo el programador).
// Clientes y cobros, gastos (servidor, dominio, IA, redes, automatizaciones...), calendario, estado de cada negocio
// (panel, n8n, motor, IA, alertas), chat con la gente de cada negocio y enlaces.
//
// Todo se guarda en la base del central. De cada empresa solo se LEE su base (y se escribe el chat y el "pagado").

const { hoyLocal } = require('./cuenta');
const crypto = require('crypto');
const crearConocimiento = require('./conocimiento');
const crearRedes = require('./redes');
const crearProyectos = require('./proyectos');
const caja = require('./caja');
const crearApps = require('./apps');
const fsR = require('fs');
const pathR = require('path');
const { spawn: spawnR } = require('child_process');

// Respaldo (botón "Respaldar ahora"): corre respaldo-zentralia.js aparte y lee su estado.
const CARPETA_RESPALDO = process.env.RESPALDO_BASE || 'C:\\Respaldos Zentralia';
const SCRIPT_RESPALDO = pathR.join(__dirname, '..', 'respaldo-zentralia.js');
// En el servidor (Linux) el respaldo lo hace systemd como root (servidor/respaldo-servidor.js): la Oficina solo
// deja el archivo "pedir-respaldo" y lee el estado. La PC baja la copia y avisa en pc-recibido.json.
const enServidor = () => process.platform !== 'win32' && fsR.existsSync(pathR.join(CARPETA_RESPALDO, 'servidor-configurado'));
function estadoRespaldo() {
  const leer = f => { try { return JSON.parse(fsR.readFileSync(pathR.join(CARPETA_RESPALDO, f), 'utf8')); } catch (e) { return null; } };
  const enCurso = leer('respaldo-en-curso.json');
  const servidor = enServidor();
  return {
    disponible: servidor || fsR.existsSync(SCRIPT_RESPALDO), windows: process.platform === 'win32', servidor,
    configurado: servidor || fsR.existsSync(pathR.join(CARPETA_RESPALDO, 'clave-respaldo.dat')) || Boolean(process.env.RESPALDO_CLAVE),
    enCurso: enCurso && Date.now() - Date.parse(enCurso.inicio) < 2 * 3600 * 1000 ? enCurso
      : servidor && fsR.existsSync(pathR.join(CARPETA_RESPALDO, 'pedir-respaldo')) ? { inicio: new Date().toISOString(), pedido: true } : null,
    ultimo: leer('ultimo-respaldo.json'),
    pc: servidor ? leer('pc-recibido.json') : null
  };
}

const CATEGORIAS = {
  servidor: 'Servidor', dominio: 'Dominio', ia: 'IA (tokens)', redes: 'Redes sociales', automatizacion: 'Automatizaciones',
  hosting: 'Hosting y página web', software: 'Programas y suscripciones', publicidad: 'Publicidad (Meta, Google…)', otro: 'Otro'
};
const FRECUENCIAS = { mensual: 'Cada mes', anual: 'Cada año', unico: 'Una sola vez' };
// Dos administraciones: Kaizen IA (sus clientes, sin reparto) y Centralia (reparto 60/40 con el socio).
const ADMINISTRACIONES = ['kaizen', 'centralia'];
// Quién paga un gasto de la plataforma: clientes con su porcentaje (la suma no puede pasar de 100 %).
function pagadoresDe(f) {
  if (f.administracion !== 'plataforma') return [];
  const lista = (Array.isArray(f.pagadores) ? f.pagadores : []).map(x => ({ empresa_id: Number(x.empresa_id) || 0, pct: Math.round((Number(x.pct) || 0) * 100) / 100 })).filter(x => x.empresa_id && x.pct > 0).slice(0, 20);
  const suma = Math.round(lista.reduce((t, x) => t + x.pct, 0) * 100) / 100;
  if (suma > 100.01) throw Object.assign(new Error(`Los porcentajes de quien lo paga suman ${suma} %: no pueden pasar de 100 %.`), { codigo: 400 });
  return lista;
}
const TIPOS_EVENTO = { tarea: 'Tarea', demo: 'Demo', cita: 'Cita / llamada', cobro: 'Cobro', otro: 'Otro' };
const ESTADOS_ABIERTOS = ['pendiente de transcribir', 'revisar', 'actualizada'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const ENLACES_INICIALES = [
  ['Infraestructura', 'Cloudflare', 'https://dash.cloudflare.com', '☁️', 'Túnel, portero y dominio', false],
  ['Infraestructura', 'n8n', 'https://automatizacion.kaizenia.app', '⚙️', 'Flujos de correo y automatizaciones', true],
  ['Infraestructura', 'Chatwoot', 'https://chat.kaizenia.app', '💬', 'Redes sociales de los clientes', false],
  ['Infraestructura', 'Hostinger', 'https://hpanel.hostinger.com', '🖥️', 'Servidor', false],
  ['Infraestructura', 'OpenRouter', 'https://openrouter.ai/settings/credits', '🤖', 'Saldo y claves de IA', false],
  ['Infraestructura', 'Azure / Microsoft 365', 'https://portal.azure.com', '🔐', 'Permisos de correo', false],
  ['Infraestructura', 'GitHub', 'https://github.com', '🐙', 'Código', false],
  ['Cobros', 'PayPal', 'https://www.paypal.com', '🅿️', 'Cobros', false],
  ['Mi negocio', 'Mi página web', 'https://kaizenia.app', '🌐', 'kaizenia.app', false]
];

function texto(v, max = 200) { return String(v ?? '').trim().slice(0, max); }
function monto(v) { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
function fechaValida(v) { return /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(Date.parse(v + 'T12:00:00Z')); }
function moneda(v) { const m = texto(v, 5); return m || 'US$'; }
function sumar(obj, mon, n) { if (n) obj[mon] = Math.round(((obj[mon] || 0) + n) * 100) / 100; }
function mesMas(mes, n) { const d = new Date(mes + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
function nombreMes(mes) { return MESES[Number(mes.slice(5, 7)) - 1] + ' ' + mes.slice(0, 4); }
const pad = n => String(n).padStart(2, '0');

module.exports = function crearOficina({ client, config, registrar, central }) {
  const activo = central.activo;
  const A = central.ayudantes;
  // Base de conocimiento del asistente de redes (tarifarios, fichas y notas de cada empresa).
  const conocimiento = crearConocimiento({ client, config, registrar, central, claveIA: e => claveDe(e) });

  // Llaves que Oficina manda a cada empresa (tabla zentralia_ajustes del panel de la empresa).
  const CLAVE_APIS = { Vuelos: 'api_vuelos', Mapas: 'api_mapas' };
  async function enviarLlaveAEmpresa(empresaId, clave, valor) {
    const e = await A.empresa(empresaId);
    if (!e || !clave || e.sin_panel) return;
    await A.conEmpresa(e, async db => {
      await db.query("CREATE TABLE IF NOT EXISTS zentralia_ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL DEFAULT '')");
      await db.query('INSERT INTO zentralia_ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor', [clave, valor]);
    });
  }
  // APIs y suscripciones: las llaves se guardan cifradas (AES-256-GCM) con una clave derivada del secreto del panel.
  const llaveApis = () => crypto.createHash('sha256').update('apis|' + String((config.sesion && config.sesion.secreto) || 'zentralia')).digest();
  function cifrarLlave(t) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', llaveApis(), iv);
    const x = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), x]).toString('base64');
  }
  // Conector con Chatwoot: el asistente sugiere (o responde) en Facebook, Instagram y WhatsApp.
  const redes = crearRedes({ client, registrar, central, conocimiento });
  // Gastos de creación de cada sistema y reparto entre socios (aparte de los gastos del negocio).
  const proyectos = crearProyectos({ client });
  // Apps instalables (PWA) para probar y publicar desde la Oficina.
  const apps = crearApps({ client, registrar });
  const apiExterna = require('./api-externa');

  async function preparar() {
    if (!activo) return;
    await conocimiento.preparar();
    await redes.preparar();
    await proyectos.preparar();
    await apps.preparar();
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_apis (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL DEFAULT 0, nombre TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'Otro',
      proveedor TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'Gratis', costo_mensual NUMERIC NOT NULL DEFAULT 0,
      limite_mes INTEGER, renovacion DATE, llave_enc TEXT, llave_fin TEXT, creado TIMESTAMP NOT NULL DEFAULT NOW(), actualizado TIMESTAMP)`);
    for (const col of ['plan', 'contacto', 'telefono', 'correo_contacto', 'ia_clave', 'n8n_clave', 'correo_lectura', 'correo_host', 'correo_clave']) {
      await client.query(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ${col} TEXT NOT NULL DEFAULT ''`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_pagos (
      id SERIAL PRIMARY KEY, empresa_id INTEGER, concepto TEXT NOT NULL, monto NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda VARCHAR(5) NOT NULL DEFAULT 'US$', vence DATE NOT NULL, pagado_el DATE, forma TEXT NOT NULL DEFAULT '',
      nota TEXT NOT NULL DEFAULT '', auto_mes VARCHAR(7), creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS oficina_pagos_auto ON oficina_pagos (empresa_id, auto_mes) WHERE auto_mes IS NOT NULL');
    // Mensualidades automáticas que el usuario borró: no se vuelven a crear.
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_cobros_borrados (
      empresa_id INTEGER NOT NULL, auto_mes VARCHAR(7) NOT NULL, borrado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (empresa_id, auto_mes))`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_diseno (usuario TEXT PRIMARY KEY, diseno JSONB NOT NULL, actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_gastos (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, categoria VARCHAR(20) NOT NULL DEFAULT 'otro', monto NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda VARCHAR(5) NOT NULL DEFAULT 'US$', frecuencia VARCHAR(10) NOT NULL DEFAULT 'mensual', dia INTEGER, fecha DATE,
      empresa_id INTEGER, url TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', activo BOOLEAN NOT NULL DEFAULT TRUE,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_administraciones (
      clave VARCHAR(20) PRIMARY KEY, nombre TEXT NOT NULL DEFAULT '', legal TEXT NOT NULL DEFAULT '', documento TEXT NOT NULL DEFAULT '',
      direccion TEXT NOT NULL DEFAULT '', correo TEXT NOT NULL DEFAULT '', telefono TEXT NOT NULL DEFAULT '', web TEXT NOT NULL DEFAULT '',
      logo TEXT NOT NULL DEFAULT '', actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query("INSERT INTO oficina_administraciones (clave, nombre) VALUES ('kaizen', 'Kaizen IA'), ('centralia', 'Centralia') ON CONFLICT (clave) DO NOTHING");
    await client.query("ALTER TABLE oficina_gastos ADD COLUMN IF NOT EXISTS administracion VARCHAR(20) NOT NULL DEFAULT 'kaizen'");
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS administracion VARCHAR(20) NOT NULL DEFAULT 'kaizen'");
    await client.query("ALTER TABLE oficina_gastos ADD COLUMN IF NOT EXISTS pagadores JSONB NOT NULL DEFAULT '[]'::jsonb");
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS logo TEXT NOT NULL DEFAULT ''");
    // Nombre que se muestra en Oficina (editable) y razón social legal (sale en los recibos).
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS nombre_oficina TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS razon_social TEXT NOT NULL DEFAULT ''");
    // Etiquetas editables de la parte de cada socio en el reparto.
    await client.query("ALTER TABLE oficina_administraciones ADD COLUMN IF NOT EXISTS etiqueta_mia TEXT NOT NULL DEFAULT 'Mi parte'");
    await client.query("ALTER TABLE oficina_administraciones ADD COLUMN IF NOT EXISTS etiqueta_socio TEXT NOT NULL DEFAULT 'Parte del socio'");
    for (const col of ['documento TEXT', 'pais TEXT', 'direccion TEXT', 'web TEXT', 'redes TEXT']) {
      await client.query(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ${col} NOT NULL DEFAULT ''`);
    }
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS metodos_pago TEXT NOT NULL DEFAULT '[]'");
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS plan_cobro TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE oficina_administraciones ADD COLUMN IF NOT EXISTS socio_nombre TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE oficina_administraciones ADD COLUMN IF NOT EXISTS socio_documento TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE oficina_administraciones ADD COLUMN IF NOT EXISTS socio_porcentaje NUMERIC");
    await client.query("ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS comprobante TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS comprobante_nombre TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS recibo_id INTEGER");
    await client.query("ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS referencia TEXT NOT NULL DEFAULT ''");
    await client.query('ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS proyecto_id INTEGER');
    await client.query('ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS recibido NUMERIC(12,2)');
    await client.query("ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS descuentos JSONB NOT NULL DEFAULT '[]'::jsonb");
    // Cobro en otra moneda: cuánto llegó en US$. Programa (plan) y líneas del recibo.
    await client.query('ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS recibido_usd NUMERIC(12,2)');
    await client.query('ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS plan_id INTEGER');
    await client.query("ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS lineas JSONB NOT NULL DEFAULT '[]'::jsonb");
    // Los gastos que estaban en Kaizen IA son de la plataforma (los usan todos los sistemas). Se pasan una sola vez.
    await client.query("CREATE TABLE IF NOT EXISTS oficina_migraciones (clave TEXT PRIMARY KEY, hecho TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    if (!(await client.query("SELECT 1 FROM oficina_migraciones WHERE clave = 'gastos_plataforma'")).rowCount) {
      await client.query("UPDATE oficina_gastos SET administracion = 'plataforma' WHERE administracion = 'kaizen'");
      await client.query("INSERT INTO oficina_migraciones (clave) VALUES ('gastos_plataforma')");
    }
    // Recibos numerados por administración: de cliente (pago recibido) y de socio (retiro de utilidades).
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_recibos (
      id SERIAL PRIMARY KEY, administracion VARCHAR(20) NOT NULL, numero INTEGER NOT NULL, tipo VARCHAR(10) NOT NULL,
      pago_id INTEGER, empresa_id INTEGER, socio TEXT NOT NULL DEFAULT '', monto NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda VARCHAR(5) NOT NULL DEFAULT 'US$', concepto TEXT NOT NULL DEFAULT '', metodo TEXT NOT NULL DEFAULT '',
      referencia TEXT NOT NULL DEFAULT '', fecha DATE NOT NULL, periodo VARCHAR(7) NOT NULL DEFAULT '',
      detalle JSONB NOT NULL DEFAULT '{}'::jsonb, creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (administracion, numero))`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_eventos (
      id SERIAL PRIMARY KEY, titulo TEXT NOT NULL, fecha DATE NOT NULL, hora VARCHAR(5) NOT NULL DEFAULT '',
      tipo VARCHAR(10) NOT NULL DEFAULT 'tarea', empresa_id INTEGER, nota TEXT NOT NULL DEFAULT '', hecho BOOLEAN NOT NULL DEFAULT FALSE,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_enlaces (
      id SERIAL PRIMARY KEY, grupo TEXT NOT NULL DEFAULT 'Otros', nombre TEXT NOT NULL, url TEXT NOT NULL, icono VARCHAR(8) NOT NULL DEFAULT '🔗',
      nota TEXT NOT NULL DEFAULT '', vigilar BOOLEAN NOT NULL DEFAULT FALSE, orden INTEGER NOT NULL DEFAULT 0,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // Gastos ya pagados en una fecha (para apagar la alarma de ese vencimiento).
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_gastos_pagados (
      gasto_id INTEGER NOT NULL, vence DATE NOT NULL, pagado TIMESTAMPTZ NOT NULL DEFAULT NOW(), usuario TEXT NOT NULL DEFAULT '', PRIMARY KEY (gasto_id, vence))`);
    // Clientes de automatización (redes sociales): su flujo de n8n, su Chatwoot y otros accesos.
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_automatizaciones (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, estado VARCHAR(10) NOT NULL DEFAULT 'activo', redes JSONB NOT NULL DEFAULT '[]',
      flujo_url TEXT NOT NULL DEFAULT '', chat_url TEXT NOT NULL DEFAULT '', enlaces JSONB NOT NULL DEFAULT '[]', contacto TEXT NOT NULL DEFAULT '',
      nota TEXT NOT NULL DEFAULT '', orden INTEGER NOT NULL DEFAULT 0, creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_ia_uso (
      empresa_id INTEGER NOT NULL, dia DATE NOT NULL, uso NUMERIC(14,6) NOT NULL, PRIMARY KEY (empresa_id, dia))`);
    if (!(await client.query('SELECT COUNT(*)::int AS n FROM oficina_enlaces')).rows[0].n) {
      let orden = 0;
      for (const [grupo, nombre, url, icono, nota, vigilar] of ENLACES_INICIALES) {
        await client.query('INSERT INTO oficina_enlaces (grupo, nombre, url, icono, nota, vigilar, orden) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [grupo, nombre, url, icono, nota, vigilar, orden++]);
      }
    }
    // Íconos que Windows no dibuja (salía un cuadrito): se cambian por unos que se ven en todas partes.
    await client.query("UPDATE oficina_enlaces SET icono = '🤖' WHERE icono = '🪙'");
    await client.query("UPDATE oficina_enlaces SET icono = '🔐' WHERE icono = '🪟'");
    // Las direcciones de internet de n8n, Chatwoot y el panel del servidor (antes apuntaban a localhost, que solo abre dentro del servidor).
    await client.query("UPDATE oficina_enlaces SET url = 'https://automatizacion.kaizenia.app' WHERE url ~* '^https?://(localhost|127\\.0\\.0\\.1):5678'");
    await client.query("UPDATE oficina_enlaces SET url = 'https://chat.kaizenia.app' WHERE url ~* '^https?://(localhost|127\\.0\\.0\\.1):3000'");
    await client.query(`INSERT INTO oficina_enlaces (grupo, nombre, url, icono, nota, vigilar, orden)
      SELECT 'Infraestructura', 'Panel del servidor', 'https://servidor.kaizenia.app', '🖥️', 'Ver, encender y apagar cada programa', FALSE, (SELECT COALESCE(MAX(orden), 0) + 1 FROM oficina_enlaces)
      WHERE NOT EXISTS (SELECT 1 FROM oficina_enlaces WHERE url ILIKE '%servidor.kaizenia.app%')`);
  }

  // Consulta a la base de una empresa que no falla si la tabla todavía no existe (versión vieja del panel).
  const q = async (db, sql, vals = [], porDefecto = []) => { try { return (await db.query(sql, vals)).rows; } catch (e) { return porDefecto; } };

  // ---------- IA: gasto de cada empresa con su propia clave de OpenRouter ----------

  const cacheClaves = new Map();
  // Cada petición a OpenRouter tiene su propio límite de tiempo. Si OpenRouter no responde, la Oficina no se queda esperando.
  async function pedirOpenRouter(ruta, clave) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 5000);
    try {
      const r = await fetch(A.OPENROUTER + ruta, { headers: { Authorization: 'Bearer ' + clave }, signal: control.signal });
      return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
    } finally { clearTimeout(reloj); }
  }
  async function consultarClave(clave) {
    const guardado = cacheClaves.get(clave);
    if (guardado && Date.now() - guardado.t < 50 * 1000) return guardado.datos; // en vivo: como mucho 50 segundos de atraso
    let datos = null;
    try {
      const k = await pedirOpenRouter('/key', clave);
      datos = k.ok ? (k.json || {}).data || null : { error: 'OpenRouter respondió ' + k.status + (k.status === 401 ? ' (clave no válida)' : '') };
      // Créditos de la cuenta en vivo: lo recargado en total y lo gastado (el saldo real de OpenRouter).
      if (datos && !datos.error) {
        try {
          const rc = await pedirOpenRouter('/credits', clave);
          const c = rc.ok ? (rc.json || {}).data || {} : null;
          datos.cuenta = c && typeof c.total_credits === 'number' ? { recargado: c.total_credits, usado: Number(c.total_usage) || 0 } : { error: rc.ok ? 'sin datos' : 'OpenRouter no da el saldo con esta clave (' + rc.status + ')' };
        } catch (e) { datos.cuenta = { error: 'No se pudo leer el saldo (OpenRouter tardó)' }; }
      }
    } catch (e) { datos = { error: 'OpenRouter tardó o no respondió' }; }
    cacheClaves.set(clave, { t: Date.now(), datos });
    return datos;
  }

  function claveDe(e) {
    if (e.ia_clave) return e.ia_clave;
    if (e.externa) return '';
    try { const a = A.leerAjustes(e); return (a && a.openrouter && a.openrouter.apiKey) || ''; } catch (err) { return ''; }
  }

  async function gastoIA(e, mes) {
    const clave = claveDe(e);
    if (!clave) return { tiene: false };
    const d = await consultarClave(clave);
    if (!d || d.error) return { tiene: true, error: (d && d.error) || 'Sin datos' };
    const uso = Number(d.usage) || 0;
    // Una foto por día del uso total: así se calcula el gasto del mes aunque OpenRouter no lo dé.
    await client.query('INSERT INTO oficina_ia_uso (empresa_id, dia, uso) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [e.id, hoyLocal(), uso]).catch(() => {});
    let delMes = null;
    if (mes === hoyLocal().slice(0, 7) && typeof d.usage_monthly === 'number') delMes = d.usage_monthly;
    else {
      const inicio = (await client.query('SELECT uso FROM oficina_ia_uso WHERE empresa_id = $1 AND dia >= $2 ORDER BY dia LIMIT 1', [e.id, mes + '-01'])).rows[0];
      const fin = (await client.query('SELECT uso FROM oficina_ia_uso WHERE empresa_id = $1 AND dia < $2 ORDER BY dia DESC LIMIT 1', [e.id, mesMas(mes, 1) + '-01'])).rows[0];
      if (inicio && fin) delMes = Math.max(0, Number(fin.uso) - Number(inicio.uso));
    }
    return {
      tiene: true, delMes: delMes === null ? null : Math.round(delMes * 100) / 100, total: Math.round(uso * 100) / 100,
      limite: d.limit ?? null, restante: d.limit_remaining ?? null, hoy: typeof d.usage_daily === 'number' ? Math.round(d.usage_daily * 100) / 100 : null,
      cuenta: d.cuenta && !d.cuenta.error ? { recargado: Math.round(d.cuenta.recargado * 100) / 100, usado: Math.round(d.cuenta.usado * 100) / 100, saldo: Math.round((d.cuenta.recargado - d.cuenta.usado) * 100) / 100 } : null,
      cuentaError: d.cuenta && d.cuenta.error ? d.cuenta.error : ''
    };
  }

  // Diseño del panel «Todo» de Administración (por usuario): orden, ancho y campos visibles. Solo acepta lo conocido.
  const BLOQUES_DISENO = ['clientes', 'cobros', 'sistemas', 'resumen'];
  const CAMPOS_DISENO = { clientes: ['cl.kpis', 'cl.resta', 'cl.pct', 'cl.estado'], cobros: ['co.kpis', 'co.cobros', 'co.gastos', 'co.fijos', 'co.reparto'], sistemas: ['si.horas', 'si.costo'], resumen: ['re.kpis', 're.calendario', 're.horas', 're.tipos', 're.debe'] };
  const POS_DISENO = { clientes: { x: 0, y: 0, w: 6, h: 10 }, cobros: { x: 6, y: 0, w: 6, h: 26 }, sistemas: { x: 0, y: 10, w: 6, h: 12 }, resumen: { x: 6, y: 26, w: 6, h: 30 } };
  function limpiarDisenoOficina(d) {
    if (!d || typeof d !== 'object') return null;
    const ent = (v, a, z, def) => (Number.isInteger(v) ? Math.min(z, Math.max(a, v)) : def);
    const bloques = {};
    for (const b of BLOQUES_DISENO) {
      const o = (d.bloques && d.bloques[b]) || {}, pos = POS_DISENO[b];
      const campos = {};
      for (const c of CAMPOS_DISENO[b]) campos[c] = c === 'cl.kpis' ? (o.campos && o.campos[c]) === true : (o.campos && o.campos[c]) !== false;
      const x = ent(o.x, 0, 11, pos.x), w = Math.min(ent(o.w, 3, 12, pos.w), 12 - x);
      bloques[b] = { x, y: ent(o.y, 0, 200, pos.y), w, h: ent(o.h, 4, 80, pos.h), campos };
    }
    return { bloques };
  }

  // ---------- Cobros: cada mes se crea solo el cobro de cada cliente con cuota ----------

  async function generarCobros(empresas) {
    const mesHoy = hoyLocal().slice(0, 7);
    for (const e of empresas) {
      const p = e.pago || {};
      const valor = monto(p.monto);
      if (e.es_demo || !p.activo || !valor) continue;
      let mes = /^\d{4}-\d{2}$/.test(p.desde || '') ? p.desde : mesHoy;
      if (mes < mesMas(mesHoy, -11)) mes = mesMas(mesHoy, -11);
      for (; mes <= mesHoy; mes = mesMas(mes, 1)) {
        const vence = `${mes}-${pad(Math.min(28, Math.max(1, Number(p.dia) || 1)))}`;
        await client.query(`INSERT INTO oficina_pagos (empresa_id, concepto, monto, moneda, vence, auto_mes)
          SELECT $1::int, $2::text, $3::numeric, $4::varchar, $5::date, $6::varchar WHERE NOT EXISTS (SELECT 1 FROM oficina_cobros_borrados b WHERE b.empresa_id = $1::int AND b.auto_mes = $6::varchar)
          ON CONFLICT DO NOTHING`, [e.id, 'Mensualidad ' + nombreMes(mes), valor, moneda(p.moneda), vence, mes]);
      }
      // Si en el panel de la empresa ya se marcó pagado un mes (desde Empresas), aquí también queda pagado.
      if (e.cuenta && /^\d{4}-\d{2}$/.test(e.cuenta.pagado || '')) {
        await client.query(`UPDATE oficina_pagos SET pagado_el = vence, forma = 'Registrado en Empresas'
          WHERE empresa_id = $1 AND auto_mes IS NOT NULL AND auto_mes <= $2 AND pagado_el IS NULL`, [e.id, e.cuenta.pagado]);
      }
    }
  }

  // ---------- Alarma de pagos: desde 2 días antes del vencimiento hasta que se marque pagado (máx. 5 días después) ----------
  const DIAS_ANTES = 2, DIAS_DESPUES = 5;
  async function alarmasGastos() {
    const hoy = hoyLocal();
    const dif = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
    const gastos = (await client.query("SELECT id, nombre, monto, moneda, frecuencia, dia, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, url, categoria FROM oficina_gastos WHERE activo")).rows;
    const pagados = new Set((await client.query("SELECT gasto_id || ':' || TO_CHAR(vence, 'YYYY-MM-DD') AS k FROM oficina_gastos_pagados WHERE vence >= $1::date - 40", [hoy])).rows.map(r => r.k));
    const lista = [];
    for (const g of gastos) {
      const fechas = [];
      if (g.frecuencia === 'mensual' && g.dia) for (const m of [mesMas(hoy.slice(0, 7), -1), hoy.slice(0, 7), mesMas(hoy.slice(0, 7), 1)]) fechas.push(m + '-' + String(Math.min(28, g.dia)).padStart(2, '0'));
      else if (g.frecuencia === 'anual' && g.fecha) for (const y of [-1, 0, 1]) fechas.push((Number(hoy.slice(0, 4)) + y) + g.fecha.slice(4));
      else if (g.fecha) fechas.push(g.fecha);
      for (const vence of fechas) {
        const dias = dif(vence, hoy);
        if (dias > DIAS_ANTES || dias < -DIAS_DESPUES || pagados.has(g.id + ':' + vence)) continue;
        lista.push({ id: g.id, nombre: g.nombre, monto: Number(g.monto), moneda: g.moneda, vence, dias, url: g.url || '', categoria: g.categoria });
      }
    }
    return lista.sort((a, b) => a.dias - b.dias);
  }

  // ---------- Gastos de un mes ----------

  function gastoDelMes(g, mes) {
    if (!g.activo) return 0;
    const valor = Number(g.monto) || 0;
    const creado = new Date(g.creado).toISOString().slice(0, 7);
    if (g.frecuencia === 'mensual') return creado <= mes ? valor : 0;
    if (!g.fecha) return 0;
    const f = new Date(g.fecha).toISOString().slice(0, 10);
    if (g.frecuencia === 'anual') return f.slice(5, 7) === mes.slice(5, 7) && f.slice(0, 7) <= mes ? valor : 0;
    return f.slice(0, 7) === mes ? valor : 0;
  }

  // Administraciones que puede ver un usuario: las que tenga marcadas. Si no tiene ninguna marcada pero sí gastos, ve las dos.
  function adminsDe(permisos) {
    const marcadas = ADMINISTRACIONES.filter(c => Boolean(permisos && permisos['oficina_admin_' + c]));
    if (marcadas.length) return marcadas;
    return permisos && permisos.oficina_gastos ? ADMINISTRACIONES.slice() : [];
  }
  function puedeAdmin(u, permisos, clave) { return u.grupo === 'Programador' || adminsDe(permisos).includes(clave); }
  // Resultado de un mes de una administración en US$: lo cobrado (pagos recibidos) menos los gastos.
  async function resultadoMes(clave, mes) {
    const ing = (await client.query(`SELECT COALESCE(SUM(p.monto), 0) AS t FROM oficina_pagos p JOIN empresas e ON e.id = p.empresa_id
      WHERE COALESCE(e.administracion, 'kaizen') = $1 AND p.moneda = 'US$' AND p.pagado_el IS NOT NULL AND TO_CHAR(p.pagado_el, 'YYYY-MM') = $2`, [clave, mes])).rows[0].t;
    const gs = (await client.query("SELECT * FROM oficina_gastos WHERE COALESCE(administracion, 'kaizen') = $1 AND moneda = 'US$'", [clave])).rows;
    const cobrado = Math.round(Number(ing) * 100) / 100;
    const gastos = Math.round(gs.reduce((t, g) => t + gastoDelMes(g, mes), 0) * 100) / 100;
    return { cobrado, gastos, utilidad: Math.round((cobrado - gastos) * 100) / 100 };
  }
  // ---------- Caja de cada administración (libro de movimientos; reglas en caja.js) ----------
  const nombreN = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
  let cajaLista = null;
  // Crea la tabla y pasa una sola vez lo que ya existía: gastos de «Creación de sistema» y retiros con recibo de socio.
  function asegurarCaja() {
    if (!cajaLista) cajaLista = (async () => {
      await client.query(`CREATE TABLE IF NOT EXISTS caja_movimientos (
        id SERIAL PRIMARY KEY, administracion VARCHAR(20) NOT NULL, fecha DATE NOT NULL, tipo VARCHAR(20) NOT NULL,
        concepto TEXT NOT NULL DEFAULT '', monto NUMERIC(12,2) NOT NULL, plan_id INTEGER, empresa_id INTEGER, socio VARCHAR(10) NOT NULL DEFAULT '',
        pago_id INTEGER, recibo_id INTEGER, detalle JSONB NOT NULL DEFAULT '{}'::jsonb, usuario TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS caja_mov_pago ON caja_movimientos (pago_id) WHERE pago_id IS NOT NULL');
      // De dónde viene cada movimiento (para mantenerlo al día con Creación de sistema y Gastos del negocio).
      await client.query("ALTER TABLE caja_movimientos ADD COLUMN IF NOT EXISTS origen TEXT");
      await client.query('ALTER TABLE caja_movimientos ADD COLUMN IF NOT EXISTS origen_id INTEGER');
      await client.query("UPDATE caja_movimientos SET origen = 'creacion', origen_id = (detalle->>'id')::int WHERE origen IS NULL AND detalle->>'origen' = 'creacion' AND detalle->>'id' ~ '^[0-9]+$'");
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS caja_mov_origen ON caja_movimientos (administracion, origen, origen_id) WHERE origen IS NOT NULL');
      await client.query("ALTER TABLE oficina_administraciones ADD COLUMN IF NOT EXISTS dueno_nombre TEXT NOT NULL DEFAULT ''");
      await client.query('CREATE TABLE IF NOT EXISTS oficina_migraciones (clave TEXT PRIMARY KEY, hecho TIMESTAMPTZ NOT NULL DEFAULT NOW())');
      // Planes de cada cliente: precio de creación, mensualidad y día de cobro propio (o todos juntos en un paquete).
      await client.query(`CREATE TABLE IF NOT EXISTS oficina_planes (
        id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL, nombre TEXT NOT NULL, precio_creacion NUMERIC(12,2) NOT NULL DEFAULT 0,
        mensualidad NUMERIC(12,2) NOT NULL DEFAULT 0, moneda VARCHAR(5) NOT NULL DEFAULT 'US$', dia_cobro INTEGER NOT NULL DEFAULT 5,
        activo BOOLEAN NOT NULL DEFAULT TRUE, creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      await client.query('ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cobro_paquete BOOLEAN NOT NULL DEFAULT FALSE');
      await client.query('ALTER TABLE empresas ADD COLUMN IF NOT EXISTS dia_paquete INTEGER NOT NULL DEFAULT 5');
      await client.query('ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS plan_id INTEGER');
      await client.query("ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS lineas JSONB NOT NULL DEFAULT '[]'::jsonb");
      await client.query('ALTER TABLE oficina_pagos ADD COLUMN IF NOT EXISTS recibido_usd NUMERIC(12,2)');
      if ((await client.query("SELECT 1 FROM oficina_migraciones WHERE clave = 'caja_v1'")).rowCount) return;
      // Creación de sistema y Gastos del negocio se mantienen al día solos (sincronizarFuentes). Aquí solo los retiros viejos con recibo.
      const retiros = (await client.query(`SELECT r.*, TO_CHAR(r.fecha, 'YYYY-MM-DD') AS f FROM oficina_recibos r WHERE r.tipo = 'socio' ORDER BY r.fecha, r.id`)).rows;
      for (const r of retiros) {
        await client.query(`INSERT INTO caja_movimientos (administracion, fecha, tipo, concepto, monto, socio, recibo_id, detalle) VALUES ($1,$2,'retiro',$3,$4,'socio',$5,$6)`,
          [r.administracion, r.f, `Retiro · ${r.socio || 'socio'}`, r.monto, r.id, { origen: 'recibo' }]);
      }
      await client.query("INSERT INTO oficina_migraciones (clave) VALUES ('caja_v1')");
    })().catch(err => { cajaLista = null; throw err; });
    return cajaLista;
  }
  // Cada cobro pagado entra a la caja (lo que pagó el cliente). Los descuentos del banco o la plataforma salen como gasto,
  // salvo que ya estén anotados (mismo monto dentro de un mes, ej. la retención que estaba en Creación de sistema).
  async function sincronizarEntradas(adm) {
    await client.query(`DELETE FROM caja_movimientos c WHERE c.administracion = $1 AND c.pago_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM oficina_pagos p WHERE p.id = c.pago_id AND p.pagado_el IS NOT NULL)`, [adm]);
    await client.query(`UPDATE caja_movimientos c SET plan_id = p.plan_id FROM oficina_pagos p
      WHERE c.pago_id = p.id AND c.administracion = $1 AND c.plan_id IS DISTINCT FROM p.plan_id`, [adm]);
    const pagos = (await client.query(`SELECT p.id, CASE WHEN p.moneda = 'US$' THEN p.monto ELSE p.recibido_usd END AS monto, p.concepto, p.empresa_id, p.descuentos, p.recibo_id, p.plan_id, TO_CHAR(p.pagado_el, 'YYYY-MM-DD') AS f, e.nombre
      FROM oficina_pagos p JOIN empresas e ON e.id = p.empresa_id
      WHERE COALESCE(e.administracion, 'kaizen') = $1 AND p.pagado_el IS NOT NULL AND (p.moneda = 'US$' OR p.recibido_usd > 0)
        AND NOT EXISTS (SELECT 1 FROM caja_movimientos c WHERE c.pago_id = p.id) ORDER BY p.pagado_el, p.id`, [adm])).rows;
    for (const p of pagos) {
      await client.query(`INSERT INTO caja_movimientos (administracion, fecha, tipo, concepto, monto, empresa_id, pago_id, recibo_id, plan_id) VALUES ($1,$2,'entrada',$3,$4,$5,$6,$7,$8)`,
        [adm, p.f, `${p.concepto} · ${p.nombre}`, p.monto, p.empresa_id, p.id, p.recibo_id, p.plan_id]);
      const desc = Array.isArray(p.descuentos) ? p.descuentos : [];
      const total = Math.round(desc.reduce((t, x) => t + (Number(x.monto) || 0), 0) * 100) / 100;
      if (!(total > 0)) continue;
      const ya = (await client.query(`SELECT 1 FROM caja_movimientos WHERE administracion = $1 AND tipo LIKE 'gasto%' AND monto = $2
        AND fecha BETWEEN $3::date - 31 AND $3::date + 31`, [adm, total, p.f])).rowCount;
      if (!ya) await client.query(`INSERT INTO caja_movimientos (administracion, fecha, tipo, concepto, monto, empresa_id, detalle) VALUES ($1,$2,'gasto_mensual',$3,$4,$5,$6)`,
        [adm, p.f, `Descuentos del cobro (${desc.map(x => x.nombre).join(', ')}) · ${p.nombre}`, total, p.empresa_id, { origen: 'descuento', pago_id: p.id }]);
    }
  }
  // Todo lo anotado en Creación de sistema y en Gastos del negocio pasa a la caja siempre (no solo una vez):
  // si se agrega, cambia o borra allá, aquí también. Los adelantos de ganancia son retiros del socio con su recibo.
  async function sincronizarFuentes(adm) {
    const admRow = (await client.query('SELECT socio_nombre FROM oficina_administraciones WHERE clave = $1', [adm])).rows[0] || {};
    const fuentes = new Map();
    const creacion = (await client.query(`SELECT g.id, g.concepto, g.categoria, g.monto::float AS monto, g.para_socio, TO_CHAR(COALESCE(g.fecha, p.creado::date), 'YYYY-MM-DD') AS f, p.socios, p.nombre AS sistema
      FROM oficina_proyecto_gastos g JOIN oficina_proyectos p ON p.id = g.proyecto_id WHERE p.administracion = $1`, [adm]).catch(() => ({ rows: [] }))).rows;
    for (const g of creacion) {
      if (!(g.monto > 0)) continue;
      if (g.categoria === 'adelanto') {
        const nombre = ((Array.isArray(g.socios) ? g.socios : [])[g.para_socio] || {}).nombre || '';
        const quien = nombre && admRow.socio_nombre && nombreN(nombre) === nombreN(admRow.socio_nombre) ? 'socio' : 'dueno';
        fuentes.set('creacion:' + g.id, { origen: 'creacion', id: g.id, tipo: 'retiro', socio: quien, fecha: g.f, concepto: `${g.concepto}${nombre ? ' · ' + nombre : ''}`, monto: g.monto });
      } else {
        fuentes.set('creacion:' + g.id, { origen: 'creacion', id: g.id, tipo: 'gasto_creacion', socio: '', fecha: g.f, concepto: `${g.concepto} · ${g.sistema}`, monto: g.monto });
      }
    }
    // Gastos del negocio ya pagados (y los de una sola vez con su fecha). Los de «plataforma» se reparten por el % de quién lo paga.
    const negocio = (await client.query(`SELECT g.id, g.nombre, g.monto::float AS monto, g.moneda, g.administracion, g.pagadores, g.frecuencia, TO_CHAR(gp.vence, 'YYYY-MM-DD') AS f
      FROM oficina_gastos g JOIN oficina_gastos_pagados gp ON gp.gasto_id = g.id
      UNION ALL SELECT g.id, g.nombre, g.monto::float, g.moneda, g.administracion, g.pagadores, g.frecuencia, TO_CHAR(g.fecha, 'YYYY-MM-DD')
      FROM oficina_gastos g WHERE g.frecuencia = 'unico' AND g.fecha IS NOT NULL AND g.fecha <= CURRENT_DATE
        AND NOT EXISTS (SELECT 1 FROM oficina_gastos_pagados gp WHERE gp.gasto_id = g.id)`).catch(() => ({ rows: [] }))).rows;
    const empresasAdm = new Set((await client.query("SELECT id FROM empresas WHERE COALESCE(administracion, 'kaizen') = $1", [adm])).rows.map(x => x.id));
    for (const g of negocio) {
      if (!(g.monto > 0) || g.moneda !== 'US$') continue;
      let parte = 0;
      if (g.administracion === adm) parte = g.monto;
      else if (g.administracion === 'plataforma') {
        const pct = (Array.isArray(g.pagadores) ? g.pagadores : []).filter(x => empresasAdm.has(Number(x.empresa_id))).reduce((t, x) => t + (Number(x.pct) || 0), 0);
        parte = Math.round(g.monto * pct) / 100;
      }
      if (parte > 0) fuentes.set(`negocio:${g.f}:${g.id}`, { origen: 'negocio:' + g.f, id: g.id, tipo: 'gasto_negocio', socio: '', fecha: g.f, concepto: g.nombre + (g.administracion === 'plataforma' ? ' (parte de la plataforma)' : ''), monto: parte });
    }
    const actuales = (await client.query("SELECT id, origen, origen_id, tipo, socio, monto::float AS monto, concepto, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, recibo_id, detalle FROM caja_movimientos WHERE administracion = $1 AND origen IS NOT NULL AND (origen = 'creacion' OR origen LIKE 'negocio:%')", [adm])).rows;
    const vistos = new Set();
    for (const a of actuales) {
      const k = a.origen === 'creacion' ? 'creacion:' + a.origen_id : `negocio:${a.origen.slice(8)}:${a.origen_id}`;
      const f = fuentes.get(k);
      if (!f) {
        await client.query('DELETE FROM caja_movimientos WHERE id = $1', [a.id]);
        if (a.recibo_id) await client.query("UPDATE oficina_recibos SET concepto = concepto || ' (ANULADO)', detalle = detalle || '{\"anulado\": true}'::jsonb WHERE id = $1 AND concepto NOT LIKE '%(ANULADO)'", [a.recibo_id]);
        continue;
      }
      vistos.add(k);
      // Si lo reclasificaste en Gastos (ej. de creación a mensual), se respeta tu tipo.
      const tipo = (a.detalle || {}).tipo_manual && f.tipo !== 'retiro' && a.tipo !== 'retiro' ? a.tipo : f.tipo;
      if (a.monto !== f.monto || a.fecha !== f.fecha || a.concepto !== f.concepto || a.tipo !== tipo || a.socio !== f.socio) {
        await client.query('UPDATE caja_movimientos SET monto = $2, fecha = $3, concepto = $4, tipo = $5, socio = $6 WHERE id = $1', [a.id, f.monto, f.fecha, f.concepto, tipo, f.socio]);
      }
    }
    for (const [k, f] of fuentes) {
      if (vistos.has(k)) continue;
      await client.query(`INSERT INTO caja_movimientos (administracion, fecha, tipo, concepto, monto, socio, origen, origen_id, detalle) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT DO NOTHING`, [adm, f.fecha, f.tipo, f.concepto, f.monto, f.socio, f.origen, f.id, { origen: f.origen.split(':')[0] }]);
    }
    // Cada adelanto de ganancia (retiro) lleva su recibo de socio.
    const sinRecibo = (await client.query("SELECT id, socio, monto::float AS monto, concepto, TO_CHAR(fecha, 'YYYY-MM-DD') AS f FROM caja_movimientos WHERE administracion = $1 AND tipo = 'retiro' AND recibo_id IS NULL ORDER BY fecha, id", [adm])).rows;
    if (sinRecibo.length) {
      const nombres = await nombresSocios(adm);
      for (const m of sinRecibo) {
        const numero = await siguienteNumero(adm);
        const rec = (await client.query(`INSERT INTO oficina_recibos (administracion, numero, tipo, socio, monto, moneda, concepto, metodo, referencia, fecha, periodo, detalle)
          VALUES ($1,$2,'socio',$3,$4,'US$',$5,'','',$6,$7,$8) RETURNING id`, [adm, numero, nombres[m.socio] || 'Socio', m.monto, `Adelanto de ganancia · ${nombres[m.socio] || ''}`, m.f, m.f.slice(0, 7), JSON.stringify({ caja: true, socio_clave: m.socio, adelanto: true })])).rows[0];
        await client.query('UPDATE caja_movimientos SET recibo_id = $2 WHERE id = $1', [m.id, rec.id]);
      }
    }
    // Todo cobro pagado lleva su recibo al cliente (también los registrados en Creación de sistema).
    const pagosSin = (await client.query(`SELECT p.id FROM oficina_pagos p JOIN empresas e ON e.id = p.empresa_id
      WHERE COALESCE(e.administracion, 'kaizen') = $1 AND p.pagado_el IS NOT NULL AND p.recibo_id IS NULL ORDER BY p.pagado_el, p.id`, [adm])).rows;
    for (const x of pagosSin) await reciboDeCobro(x.id).catch(() => {});
  }
  async function nombresSocios(adm) {
    const a = (await client.query('SELECT * FROM oficina_administraciones WHERE clave = $1', [adm])).rows[0] || {};
    let dueno = a.dueno_nombre || '';
    if (!dueno) {
      const p = (await client.query('SELECT socios FROM oficina_proyectos WHERE administracion = $1 ORDER BY id LIMIT 1', [adm]).catch(() => ({ rows: [] }))).rows[0];
      const lista = p && Array.isArray(p.socios) ? p.socios : [];
      dueno = (lista.find(x => x.nombre && nombreN(x.nombre) !== nombreN(a.socio_nombre)) || {}).nombre || 'Dueño';
    }
    return { dueno, socio: a.socio_nombre || 'Socio', empresa: a.nombre || (adm === 'kaizen' ? 'Kaizen IA' : 'Zentralia') };
  }
  async function movimientosCaja(adm) {
    return (await client.query(`SELECT id, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha, tipo, concepto, monto::float AS monto, plan_id, empresa_id, socio, pago_id, recibo_id, detalle, usuario
      FROM caja_movimientos WHERE administracion = $1 ORDER BY fecha, id`, [adm])).rows;
  }
  async function estadoCaja(adm) {
    await asegurarCaja();
    await sincronizarFuentes(adm);
    await sincronizarEntradas(adm);
    const pct = await porcentajeSocio(adm);
    const movs = await movimientosCaja(adm);
    const estado = caja.calcular(movs, pct);
    let saldo = 0;
    const lista = movs.map(m => { saldo = Math.round((saldo + (m.tipo === 'entrada' ? m.monto : m.tipo === 'reparto' || m.tipo === 'prestamo' ? 0 : -m.monto)) * 100) / 100; return { ...m, queda: saldo }; }).reverse();
    const recibos = (await client.query(`SELECT r.id, r.numero, r.tipo, r.socio, r.monto::float AS monto, r.moneda, r.concepto, TO_CHAR(r.fecha, 'YYYY-MM-DD') AS fecha, e.nombre AS empresa
      FROM oficina_recibos r LEFT JOIN empresas e ON e.id = r.empresa_id WHERE r.administracion = $1 ORDER BY r.fecha DESC, r.id DESC LIMIT 200`, [adm])).rows;
    const planes = (await client.query(`SELECT pl.id, pl.empresa_id, pl.nombre, pl.precio_creacion::float AS precio_creacion, pl.mensualidad::float AS mensualidad,
        pl.moneda, pl.dia_cobro, pl.activo, e.nombre AS empresa, e.cobro_paquete, e.dia_paquete
      FROM oficina_planes pl JOIN empresas e ON e.id = pl.empresa_id WHERE COALESCE(e.administracion, 'kaizen') = $1 ORDER BY e.nombre, pl.id`, [adm])).rows;
    for (const pl of planes) {
      const de = movs.filter(m => m.plan_id === pl.id);
      pl.cobrado = Math.round(de.filter(m => m.tipo === 'entrada').reduce((t, m) => t + m.monto, 0) * 100) / 100;
      pl.creacion = Math.round(de.filter(m => m.tipo === 'gasto_creacion').reduce((t, m) => t + m.monto, 0) * 100) / 100;
      pl.mensuales = Math.round(de.filter(m => m.tipo === 'gasto_mensual').reduce((t, m) => t + m.monto, 0) * 100) / 100;
      pl.deja = Math.round((pl.cobrado - pl.creacion - pl.mensuales) * 100) / 100;
    }
    const empresas = (await client.query("SELECT id, nombre, cobro_paquete, dia_paquete FROM empresas WHERE COALESCE(administracion, 'kaizen') = $1 AND es_demo = FALSE ORDER BY nombre", [adm])).rows;
    const sinPlan = (await client.query(`SELECT p.id, p.empresa_id, p.concepto, p.monto::float AS monto, TO_CHAR(p.pagado_el, 'YYYY-MM-DD') AS fecha FROM oficina_pagos p JOIN empresas e ON e.id = p.empresa_id
      WHERE COALESCE(e.administracion, 'kaizen') = $1 AND p.plan_id IS NULL AND p.pagado_el IS NOT NULL ORDER BY p.pagado_el`, [adm])).rows;
    return { administracion: adm, nombres: await nombresSocios(adm), pct, estado, movimientos: lista, recibos, tipos: caja.TIPOS, planes, empresas, cobrosSinPlan: sinPlan };
  }

  // Porcentaje del socio: Centralia 40% por defecto (tú 60%); Kaizen IA 0% (todo es tuyo).
  async function porcentajeSocio(clave) {
    const f = (await client.query('SELECT socio_porcentaje FROM oficina_administraciones WHERE clave = $1', [clave])).rows[0];
    if (!f) return 0;
    return f.socio_porcentaje == null ? (clave === 'centralia' ? 40 : 0) : Number(f.socio_porcentaje);
  }
  // Lo que le toca al socio en un mes y lo que ya retiró ese mes.
  async function disponibleSocio(clave, mes) {
    const r = await resultadoMes(clave, mes);
    const pct = await porcentajeSocio(clave);
    const participacion = Math.round(r.utilidad * pct) / 100;
    const retirado = Math.round(Number((await client.query("SELECT COALESCE(SUM(monto), 0) AS t FROM oficina_recibos WHERE administracion = $1 AND tipo = 'socio' AND periodo = $2", [clave, mes])).rows[0].t) * 100) / 100;
    const socio = (await client.query('SELECT socio_nombre FROM oficina_administraciones WHERE clave = $1', [clave])).rows[0] || {};
    return { mes, pct, utilidad: r.utilidad, cobrado: r.cobrado, gastos: r.gastos, participacion, retirado, disponible: Math.round((participacion - retirado) * 100) / 100, socio: socio.socio_nombre || '' };
  }
  // Seis meses por administración para el resumen y las gráficas.
  async function resumenDe(mes) {
    const salida = {};
    for (const clave of ADMINISTRACIONES) {
      const pct = await porcentajeSocio(clave);
      const serie = [];
      for (const n of [-5, -4, -3, -2, -1, 0]) {
        const m = mesMas(mes, n), r = await resultadoMes(clave, m);
        const socio = Math.round(r.utilidad * pct) / 100;
        serie.push({ mes: m, ...r, pct, socio, tuyo: Math.round((r.utilidad - socio) * 100) / 100 });
      }
      salida[clave] = serie;
    }
    return salida;
  }
  // Recibo al cliente de un cobro pagado que todavía no tiene recibo. Devuelve { id, numero }.
  async function reciboDeCobro(pagoId) {
    const p = (await client.query(`SELECT p.*, TO_CHAR(p.pagado_el, 'YYYY-MM-DD') AS pagado, COALESCE(e.administracion, 'kaizen') AS administracion
      FROM oficina_pagos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1`, [pagoId])).rows[0];
    if (!p) throw Object.assign(new Error('Cobro no encontrado.'), { codigo: 404 });
    if (!p.pagado) throw Object.assign(new Error('Ese cobro todavía no está pagado.'), { codigo: 400 });
    if (p.recibo_id) return { id: p.recibo_id, numero: null, ya: true };
    const numero = await siguienteNumero(p.administracion);
    const rec = (await client.query(`INSERT INTO oficina_recibos (administracion, numero, tipo, pago_id, empresa_id, monto, moneda, concepto, metodo, referencia, fecha, detalle)
      VALUES ($1,$2,'cliente',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [p.administracion, numero, p.id, p.empresa_id, p.monto, p.moneda, p.concepto, p.forma || '', p.referencia || '', p.pagado,
        JSON.stringify({ comprobante_nombre: p.comprobante_nombre || '', descuentos: p.descuentos || [], recibido: p.recibido, lineas: p.lineas || [] })])).rows[0];
    await client.query('UPDATE oficina_pagos SET recibo_id = $2 WHERE id = $1', [p.id, rec.id]);
    return { id: rec.id, numero };
  }
  // Siguiente número de recibo de cada administración (cada una numera por separado).
  async function siguienteNumero(clave) {
    return Number((await client.query('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM oficina_recibos WHERE administracion = $1', [clave])).rows[0].n);
  }
  // Quita de los datos todo lo que no es de las administraciones que puede ver el usuario.
  function recortar(d, permitidas) {
    const ok = new Set(permitidas);
    const empresasOk = new Set(d.empresas.filter(e => ok.has(e.administracion || 'kaizen')).map(e => e.id));
    const vacio = { cobrado: {}, porCobrar: {}, vencido: {}, gastos: {}, gastosFijos: {}, ia: {}, ingresoFijo: {} };
    return {
      ...d, permitidas,
      empresas: d.empresas.filter(e => empresasOk.has(e.id)),
      administraciones: (d.administraciones || []).filter(a => ok.has(a.clave)),
      pagos: d.pagos.filter(p => empresasOk.has(p.empresa_id)),
      gastos: d.gastos.filter(g => ok.has(g.administracion || 'kaizen')),
      recibos: (d.recibos || []).filter(r => ok.has(r.administracion)),
      resumen: Object.fromEntries(Object.entries(d.resumen || {}).filter(([c]) => ok.has(c))),
      totales: vacio, serie: []
    };
  }

  async function datos(mes) {
    const hoy = hoyLocal();
    const filas = (await client.query('SELECT * FROM empresas ORDER BY es_demo, nombre')).rows;
    const empresas = await Promise.all(filas.map(A.detalle));
    const porId = new Map(filas.map(e => [e.id, e]));
    await generarCobros(empresas.map(d => ({ ...porId.get(d.id), cuenta: d.cuenta })));
    const ia = new Map();
    await Promise.all(filas.filter(e => !e.es_demo).map(async e => ia.set(e.id, await gastoIA(e, mes))));
    // Si varias empresas usan la misma clave, su gasto es uno solo: se cuenta una vez y se avisa.
    const porClave = new Map();
    for (const e of filas.filter(x => !x.es_demo)) { const k = claveDe(e); if (k) (porClave.get(k) || porClave.set(k, []).get(k)).push(e); }
    for (const [, lista] of porClave) {
      if (lista.length < 2) continue;
      lista.forEach((e, i) => { const x = ia.get(e.id); if (x) { x.compartida = lista.filter(o => o.id !== e.id).map(o => o.nombre); x.repetida = i > 0; } });
    }

    const pagos = (await client.query(`SELECT p.id, p.empresa_id, p.concepto, p.monto, p.moneda, p.forma, p.referencia, p.nota, p.auto_mes, p.recibo_id, p.comprobante_nombre, p.recibido, p.descuentos, p.creado, TO_CHAR(p.vence, 'YYYY-MM-DD') AS vence, TO_CHAR(p.pagado_el, 'YYYY-MM-DD') AS pagado_el, e.nombre AS empresa
      FROM oficina_pagos p LEFT JOIN empresas e ON e.id = p.empresa_id
      WHERE p.vence >= $1 OR p.pagado_el IS NULL ORDER BY p.vence DESC, p.id DESC`, [mesMas(mes, -12) + '-01'])).rows
      .map(p => ({ ...p, monto: Number(p.monto), estado: p.pagado_el ? 'pagado' : p.vence < hoy ? 'vencido' : p.vence === hoy ? 'hoy' : 'pendiente' }));
    const gastos = (await client.query(`SELECT g.*, TO_CHAR(g.fecha, 'YYYY-MM-DD') AS fecha, e.nombre AS empresa
      FROM oficina_gastos g LEFT JOIN empresas e ON e.id = g.empresa_id ORDER BY g.activo DESC, g.categoria, g.nombre`)).rows
      .map(g => ({ ...g, monto: Number(g.monto) }));
    const eventos = (await client.query(`SELECT ev.*, TO_CHAR(ev.fecha, 'YYYY-MM-DD') AS fecha, e.nombre AS empresa
      FROM oficina_eventos ev LEFT JOIN empresas e ON e.id = ev.empresa_id
      WHERE ev.fecha BETWEEN $1 AND $2 OR (ev.hecho = FALSE AND ev.fecha < $3) ORDER BY ev.fecha, ev.hora`,
      [mesMas(mes, -1) + '-01', mesMas(mes, 2) + '-01', hoy])).rows;
    const enlaces = (await client.query('SELECT * FROM oficina_enlaces ORDER BY grupo, orden, nombre')).rows;
    const administraciones = (await client.query('SELECT * FROM oficina_administraciones ORDER BY clave')).rows
      .map(a => ({ ...a, socio_porcentaje: a.socio_porcentaje == null ? (a.clave === 'centralia' ? 40 : 0) : Number(a.socio_porcentaje) }));
    const recibos = (await client.query(`SELECT r.id, r.administracion, r.numero, r.tipo, r.pago_id, r.empresa_id, r.socio, r.monto, r.moneda, r.concepto, r.metodo,
      r.referencia, TO_CHAR(r.fecha, 'YYYY-MM-DD') AS fecha, r.periodo, r.detalle, e.nombre AS empresa
      FROM oficina_recibos r LEFT JOIN empresas e ON e.id = r.empresa_id ORDER BY r.creado DESC LIMIT 400`)).rows;
    const automatizaciones = (await client.query("SELECT * FROM oficina_automatizaciones ORDER BY (estado = 'pausado'), orden, lower(nombre)")).rows;

    // Totales del mes elegido, por moneda.
    const t = { cobrado: {}, porCobrar: {}, vencido: {}, gastos: {}, gastosFijos: {}, ia: {}, ingresoFijo: {} };
    for (const p of pagos) {
      if (p.pagado_el && p.pagado_el.slice(0, 7) === mes) sumar(t.cobrado, p.moneda, p.monto);
      if (!p.pagado_el && p.vence.slice(0, 7) <= mes) sumar(t.porCobrar, p.moneda, p.monto);
      if (!p.pagado_el && p.vence < hoy) sumar(t.vencido, p.moneda, p.monto);
    }
    for (const g of gastos) {
      sumar(t.gastos, g.moneda, gastoDelMes(g, mes));
      if (g.activo && g.frecuencia === 'mensual') sumar(t.gastosFijos, g.moneda, g.monto);
      if (g.activo && g.frecuencia === 'anual') sumar(t.gastosFijos, g.moneda, Math.round(g.monto / 12 * 100) / 100);
    }
    for (const [, x] of ia) if (x.delMes && !x.repetida) { sumar(t.ia, 'US$', x.delMes); sumar(t.gastos, 'US$', x.delMes); }
    for (const e of empresas) {
      const p = e.pagoCentral || {};
      if (!e.es_demo && p.activo && e.estado !== 'apagada') sumar(t.ingresoFijo, moneda(p.moneda), monto(p.monto));
    }
    // Seis meses: lo cobrado y lo gastado (la IA solo se conoce desde que se mide).
    const serie = [];
    for (let i = 5; i >= 0; i--) {
      const m = mesMas(mes, -i);
      const s = { mes: m, cobrado: 0, gastos: 0 };
      for (const p of pagos) if (p.pagado_el && p.pagado_el.slice(0, 7) === m && p.moneda === 'US$') s.cobrado += p.monto;
      for (const g of gastos) if (g.moneda === 'US$') s.gastos += gastoDelMes(g, m);
      if (m === mes) s.gastos += t.ia['US$'] || 0;
      s.cobrado = Math.round(s.cobrado * 100) / 100; s.gastos = Math.round(s.gastos * 100) / 100;
      serie.push(s);
    }

    return {
      hoy, mes, nombreMes: nombreMes(mes), categorias: CATEGORIAS, frecuencias: FRECUENCIAS, tiposEvento: TIPOS_EVENTO,
      empresas: empresas.map(d => {
        const e = porId.get(d.id);
        return {
          id: d.id, nombre: d.nombre, slug: d.slug, url: d.url, estado: d.estado, vivo: d.vivo, es_demo: d.es_demo, externa: d.externa,
          administracion: e.administracion || 'kaizen', logo: e.logo || '', nombre_oficina: e.nombre_oficina || '', razon_social: e.razon_social || '', documento: e.documento || '', pais: e.pais || '', direccion: e.direccion || '', web: e.web || '', redes: e.redes || '', metodos_pago: e.metodos_pago || '[]', plan_cobro: e.plan_cobro || '', plan: e.plan, contacto: e.contacto, telefono: e.telefono, correo_contacto: e.correo_contacto, notas: e.notas,
          tieneClaveIA: Boolean(claveDe(e)), claveIAPropia: Boolean(e.ia_clave), tieneN8n: Boolean(e.n8n_clave), correo_lectura: e.correo_lectura || '', correo_host: e.correo_host || '', tieneCorreo: Boolean(e.correo_clave),
          pago: d.pagoCentral || {}, pagado: (d.cuenta || {}).pagado || '', etapaPago: d.etapaPago,
          usuarios: (d.numeros || {}).usuarios ?? null, correosHoy: (d.numeros || {}).correos_hoy ?? null, error: d.error || '',
          ia: ia.get(d.id) || { tiene: false }
        };
      }),
      pagos, gastos, eventos, enlaces, automatizaciones, administraciones, recibos, resumen: await resumenDe(mes), totales: t, serie
    };
  }

  // ---------- Estado de cada negocio (se lee de su propia base) ----------

  const minutosDesde = f => (f ? Math.round((Date.now() - new Date(f).getTime()) / 60000) : null);

  // Qué significa un error de la IA y qué hacer, según el texto que dejó el motor.
  function solucionError(motivo) {
    const m = String(motivo || '').toLowerCase();
    if (/401|403|unauthori|invalid api key|no autorizad|clave/.test(m)) return 'La clave de OpenRouter no sirve. Ponla de nuevo en Clientes y cobros → Editar.';
    if (/402|saldo|credit|insufficient|quota|429|límite|limite/.test(m)) return 'Se acabó el saldo o el límite de OpenRouter. Recarga la cuenta en openrouter.ai → Credits.';
    if (/timeout|timed out|504|503|overload|sobrecarg|abort|network|fetch/.test(m)) return 'OpenRouter tardó o no respondió. El panel lo vuelve a intentar solo.';
    if (/no se pudo leer la respuesta/.test(m)) return 'La IA respondió algo que no se pudo leer. Se vuelve a intentar sola.';
    if (/no se pudo leer|adjunto|pdf|imagen/.test(m)) return 'El correo o un adjunto no se pudo leer. Ábrelo y revisa que tenga contenido normal.';
    return 'Revisa el texto del error. Si se repite, mándame ese texto y lo arreglo.';
  }
  async function estadoNegocio(e) {
    if (e.sin_panel) {
      return { id: e.id, nombre: e.nombre, url: A.urlDe(e), es_demo: e.es_demo, externa: false, sin_panel: true, estado: e.estado, vivo: false,
        revisiones: [{ nombre: 'Panel', estado: 'gris', detalle: 'Sin panel de reservas (solo redes, CRM o panel del cliente)' }] };
    }
    const vivo = await A.responde(e);
    const r = { id: e.id, nombre: e.nombre, url: A.urlDe(e), es_demo: e.es_demo, externa: e.externa, estado: e.estado, vivo, revisiones: [] };
    const fila = (nombre, estado, detalle) => r.revisiones.push({ nombre, estado, detalle });
    fila('Panel', e.estado === 'apagada' ? 'gris' : vivo ? 'bien' : 'falla', e.estado === 'apagada' ? 'Apagado a propósito' : vivo ? 'Responde' : 'No responde');
    try {
      await A.conEmpresa(e, async db => {
        const n8n = (await q(db, 'SELECT visto FROM salud_n8n WHERE id = 1'))[0];
        const motor = (await q(db, 'SELECT * FROM motor_estado WHERE id = 1'))[0];
        const num = (await q(db, `SELECT
            (SELECT MAX(creado) FROM clasificacion) AS ultimo,
            (SELECT ROUND(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - MAX(creado)::timestamp)) / 60) FROM clasificacion) AS ultimo_min,
            (SELECT COUNT(*)::int FROM clasificacion WHERE creado >= date_trunc('day', NOW())) AS hoy,
            (SELECT COUNT(*)::int FROM clasificacion WHERE error_ia = TRUE AND creado >= NOW() - INTERVAL '1 hour') AS errores,
            (SELECT COUNT(*)::int FROM clasificacion WHERE categoria IN ('RESERVA','MODIFICACION') AND estado = ANY($1::text[])) AS pendientes`, [ESTADOS_ABIERTOS]))[0] || {};
        const alertas = await q(db, "SELECT clave, texto, creada FROM alertas WHERE resuelta IS NULL ORDER BY creada DESC LIMIT 5");
        const conectados = await q(db, "SELECT usuario, nombre, grupo, estado FROM conectados_ahora WHERE visto > NOW() - INTERVAL '3 minutes' AND grupo <> 'Programador' ORDER BY nombre");
        const mn = minutosDesde(n8n && n8n.visto);
        if (mn === null) fila('n8n (leer correos)', 'gris', 'Este negocio no usa n8n o falta su aviso de vida');
        else fila('n8n (leer correos)', mn <= 20 ? 'bien' : 'falla', mn <= 20 ? `Corriendo · último aviso hace ${mn} min` : `Sin aviso desde hace ${mn} min: revisa que n8n esté encendido`);
        if (!motor || !motor.fin) fila('Motor de correo', 'gris', 'Apagado');
        else {
          const mm = minutosDesde(motor.fin);
          const sombra = /sombra/i.test(motor.mensaje || '');
          const conError = /^error|falta|no hay conexi/i.test(motor.mensaje || '');
          fila('Motor de correo' + (sombra ? ' (modo sombra)' : ''), conError ? 'falla' : mm <= 15 ? 'bien' : 'aviso', `${motor.mensaje || ''} · última vuelta hace ${mm} min`);
        }
        // Los minutos los calcula la base (mismo reloj con que se guardó): así no sale "hace -229 min" por la zona horaria.
        const mu = num.ultimo_min === null || num.ultimo_min === undefined ? minutosDesde(num.ultimo) : Math.max(0, Number(num.ultimo_min));
        fila('Correos', num.hoy ? 'bien' : 'gris', `${num.hoy || 0} hoy · último hace ${mu === null ? '—' : mu < 60 ? mu + ' min' : Math.round(mu / 60) + ' h'}`);
        fila('IA (lectura de reservas)', (num.errores || 0) >= 5 ? 'falla' : 'bien', num.errores ? `${num.errores} error(es) en la última hora` : 'Sin errores en la última hora');
        r.pendientes = num.pendientes || 0;
        r.errores = num.errores || 0;
        r.alertas = alertas;
        r.conectados = conectados;
      });
    } catch (err) {
      fila('Base de datos', 'falla', 'Sin conexión: ' + err.message);
    }
    return r;
  }

  // ---------- Revisar enlaces marcados "vigilar" ----------

  async function revisarEnlace(x) {
    const t = Date.now();
    try {
      const control = new AbortController();
      const reloj = setTimeout(() => control.abort(), 5000);
      const r = await fetch(x.url, { redirect: 'manual', signal: control.signal });
      clearTimeout(reloj);
      return { id: x.id, ok: r.status < 500, codigo: r.status, ms: Date.now() - t };
    } catch (e) { return { id: x.id, ok: false, codigo: 0, ms: Date.now() - t, error: e.name === 'AbortError' ? 'No respondió en 5 s' : 'No responde' }; }
  }

  // ---------- Chat con la gente de cada negocio (se escribe en el chat de su propio panel) ----------

  async function programadorDe(db) {
    return (await q(db, "SELECT usuario, nombre FROM usuarios WHERE grupo = 'Programador' AND activo = TRUE ORDER BY id LIMIT 1"))[0] || null;
  }

  async function contactos() {
    const filas = (await client.query("SELECT * FROM empresas WHERE estado <> 'apagada' AND sin_panel = FALSE ORDER BY es_demo, nombre")).rows;
    return Promise.all(filas.map(async e => {
      try {
        return await A.conEmpresa(e, async db => {
          const yo = await programadorDe(db);
          const cuentaE = (await q(db, 'SELECT pago FROM cuenta WHERE id = 1'))[0] || {};
          const principal = (cuentaE.pago && cuentaE.pago.usuario) || '';
          const conectados = new Map((await q(db, "SELECT usuario, estado FROM conectados_ahora WHERE visto > NOW() - INTERVAL '3 minutes'")).map(x => [x.usuario, x.estado]));
          const noLeidos = yo ? new Map((await q(db, 'SELECT de, COUNT(*)::int AS n FROM mensajes WHERE para = $1 AND leido = FALSE GROUP BY de', [yo.usuario])).map(x => [x.de, x.n])) : new Map();
          const ultimo = yo ? new Map((await q(db, `SELECT DISTINCT ON (otro) otro, fecha FROM (
              SELECT CASE WHEN de = $1 THEN para ELSE de END AS otro, fecha FROM mensajes WHERE de = $1 OR para = $1) t ORDER BY otro, fecha DESC`, [yo.usuario])).map(x => [x.otro, x.fecha])) : new Map();
          const gente = (await q(db, "SELECT usuario, nombre, grupo FROM usuarios WHERE activo = TRUE AND grupo <> 'Programador' AND vence IS NULL ORDER BY nombre"))
            .map(x => ({
              ...x, estado: conectados.get(x.usuario) || 'desconectado', noLeidos: noLeidos.get(x.usuario) || 0, ultimo: ultimo.get(x.usuario) || null,
              principal: x.usuario === principal || /gerenc|direc|due|admin|jefe/i.test(x.grupo)
            }));
          return { id: e.id, nombre: e.nombre, es_demo: e.es_demo, yo: yo ? yo.usuario : null, gente };
        });
      } catch (err) { return { id: e.id, nombre: e.nombre, es_demo: e.es_demo, error: 'Sin conexión con su base', gente: [] }; }
    }));
  }

  // ---------- Rutas ----------

  async function guardar(tipo, f) {
    const id = Number(f.id) || null;
    const empresaId = Number(f.empresa_id) || null;
    if (tipo === 'pagos') {
      const v = [empresaId, texto(f.concepto, 200), monto(f.monto), moneda(f.moneda), f.vence, texto(f.forma, 60), texto(f.nota, 500)];
      if (!v[1]) throw Object.assign(new Error('Escribe el concepto (ej.: Instalación del sistema).'), { codigo: 400 });
      if (!fechaValida(f.vence)) throw Object.assign(new Error('Elige la fecha en que vence el cobro.'), { codigo: 400 });
      if (id) await client.query('UPDATE oficina_pagos SET empresa_id=$1, concepto=$2, monto=$3, moneda=$4, vence=$5, forma=$6, nota=$7 WHERE id=$8', [...v, id]);
      else await client.query('INSERT INTO oficina_pagos (empresa_id, concepto, monto, moneda, vence, forma, nota) VALUES ($1,$2,$3,$4,$5,$6,$7)', v);
      return;
    }
    if (tipo === 'gastos') {
      const frecuencia = FRECUENCIAS[f.frecuencia] ? f.frecuencia : 'mensual';
      const v = [texto(f.nombre, 120), CATEGORIAS[f.categoria] ? f.categoria : 'otro', monto(f.monto), moneda(f.moneda), frecuencia,
        frecuencia === 'mensual' ? Math.min(28, Math.max(1, Number(f.dia) || 1)) : null,
        frecuencia === 'mensual' ? null : (fechaValida(f.fecha) ? f.fecha : null),
        empresaId, texto(f.url, 300), texto(f.nota, 500), f.activo !== false,
        ['kaizen', 'centralia', 'plataforma'].includes(f.administracion) ? f.administracion : 'kaizen', JSON.stringify(pagadoresDe(f))];
      if (!v[0]) throw Object.assign(new Error('Escribe el nombre del gasto (ej.: Servidor Hostinger).'), { codigo: 400 });
      if (frecuencia !== 'mensual' && !v[6]) throw Object.assign(new Error('Elige la fecha del pago (o de la próxima renovación).'), { codigo: 400 });
      if (v[8] && !/^https?:\/\//i.test(v[8])) throw Object.assign(new Error('El enlace debe empezar con http:// o https://'), { codigo: 400 });
      if (id) await client.query('UPDATE oficina_gastos SET nombre=$1, categoria=$2, monto=$3, moneda=$4, frecuencia=$5, dia=$6, fecha=$7, empresa_id=$8, url=$9, nota=$10, activo=$11, administracion=$12, pagadores=$13 WHERE id=$14', [...v, id]);
      else await client.query('INSERT INTO oficina_gastos (nombre, categoria, monto, moneda, frecuencia, dia, fecha, empresa_id, url, nota, activo, administracion, pagadores) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', v);
      return;
    }
    if (tipo === 'eventos') {
      const v = [texto(f.titulo, 200), f.fecha, /^\d{2}:\d{2}$/.test(f.hora || '') ? f.hora : '', TIPOS_EVENTO[f.tipo] ? f.tipo : 'tarea', empresaId, texto(f.nota, 1000), Boolean(f.hecho)];
      if (!v[0]) throw Object.assign(new Error('Escribe qué hay que hacer (ej.: Demo con Caribe Tours).'), { codigo: 400 });
      if (!fechaValida(f.fecha)) throw Object.assign(new Error('Elige la fecha.'), { codigo: 400 });
      if (id) await client.query('UPDATE oficina_eventos SET titulo=$1, fecha=$2, hora=$3, tipo=$4, empresa_id=$5, nota=$6, hecho=$7 WHERE id=$8', [...v, id]);
      else await client.query('INSERT INTO oficina_eventos (titulo, fecha, hora, tipo, empresa_id, nota, hecho) VALUES ($1,$2,$3,$4,$5,$6,$7)', v);
      return;
    }
    if (tipo === 'enlaces') {
      const v = [texto(f.grupo, 60) || 'Otros', texto(f.nombre, 80), texto(f.url, 300), texto(f.icono, 8) || '🔗', texto(f.nota, 200), Boolean(f.vigilar)];
      if (!v[1]) throw Object.assign(new Error('Escribe el nombre del enlace.'), { codigo: 400 });
      if (!/^https?:\/\/\S+$/i.test(v[2])) throw Object.assign(new Error('El enlace debe empezar con http:// o https:// (ej.: https://dash.cloudflare.com).'), { codigo: 400 });
      if (id) await client.query('UPDATE oficina_enlaces SET grupo=$1, nombre=$2, url=$3, icono=$4, nota=$5, vigilar=$6 WHERE id=$7', [...v, id]);
      else await client.query('INSERT INTO oficina_enlaces (grupo, nombre, url, icono, nota, vigilar, orden) VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(orden),0)+1 FROM oficina_enlaces))', v);
      return;
    }
    if (tipo === 'automatizaciones') {
      const url = (x, nombre) => { const u = texto(x, 400); if (u && !/^https?:\/\/\S+$/i.test(u)) throw Object.assign(new Error(`${nombre}: el enlace debe empezar con http:// o https://`), { codigo: 400 }); return u; };
      const REDES = ['facebook', 'instagram', 'whatsapp', 'tiktok', 'messenger', 'web', 'telegram', 'google'];
      const redes = (Array.isArray(f.redes) ? f.redes : []).filter(r => REDES.includes(r));
      const enlaces = (Array.isArray(f.enlaces) ? f.enlaces : []).slice(0, 12).map(e => ({ n: texto(e && e.n, 60), u: url(e && e.u, 'Otro acceso') })).filter(e => e.n && e.u);
      const v = [texto(f.nombre, 120), ['activo', 'prueba', 'pausado'].includes(f.estado) ? f.estado : 'activo', JSON.stringify(redes),
        url(f.flujo_url, 'Flujo de n8n'), url(f.chat_url, 'Chatwoot'), JSON.stringify(enlaces), texto(f.contacto, 200), texto(f.nota, 1000)];
      if (!v[0]) throw Object.assign(new Error('Escribe el nombre del cliente.'), { codigo: 400 });
      if (id) await client.query('UPDATE oficina_automatizaciones SET nombre=$1, estado=$2, redes=$3, flujo_url=$4, chat_url=$5, enlaces=$6, contacto=$7, nota=$8 WHERE id=$9', [...v, id]);
      else await client.query('INSERT INTO oficina_automatizaciones (nombre, estado, redes, flujo_url, chat_url, enlaces, contacto, nota, orden) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,(SELECT COALESCE(MAX(orden),0)+1 FROM oficina_automatizaciones))', v);
      return;
    }
    throw Object.assign(new Error('Tipo no válido.'), { codigo: 400 });
  }

  // Qué sección de la Oficina usa cada ruta (para quien no es Programador: su socio u otro usuario con "Entrar a la Oficina").
  function seccionesDe(url, metodo, cuerpoTipo) {
    if (url === '/api/oficina/datos') return ['inicio', 'clientes', 'gastos', 'calendario', 'enlaces'];
    if (url === '/api/oficina/alarmas' || url === '/api/oficina/gastos/pagado') return ['gastos', 'inicio'];
    if (url === '/api/oficina/negocios') return ['negocios', 'inicio'];
    if (url === '/api/oficina/servicios') return ['enlaces', 'inicio'];
    if (url.startsWith('/api/oficina/apis')) return ['apis_programador'];
    if (url.startsWith('/api/oficina/apps')) return ['apps_programador'];
    if (url.startsWith('/api/oficina/integraciones')) return ['apis_programador'];
    const g = url.match(/^\/api\/oficina\/(guardar|borrar)\/(pagos|gastos|eventos|enlaces|automatizaciones)$/);
    if (g) return [{ pagos: 'clientes', gastos: 'gastos', eventos: 'calendario', enlaces: 'enlaces', automatizaciones: 'enlaces' }[g[2]]];
    if (url.startsWith('/api/oficina/administracion/')) return ['gastos'];
    if (url === '/api/oficina/caja' || url.startsWith('/api/oficina/caja/')) return ['gastos'];
    if (url.startsWith('/api/oficina/recibo/socio') || url.startsWith('/api/oficina/socio/')) return ['gastos'];
    if (url === '/api/oficina/recibo-enlace') return ['clientes', 'gastos'];
    if (url.startsWith('/api/oficina/recibo/') || url.startsWith('/api/oficina/cobro/') || url.startsWith('/api/oficina/cliente/datos')) return ['clientes', 'gastos'];
    if (url === '/api/oficina/pagado' || url === '/api/oficina/editar-cliente') return ['clientes'];
    if (url.startsWith('/api/oficina/diseno')) return ['clientes'];
    if (url === '/api/oficina/evento-hecho') return ['calendario', 'inicio'];
    if (url.startsWith('/api/oficina/chat')) return ['chat'];
    if (url.startsWith('/api/oficina/conocimiento')) return ['asistente', 'redes'];
    if (url.startsWith('/api/oficina/redes')) return ['redes', 'asistente'];
    if (url.startsWith('/api/oficina/respaldo')) return ['respaldos', 'inicio'];
    if (url.startsWith('/api/oficina/proyectos')) return metodo === 'GET' ? ['creacion', 'gastos'] : cuerpoTipo === 'recarga' ? ['gastos'] : ['creacion'];
    return [];
  }

  async function manejar(req, res, url, u, { json, leerCuerpo, permisos = {} }) {
    if (!activo) return json(res, 404, { error: 'La Oficina solo existe en el panel central.' });
    if (!u) return json(res, 401, { error: 'Sin sesión' });
    if (u.grupo !== 'Programador') {
      if (!permisos.ver_oficina) return json(res, 403, { error: 'No tienes acceso a la Oficina.' });
      // El tipo de lo que se guarda (para separar recargas de OpenRouter de los gastos de creación).
      let tipo = '';
      if (req.method === 'POST' && url.startsWith('/api/oficina/proyectos/')) {
        const original = leerCuerpo; let guardado;
        leerCuerpo = async r => { if (guardado === undefined) guardado = await original(r); return guardado; };
        tipo = String((await leerCuerpo(req)).tipo || '');
      }
      const secciones = seccionesDe(url, req.method, tipo);
      if (!secciones.some(sc => permisos['oficina_' + sc])) return json(res, 403, { error: 'No tienes permiso para esta parte de la Oficina.' });
    }
    try {
      const p = new URL(req.url, 'http://localhost').searchParams;

      if (url === '/api/oficina/redes' || url.startsWith('/api/oficina/redes/')) {
        return await redes.manejarOficina(req, res, url, u, { json, leerCuerpo });
      }
      if (url === '/api/oficina/apps' || url.startsWith('/api/oficina/apps/')) {
        return await apps.manejarOficina(req, res, url, u, { json, leerCuerpo });
      }
      if (url === '/api/oficina/proyectos' || url.startsWith('/api/oficina/proyectos/')) {
        return await proyectos.manejar(req, res, url, u, { json, leerCuerpo, registrar });
      }
      if (url === '/api/oficina/conocimiento' || url.startsWith('/api/oficina/conocimiento/')) {
        return await conocimiento.manejarOficina(req, res, url, u, { json, leerCuerpo });
      }
      if (req.method === 'GET' && url === '/api/oficina/respaldo') return json(res, 200, estadoRespaldo());
      if (req.method === 'POST' && url === '/api/oficina/respaldo') {
        const e = estadoRespaldo();
        if (!e.disponible) return json(res, 400, { error: 'Falta respaldo-zentralia.js en la carpeta del panel.' });
        if (e.enCurso) return json(res, 409, { error: 'Ya hay un respaldo en curso.' });
        if (e.servidor) {
          fsR.writeFileSync(pathR.join(CARPETA_RESPALDO, 'pedir-respaldo'), new Date().toISOString());
          await registrar(u, 'respaldo_manual', 'sistema', 0, '', '', 'Respaldo del servidor pedido desde la Oficina');
          return json(res, 200, { ok: true });
        }
        const hijo = spawnR(process.execPath, [SCRIPT_RESPALDO], { cwd: pathR.dirname(SCRIPT_RESPALDO), detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
        hijo.unref();
        await registrar(u, 'respaldo_manual', 'sistema', 0, '', '', 'Respaldo pedido desde la Oficina');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url === '/api/oficina/datos') {
        const mes = /^\d{4}-\d{2}$/.test(p.get('mes') || '') ? p.get('mes') : hoyLocal().slice(0, 7);
        // "Actualizar ahora": se vuelve a preguntar a OpenRouter sin esperar.
        if (p.get('fresco') === '1') cacheClaves.clear();
        let d = await datos(mes);
        d = u.grupo === 'Programador' ? { ...d, permitidas: ADMINISTRACIONES.slice() } : recortar(d, adminsDe(permisos));
        return json(res, 200, { ...d, alarmas: await alarmasGastos(), leido: new Date().toISOString() });
      }
      if (req.method === 'GET' && url === '/api/oficina/alarmas') return json(res, 200, { alarmas: await alarmasGastos() });
      if (req.method === 'POST' && url === '/api/oficina/gastos/pagado') {
        const f = await leerCuerpo(req);
        if (!fechaValida(f.vence)) return json(res, 400, { error: 'Fecha no válida.' });
        if (f.deshacer) await client.query('DELETE FROM oficina_gastos_pagados WHERE gasto_id = $1 AND vence = $2', [Number(f.id), f.vence]);
        else await client.query('INSERT INTO oficina_gastos_pagados (gasto_id, vence, usuario) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [Number(f.id), f.vence, u.usuario]);
        await registrar(u, f.deshacer ? 'gasto_no_pagado' : 'gasto_pagado', 'gasto', Number(f.id), '', f.vence, '');
        return json(res, 200, { ok: true, alarmas: await alarmasGastos() });
      }
      // Usuarios del panel de un cliente: ver, y activar o desactivar (no se crean ni se borran desde aquí).
      if (req.method === 'GET' && url === '/api/oficina/usuarios') {
        const e = await A.empresa(p.get('empresa'));
        if (!e) return json(res, 404, { error: 'No encontrado.' });
        const filas = await A.conEmpresa(e, async db => q(db,
          'SELECT id, usuario, nombre, grupo, activo, debe_cambiar, email FROM usuarios ORDER BY id'));
        return json(res, 200, { usuarios: filas });
      }
      if (req.method === 'POST' && url === '/api/oficina/usuarios/activo') {
        const f = await leerCuerpo(req);
        const e = await A.empresa(Number(f.empresa_id));
        if (!e) return json(res, 404, { error: 'No encontrado.' });
        const id = Number(f.usuario_id);
        const activar = Boolean(f.activo);
        const error = await A.conEmpresa(e, async db => {
          const fila = (await q(db, 'SELECT id, grupo FROM usuarios WHERE id = $1', [id]))[0];
          if (!fila) return 'Ese usuario ya no existe.';
          if (!activar && fila.grupo === 'Programador') return 'No se puede desactivar al Programador.';
          await db.query('UPDATE usuarios SET activo = $1 WHERE id = $2', [activar, id]);
          return '';
        });
        if (error) return json(res, 400, { error });
        await registrar(u, activar ? 'oficina_usuario_activar' : 'oficina_usuario_desactivar', 'empresa', e.slug, '', '', 'usuario #' + id);
        return json(res, 200, { ok: true });
      }
      // Cambiar la clave de un usuario del panel: se guarda con el mismo método del panel y debe cambiarla al entrar.
      if (req.method === 'POST' && url === '/api/oficina/usuarios/clave') {
        const f = await leerCuerpo(req);
        const e = await A.empresa(Number(f.empresa_id));
        if (!e) return json(res, 404, { error: 'No encontrado.' });
        const clave = String(f.clave || '');
        if (clave.length < 8) return json(res, 400, { error: 'La clave debe tener al menos 8 caracteres.' });
        const id = Number(f.usuario_id);
        const hash = require('bcryptjs').hashSync(clave, 10);
        const error = await A.conEmpresa(e, async db => {
          const cambiadas = await db.query('UPDATE usuarios SET password_hash = $1, debe_cambiar = TRUE WHERE id = $2', [hash, id]);
          return cambiadas.rowCount ? '' : 'Ese usuario ya no existe.';
        });
        if (error) return json(res, 400, { error });
        await registrar(u, 'oficina_usuario_clave', 'empresa', e.slug, '', '', 'usuario #' + id);
        return json(res, 200, { ok: true });
      }
      // Errores de la IA de un negocio (últimas 24 h), con qué significa cada uno y qué hacer.
      if (req.method === 'GET' && url === '/api/oficina/errores-ia') {
        const e = await A.empresa(p.get('empresa'));
        if (!e) return json(res, 404, { error: 'No encontrado.' });
        const filas = await A.conEmpresa(e, async db => q(db,
          `SELECT id, creado, fecha, remitente, asunto, message_id, motivo FROM clasificacion
           WHERE error_ia = TRUE AND creado >= NOW() - INTERVAL '24 hours' ORDER BY creado DESC LIMIT 200`));
        return json(res, 200, { errores: filas.map(x => ({ ...x, solucion: solucionError(x.motivo) })) });
      }
      if (req.method === 'GET' && url === '/api/oficina/negocios') {
        const filas = (await client.query('SELECT * FROM empresas ORDER BY es_demo, nombre')).rows;
        return json(res, 200, { negocios: await Promise.all(filas.map(estadoNegocio)) });
      }
      if (url === '/api/oficina/integraciones' || url.startsWith('/api/oficina/integraciones/')) {
        const f = req.method === 'POST' ? await leerCuerpo(req) : {};
        const eid = Number(req.method === 'GET' ? new URL(req.url, 'http://localhost').searchParams.get('empresa') : f.empresa_id) || 0;
        const e = eid ? await A.empresa(eid) : null;
        if (!e) return json(res, 400, { error: 'Elige la empresa a la que se conecta el sistema.' });
        if (req.method === 'GET' && url === '/api/oficina/integraciones') return json(res, 200, { llaves: await A.conEmpresa(e, db => apiExterna.listarLlaves(db)), alcances: apiExterna.ALCANCES, empresa: e.nombre });
        if (req.method === 'POST' && url === '/api/oficina/integraciones/crear') {
          try {
            const r = await A.conEmpresa(e, db => apiExterna.crearLlave(db, f));
            await registrar(u, 'oficina_integraciones', 'integraciones', f.nombre, '', '', 'llave creada para ' + e.nombre);
            return json(res, 200, { ...r, empresa: e.nombre });
          } catch (err) { return json(res, err.codigo || 500, { error: err.codigo ? err.message : 'No se pudo crear la llave.' }); }
        }
        if (req.method === 'POST' && url === '/api/oficina/integraciones/revocar') {
          const nombre = await A.conEmpresa(e, db => apiExterna.revocarLlave(db, f.id));
          if (!nombre) return json(res, 404, { error: 'Esa llave ya no existe.' });
          await registrar(u, 'oficina_integraciones', 'integraciones', nombre, '', '', 'llave revocada en ' + e.nombre);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'No existe.' });
      }
      if (req.method === 'GET' && url === '/api/oficina/apis') {
        const eid = Number(new URL(req.url, 'http://localhost').searchParams.get('empresa')) || 0;
        const filas = (await client.query("SELECT id, empresa_id, nombre, tipo, proveedor, plan, costo_mensual, limite_mes, to_char(renovacion, 'YYYY-MM-DD') AS renovacion, llave_fin FROM oficina_apis WHERE empresa_id = $1 ORDER BY tipo, nombre", [eid])).rows;
        const hoyD = hoyLocal();
        return json(res, 200, { apis: filas.map(r => {
          const dias = r.renovacion ? Math.round((Date.parse(r.renovacion) - Date.parse(hoyD)) / 86400000) : null;
          return { ...r, costo_mensual: Number(r.costo_mensual), dias_para_renovar: dias, aviso: dias === null ? '' : dias < 0 ? 'vencido' : dias <= 7 ? 'por_vencer' : '' };
        }) });
      }
      if (req.method === 'POST' && url === '/api/oficina/apis/guardar') {
        const f = await leerCuerpo(req);
        const nombre = String(f.nombre || '').trim().slice(0, 80);
        if (!nombre) return json(res, 400, { error: 'Escribe el nombre del servicio.' });
        const tipo = ['Vuelos', 'Mapas', 'IA', 'WhatsApp', 'Correo', 'Pagos', 'Otro'].includes(f.tipo) ? f.tipo : 'Otro';
        const plan = ['Gratis', 'Prueba', 'Pago'].includes(f.plan) ? f.plan : 'Gratis';
        const costo = Math.max(0, Number(f.costo_mensual) || 0);
        const limite = f.limite_mes === '' || f.limite_mes == null ? null : Math.max(0, parseInt(f.limite_mes, 10) || 0);
        const renov = /^\d{4}-\d{2}-\d{2}$/.test(String(f.renovacion || '')) ? String(f.renovacion) : null;
        const eid = Number(f.empresa_id) || 0;
        const proveedor = String(f.proveedor || '').trim().slice(0, 80);
        const llave = String(f.llave || '').trim();
        const llaveEnc = llave ? cifrarLlave(llave) : null;
        const llaveFin = llave ? llave.slice(-4) : null;
        let id = Number(f.id) || 0;
        if (id) {
          await client.query('UPDATE oficina_apis SET empresa_id=$2, nombre=$3, tipo=$4, proveedor=$5, plan=$6, costo_mensual=$7, limite_mes=$8, renovacion=$9, llave_enc=COALESCE($10, llave_enc), llave_fin=COALESCE($11, llave_fin), actualizado=NOW() WHERE id=$1', [id, eid, nombre, tipo, proveedor, plan, costo, limite, renov, llaveEnc, llaveFin]);
        } else {
          id = (await client.query('INSERT INTO oficina_apis (empresa_id, nombre, tipo, proveedor, plan, costo_mensual, limite_mes, renovacion, llave_enc, llave_fin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id', [eid, nombre, tipo, proveedor, plan, costo, limite, renov, llaveEnc, llaveFin])).rows[0].id;
        }
        await registrar(u, 'oficina_apis', 'apis', nombre, '', '', llave ? 'llave guardada (cifrada)' : 'sin cambio de llave');
        if (llave && eid) await enviarLlaveAEmpresa(eid, CLAVE_APIS[tipo], llave);
        return json(res, 200, { ok: true, id });
      }
      if (req.method === 'POST' && url === '/api/oficina/apis/borrar') {
        const f = await leerCuerpo(req);
        const previo = (await client.query('SELECT empresa_id, tipo FROM oficina_apis WHERE id = $1', [Number(f.id) || 0])).rows[0];
        await client.query('DELETE FROM oficina_apis WHERE id = $1', [Number(f.id) || 0]);
        await registrar(u, 'oficina_apis', 'apis', f.id, '', '', 'borrado');
        // Si ya no queda ningún servicio de ese tipo en la empresa, se quita la llave que tenía.
        if (previo && previo.empresa_id && CLAVE_APIS[previo.tipo]) {
          const quedan = (await client.query('SELECT 1 FROM oficina_apis WHERE empresa_id = $1 AND tipo = $2 LIMIT 1', [previo.empresa_id, previo.tipo])).rowCount;
          if (!quedan) await enviarLlaveAEmpresa(previo.empresa_id, CLAVE_APIS[previo.tipo], '');
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url === '/api/oficina/servicios') {
        const lista = (await client.query('SELECT * FROM oficina_enlaces WHERE vigilar = TRUE')).rows;
        return json(res, 200, { servicios: await Promise.all(lista.map(revisarEnlace)) });
      }

      // Cliente: datos de la empresa. El documento fiscal es obligatorio (RUC, DNI, cédula... según el país).
      if (req.method === 'POST' && url === '/api/oficina/cliente/datos') {
        const f = await leerCuerpo(req);
        const e = (await client.query("SELECT id, COALESCE(administracion, 'kaizen') AS administracion FROM empresas WHERE id = $1", [Number(f.empresa_id)])).rows[0];
        if (!e) return json(res, 404, { error: 'Cliente no encontrado.' });
        const admin = ADMINISTRACIONES.includes(f.administracion) ? f.administracion : e.administracion;
        if (!puedeAdmin(u, permisos, e.administracion) || !puedeAdmin(u, permisos, admin)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        const doc = texto(f.documento, 60);
        if (!doc) return json(res, 400, { error: 'El documento fiscal es obligatorio (RUC, DNI, cédula u otro según el país).' });
        // Logo del cliente: solo se cambia si se manda uno nuevo.
        const logo = f.logo == null ? null : String(f.logo);
        if (logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(logo)) return json(res, 400, { error: 'El logo debe ser una imagen PNG, JPG o WEBP.' });
        if (logo && logo.length > 200000) return json(res, 400, { error: 'El logo pesa demasiado. Usa una imagen de menos de 150 KB.' });
        if (logo !== null) await client.query('UPDATE empresas SET logo = $2 WHERE id = $1', [e.id, logo]);
        const metodos = Array.isArray(f.metodos_pago) ? f.metodos_pago.map(m => texto(m, 40)).filter(Boolean).slice(0, 20) : [];
        await client.query('UPDATE empresas SET documento=$2, pais=$3, direccion=$4, web=$5, redes=$6, metodos_pago=$7, administracion=$8, nombre_oficina=COALESCE($9, nombre_oficina), razon_social=COALESCE($10, razon_social) WHERE id=$1',
          [e.id, doc, texto(f.pais, 60), texto(f.direccion, 300), texto(f.web, 200), texto(f.redes, 400), JSON.stringify(metodos), admin, f.nombre_oficina === undefined ? null : texto(f.nombre_oficina, 120), f.razon_social === undefined ? null : texto(f.razon_social, 160)]);
        await registrar(u, 'cliente_datos', 'empresa', e.id, '', '', doc);
        return json(res, 200, { ok: true });
      }
      // Plan de cobro: pago único, o setup con abono y saldo. La mensualidad se configura con la cuota del cliente.
      if (req.method === 'POST' && url === '/api/oficina/cobro/plan') {
        const f = await leerCuerpo(req);
        const e = (await client.query("SELECT id, COALESCE(administracion, 'kaizen') AS administracion, plan_cobro FROM empresas WHERE id = $1", [Number(f.empresa_id)])).rows[0];
        if (!e) return json(res, 404, { error: 'Cliente no encontrado.' });
        if (!puedeAdmin(u, permisos, e.administracion)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        if (e.plan_cobro) return json(res, 400, { error: 'Este cliente ya tiene su plan de cobro creado.' });
        const tipo = ['unico', 'abono', 'mensual'].includes(f.plan) ? f.plan : null;
        if (!tipo) return json(res, 400, { error: 'Elige el plan: pago único, setup con abono o solo mensualidad.' });
        const moneda = texto(f.moneda, 5) || 'US$';
        const fechaCobro = fechaValida(f.fecha) ? f.fecha : hoyLocal();
        if (tipo !== 'mensual') {
          const total = monto(f.monto);
          if (!(total > 0)) return json(res, 400, { error: 'Escribe el monto total del setup.' });
          if (tipo === 'unico') {
            await client.query('INSERT INTO oficina_pagos (empresa_id, concepto, monto, moneda, vence) VALUES ($1,$2,$3,$4,$5)', [e.id, texto(f.concepto, 200) || 'Pago único', total, moneda, fechaCobro]);
          } else {
            // El abono puede venir como monto (y se calcula el %) o como porcentaje (y se calcula el monto).
            const montoAbono = monto(f.abono_monto);
            const abono = montoAbono > 0 ? Math.min(total, montoAbono) : Math.round(total * Math.min(99, Math.max(1, Number(f.abono_pct) || 60))) / 100;
            const pct = Math.round(abono * 10000 / total) / 100;
            const saldo = Math.round((total - abono) * 100) / 100;
            const fechaSaldo = fechaValida(f.fecha_saldo) ? f.fecha_saldo : fechaCobro;
            await client.query('INSERT INTO oficina_pagos (empresa_id, concepto, monto, moneda, vence) VALUES ($1,$2,$3,$4,$5)', [e.id, `Abono inicial (${pct}%)`, abono, moneda, fechaCobro]);
            await client.query('INSERT INTO oficina_pagos (empresa_id, concepto, monto, moneda, vence) VALUES ($1,$2,$3,$4,$5)', [e.id, `Saldo (${100 - pct}%) al entregar`, saldo, moneda, fechaSaldo]);
          }
        }
        await client.query('UPDATE empresas SET plan_cobro = $2 WHERE id = $1', [e.id, tipo]);
        await registrar(u, 'cobro_plan', 'empresa', e.id, '', tipo, '');
        return json(res, 200, { ok: true });
      }
      // Cobro pagado: se sube el comprobante (PDF o imagen) y se genera el recibo numerado de esa administración.
      if (req.method === 'POST' && url === '/api/oficina/cobro/pagar') {
        const f = await leerCuerpo(req);
        const p = (await client.query("SELECT p.*, TO_CHAR(p.vence, 'YYYY-MM-DD') AS vence, COALESCE(e.administracion, 'kaizen') AS administracion FROM oficina_pagos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1", [Number(f.pago_id)])).rows[0];
        if (!p) return json(res, 404, { error: 'Cobro no encontrado.' });
        if (!puedeAdmin(u, permisos, p.administracion)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        if (p.pagado_el) return json(res, 400, { error: 'Este cobro ya está pagado.' });
        const fecha = fechaValida(f.fecha) ? f.fecha : hoyLocal();
        const metodo = texto(f.metodo, 60);
        let comprobante = '';
        // Un cobro solo cuenta (y suma a la caja) cuando está pagado con su voucher.
        if (!f.comprobante) return json(res, 400, { error: 'Sube el voucher del pago (PDF o imagen). Sin voucher no se registra el pago.' });
        if (p.moneda !== 'US$' && !(monto(f.recibido_usd) > 0)) return json(res, 400, { error: `Este cobro es en ${p.moneda}: escribe cuánto llegó en US$.` });
        if (f.comprobante) {
          comprobante = String(f.comprobante);
          if (!/^data:(application\/pdf|image\/(png|jpeg|webp));base64,[A-Za-z0-9+\/=]+$/.test(comprobante)) return json(res, 400, { error: 'El comprobante debe ser PDF, PNG, JPG o WEBP.' });
          if (comprobante.length > 2800000) return json(res, 400, { error: 'El comprobante pesa más de 2 MB.' });
        }
        const nombreC = texto(f.comprobante_nombre, 200);
        // Descuentos opcionales (comisión del banco, PayPal, Payoneer, impuesto). Lo recibido se puede escribir a mano.
        const descuentos = (Array.isArray(f.descuentos) ? f.descuentos : []).map(x => ({ nombre: texto(x.nombre, 80) || 'Descuento', monto: monto(x.monto) })).filter(x => x.monto > 0).slice(0, 10);
        const totalDescuentos = Math.round(descuentos.reduce((t, x) => t + x.monto, 0) * 100) / 100;
        let recibido = f.recibido === undefined || f.recibido === null || f.recibido === '' ? null : monto(f.recibido);
        if (recibido === null && descuentos.length) recibido = Math.round((Number(p.monto) - totalDescuentos) * 100) / 100;
        if (recibido !== null) {
          const diferencia = Math.round((Number(p.monto) - recibido - totalDescuentos) * 100) / 100;
          if (Math.abs(diferencia) >= 1) return json(res, 400, { error: `No cuadra: el cobro es ${p.monto}, recibiste ${recibido} y los descuentos suman ${totalDescuentos}. Falta explicar ${diferencia}.` });
        }
        const numero = await siguienteNumero(p.administracion);
        const rec = (await client.query(`INSERT INTO oficina_recibos (administracion, numero, tipo, pago_id, empresa_id, monto, moneda, concepto, metodo, referencia, fecha, detalle)
          VALUES ($1,$2,'cliente',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [p.administracion, numero, p.id, p.empresa_id, p.monto, p.moneda, p.concepto, metodo, texto(f.referencia, 120), fecha, JSON.stringify({ comprobante_nombre: nombreC, descuentos, recibido, lineas: p.lineas || [] })])).rows[0];
        if (p.moneda !== 'US$') await client.query('UPDATE oficina_pagos SET recibido_usd = $2 WHERE id = $1', [p.id, monto(f.recibido_usd)]);
        await client.query('UPDATE oficina_pagos SET pagado_el = $2, forma = $3, comprobante = $4, comprobante_nombre = $5, recibo_id = $6, referencia = $7, recibido = $8, descuentos = $9::jsonb WHERE id = $1', [p.id, fecha, metodo, comprobante, nombreC, rec.id, texto(f.referencia, 120), recibido, JSON.stringify(descuentos)]);
        await registrar(u, 'cobro_pagado', 'pago', p.id, '', fecha, p.concepto);
        return json(res, 200, { ok: true, recibo_id: rec.id, numero });
      }
      // Cobro pagado sin recibo (ej. marcado pagado antes de que existieran los recibos): se le genera ahora.
      if (req.method === 'POST' && url === '/api/oficina/cobro/recibo') {
        const f = await leerCuerpo(req);
        const adm = (await client.query("SELECT COALESCE(e.administracion, 'kaizen') AS administracion FROM oficina_pagos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1", [Number(f.id)])).rows[0];
        if (!adm) return json(res, 404, { error: 'Cobro no encontrado.' });
        if (!puedeAdmin(u, permisos, adm.administracion)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        const r = await reciboDeCobro(Number(f.id));
        if (!r.ya) await registrar(u, 'recibo_cliente', 'pago', Number(f.id), '', String(r.numero), 'recibo generado');
        return json(res, 200, { ok: true, recibo_id: r.id, numero: r.numero });
      }
      // Varios cobros pagados de una sola vez: un recibo por cada cobro, con su número, y un solo comprobante del pago total.
      if (req.method === 'POST' && url === '/api/oficina/cobro/pagar-varios') {
        const f = await leerCuerpo(req);
        const ids = [...new Set((Array.isArray(f.pago_ids) ? f.pago_ids : []).map(Number).filter(Boolean))].slice(0, 50);
        if (!ids.length) return json(res, 400, { error: 'Marca los cobros que vas a pagar.' });
        const filas = (await client.query(`SELECT p.*, TO_CHAR(p.vence, 'YYYY-MM-DD') AS vence, COALESCE(e.administracion, 'kaizen') AS administracion
          FROM oficina_pagos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = ANY($1::int[]) ORDER BY p.vence, p.id`, [ids])).rows;
        if (filas.length !== ids.length) return json(res, 404, { error: 'Algún cobro no existe.' });
        if (filas.some(x => x.pagado_el)) return json(res, 400, { error: 'Algún cobro ya está pagado. Quítalo de la selección.' });
        if (filas.some(x => !puedeAdmin(u, permisos, x.administracion))) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        const fecha = fechaValida(f.fecha) ? f.fecha : hoyLocal();
        const metodo = texto(f.metodo, 60), referencia = texto(f.referencia, 120), nombreC = texto(f.comprobante_nombre, 200);
        let comprobante = '';
        if (!f.comprobante) return json(res, 400, { error: 'Sube el voucher del pago (PDF o imagen). Sin voucher no se registra el pago.' });
        if (filas.some(x => x.moneda !== 'US$')) return json(res, 400, { error: 'Los cobros en otra moneda se registran uno por uno (para anotar cuánto llegó en US$).' });
        if (f.comprobante) {
          comprobante = String(f.comprobante);
          if (!/^data:(application\/pdf|image\/(png|jpeg|webp));base64,[A-Za-z0-9+\/=]+$/.test(comprobante)) return json(res, 400, { error: 'El comprobante debe ser PDF, PNG, JPG o WEBP.' });
          if (comprobante.length > 2800000) return json(res, 400, { error: 'El comprobante pesa más de 2 MB.' });
        }
        const recibos = [];
        for (const [i, x] of filas.entries()) {
          const numero = await siguienteNumero(x.administracion);
          const rec = (await client.query(`INSERT INTO oficina_recibos (administracion, numero, tipo, pago_id, empresa_id, monto, moneda, concepto, metodo, referencia, fecha, detalle)
            VALUES ($1,$2,'cliente',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [x.administracion, numero, x.id, x.empresa_id, x.monto, x.moneda, x.concepto, metodo, referencia, fecha,
              JSON.stringify({ comprobante_nombre: nombreC, pago_conjunto: ids.length > 1 ? ids : null })])).rows[0];
          await client.query('UPDATE oficina_pagos SET pagado_el = $2, forma = $3, comprobante = $4, comprobante_nombre = $5, recibo_id = $6, referencia = $7 WHERE id = $1',
            [x.id, fecha, metodo, i === 0 ? comprobante : '', nombreC, rec.id, referencia]);
          recibos.push({ id: rec.id, numero, concepto: x.concepto, monto: x.monto });
        }
        await registrar(u, 'cobro_pagado_varios', 'pago', ids.join(','), '', fecha, String(ids.length) + ' cobros');
        return json(res, 200, { ok: true, recibos });
      }
      // Comprobante de un cobro (se pide solo al abrirlo, para no cargar todos los archivos en cada consulta).
      if (req.method === 'GET' && url === '/api/oficina/cobro/comprobante') {
        const fila = (await client.query("SELECT p.comprobante, p.comprobante_nombre, COALESCE(e.administracion, 'kaizen') AS administracion FROM oficina_pagos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1", [Number(p.get('id'))])).rows[0];
        if (!fila || !puedeAdmin(u, permisos, fila.administracion)) return json(res, 404, { error: 'Comprobante no encontrado.' });
        return json(res, 200, { comprobante: fila.comprobante, nombre: fila.comprobante_nombre });
      }
      // Recibo para imprimir: datos de la administración (logo, RUC), de la empresa y del recibo.
      // Enlace para compartir un recibo (WhatsApp, correo o copiar): guarda una copia fija y devuelve la dirección.
      if (req.method === 'POST' && url === '/api/oficina/recibo-enlace') {
        const f = await leerCuerpo(req);
        const r = (await client.query('SELECT id, administracion FROM oficina_recibos WHERE id = $1', [Number(f.id)])).rows[0];
        if (!r) return json(res, 404, { error: 'Recibo no encontrado.' });
        if (!puedeAdmin(u, permisos, r.administracion)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        const html = String(f.html || '');
        if (!/^<!doctype html>/i.test(html) || html.length > 3000000) return json(res, 400, { error: 'No se pudo preparar el recibo para compartir.' });
        await client.query('CREATE TABLE IF NOT EXISTS oficina_recibo_enlaces (token TEXT PRIMARY KEY, recibo_id INTEGER UNIQUE NOT NULL, html TEXT NOT NULL, creado TIMESTAMPTZ NOT NULL DEFAULT NOW())');
        const previo = (await client.query('SELECT token FROM oficina_recibo_enlaces WHERE recibo_id = $1', [r.id])).rows[0];
        const token = previo ? previo.token : crypto.randomBytes(24).toString('base64url');
        await client.query(`INSERT INTO oficina_recibo_enlaces (token, recibo_id, html) VALUES ($1,$2,$3) ON CONFLICT (recibo_id) DO UPDATE SET html = EXCLUDED.html`, [token, r.id, html]);
        await registrar(u, 'recibo_enlace', 'recibo', r.id, '', '', previo ? 'enlace actualizado' : 'enlace creado');
        return json(res, 200, { ok: true, ruta: '/r/' + token });
      }
      if (req.method === 'GET' && url.startsWith('/api/oficina/recibo/')) {
        const r = (await client.query("SELECT r.*, TO_CHAR(r.fecha, 'YYYY-MM-DD') AS fecha FROM oficina_recibos r WHERE r.id = $1", [Number(url.split('/').pop())])).rows[0];
        if (!r) return json(res, 404, { error: 'Recibo no encontrado.' });
        if (!puedeAdmin(u, permisos, r.administracion)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        const adm = (await client.query('SELECT * FROM oficina_administraciones WHERE clave = $1', [r.administracion])).rows[0] || {};
        const emp = r.empresa_id ? (await client.query('SELECT id, nombre, documento, pais, direccion, web, contacto, telefono, correo_contacto FROM empresas WHERE id = $1', [r.empresa_id])).rows[0] : null;
        return json(res, 200, { recibo: r, administracion: adm, empresa: emp });
      }
      // ---------- Caja: estado, gastos, reparto, retiros (con recibo) y deshacer el último ----------
      if (url === '/api/oficina/caja' || url.startsWith('/api/oficina/caja/')) {
        const f = req.method === 'POST' ? await leerCuerpo(req) : {};
        const adm = ADMINISTRACIONES.includes(req.method === 'GET' ? p.get('administracion') : f.administracion) ? (req.method === 'GET' ? p.get('administracion') : f.administracion) : null;
        if (!adm) return json(res, 400, { error: 'Elige Kaizen IA o Zentralia.' });
        if (!puedeAdmin(u, permisos, adm)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        if (req.method === 'GET' && url === '/api/oficina/caja') return json(res, 200, await estadoCaja(adm));
        if (req.method !== 'POST') return json(res, 404, { error: 'No encontrado.' });
        const actual = await estadoCaja(adm);
        const fecha = fechaValida(f.fecha) ? f.fecha : hoyLocal();
        const quien = u.nombre || u.usuario;
        if (url === '/api/oficina/caja/gasto') {
          const tipo = f.tipo === 'gasto_creacion' ? 'gasto_creacion' : 'gasto_mensual';
          const concepto = texto(f.concepto, 200);
          if (!concepto) return json(res, 400, { error: 'Escribe qué se pagó.' });
          const prestamos = (Array.isArray(f.prestamos) ? f.prestamos : []).map(x => ({ presta: x.presta, debe: x.debe, monto: monto(x.monto) })).filter(x => x.monto > 0).slice(0, 2);
          const mov = { tipo, monto: monto(f.monto), concepto, detalle: { prestamos } };
          const err = caja.revisar(actual.estado, mov);
          if (err) return json(res, 400, { error: err, fondo: actual.estado.fondo, libre: actual.estado.libre });
          let plan = Number(f.plan_id) || null;
          if (plan && !(await client.query("SELECT 1 FROM oficina_planes pl JOIN empresas e ON e.id = pl.empresa_id WHERE pl.id = $1 AND COALESCE(e.administracion, 'kaizen') = $2", [plan, adm])).rowCount) plan = null;
          const r = await client.query(`INSERT INTO caja_movimientos (administracion, fecha, tipo, concepto, monto, plan_id, detalle, usuario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
            [adm, fecha, tipo, concepto, mov.monto, plan, { prestamos, nota: texto(f.nota, 300) }, quien]);
          await registrar(u, 'caja_gasto', 'caja', r.rows[0].id, '', String(mov.monto), concepto);
          return json(res, 200, { ok: true, id: r.rows[0].id });
        }
        if (url === '/api/oficina/caja/reparto') {
          const mov = { tipo: 'reparto', monto: f.monto === undefined || f.monto === '' ? Math.max(0, actual.estado.fondo) : monto(f.monto) };
          const err = caja.revisar(actual.estado, mov);
          if (err) return json(res, 400, { error: err });
          const r = await client.query(`INSERT INTO caja_movimientos (administracion, fecha, tipo, concepto, monto, detalle, usuario) VALUES ($1,$2,'reparto',$3,$4,$5,$6) RETURNING id`,
            [adm, fecha, texto(f.concepto, 200) || 'Reparto de utilidad', mov.monto, { pct: actual.pct, nota: texto(f.nota, 300) }, quien]);
          await registrar(u, 'caja_reparto', 'caja', r.rows[0].id, '', String(mov.monto), '');
          const despues = caja.calcular(await movimientosCaja(adm), actual.pct);
          return json(res, 200, { ok: true, libre: despues.libre, debe: despues.debe });
        }
        if (url === '/api/oficina/caja/prestamo') {
          const presta = caja.SOCIOS.includes(f.presta) ? f.presta : '';
          const debe = presta === 'dueno' ? 'socio' : 'dueno';
          const mov = { tipo: 'prestamo', monto: monto(f.monto), detalle: { presta, debe } };
          const err = caja.revisar(actual.estado, mov);
          if (err) return json(res, 400, { error: err });
          await client.query(`INSERT INTO caja_movimientos (administracion, fecha, tipo, concepto, monto, socio, detalle, usuario) VALUES ($1,$2,'prestamo',$3,$4,$5,$6,$7)`,
            [adm, fecha, `Préstamo de ${actual.nombres[presta]} para cubrir el fondo (lo debe ${actual.nombres[debe]})`, mov.monto, presta, { presta, debe }, quien]);
          await registrar(u, 'caja_prestamo', 'caja', presta, '', String(mov.monto), debe);
          return json(res, 200, { ok: true });
        }
        if (url === '/api/oficina/caja/retiro') {
          const socio = caja.SOCIOS.includes(f.socio) ? f.socio : '';
          const mov = { tipo: 'retiro', socio, monto: monto(f.monto) };
          const err = caja.revisar(actual.estado, mov);
          if (err) return json(res, 400, { error: err });
          const nombre = actual.nombres[socio];
          const numero = await siguienteNumero(adm);
          const rec = (await client.query(`INSERT INTO oficina_recibos (administracion, numero, tipo, socio, monto, moneda, concepto, metodo, referencia, fecha, periodo, detalle)
            VALUES ($1,$2,'socio',$3,$4,'US$',$5,$6,$7,$8,$9,$10) RETURNING id`,
            [adm, numero, nombre, mov.monto, `Retiro de utilidad · ${nombre}`, texto(f.metodo, 60), texto(f.referencia, 120), fecha, fecha.slice(0, 7),
              JSON.stringify({ caja: true, socio_clave: socio, le_tocaba: actual.estado.libre[socio], queda: Math.round((actual.estado.libre[socio] - mov.monto) * 100) / 100, nota: texto(f.nota, 300) })])).rows[0];
          await client.query(`INSERT INTO caja_movimientos (administracion, fecha, tipo, concepto, monto, socio, recibo_id, usuario) VALUES ($1,$2,'retiro',$3,$4,$5,$6,$7)`,
            [adm, fecha, `Retiro · ${nombre}`, mov.monto, socio, rec.id, quien]);
          await registrar(u, 'caja_retiro', 'recibo', rec.id, '', String(mov.monto), nombre);
          return json(res, 200, { ok: true, recibo_id: rec.id, numero });
        }
        if (url === '/api/oficina/caja/plan') {
          const empresaId = Number(f.empresa_id);
          const e = (await client.query("SELECT id, nombre FROM empresas WHERE id = $1 AND COALESCE(administracion, 'kaizen') = $2", [empresaId, adm])).rows[0];
          if (!e) return json(res, 400, { error: 'Elige el cliente del plan.' });
          const nombre = texto(f.nombre, 120);
          if (!nombre) return json(res, 400, { error: 'Escribe el nombre del plan (ej.: Plan de panel de correo).' });
          const dia = Math.min(31, Math.max(1, Number(f.dia_cobro) || 5));
          const vals = [empresaId, nombre, monto(f.precio_creacion), monto(f.mensualidad), dia, f.activo !== false, texto(f.moneda, 5) || 'US$'];
          let id = Number(f.id) || 0;
          if (id) {
            const r = await client.query('UPDATE oficina_planes SET empresa_id=$1, nombre=$2, precio_creacion=$3, mensualidad=$4, dia_cobro=$5, activo=$6, moneda=$7 WHERE id=$8 RETURNING id', [...vals, id]);
            if (!r.rowCount) return json(res, 404, { error: 'Ese plan ya no existe.' });
          } else id = (await client.query('INSERT INTO oficina_planes (empresa_id, nombre, precio_creacion, mensualidad, dia_cobro, activo, moneda) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', vals)).rows[0].id;
          // Cobros ya pagados y gastos sin plan que son de este plan.
          for (const pid of (Array.isArray(f.cobros) ? f.cobros : []).map(Number).filter(Boolean)) {
            await client.query('UPDATE oficina_pagos SET plan_id = $1 WHERE id = $2 AND empresa_id = $3 AND plan_id IS NULL', [id, pid, empresaId]);
          }
          for (const mid of (Array.isArray(f.gastos) ? f.gastos : []).map(Number).filter(Boolean)) {
            await client.query("UPDATE caja_movimientos SET plan_id = $1 WHERE id = $2 AND administracion = $3 AND tipo LIKE 'gasto%' AND plan_id IS NULL", [id, mid, adm]);
          }
          if (f.paquete !== undefined) {
            await client.query('UPDATE empresas SET cobro_paquete = $1, dia_paquete = $2 WHERE id = $3', [Boolean(f.paquete), Math.min(31, Math.max(1, Number(f.dia_paquete) || dia)), empresaId]);
          }
          await registrar(u, 'caja_plan', 'plan', id, '', nombre, e.nombre);
          return json(res, 200, { ok: true, id });
        }
        // Cobros del mes según los planes: uno por plan con su día, o uno solo en paquete; los extras van como líneas.
        if (url === '/api/oficina/caja/cobrar-mes') {
          const empresaId = Number(f.empresa_id);
          const e = (await client.query("SELECT id, nombre, cobro_paquete, dia_paquete FROM empresas WHERE id = $1 AND COALESCE(administracion, 'kaizen') = $2", [empresaId, adm])).rows[0];
          if (!e) return json(res, 400, { error: 'Elige el cliente.' });
          const mes = /^\d{4}-\d{2}$/.test(f.mes || '') ? f.mes : hoyLocal().slice(0, 7);
          const nombreMes = new Date(mes + '-15T12:00:00Z').toLocaleDateString('es-DO', { month: 'long', year: 'numeric', timeZone: 'UTC' });
          const planes = (await client.query('SELECT * FROM oficina_planes WHERE empresa_id = $1 AND activo = TRUE AND mensualidad > 0 ORDER BY id', [empresaId])).rows;
          const extras = (Array.isArray(f.extras) ? f.extras : []).map(x => ({ concepto: texto(x.concepto, 150), monto: monto(x.monto) })).filter(x => x.concepto && x.monto > 0).slice(0, 10);
          if (!planes.length && !extras.length) return json(res, 400, { error: 'Este cliente no tiene planes con mensualidad.' });
          // Día de cobro; en un mes más corto (ej. 30 en febrero) cae el último día de ese mes.
          const ultimo = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
          const dia = d => `${mes}-${String(Math.min(ultimo, Math.max(1, Number(d) || 5))).padStart(2, '0')}`;
          const ya = async (planId, concepto) => (await client.query("SELECT 1 FROM oficina_pagos WHERE empresa_id = $1 AND TO_CHAR(vence, 'YYYY-MM') = $2 AND (plan_id = $3 OR concepto = $4)", [empresaId, mes, planId, concepto])).rowCount > 0;
          const creados = [];
          const crear = async (concepto, lineas, vence, planId, moneda = 'US$') => {
            const total = Math.round(lineas.reduce((t, l) => t + l.monto, 0) * 100) / 100;
            const r = await client.query('INSERT INTO oficina_pagos (empresa_id, concepto, monto, moneda, vence, plan_id, lineas) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [empresaId, concepto, total, moneda, vence, planId, JSON.stringify(lineas)]);
            creados.push({ id: r.rows[0].id, concepto, total, vence });
          };
          const lineaPlan = pl => ({ concepto: `Mensualidad ${nombreMes} · ${pl.nombre}`, monto: Number(pl.mensualidad), plan_id: pl.id });
          if (e.cobro_paquete) {
            const concepto = `Mensualidad ${nombreMes} · paquete`;
            if (await ya(null, concepto)) return json(res, 400, { error: `Ya está creado el cobro de ${nombreMes}.` });
            const monedas = [...new Set(planes.map(pl => pl.moneda || 'US$'))];
            if (monedas.length > 1) return json(res, 400, { error: `Los programas de este cliente están en varias monedas (${monedas.join(', ')}): en paquete deben tener la misma.` });
            await crear(concepto, [...planes.map(lineaPlan), ...extras], dia(e.dia_paquete), planes.length === 1 ? planes[0].id : null, monedas[0] || 'US$');
          } else {
            for (const pl of planes) {
              const l = lineaPlan(pl);
              if (await ya(pl.id, l.concepto)) continue;
              await crear(l.concepto, [l, ...(pl === planes[0] ? extras : [])], dia(pl.dia_cobro), pl.id, pl.moneda || 'US$');
            }
            if (!planes.length && extras.length) await crear(`Extras ${nombreMes}`, extras, dia(5), null);
            if (!creados.length) return json(res, 400, { error: `Ya están creados los cobros de ${nombreMes}.` });
          }
          await registrar(u, 'caja_cobrar_mes', 'empresa', empresaId, '', mes, creados.map(c => c.concepto).join(' | '));
          return json(res, 200, { ok: true, creados });
        }
        // Cambiar el grupo de un gasto (creación, mensual, del negocio) o el programa al que se carga.
        if (url === '/api/oficina/caja/clasificar') {
          const m = (await client.query("SELECT * FROM caja_movimientos WHERE id = $1 AND administracion = $2 AND tipo LIKE 'gasto%'", [Number(f.id), adm])).rows[0];
          if (!m) return json(res, 404, { error: 'Ese gasto no existe.' });
          const tipo = ['gasto_creacion', 'gasto_mensual', 'gasto_negocio'].includes(f.tipo) ? f.tipo : m.tipo;
          let plan = f.plan_id === undefined ? m.plan_id : (Number(f.plan_id) || null);
          if (plan && !(await client.query("SELECT 1 FROM oficina_planes pl JOIN empresas e ON e.id = pl.empresa_id WHERE pl.id = $1 AND COALESCE(e.administracion, 'kaizen') = $2", [plan, adm])).rowCount) plan = null;
          await client.query("UPDATE caja_movimientos SET tipo = $2, plan_id = $3, detalle = detalle || $4::jsonb WHERE id = $1", [m.id, tipo, plan, JSON.stringify(tipo !== m.tipo ? { tipo_manual: true } : {})]);
          await registrar(u, 'caja_clasificar', 'caja', m.id, m.tipo, tipo, m.concepto);
          return json(res, 200, { ok: true });
        }
        if (url === '/api/oficina/caja/deshacer') {
          // Solo el último movimiento hecho a mano (gasto, reparto o retiro), para que las cuentas siempre cuadren.
          const ult = (await client.query("SELECT * FROM caja_movimientos WHERE administracion = $1 AND tipo <> 'entrada' AND detalle->>'origen' IS NULL ORDER BY id DESC LIMIT 1", [adm])).rows[0];
          if (!ult || ult.id !== Number(f.id)) return json(res, 400, { error: 'Solo se puede deshacer el último movimiento que se anotó a mano.' });
          await client.query('DELETE FROM caja_movimientos WHERE id = $1', [ult.id]);
          if (ult.recibo_id) await client.query("UPDATE oficina_recibos SET detalle = detalle || '{\"anulado\": true}'::jsonb, concepto = concepto || ' (ANULADO)' WHERE id = $1", [ult.recibo_id]);
          await registrar(u, 'caja_deshacer', 'caja', ult.id, ult.tipo, String(ult.monto), ult.concepto);
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { error: 'No encontrado.' });
      }
      // Retiro de utilidades del socio: lo que le toca en el mes menos lo que ya retiró.
      if (req.method === 'GET' && url === '/api/oficina/socio/disponible') {
        const clave = ADMINISTRACIONES.includes(p.get('administracion')) ? p.get('administracion') : null;
        if (!clave) return json(res, 400, { error: 'Administración no válida.' });
        if (!puedeAdmin(u, permisos, clave)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        const mes = /^\d{4}-\d{2}$/.test(p.get('mes') || '') ? p.get('mes') : hoyLocal().slice(0, 7);
        return json(res, 200, await disponibleSocio(clave, mes));
      }
      if (req.method === 'POST' && url === '/api/oficina/recibo/socio') {
        const f = await leerCuerpo(req);
        const clave = ADMINISTRACIONES.includes(f.administracion) ? f.administracion : null;
        if (!clave) return json(res, 400, { error: 'Administración no válida.' });
        if (!puedeAdmin(u, permisos, clave)) return json(res, 403, { error: 'No tienes acceso a esta administración.' });
        const mes = /^\d{4}-\d{2}$/.test(f.mes || '') ? f.mes : hoyLocal().slice(0, 7);
        const d = await disponibleSocio(clave, mes);
        const cantidad = f.monto === undefined || f.monto === null || f.monto === '' ? d.disponible : monto(f.monto);
        if (!(cantidad > 0)) return json(res, 400, { error: 'El monto del retiro debe ser mayor que 0.' });
        const descuentos = (Array.isArray(f.descuentos) ? f.descuentos : []).map(x => ({ nombre: texto(x.nombre, 80) || 'Descuento', monto: monto(x.monto) })).filter(x => x.monto > 0).slice(0, 10);
        const totalDescuentos = Math.round(descuentos.reduce((t, x) => t + x.monto, 0) * 100) / 100;
        if (totalDescuentos > cantidad) return json(res, 400, { error: 'Los descuentos son más que el monto del retiro.' });
        const recibe = Math.round((cantidad - totalDescuentos) * 100) / 100;
        const fecha = fechaValida(f.fecha) ? f.fecha : hoyLocal();
        const numero = await siguienteNumero(clave);
        const ins = (await client.query(`INSERT INTO oficina_recibos (administracion, numero, tipo, socio, monto, moneda, concepto, metodo, referencia, fecha, periodo, detalle)
          VALUES ($1,$2,'socio',$3,$4,'US$',$5,$6,$7,$8,$9,$10) RETURNING id`,
          [clave, numero, d.socio || 'Socio', cantidad, `Adelanto de utilidades · ${mes}`, texto(f.metodo, 60), texto(f.referencia, 120), fecha, mes,
            JSON.stringify({ utilidad: d.utilidad, pct: d.pct, participacion: d.participacion, retirado_antes: d.retirado, disponible_antes: d.disponible, nota: texto(f.nota, 300), descuentos, total_descuentos: totalDescuentos, recibe })])).rows[0];
        await registrar(u, 'recibo_socio', 'recibo', ins.id, '', String(cantidad), mes);
        return json(res, 200, { ok: true, recibo_id: ins.id, numero, queda_negativo: cantidad > d.disponible ? Math.round((cantidad - d.disponible) * 100) / 100 : 0 });
      }
      if (req.method === 'POST' && url === '/api/oficina/administracion/guardar') {
        if (u.grupo !== 'Programador' && !(permisos || {}).oficina_gastos_editar) return json(res, 403, { error: 'Puedes ver los datos, pero no cambiarlos.' });
        const f = await leerCuerpo(req);
        if (!ADMINISTRACIONES.includes(f.clave)) return json(res, 400, { error: 'Administración no válida.' });
        const logo = f.logo == null ? null : String(f.logo);
        if (logo && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(logo)) return json(res, 400, { error: 'El logo debe ser una imagen PNG, JPG o WEBP.' });
        if (logo && logo.length > 200000) return json(res, 400, { error: 'El logo pesa demasiado. Usa una imagen de menos de 150 KB.' });
        const pct = f.socio_porcentaje === '' || f.socio_porcentaje == null ? null : Math.min(100, Math.max(0, Number(f.socio_porcentaje) || 0));
        await client.query('UPDATE oficina_administraciones SET nombre=$2, legal=$3, documento=$4, direccion=$5, correo=$6, telefono=$7, web=$8, logo=COALESCE($9, logo), socio_nombre=$10, socio_documento=$11, socio_porcentaje=$12, etiqueta_mia=COALESCE($13, etiqueta_mia), etiqueta_socio=COALESCE($14, etiqueta_socio), actualizado=NOW() WHERE clave=$1',
          [f.clave, texto(f.nombre, 120), texto(f.legal, 160), texto(f.documento, 60), texto(f.direccion, 300), texto(f.correo, 120), texto(f.telefono, 40), texto(f.web, 160), logo,
           texto(f.socio_nombre, 120), texto(f.socio_documento, 60), pct, f.etiqueta_mia === undefined ? null : (texto(f.etiqueta_mia, 40) || 'Mi parte'), f.etiqueta_socio === undefined ? null : (texto(f.etiqueta_socio, 40) || 'Parte del socio')]);
        await registrar(u, 'administracion_guardar', 'administracion', f.clave, '', '', texto(f.nombre, 120));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/oficina/administracion/empresa') {
        if (u.grupo !== 'Programador' && !(permisos || {}).oficina_gastos_editar) return json(res, 403, { error: 'No puedes cambiar esto.' });
        const f = await leerCuerpo(req);
        if (!ADMINISTRACIONES.includes(f.administracion)) return json(res, 400, { error: 'Administración no válida.' });
        const r = await client.query('UPDATE empresas SET administracion = $1 WHERE id = $2', [f.administracion, Number(f.empresa_id)]);
        if (!r.rowCount) return json(res, 404, { error: 'Empresa no encontrada.' });
        await registrar(u, 'administracion_empresa', 'empresa', Number(f.empresa_id), '', f.administracion, '');
        return json(res, 200, { ok: true });
      }

      const g = url.match(/^\/api\/oficina\/(guardar|borrar)\/(pagos|gastos|eventos|enlaces|automatizaciones)$/);
      if (g && req.method === 'POST' && g[2] === 'gastos' && u.grupo !== 'Programador' && !(permisos || {}).oficina_gastos_editar) {
        return json(res, 403, { error: 'Puedes ver los gastos, pero no cambiarlos.' });
      }
      if (g && req.method === 'POST') {
        const f = await leerCuerpo(req);
        if (g[1] === 'guardar') {
          await guardar(g[2], f);
          await registrar(u, 'oficina_guardar', g[2], f.id || 'nuevo', '', '', texto(f.concepto || f.nombre || f.titulo, 120));
        } else {
          let detalle = '';
          if (g[2] === 'pagos') {
            // Antes de borrar, se guarda qué cobro era (la auditoría necesita concepto y monto).
            const c = (await client.query('SELECT empresa_id, concepto, monto, moneda, vence, pagado_el, auto_mes FROM oficina_pagos WHERE id = $1', [Number(f.id)])).rows[0];
            if (!c) return json(res, 404, { error: 'Ese cobro ya no existe.' });
            detalle = `${c.concepto} · ${c.moneda} ${c.monto} · vence ${String(c.vence).slice(0, 10)} · ${c.pagado_el ? 'pagado' : 'pendiente'}`;
            // Si es una mensualidad automática, se recuerda que se borró para que no vuelva a crearse.
            if (c.auto_mes && c.empresa_id) await client.query('INSERT INTO oficina_cobros_borrados (empresa_id, auto_mes) VALUES ($1, $2) ON CONFLICT DO NOTHING', [c.empresa_id, c.auto_mes]);
          }
          await client.query(`DELETE FROM oficina_${g[2]} WHERE id = $1`, [Number(f.id)]);
          await registrar(u, 'oficina_borrar', g[2], f.id, detalle, '', detalle);
        }
        return json(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url === '/api/oficina/diseno') {
        const r = (await client.query('SELECT diseno FROM oficina_diseno WHERE usuario = $1', [u.usuario])).rows[0];
        return json(res, 200, { diseno: r ? r.diseno : null });
      }
      if (req.method === 'POST' && url === '/api/oficina/diseno') {
        const f = await leerCuerpo(req);
        const limpio = limpiarDisenoOficina(f.diseno);
        if (!limpio) return json(res, 400, { error: 'El diseño no es válido.' });
        await client.query(`INSERT INTO oficina_diseno (usuario, diseno, actualizado) VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (usuario) DO UPDATE SET diseno = EXCLUDED.diseno, actualizado = NOW()`, [u.usuario, JSON.stringify(limpio)]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/oficina/evento-hecho') {
        const f = await leerCuerpo(req);
        await client.query('UPDATE oficina_eventos SET hecho = $1 WHERE id = $2', [Boolean(f.hecho), Number(f.id)]);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url === '/api/oficina/pagado') {
        const f = await leerCuerpo(req);
        const pago = (await client.query("SELECT *, TO_CHAR(vence, 'YYYY-MM-DD') AS vence FROM oficina_pagos WHERE id = $1", [Number(f.id)])).rows[0];
        if (!pago) return json(res, 404, { error: 'Cobro no encontrado.' });
        if (f.deshacer) {
          await client.query("UPDATE oficina_pagos SET pagado_el = NULL, forma = '' WHERE id = $1", [pago.id]);
          await registrar(u, 'oficina_pago_deshecho', 'pago', pago.id, '', '', pago.concepto);
          return json(res, 200, { ok: true });
        }
        const fecha = fechaValida(f.fecha) ? f.fecha : hoyLocal();
        const comp = String(f.comprobante || '');
        if (!comp) return json(res, 400, { error: 'Sube el voucher del pago (PDF o imagen). Sin voucher no se registra el pago.' });
        if (!/^data:(application\/pdf|image\/(png|jpeg|webp));base64,[A-Za-z0-9+\/=]+$/.test(comp)) return json(res, 400, { error: 'El voucher debe ser PDF, PNG, JPG o WEBP.' });
        if (comp.length > 2800000) return json(res, 400, { error: 'El voucher pesa más de 2 MB.' });
        const usd = pago.moneda === 'US$' ? null : monto(f.recibido_usd);
        if (pago.moneda !== 'US$' && !(usd > 0)) return json(res, 400, { error: `Este cobro es en ${pago.moneda}: escribe cuánto llegó en US$.` });
        await client.query('UPDATE oficina_pagos SET pagado_el = $1, forma = $2, comprobante = $4, comprobante_nombre = $5, referencia = $6, recibido_usd = $7 WHERE id = $3',
          [fecha, texto(f.forma, 60), pago.id, comp, texto(f.comprobante_nombre, 200), texto(f.referencia, 120), usd]);
        // Todo cobro pagado lleva su recibo al cliente.
        const recibo = await reciboDeCobro(pago.id);
        // Si es la mensualidad automática, el panel del cliente también la da por pagada y quita el aviso.
        let avisoQuitado = false;
        if (pago.auto_mes && pago.empresa_id) {
          try {
            const e = await A.empresa(pago.empresa_id);
            // Sin panel de reservas: el último mes pagado se guarda en Oficina.
            if (e.sin_panel) await client.query(`UPDATE empresas SET cuenta_central = COALESCE(cuenta_central, '{}'::jsonb) ||
              jsonb_build_object('pagado', GREATEST(COALESCE(cuenta_central->>'pagado', ''), $1::text)) WHERE id = $2`, [pago.auto_mes, e.id]);
            else await A.conEmpresa(e, db => db.query(`UPDATE cuenta SET pagado = CASE WHEN COALESCE(pagado, '') < $1 THEN $1 ELSE pagado END,
              aviso_pago = '', actualizado = NOW() WHERE id = 1`, [pago.auto_mes]));
            avisoQuitado = true;
          } catch (err) { /* sin conexión con la empresa: queda anotado aquí igual */ }
        }
        await registrar(u, 'oficina_pago_recibido', 'pago', pago.id, '', fecha, `${pago.concepto} · ${pago.moneda} ${pago.monto}`);
        return json(res, 200, { ok: true, avisoQuitado, recibo_id: recibo.id });
      }

      const ce = url.match(/^\/api\/oficina\/empresa\/(\d+)$/);
      if (ce && req.method === 'POST') {
        const f = await leerCuerpo(req);
        const e = await A.empresa(ce[1]);
        const clave = f.ia_clave === null ? '' : texto(f.ia_clave, 200);
        await client.query(`UPDATE empresas SET plan = $1, contacto = $2, telefono = $3, correo_contacto = $4, notas = $5,
          ia_clave = CASE WHEN $6 = '__borrar__' THEN '' WHEN $6 = '' THEN ia_clave ELSE $6 END WHERE id = $7`,
          [texto(f.plan, 60), texto(f.contacto, 100), texto(f.telefono, 40), texto(f.correo_contacto, 120), texto(f.notas, 2000), f.borrarClave ? '__borrar__' : clave, e.id]);
        cacheClaves.clear();
        await registrar(u, 'oficina_editar_cliente', 'empresa', e.slug, '', '', clave ? 'con clave de IA nueva' : '');
        // Claves que se mandan a la base del panel del cliente (ahí las usa el panel): n8n y OpenRouter.
        const empujar = (nombre, valor) => A.conEmpresa(e, async db => {
          await db.query("CREATE TABLE IF NOT EXISTS zentralia_ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL DEFAULT '')");
          await db.query('INSERT INTO zentralia_ajustes (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor', [nombre, valor]);
        });
        const avisos = [];
        if (f.borrarN8n || texto(f.n8n_clave || '', 300)) {
          const valor = f.borrarN8n ? '' : texto(f.n8n_clave, 300);
          await client.query('UPDATE empresas SET n8n_clave = $1 WHERE id = $2', [valor, e.id]);
          try { await empujar('n8n_clave', valor); await registrar(u, 'oficina_editar_cliente', 'empresa', e.slug, '', '', valor ? 'clave de n8n guardada' : 'clave de n8n quitada'); }
          catch (err) { avisos.push('clave de n8n: ' + err.message); }
        }
        if (f.borrarClave || clave) {
          const valor = f.borrarClave ? '' : clave;
          try { await empujar('ia_clave', valor); await registrar(u, 'oficina_editar_cliente', 'empresa', e.slug, '', '', valor ? 'clave de OpenRouter enviada al panel' : 'clave de OpenRouter quitada del panel'); }
          catch (err) { avisos.push('clave de OpenRouter: ' + err.message); }
        }
        // Correo para leer (Yahoo u otro IMAP): se guarda aquí y el panel del cliente lo lee como un buzón más.
        if (f.borrarCorreo || texto(f.correo_usuario || '', 120)) {
          const usuario = f.borrarCorreo ? '' : texto(f.correo_usuario, 120).trim();
          const host = f.borrarCorreo ? '' : (texto(f.correo_host || '', 120).trim() || 'imap.mail.yahoo.com');
          const clave = f.borrarCorreo ? '' : (f.correo_clave ? texto(f.correo_clave, 200) : (e.correo_clave || ''));
          await client.query('UPDATE empresas SET correo_lectura = $1, correo_host = $2, correo_clave = $3 WHERE id = $4', [usuario, host, clave, e.id]);
          const valor = usuario && clave ? JSON.stringify({ buzon: usuario, imap: { host, puerto: 993, usuario, clave } }) : '';
          try { await empujar('imap_cuenta', valor); await registrar(u, 'oficina_editar_cliente', 'empresa', e.slug, '', '', valor ? 'correo de lectura guardado' : 'correo de lectura quitado'); }
          catch (err) { avisos.push('correo de lectura: ' + err.message); }
        }
        const aviso = avisos.length ? 'Guardado en Oficina, pero no se pudo enviar al panel del cliente (¿está encendido?): ' + avisos.join('; ') : '';
        return json(res, 200, { ok: true, aviso });
      }

      if (req.method === 'GET' && url === '/api/oficina/chat/contactos') {
        return json(res, 200, { empresas: await contactos() });
      }
      if (req.method === 'GET' && url === '/api/oficina/chat/mensajes') {
        const e = await A.empresa(p.get('empresa'));
        const con = texto(p.get('con'), 50);
        const r = await A.conEmpresa(e, async db => {
          const yo = await programadorDe(db);
          if (!yo) return { error: 'Esa empresa no tiene un usuario Programador para chatear.' };
          await db.query('UPDATE mensajes SET leido = TRUE WHERE de = $1 AND para = $2 AND leido = FALSE', [con, yo.usuario]);
          const m = (await db.query(`SELECT id, de, para, texto, fecha, (imagen IS NOT NULL) AS "tieneImagen" FROM (
              SELECT * FROM mensajes WHERE (de = $1 AND para = $2) OR (de = $2 AND para = $1) ORDER BY fecha DESC, id DESC LIMIT 100) t
            ORDER BY fecha, id`, [yo.usuario, con])).rows;
          return { yo: yo.usuario, mensajes: m };
        });
        if (r.error) return json(res, 400, r);
        return json(res, 200, r);
      }
      if (req.method === 'POST' && url === '/api/oficina/chat/enviar') {
        const f = await leerCuerpo(req);
        const e = await A.empresa(f.empresa);
        const limpio = texto(f.texto, 1000);
        if (!limpio) return json(res, 400, { error: 'Escribe el mensaje.' });
        const r = await A.conEmpresa(e, async db => {
          const yo = await programadorDe(db);
          if (!yo) return { error: 'Esa empresa no tiene un usuario Programador para chatear.' };
          const existe = (await db.query("SELECT 1 FROM usuarios WHERE usuario = $1 AND activo = TRUE AND grupo <> 'Programador'", [texto(f.para, 50)])).rowCount;
          if (!existe) return { error: 'Esa persona ya no existe o está desactivada.' };
          await db.query('INSERT INTO mensajes (de, para, texto) VALUES ($1, $2, $3)', [yo.usuario, texto(f.para, 50), limpio]);
          return { ok: true };
        });
        if (r.error) return json(res, 400, r);
        await registrar(u, 'oficina_chat', 'empresa', e.slug, '', texto(f.para, 50), '');
        return json(res, 200, r);
      }

      return json(res, 404, { error: 'Ruta no encontrada' });
    } catch (e) {
      return json(res, e.codigo || 500, { error: e.message });
    }
  }

  // Recibo compartido por enlace: copia fija del recibo, sin scripts (página aislada), con un enlace imposible de adivinar.
  async function servirReciboPublico(req, res, url) {
    const token = url.slice(3);
    if (!/^[A-Za-z0-9_-]{30,60}$/.test(token)) { res.writeHead(404); return res.end('No encontrado'); }
    const fila = (await client.query('SELECT html FROM oficina_recibo_enlaces WHERE token = $1', [token]).catch(() => ({ rows: [] }))).rows[0];
    if (!fila) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Este recibo no existe o el enlace ya no es válido.'); }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "sandbox allow-modals; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data: https:",
      'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, max-age=300'
    });
    return res.end(fila.html);
  }

  return { activo, preparar, manejar, conocimiento, redes, apps, servirReciboPublico };
};
