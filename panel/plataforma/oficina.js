// Oficina de Kaizen IA: la pantalla de administración del dueño (solo en el panel central, solo el programador).
// Clientes y cobros, gastos (servidor, dominio, IA, redes, automatizaciones...), calendario, estado de cada negocio
// (panel, n8n, motor, IA, alertas), chat con la gente de cada negocio y enlaces.
//
// Todo se guarda en la base del central. De cada empresa solo se LEE su base (y se escribe el chat y el "pagado").

const { hoyLocal } = require('./cuenta');
const crearConocimiento = require('./conocimiento');

const CATEGORIAS = {
  servidor: 'Servidor', dominio: 'Dominio', ia: 'IA (tokens)', redes: 'Redes sociales', automatizacion: 'Automatizaciones',
  software: 'Programas y suscripciones', publicidad: 'Publicidad', otro: 'Otro'
};
const FRECUENCIAS = { mensual: 'Cada mes', anual: 'Cada año', unico: 'Una sola vez' };
const TIPOS_EVENTO = { tarea: 'Tarea', demo: 'Demo', cita: 'Cita / llamada', cobro: 'Cobro', otro: 'Otro' };
const ESTADOS_ABIERTOS = ['pendiente de transcribir', 'revisar', 'actualizada'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const ENLACES_INICIALES = [
  ['Infraestructura', 'Cloudflare', 'https://dash.cloudflare.com', '☁️', 'Túnel, portero y dominio', false],
  ['Infraestructura', 'n8n', 'http://localhost:5678', '⚙️', 'Flujos de correo', true],
  ['Infraestructura', 'Chatwoot', 'http://localhost:3000', '💬', 'Redes sociales de los clientes', false],
  ['Infraestructura', 'Hostinger', 'https://hpanel.hostinger.com', '🖥️', 'Servidor', false],
  ['Infraestructura', 'OpenRouter', 'https://openrouter.ai/settings/credits', '🪙', 'Saldo y claves de IA', false],
  ['Infraestructura', 'Azure / Microsoft 365', 'https://portal.azure.com', '🪟', 'Permisos de correo', false],
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
  const conocimiento = crearConocimiento({ client, registrar, central });

  async function preparar() {
    if (!activo) return;
    await conocimiento.preparar();
    for (const col of ['plan', 'contacto', 'telefono', 'correo_contacto', 'ia_clave']) {
      await client.query(`ALTER TABLE empresas ADD COLUMN IF NOT EXISTS ${col} TEXT NOT NULL DEFAULT ''`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_pagos (
      id SERIAL PRIMARY KEY, empresa_id INTEGER, concepto TEXT NOT NULL, monto NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda VARCHAR(5) NOT NULL DEFAULT 'US$', vence DATE NOT NULL, pagado_el DATE, forma TEXT NOT NULL DEFAULT '',
      nota TEXT NOT NULL DEFAULT '', auto_mes VARCHAR(7), creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS oficina_pagos_auto ON oficina_pagos (empresa_id, auto_mes) WHERE auto_mes IS NOT NULL');
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_gastos (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, categoria VARCHAR(20) NOT NULL DEFAULT 'otro', monto NUMERIC(12,2) NOT NULL DEFAULT 0,
      moneda VARCHAR(5) NOT NULL DEFAULT 'US$', frecuencia VARCHAR(10) NOT NULL DEFAULT 'mensual', dia INTEGER, fecha DATE,
      empresa_id INTEGER, url TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', activo BOOLEAN NOT NULL DEFAULT TRUE,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_eventos (
      id SERIAL PRIMARY KEY, titulo TEXT NOT NULL, fecha DATE NOT NULL, hora VARCHAR(5) NOT NULL DEFAULT '',
      tipo VARCHAR(10) NOT NULL DEFAULT 'tarea', empresa_id INTEGER, nota TEXT NOT NULL DEFAULT '', hecho BOOLEAN NOT NULL DEFAULT FALSE,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_enlaces (
      id SERIAL PRIMARY KEY, grupo TEXT NOT NULL DEFAULT 'Otros', nombre TEXT NOT NULL, url TEXT NOT NULL, icono VARCHAR(8) NOT NULL DEFAULT '🔗',
      nota TEXT NOT NULL DEFAULT '', vigilar BOOLEAN NOT NULL DEFAULT FALSE, orden INTEGER NOT NULL DEFAULT 0,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_ia_uso (
      empresa_id INTEGER NOT NULL, dia DATE NOT NULL, uso NUMERIC(14,6) NOT NULL, PRIMARY KEY (empresa_id, dia))`);
    if (!(await client.query('SELECT COUNT(*)::int AS n FROM oficina_enlaces')).rows[0].n) {
      let orden = 0;
      for (const [grupo, nombre, url, icono, nota, vigilar] of ENLACES_INICIALES) {
        await client.query('INSERT INTO oficina_enlaces (grupo, nombre, url, icono, nota, vigilar, orden) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [grupo, nombre, url, icono, nota, vigilar, orden++]);
      }
    }
  }

  // Consulta a la base de una empresa que no falla si la tabla todavía no existe (versión vieja del panel).
  const q = async (db, sql, vals = [], porDefecto = []) => { try { return (await db.query(sql, vals)).rows; } catch (e) { return porDefecto; } };

  // ---------- IA: gasto de cada empresa con su propia clave de OpenRouter ----------

  const cacheClaves = new Map();
  async function consultarClave(clave) {
    const guardado = cacheClaves.get(clave);
    if (guardado && Date.now() - guardado.t < 10 * 60 * 1000) return guardado.datos;
    let datos = null;
    try {
      const control = new AbortController();
      const reloj = setTimeout(() => control.abort(), 8000);
      const r = await fetch(A.OPENROUTER + '/key', { headers: { Authorization: 'Bearer ' + clave }, signal: control.signal });
      clearTimeout(reloj);
      datos = r.ok ? (await r.json()).data || null : { error: 'OpenRouter respondió ' + r.status + (r.status === 401 ? ' (clave no válida)' : '') };
    } catch (e) { datos = { error: 'No se pudo consultar OpenRouter' }; }
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
      limite: d.limit ?? null, restante: d.limit_remaining ?? null, hoy: typeof d.usage_daily === 'number' ? Math.round(d.usage_daily * 100) / 100 : null
    };
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
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`, [e.id, 'Mensualidad ' + nombreMes(mes), valor, moneda(p.moneda), vence, mes]);
      }
      // Si en el panel de la empresa ya se marcó pagado un mes (desde Empresas), aquí también queda pagado.
      if (e.cuenta && /^\d{4}-\d{2}$/.test(e.cuenta.pagado || '')) {
        await client.query(`UPDATE oficina_pagos SET pagado_el = vence, forma = 'Registrado en Empresas'
          WHERE empresa_id = $1 AND auto_mes IS NOT NULL AND auto_mes <= $2 AND pagado_el IS NULL`, [e.id, e.cuenta.pagado]);
      }
    }
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

    const pagos = (await client.query(`SELECT p.*, TO_CHAR(p.vence, 'YYYY-MM-DD') AS vence, TO_CHAR(p.pagado_el, 'YYYY-MM-DD') AS pagado_el, e.nombre AS empresa
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
          plan: e.plan, contacto: e.contacto, telefono: e.telefono, correo_contacto: e.correo_contacto, notas: e.notas,
          tieneClaveIA: Boolean(claveDe(e)), claveIAPropia: Boolean(e.ia_clave),
          pago: d.pagoCentral || {}, pagado: (d.cuenta || {}).pagado || '', etapaPago: d.etapaPago,
          usuarios: (d.numeros || {}).usuarios ?? null, correosHoy: (d.numeros || {}).correos_hoy ?? null, error: d.error || '',
          ia: ia.get(d.id) || { tiene: false }
        };
      }),
      pagos, gastos, eventos, enlaces, totales: t, serie
    };
  }

  // ---------- Estado de cada negocio (se lee de su propia base) ----------

  const minutosDesde = f => (f ? Math.round((Date.now() - new Date(f).getTime()) / 60000) : null);

  async function estadoNegocio(e) {
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
        const mu = minutosDesde(num.ultimo);
        fila('Correos', num.hoy ? 'bien' : 'gris', `${num.hoy || 0} hoy · último hace ${mu === null ? '—' : mu < 60 ? mu + ' min' : Math.round(mu / 60) + ' h'}`);
        fila('IA (lectura de reservas)', (num.errores || 0) >= 5 ? 'falla' : 'bien', num.errores ? `${num.errores} error(es) en la última hora` : 'Sin errores en la última hora');
        r.pendientes = num.pendientes || 0;
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
    const filas = (await client.query("SELECT * FROM empresas WHERE estado <> 'apagada' ORDER BY es_demo, nombre")).rows;
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
        empresaId, texto(f.url, 300), texto(f.nota, 500), f.activo !== false];
      if (!v[0]) throw Object.assign(new Error('Escribe el nombre del gasto (ej.: Servidor Hostinger).'), { codigo: 400 });
      if (frecuencia !== 'mensual' && !v[6]) throw Object.assign(new Error('Elige la fecha del pago (o de la próxima renovación).'), { codigo: 400 });
      if (v[8] && !/^https?:\/\//i.test(v[8])) throw Object.assign(new Error('El enlace debe empezar con http:// o https://'), { codigo: 400 });
      if (id) await client.query('UPDATE oficina_gastos SET nombre=$1, categoria=$2, monto=$3, moneda=$4, frecuencia=$5, dia=$6, fecha=$7, empresa_id=$8, url=$9, nota=$10, activo=$11 WHERE id=$12', [...v, id]);
      else await client.query('INSERT INTO oficina_gastos (nombre, categoria, monto, moneda, frecuencia, dia, fecha, empresa_id, url, nota, activo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', v);
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
    throw Object.assign(new Error('Tipo no válido.'), { codigo: 400 });
  }

  async function manejar(req, res, url, u, { json, leerCuerpo }) {
    if (!activo) return json(res, 404, { error: 'La Oficina solo existe en el panel central.' });
    if (!u) return json(res, 401, { error: 'Sin sesión' });
    if (u.grupo !== 'Programador') return json(res, 403, { error: 'La Oficina es solo del programador.' });
    try {
      const p = new URL(req.url, 'http://localhost').searchParams;

      if (url === '/api/oficina/conocimiento' || url.startsWith('/api/oficina/conocimiento/')) {
        return await conocimiento.manejarOficina(req, res, url, u, { json, leerCuerpo });
      }
      if (req.method === 'GET' && url === '/api/oficina/datos') {
        const mes = /^\d{4}-\d{2}$/.test(p.get('mes') || '') ? p.get('mes') : hoyLocal().slice(0, 7);
        return json(res, 200, await datos(mes));
      }
      if (req.method === 'GET' && url === '/api/oficina/negocios') {
        const filas = (await client.query('SELECT * FROM empresas ORDER BY es_demo, nombre')).rows;
        return json(res, 200, { negocios: await Promise.all(filas.map(estadoNegocio)) });
      }
      if (req.method === 'GET' && url === '/api/oficina/servicios') {
        const lista = (await client.query('SELECT * FROM oficina_enlaces WHERE vigilar = TRUE')).rows;
        return json(res, 200, { servicios: await Promise.all(lista.map(revisarEnlace)) });
      }

      const g = url.match(/^\/api\/oficina\/(guardar|borrar)\/(pagos|gastos|eventos|enlaces)$/);
      if (g && req.method === 'POST') {
        const f = await leerCuerpo(req);
        if (g[1] === 'guardar') {
          await guardar(g[2], f);
          await registrar(u, 'oficina_guardar', g[2], f.id || 'nuevo', '', '', texto(f.concepto || f.nombre || f.titulo, 120));
        } else {
          await client.query(`DELETE FROM oficina_${g[2]} WHERE id = $1`, [Number(f.id)]);
          await registrar(u, 'oficina_borrar', g[2], f.id, '', '', '');
        }
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
        await client.query('UPDATE oficina_pagos SET pagado_el = $1, forma = $2 WHERE id = $3', [fecha, texto(f.forma, 60), pago.id]);
        // Si es la mensualidad automática, el panel del cliente también la da por pagada y quita el aviso.
        let avisoQuitado = false;
        if (pago.auto_mes && pago.empresa_id) {
          try {
            const e = await A.empresa(pago.empresa_id);
            await A.conEmpresa(e, db => db.query(`UPDATE cuenta SET pagado = CASE WHEN COALESCE(pagado, '') < $1 THEN $1 ELSE pagado END,
              aviso_pago = '', actualizado = NOW() WHERE id = 1`, [pago.auto_mes]));
            avisoQuitado = true;
          } catch (err) { /* sin conexión con la empresa: queda anotado aquí igual */ }
        }
        await registrar(u, 'oficina_pago_recibido', 'pago', pago.id, '', fecha, `${pago.concepto} · ${pago.moneda} ${pago.monto}`);
        return json(res, 200, { ok: true, avisoQuitado });
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
        return json(res, 200, { ok: true });
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

  return { activo, preparar, manejar, conocimiento };
};
