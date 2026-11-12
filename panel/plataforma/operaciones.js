// Operaciones (reservas → choferes): lo que pasa después de que una reserva queda "Registrada".
//   • Cada servicio registrado aparece solo en Operaciones como "Por asignar".
//   • Operaciones elige chofer propio o transportista externo; avisa si no cabe o si se cruza con otro servicio.
//   • Precio de venta (tarifario de la agencia) y costo (tarifario del proveedor o pago del chofer) → ganancia.
//   • Reserva manual (llamada / WhatsApp / oficina) y paquetes de Orlando (entradas, transporte, traslados).
//   • Operativo del día imprimible, reportes por agencia / proveedor / general, voucher y cotización.
//   • Fase 2: vuelos en vivo (AeroDataBox o FlightAware), app web del chofer con ubicación, WhatsApp por Chatwoot.
// Todo se enciende o se apaga desde Configuración (solo con el permiso "configurar_operaciones").
// Mientras no se publica, solo el Programador lo ve: los demás ven "Próximamente".

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { leerExcel } = require('./lector-xlsx');

const AEROPUERTOS_RD = ['PUJ', 'SDQ', 'LRM', 'POP', 'STI', 'JBQ', 'AZS', 'BRX', 'STO'];
const AEROPUERTOS_ORL = ['MCO', 'SFB', 'TPA', 'MIA', 'FLL'];
const ESTADOS = ['por_asignar', 'asignado', 'en_camino', 'en_sitio', 'recogido', 'completado', 'no_show', 'cancelado'];
const NOMBRE_ESTADO = { por_asignar: 'Por asignar', asignado: 'Asignado', en_camino: 'En camino', en_sitio: 'En el lugar', recogido: 'Recogido', completado: 'Completado', no_show: 'No show', cancelado: 'Cancelado' };
const TIPOS_TARIFA = ['TRASLADO', 'IN', 'OUT', 'INTERHOTEL', 'ACTIVIDAD', 'ENTRADA', 'TRANSPORTE', 'OTRO'];
const TIPOS_PROVEEDOR = ['transportista', 'tours', 'entradas', 'otro'];

const MODULOS_INICIALES = { operaciones: true, reserva_manual: true, operativo: true, precios: true, reportes: true, paquetes: true, vuelos: false, app_chofer: false, whatsapp: false };
const REGLAS_INICIALES = {
  antes_aeropuerto_min: 180,   // salida: el cliente debe estar en el aeropuerto X minutos antes del vuelo
  espera_llegada_min: 30,      // llegada: tiempo de espera del chofer desde que aterriza
  minutos_entre_servicios: 15, // margen mínimo entre dos servicios del mismo chofer
  duracion_traslado_min: 60,   // si la zona no tiene tiempo propio
  duracion_actividad_min: 240,
  tiempos_zona: { 'Bávaro': 30, 'Punta Cana': 20, 'Cap Cana': 20, 'Uvero Alto': 50, 'Macao': 40, 'Bayahíbe': 75, 'La Romana': 70, 'Santo Domingo': 150, 'International Drive': 20, 'Lake Buena Vista': 25, 'Kissimmee': 30, 'Disney': 25 },
  aviso_retraso_min: 15,       // vuelos: avisar si se mueve más que esto
  consultar_vuelos_cada_min: 10
};
const PLANTILLAS_INICIALES = {
  operativo: { titulo: 'Operativo del día', subtitulo: '', columnas: ['hora', 'servicio', 'pasajero', 'pax', 'vuelo', 'recoger', 'llevar', 'agencia', 'notas'], pie: 'Llegar 10 minutos antes. Cartel con el nombre del pasajero en llegadas.', firmas: true },
  voucher: { titulo: 'Voucher de servicio', texto: 'Presente este voucher (impreso o en el celular) a su chofer o guía. Ante cualquier cambio comuníquese con nosotros.', pie: '' },
  cotizacion: { titulo: 'Cotización', texto: 'Precios en dólares estadounidenses, sujetos a disponibilidad y confirmación al momento de reservar.', validez_dias: 7, pie: '' },
  reporte: { titulo: 'Reporte de servicios', pie: 'Documento interno para facturación. No es una factura fiscal.' }
};
const WHATSAPP_INICIAL = { chatwoot_url: '', cuenta: '', inbox_id: '', plantilla: '', idioma: 'es', auto_al_asignar: false,
  mensaje: 'Hola {cliente}, le saluda {empresa}. Su traslado del {fecha} a las {recogida}: chofer {chofer}, vehículo {vehiculo} {placa}. Punto de encuentro: {punto}. Cualquier duda, responda a este mensaje.' };
const VUELOS_INICIAL = { proveedor: 'aerodatabox', rapidapi_host: 'aerodatabox.p.rapidapi.com' };

module.exports = function crearOperaciones({ client, config, registrar, fechaServicioISO, hoyLocal, esCancelacion, indiceReservas, originalDe }) {
  let ultimaSync = 0, sincronizando = null;

  // ---------- utilidades ----------
  const error = (msg, codigo = 400) => Object.assign(new Error(msg), { codigo });
  const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const norm = s => sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const txt = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const num = v => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
  const entero = v => Math.max(0, Math.round(num(v)));
  const minutos = h => { const m = String(h || '').match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const hhmm = m => { if (m === null || m === undefined || !Number.isFinite(m)) return ''; const x = ((Math.round(m) % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
  const dinero = n => (n === null || n === undefined || n === '') ? null : Math.round(Number(n) * 100) / 100;
  const aeropuertoDe = s => (String(s || '').toUpperCase().match(/\b[A-Z]{3}\b/) || [''])[0];

  // Llaves (vuelos, Chatwoot): cifradas con el secreto de sesión del panel; nunca vuelven al navegador.
  const llaveCifrado = () => crypto.createHash('sha256').update('operaciones|' + String((config.sesion && config.sesion.secreto) || 'zentralia')).digest();
  function cifrar(t) {
    if (!t) return '';
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', llaveCifrado(), iv);
    const d = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64');
  }
  function descifrar(b) {
    if (!b) return '';
    try { const x = Buffer.from(b, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', llaveCifrado(), x.subarray(0, 12)); d.setAuthTag(x.subarray(12, 28)); return Buffer.concat([d.update(x.subarray(28)), d.final()]).toString('utf8'); }
    catch (e) { return ''; }
  }

  // ---------- tablas ----------
  async function preparar() {
    const q = s => client.query(s);
    await q(`CREATE TABLE IF NOT EXISTS op_config (clave TEXT PRIMARY KEY, valor JSONB NOT NULL)`);
    await q(`CREATE TABLE IF NOT EXISTS op_vehiculos (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, placa TEXT NOT NULL DEFAULT '', capacidad INTEGER NOT NULL DEFAULT 4,
      tipo TEXT NOT NULL DEFAULT 'Van', sede TEXT NOT NULL DEFAULT '', seguro_vence TEXT NOT NULL DEFAULT '', marbete_vence TEXT NOT NULL DEFAULT '',
      activo BOOLEAN NOT NULL DEFAULT TRUE, notas TEXT NOT NULL DEFAULT '')`);
    await q(`CREATE TABLE IF NOT EXISTS op_choferes (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, telefono TEXT NOT NULL DEFAULT '', licencia TEXT NOT NULL DEFAULT '',
      licencia_vence TEXT NOT NULL DEFAULT '', vehiculo_id INTEGER, sede TEXT NOT NULL DEFAULT '', pago_servicio NUMERIC NOT NULL DEFAULT 0,
      codigo TEXT UNIQUE, pin_hash TEXT NOT NULL DEFAULT '', activo BOOLEAN NOT NULL DEFAULT TRUE, libre_desde TEXT NOT NULL DEFAULT '', libre_hasta TEXT NOT NULL DEFAULT '',
      notas TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS op_proveedores (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'transportista',
      contacto TEXT NOT NULL DEFAULT '', telefono TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', sede TEXT NOT NULL DEFAULT '',
      activo BOOLEAN NOT NULL DEFAULT TRUE, notas TEXT NOT NULL DEFAULT '')`);
    await q(`CREATE TABLE IF NOT EXISTS op_agencias (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, alias TEXT NOT NULL DEFAULT '', tarifario_id INTEGER,
      modalidad TEXT NOT NULL DEFAULT 'privado', contacto TEXT NOT NULL DEFAULT '', telefono TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      activo BOOLEAN NOT NULL DEFAULT TRUE, notas TEXT NOT NULL DEFAULT '')`);
    await q(`CREATE TABLE IF NOT EXISTS op_hoteles (id SERIAL PRIMARY KEY, hotel TEXT NOT NULL UNIQUE, zona TEXT NOT NULL DEFAULT '', sede TEXT NOT NULL DEFAULT '')`);
    await q(`CREATE TABLE IF NOT EXISTS op_tarifarios (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'venta',
      agencia_id INTEGER, proveedor_id INTEGER, moneda TEXT NOT NULL DEFAULT 'US$', activo BOOLEAN NOT NULL DEFAULT TRUE, notas TEXT NOT NULL DEFAULT '',
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS op_tarifas (id SERIAL PRIMARY KEY, tarifario_id INTEGER NOT NULL, servicio TEXT NOT NULL DEFAULT 'TRASLADO',
      nombre TEXT NOT NULL DEFAULT '', aeropuerto TEXT NOT NULL DEFAULT '', zona TEXT NOT NULL DEFAULT '', modalidad TEXT NOT NULL DEFAULT '',
      cobro TEXT NOT NULL DEFAULT 'vehiculo', pax_desde INTEGER NOT NULL DEFAULT 1, pax_hasta INTEGER NOT NULL DEFAULT 99,
      precio_vehiculo NUMERIC NOT NULL DEFAULT 0, precio_adulto NUMERIC NOT NULL DEFAULT 0, precio_nino NUMERIC NOT NULL DEFAULT 0, precio_infante NUMERIC NOT NULL DEFAULT 0,
      desde TEXT NOT NULL DEFAULT '', hasta TEXT NOT NULL DEFAULT '', nocturno_pct NUMERIC NOT NULL DEFAULT 0, nocturno_desde TEXT NOT NULL DEFAULT '', nocturno_hasta TEXT NOT NULL DEFAULT '',
      notas TEXT NOT NULL DEFAULT '')`);
    await q('CREATE INDEX IF NOT EXISTS op_tarifas_tarifario ON op_tarifas (tarifario_id)');
    await q(`CREATE TABLE IF NOT EXISTS op_servicios (id SERIAL PRIMARY KEY, servicio_id INTEGER UNIQUE, clase TEXT NOT NULL DEFAULT 'transporte',
      estado TEXT NOT NULL DEFAULT 'por_asignar', fecha TEXT NOT NULL DEFAULT '', hora TEXT NOT NULL DEFAULT '', sede TEXT NOT NULL DEFAULT '', agencia TEXT NOT NULL DEFAULT '',
      chofer_id INTEGER, vehiculo_id INTEGER, proveedor_id INTEGER, hora_recogida TEXT NOT NULL DEFAULT '', notas TEXT NOT NULL DEFAULT '',
      precio NUMERIC, costo NUMERIC, precio_manual BOOLEAN NOT NULL DEFAULT FALSE, costo_manual BOOLEAN NOT NULL DEFAULT FALSE, precio_motivo TEXT NOT NULL DEFAULT '',
      tarifa_venta TEXT NOT NULL DEFAULT '', tarifa_costo TEXT NOT NULL DEFAULT '', snap JSONB NOT NULL DEFAULT '{}', alerta TEXT NOT NULL DEFAULT '',
      vuelo JSONB, wa JSONB, entrada_codigos TEXT NOT NULL DEFAULT '', asignado_por TEXT NOT NULL DEFAULT '', asignado_en TIMESTAMPTZ,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW(), creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q('CREATE INDEX IF NOT EXISTS op_servicios_fecha ON op_servicios (fecha)');
    await q(`CREATE TABLE IF NOT EXISTS op_eventos (id SERIAL PRIMARY KEY, op_id INTEGER, tipo TEXT NOT NULL, texto TEXT NOT NULL,
      usuario TEXT NOT NULL DEFAULT '', fecha TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q('CREATE INDEX IF NOT EXISTS op_eventos_op ON op_eventos (op_id)');
    await q(`CREATE TABLE IF NOT EXISTS op_ubicaciones (chofer_id INTEGER PRIMARY KEY, lat DOUBLE PRECISION NOT NULL, lng DOUBLE PRECISION NOT NULL,
      precision DOUBLE PRECISION, fecha TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS op_paquetes (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, sede TEXT NOT NULL DEFAULT 'Orlando', icono TEXT NOT NULL DEFAULT 'castle',
      descripcion TEXT NOT NULL DEFAULT '', piezas JSONB NOT NULL DEFAULT '[]', activo BOOLEAN NOT NULL DEFAULT TRUE, orden INTEGER NOT NULL DEFAULT 0)`);
    const def = async (clave, valor) => client.query('INSERT INTO op_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING', [clave, JSON.stringify(valor)]);
    await def('publico', false);
    await def('modulos', MODULOS_INICIALES);
    await def('reglas', REGLAS_INICIALES);
    await def('plantillas', PLANTILLAS_INICIALES);
    await def('whatsapp', WHATSAPP_INICIAL);
    await def('vuelos', VUELOS_INICIAL);
    // Paquetes de ejemplo (se editan o borran en Configuración).
    if (!(await client.query('SELECT 1 FROM op_paquetes LIMIT 1')).rowCount) {
      const ej = [
        ['Disney 4 días · familia', 'castle', 'Entradas Disney 4 días + transporte a los parques + traslados', [
          { tipo: 'IN', nombre: 'Traslado aeropuerto → hotel' }, { tipo: 'ENTRADA', nombre: 'Disney 4 días', dias: 4, parques: ['Magic Kingdom', 'EPCOT', 'Hollywood Studios', 'Animal Kingdom'] },
          { tipo: 'TRANSPORTE', nombre: 'Transporte hotel ↔ parque', dias: 4 }, { tipo: 'EXTRA', nombre: 'Lightning Lane Multi Pass', opcional: true, dias: 4 },
          { tipo: 'OUT', nombre: 'Traslado hotel → aeropuerto' }]],
        ['Universal 2 parques', 'ferris-wheel', 'Park-to-Park 2 días + transporte', [
          { tipo: 'ENTRADA', nombre: 'Universal Park-to-Park 2 días', dias: 2, parques: ['Universal Studios', 'Islands of Adventure'] },
          { tipo: 'TRANSPORTE', nombre: 'Transporte hotel ↔ parque', dias: 2 }]],
        ['Combo Disney + Universal', 'star', '6 días: 4 Disney + 2 Universal', [
          { tipo: 'IN', nombre: 'Traslado aeropuerto → hotel' }, { tipo: 'ENTRADA', nombre: 'Disney 4 días', dias: 4, parques: ['Magic Kingdom', 'EPCOT', 'Hollywood Studios', 'Animal Kingdom'] },
          { tipo: 'ENTRADA', nombre: 'Universal Park-to-Park 2 días', dias: 2, parques: ['Universal Studios', 'Islands of Adventure'] },
          { tipo: 'TRANSPORTE', nombre: 'Transporte hotel ↔ parque', dias: 6 }, { tipo: 'OUT', nombre: 'Traslado hotel → aeropuerto' }]],
        ['Kennedy Space Center', 'rocket', 'Tour de un día con transporte', [{ tipo: 'ACTIVIDAD', nombre: 'Kennedy Space Center' }]],
        ['Solo entradas', 'gift', 'Entradas sin transporte', [{ tipo: 'ENTRADA', nombre: 'Disney 1 día', dias: 1, parques: ['Magic Kingdom'] }]]
      ];
      let i = 0;
      for (const [nombre, icono, descripcion, piezas] of ej) await client.query('INSERT INTO op_paquetes (nombre, icono, descripcion, piezas, orden) VALUES ($1,$2,$3,$4,$5)', [nombre, icono, descripcion, JSON.stringify(piezas), i++]);
    }
    // Grupos sugeridos (se pueden cambiar en Herramientas → Grupos).
    const grupos = {
      'Operaciones': { ver_reservas: true, ver_operaciones: true, asignar_servicios: true, ver_choferes_vivo: true, imprimir_operativo: true },
      'Gerente de operaciones': { ver_reservas: true, ver_operaciones: true, asignar_servicios: true, ver_choferes_vivo: true, imprimir_operativo: true, crear_reservas: true, ver_precios: true, ver_reportes_op: true, crear_paquetes: true }
    };
    for (const [nombre, permisos] of Object.entries(grupos)) {
      await client.query('INSERT INTO grupos (nombre, permisos, protegido) SELECT $1::varchar, $2::jsonb, FALSE WHERE NOT EXISTS (SELECT 1 FROM grupos WHERE nombre = $1::varchar)', [nombre, JSON.stringify(permisos)]).catch(e => console.error('Operaciones: no se pudo crear el grupo', nombre, e.message));
    }
  }

  async function cfg(clave, def) {
    const r = (await client.query('SELECT valor FROM op_config WHERE clave = $1', [clave])).rows[0];
    if (!r) return def;
    return def && typeof def === 'object' && !Array.isArray(def) ? { ...def, ...r.valor } : r.valor;
  }
  const guardarCfg = (clave, valor) => client.query('INSERT INTO op_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor', [clave, JSON.stringify(valor)]);
  const modulos = () => cfg('modulos', MODULOS_INICIALES);

  async function evento(opId, tipo, texto, usuario = '') {
    await client.query('INSERT INTO op_eventos (op_id, tipo, texto, usuario) VALUES ($1, $2, $3, $4)', [opId, tipo, texto, usuario]).catch(() => {});
  }

  // ---------- sede, zona y agencia de un servicio ----------
  let cacheHoteles = { t: 0, lista: [] };
  async function hoteles() {
    if (Date.now() - cacheHoteles.t > 60000) cacheHoteles = { t: Date.now(), lista: (await client.query('SELECT hotel, zona, sede FROM op_hoteles')).rows.map(h => ({ ...h, n: norm(h.hotel) })) };
    return cacheHoteles.lista;
  }
  function zonaDe(nombre, lista) {
    const n = norm(nombre);
    if (!n) return '';
    let mejor = null;
    for (const h of lista) if (h.n && (n.includes(h.n) || h.n.includes(n)) && (!mejor || h.n.length > mejor.n.length)) mejor = h;
    return mejor ? mejor.zona : '';
  }
  function sedeDe(s, zona, lista) {
    const ae = aeropuertoDe(s.aeropuerto);
    if (AEROPUERTOS_ORL.includes(ae)) return 'Orlando';
    if (AEROPUERTOS_RD.includes(ae)) return 'Punta Cana';
    const h = lista.find(x => x.zona === zona && x.sede);
    if (h) return h.sede;
    return /orlando|disney|universal|kissimmee|seaworld|mco/i.test([s.hotel, s.actividad, s.punto_llegada, s.punto_partida].join(' ')) ? 'Orlando' : 'Punta Cana';
  }
  let cacheAgencias = { t: 0, lista: [] };
  async function agencias() {
    if (Date.now() - cacheAgencias.t > 60000) {
      const filas = (await client.query('SELECT * FROM op_agencias WHERE activo')).rows;
      cacheAgencias = { t: Date.now(), lista: filas.map(a => ({ ...a, claves: [a.nombre, ...String(a.alias || '').split(',')].map(norm).filter(Boolean) })) };
    }
    return cacheAgencias.lista;
  }
  function agenciaDe(s, lista) {
    const dominio = (String(s.remitente || '').match(/@([^>\s]+)/) || [])[1] || '';
    const base = txt(s.agencia, 120) || (dominio ? dominio.split('.').slice(-2, -1)[0] : '');
    const nb = norm(base), nd = norm(dominio);
    const a = lista.find(x => x.claves.some(k => k && (k === nb || (nb && nb.includes(k)) || (nd && nd.includes(k)))));
    return { nombre: a ? a.nombre : (base || 'Sin agencia'), id: a ? a.id : null, modalidad: a ? a.modalidad : 'privado', tarifario_id: a ? a.tarifario_id : null };
  }
  const paxDe = s => ({ adultos: entero(s.adultos), ninos: entero(s.ninos), infantes: entero(s.infantes) });
  const paxTotal = s => entero(s.adultos) + entero(s.ninos) + entero(s.infantes);

  // Hora de recogida y bloque de tiempo que ocupa el servicio (para avisar choques).
  function tiempos(s, op, reglas, zona) {
    const t = tipoDe(s, op);
    const h = minutos(op && op.vuelo && op.vuelo.hora_estimada ? op.vuelo.hora_estimada : s.hora_servicio);
    const viaje = Number((reglas.tiempos_zona || {})[zona]) || Number(reglas.duracion_traslado_min) || 60;
    if (h === null) return { recogida: '', inicio: null, fin: null };
    if (t === 'OUT') { const rec = h - (Number(reglas.antes_aeropuerto_min) || 180) - viaje; return { recogida: hhmm(rec), inicio: rec, fin: rec + viaje + 15 }; }
    if (t === 'IN') return { recogida: hhmm(h), inicio: h, fin: h + (Number(reglas.espera_llegada_min) || 30) + viaje };
    if (t === 'INTERHOTEL') return { recogida: hhmm(h), inicio: h, fin: h + viaje };
    return { recogida: hhmm(h), inicio: h, fin: h + (Number(reglas.duracion_actividad_min) || 240) };
  }
  function tipoDe(s) {
    const t = String(s.tipo_servicio || '').toUpperCase();
    if (['IN', 'OUT', 'INTERHOTEL', 'ACTIVIDAD'].includes(t)) return t;
    if (/llegada|arrival|aeropuerto.*hotel/i.test(s.tipo_servicio || '')) return 'IN';
    if (/salida|departure|hotel.*aeropuerto/i.test(s.tipo_servicio || '')) return 'OUT';
    return s.actividad ? 'ACTIVIDAD' : 'OTRO';
  }

  // ---------- precios ----------
  async function tarifasDe(tarifarioId) {
    if (!tarifarioId) return [];
    return (await client.query('SELECT * FROM op_tarifas WHERE tarifario_id = $1', [tarifarioId])).rows;
  }
  async function tarifarioVenta(agencia) {
    if (agencia && agencia.tarifario_id) {
      const t = (await client.query('SELECT * FROM op_tarifarios WHERE id = $1 AND activo', [agencia.tarifario_id])).rows[0];
      if (t) return t;
    }
    if (agencia && agencia.id) {
      const t = (await client.query("SELECT * FROM op_tarifarios WHERE agencia_id = $1 AND tipo = 'venta' AND activo ORDER BY id DESC LIMIT 1", [agencia.id])).rows[0];
      if (t) return t;
    }
    return (await client.query("SELECT * FROM op_tarifarios WHERE tipo = 'venta' AND agencia_id IS NULL AND activo ORDER BY id LIMIT 1")).rows[0] || null;
  }
  // Busca la tarifa que mejor encaja: tipo, nombre (tours/entradas), aeropuerto, zona, modalidad, pax, temporada.
  function mejorTarifa(tarifas, { tipo, nombre, aeropuerto, zona, modalidad, pax, fecha }) {
    const nNombre = norm(nombre), nZona = norm(zona);
    let mejor = null, puntos = -1;
    for (const t of tarifas) {
      const st = String(t.servicio || '').toUpperCase();
      const tipoOk = st === tipo || (st === 'TRASLADO' && (tipo === 'IN' || tipo === 'OUT')) || (tipo === 'ACTIVIDAD' && ['ACTIVIDAD', 'ENTRADA', 'TRANSPORTE'].includes(st)) || (tipo === st);
      if (!tipoOk) continue;
      let p = st === tipo ? 2 : 1;
      if (t.nombre) { const nt = norm(t.nombre); if (!nNombre || !(nNombre.includes(nt) || nt.includes(nNombre))) continue; p += 3 + Math.min(nt.length, 40) / 40; }
      if (t.aeropuerto) { if (t.aeropuerto.toUpperCase() !== aeropuerto) continue; p += 2; }
      if (t.zona) { const z = norm(t.zona); if (!nZona || !(nZona === z || nZona.includes(z) || z.includes(nZona))) continue; p += 3; }
      if (t.modalidad) { if (modalidad && norm(t.modalidad) !== norm(modalidad)) continue; p += 1; }
      if (pax && (pax < t.pax_desde || pax > t.pax_hasta)) continue;
      if (t.desde || t.hasta) { if (!fecha || (t.desde && fecha < t.desde) || (t.hasta && fecha > t.hasta)) continue; p += 2; }
      if (p > puntos) { mejor = t; puntos = p; }
    }
    return mejor;
  }
  function importe(t, pax, hora) {
    if (!t) return null;
    let v = t.cobro === 'persona'
      ? pax.adultos * num(t.precio_adulto) + pax.ninos * num(t.precio_nino || t.precio_adulto) + pax.infantes * num(t.precio_infante)
      : num(t.precio_vehiculo);
    const h = minutos(hora), d = minutos(t.nocturno_desde), a = minutos(t.nocturno_hasta);
    if (num(t.nocturno_pct) && h !== null && d !== null && a !== null && (d <= a ? h >= d && h < a : h >= d || h < a)) v *= 1 + num(t.nocturno_pct) / 100;
    return dinero(v);
  }
  function describir(t) {
    if (!t) return '';
    const partes = [t.servicio, t.nombre, t.aeropuerto, t.zona, t.modalidad, `${t.pax_desde}-${t.pax_hasta} pax`].filter(Boolean);
    return partes.join(' · ') + (t.cobro === 'persona' ? ` · ad ${num(t.precio_adulto)} / niño ${num(t.precio_nino)}` : ` · ${num(t.precio_vehiculo)} por vehículo`);
  }
  // Precio de venta y costo de un servicio de la bandeja.
  async function calcularPrecio(s, op, ctx) {
    const lista = ctx.hoteles || await hoteles();
    const agencia = ctx.agencia || agenciaDe(s, ctx.agencias || await agencias());
    const tipo = tipoDe(s);
    const zona = zonaDe(tipo === 'OUT' ? (s.hotel || s.punto_partida) : (s.hotel || s.punto_llegada), lista);
    const modalidad = /compartid|shared|regular/i.test([s.motivo, s.actividad, s.asunto].join(' ')) ? 'compartido' : /privad|private/i.test([s.motivo, s.actividad, s.asunto].join(' ')) ? 'privado' : agencia.modalidad;
    const fecha = (op && op.fecha) || fechaServicioISO(s.fecha_servicio, s.fecha) || '';
    const pax = paxDe(s), total = paxTotal(s) || 1;
    const filtro = { tipo, nombre: s.actividad || '', aeropuerto: aeropuertoDe(s.aeropuerto), zona, modalidad, pax: total, fecha };
    const tv = await tarifarioVenta(agencia);
    const venta = tv ? mejorTarifa(await tarifasDe(tv.id), filtro) : null;
    let costo = null, tc = null, tCosto = '';
    if (op && op.proveedor_id) {
      tc = (await client.query("SELECT * FROM op_tarifarios WHERE proveedor_id = $1 AND tipo = 'costo' AND activo ORDER BY id DESC LIMIT 1", [op.proveedor_id])).rows[0];
      const t = tc ? mejorTarifa(await tarifasDe(tc.id), filtro) : null;
      costo = importe(t, pax, s.hora_servicio); tCosto = t ? `${tc.nombre}: ${describir(t)}` : '';
    } else if (op && op.chofer_id) {
      const ch = (await client.query('SELECT nombre, pago_servicio FROM op_choferes WHERE id = $1', [op.chofer_id])).rows[0];
      if (ch && num(ch.pago_servicio)) { costo = dinero(ch.pago_servicio); tCosto = `Pago al chofer ${ch.nombre}`; }
    }
    return { precio: importe(venta, pax, s.hora_servicio), tarifa_venta: venta ? `${tv.nombre}: ${describir(venta)}` : (tv ? `${tv.nombre}: sin tarifa para este servicio` : 'Sin tarifario'),
      costo, tarifa_costo: tCosto, zona, modalidad, agencia };
  }

  // ---------- sincronizar: servicios "Registrada" → Operaciones ----------
  function snapDe(s) { return { fecha: s.fecha_servicio || '', hora: s.hora_servicio || '', vuelo: s.vuelo || '', pax: paxTotal(s), hotel: s.hotel || '', tipo: s.tipo_servicio || '', cancelado: /^\s*(CANCELAD[OA]|EN ESPERA|STANDBY)/i.test(s.motivo || '') }; }
  async function sincronizar(forzar) {
    if (sincronizando) return sincronizando;
    if (!forzar && Date.now() - ultimaSync < 20000) return;
    sincronizando = (async () => {
      const lista = await hoteles(), ags = await agencias(), reglas = await cfg('reglas', REGLAS_INICIALES);
      // 1. Nuevos: servicios registrados de los últimos 120 días que todavía no están en Operaciones.
      const nuevos = (await client.query(`SELECT c.* FROM clasificacion c LEFT JOIN op_servicios o ON o.servicio_id = c.id
        WHERE o.id IS NULL AND c.estado = 'registrada' AND c.categoria IN ('RESERVA', 'MODIFICACION') AND NOT COALESCE(c.error_ia, FALSE)
          AND c.creado > NOW() - INTERVAL '120 days' ORDER BY c.id LIMIT 500`)).rows;
      // Las cancelaciones no son servicios para hacer: cancelan los de la reserva original.
      const porCorreo = new Map();
      for (const s of nuevos) { const k = s.message_id || 'id:' + s.id; if (!porCorreo.has(k)) porCorreo.set(k, []); porCorreo.get(k).push(s); }
      let indice = null;
      for (const grupo of porCorreo.values()) {
        const cancela = grupo[0].categoria === 'MODIFICACION' && esCancelacion && esCancelacion(grupo);
        // Un cambio o una cancelación registrados reemplazan a la reserva original que ya estaba en Operaciones.
        if (grupo[0].categoria === 'MODIFICACION' && indiceReservas && originalDe) {
          if (!indice) indice = indiceReservas((await client.query("SELECT * FROM clasificacion WHERE categoria = 'RESERVA' AND creado > NOW() - INTERVAL '200 days'")).rows);
          const original = originalDe(grupo[0], indice);
          if (original) {
            const clave = original.message_id || null;
            const ops = (await client.query(`SELECT o.id, o.chofer_id, o.proveedor_id FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id
              WHERE (($1::text IS NOT NULL AND c.message_id = $1) OR c.id = $2) AND o.estado NOT IN ('cancelado', 'completado', 'no_show')`, [clave, original.id])).rows;
            for (const o of ops) {
              const asignado = o.chofer_id || o.proveedor_id;
              const texto = cancela ? `Cancelada por el correo #${grupo[0].id}` : `Reemplazada por el cambio #${grupo[0].id}`;
              await client.query("UPDATE op_servicios SET estado = 'cancelado', alerta = $1, actualizado = NOW() WHERE id = $2", [asignado ? texto + ' (ya estaba asignada: avisa al chofer).' : '', o.id]);
              await evento(o.id, 'cancelado', texto, 'sistema');
            }
          }
        }
        for (const s of grupo) {
          const fecha = fechaServicioISO(s.fecha_servicio, s.fecha) || '';
          const agencia = agenciaDe(s, ags);
          const tipo = tipoDe(s);
          const zona = zonaDe(tipo === 'OUT' ? (s.hotel || s.punto_partida) : (s.hotel || s.punto_llegada), lista);
          const clase = /^\s*entradas?\b|ticket/i.test(s.actividad || '') && tipo === 'ACTIVIDAD' ? 'entrada' : 'transporte';
          const snap = snapDe(s);
          const estado = cancela || snap.cancelado ? 'cancelado' : 'por_asignar';
          const tm = tiempos(s, null, reglas, zona);
          const r = await client.query(`INSERT INTO op_servicios (servicio_id, clase, estado, fecha, hora, sede, agencia, hora_recogida, snap)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (servicio_id) DO NOTHING RETURNING id`,
            [s.id, clase, estado, fecha, s.hora_servicio || '', sedeDe(s, zona, lista), agencia.nombre, tm.recogida, JSON.stringify(snap)]);
          if (!r.rows[0]) continue;
          const opId = r.rows[0].id;
          if (estado !== 'cancelado') {
            const p = await calcularPrecio(s, { fecha }, { hoteles: lista, agencias: ags, agencia });
            await client.query('UPDATE op_servicios SET precio = $1, tarifa_venta = $2 WHERE id = $3', [p.precio, p.tarifa_venta, opId]);
          }
          await evento(opId, 'nuevo', estado === 'cancelado' ? 'Llegó ya cancelado' : 'Registrado en Reservas: pasa a Operaciones', 'sistema');
        }
      }
      // 2. Cambios: si en Reservas cambió la fecha, la hora, el vuelo, los pax o se canceló un servicio que ya estaba aquí.
      const vivos = (await client.query(`SELECT o.id AS op_id, o.estado AS op_estado, o.snap, o.chofer_id, o.proveedor_id, c.* FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id
        WHERE o.estado NOT IN ('completado', 'no_show', 'cancelado') AND (o.fecha = '' OR o.fecha >= $1)`, [haceDias(2)])).rows;
      for (const s of vivos) {
        const nuevo = snapDe(s), viejo = s.snap || {};
        const cambios = ['fecha', 'hora', 'vuelo', 'pax', 'hotel'].filter(k => String(viejo[k] ?? '') !== String(nuevo[k] ?? ''));
        const cancelado = nuevo.cancelado || s.estado === 'historico';
        if (!cambios.length && !cancelado) continue;
        const asignado = s.chofer_id || s.proveedor_id;
        if (cancelado) {
          await client.query("UPDATE op_servicios SET estado = 'cancelado', alerta = $1, snap = $2, actualizado = NOW() WHERE id = $3",
            [asignado ? 'Se canceló después de asignarlo: avisa al chofer.' : '', JSON.stringify(nuevo), s.op_id]);
          await evento(s.op_id, 'cancelado', 'Cancelado en Reservas' + (asignado ? ' (ya estaba asignado)' : ''), 'sistema');
          continue;
        }
        const fecha = fechaServicioISO(s.fecha_servicio, s.fecha) || '';
        const zona = zonaDe(tipoDe(s) === 'OUT' ? (s.hotel || s.punto_partida) : (s.hotel || s.punto_llegada), lista);
        const tm = tiempos(s, null, reglas, zona);
        const texto = 'Cambió en Reservas: ' + cambios.map(k => `${k} ${viejo[k] || '—'} → ${nuevo[k] || '—'}`).join(', ');
        await client.query('UPDATE op_servicios SET fecha = $1, hora = $2, hora_recogida = $3, snap = $4, alerta = $5, actualizado = NOW() WHERE id = $6',
          [fecha, s.hora_servicio || '', tm.recogida, JSON.stringify(nuevo), asignado ? texto + '. Revisa el chofer.' : '', s.op_id]);
        await evento(s.op_id, 'cambio', texto, 'sistema');
      }
      ultimaSync = Date.now();
    })().finally(() => { sincronizando = null; });
    return sincronizando;
  }
  function haceDias(n) { const d = new Date(hoyLocal() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
  function masDias(f, n) { const d = new Date((f || hoyLocal()) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  // ---------- lista del día ----------
  async function listar({ fecha, sede, desde, hasta, sinFecha }) {
    await sincronizar();
    const reglas = await cfg('reglas', REGLAS_INICIALES), lista = await hoteles();
    const params = [], cond = [];
    if (sinFecha) cond.push("o.fecha = '' AND o.estado <> 'cancelado'");
    else if (desde || hasta) { params.push(desde || '0000'); cond.push(`o.fecha >= $${params.length}`); params.push(hasta || '9999'); cond.push(`o.fecha <= $${params.length}`); }
    else { params.push(fecha || hoyLocal()); cond.push(`o.fecha = $${params.length}`); }
    if (sede) { params.push(sede); cond.push(`o.sede = $${params.length}`); }
    const filas = (await client.query(`SELECT o.*, o.vuelo AS vuelo_vivo, c.id AS sid, c.message_id, c.categoria, c.tipo_servicio, c.nombre_cliente, c.hora_servicio, c.vuelo, c.hotel, c.punto_partida,
        c.punto_llegada, c.fecha_servicio, c.adultos, c.ninos, c.infantes, c.aeropuerto, c.actividad, c.telefono, c.motivo, c.asunto, c.remitente,
        ch.nombre AS chofer, ch.telefono AS chofer_tel, v.nombre AS vehiculo, v.placa, v.capacidad, p.nombre AS proveedor
      FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id
      LEFT JOIN op_choferes ch ON ch.id = o.chofer_id LEFT JOIN op_vehiculos v ON v.id = o.vehiculo_id LEFT JOIN op_proveedores p ON p.id = o.proveedor_id
      WHERE ${cond.join(' AND ')} ORDER BY o.fecha, COALESCE(NULLIF(o.hora_recogida, ''), o.hora, '99:99'), o.id`, params)).rows;
    const servicios = filas.map(s => {
      const tipo = tipoDe(s);
      const zona = zonaDe(tipo === 'OUT' ? (s.hotel || s.punto_partida) : (s.hotel || s.punto_llegada), lista);
      const tm = tiempos(s, { vuelo: s.vuelo_vivo }, reglas, zona);
      const desdeL = tipo === 'IN' ? (aeropuertoDe(s.aeropuerto) || 'Aeropuerto') : (s.hotel || s.punto_partida || '');
      const hastaL = tipo === 'OUT' ? (aeropuertoDe(s.aeropuerto) || 'Aeropuerto') : tipo === 'IN' ? (s.hotel || s.punto_llegada || '') : (s.actividad || s.punto_llegada || '');
      return {
        id: s.id, servicio_id: s.servicio_id, reserva: s.servicio_id, clase: s.clase, estado: s.estado, estado_nombre: NOMBRE_ESTADO[s.estado] || s.estado,
        fecha: s.fecha, hora: s.hora_servicio || '', recogida: s.hora_recogida || tm.recogida, inicio: tm.inicio, fin: tm.fin, tipo, zona, sede: s.sede,
        cliente: s.nombre_cliente || '', telefono: s.telefono || '', agencia: s.agencia, vuelo: s.vuelo || '', aeropuerto: aeropuertoDe(s.aeropuerto), hotel: s.hotel || '',
        actividad: s.actividad || '', desde: desdeL, hasta: hastaL, pax: paxDe(s), pax_total: paxTotal(s), nota: s.motivo || '', manual: String(s.message_id || '').startsWith('manual-'),
        chofer_id: s.chofer_id, chofer: s.chofer || '', chofer_tel: s.chofer_tel || '', vehiculo_id: s.vehiculo_id, vehiculo: s.vehiculo || '', placa: s.placa || '', capacidad: s.capacidad,
        proveedor_id: s.proveedor_id, proveedor: s.proveedor || '', notas: s.notas, alerta: s.alerta, vuelo_vivo: s.vuelo_vivo, wa: s.wa,
        precio: s.precio === null ? null : Number(s.precio), costo: s.costo === null ? null : Number(s.costo), precio_manual: s.precio_manual, tarifa_venta: s.tarifa_venta, tarifa_costo: s.tarifa_costo,
        entrada_codigos: s.entrada_codigos
      };
    });
    marcarChoques(servicios, reglas);
    return servicios;
  }
  // Dos servicios del mismo chofer (o vehículo) que se pisan en el tiempo.
  function marcarChoques(servicios, reglas) {
    const margen = Number(reglas.minutos_entre_servicios) || 15;
    const porQuien = new Map();
    for (const s of servicios) {
      s.choques = [];
      if (s.estado === 'cancelado' || s.inicio === null) continue;
      for (const k of [s.chofer_id && 'c' + s.chofer_id, s.vehiculo_id && 'v' + s.vehiculo_id].filter(Boolean)) {
        if (!porQuien.has(k + s.fecha)) porQuien.set(k + s.fecha, []);
        porQuien.get(k + s.fecha).push(s);
      }
    }
    for (const l of porQuien.values()) {
      for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
        const a = l[i], b = l[j];
        if (a.inicio < b.fin + margen && b.inicio < a.fin + margen) {
          if (!a.choques.includes(b.id)) a.choques.push(b.id);
          if (!b.choques.includes(a.id)) b.choques.push(a.id);
        }
      }
    }
  }

  // ---------- asignar ----------
  async function asignar(u, ids, { chofer_id, vehiculo_id, proveedor_id, notas }) {
    ids = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean).slice(0, 200);
    if (!ids.length) throw error('Elige al menos un servicio.');
    const quitar = !chofer_id && !proveedor_id;
    let chofer = null, veh = null, prov = null;
    if (chofer_id) { chofer = (await client.query('SELECT * FROM op_choferes WHERE id = $1 AND activo', [chofer_id])).rows[0]; if (!chofer) throw error('Ese chofer no existe o está inactivo.'); }
    if (proveedor_id) { prov = (await client.query('SELECT * FROM op_proveedores WHERE id = $1 AND activo', [proveedor_id])).rows[0]; if (!prov) throw error('Ese transportista no existe o está inactivo.'); }
    const vId = vehiculo_id || (chofer && chofer.vehiculo_id) || null;
    if (vId) veh = (await client.query('SELECT * FROM op_vehiculos WHERE id = $1', [vId])).rows[0] || null;
    const avisos = [];
    const lista = await hoteles(), ags = await agencias();
    for (const id of ids) {
      const o = (await client.query(`SELECT c.*, o.id AS op_id, o.estado AS op_estado, o.fecha AS op_fecha, o.servicio_id, o.costo, o.costo_manual, o.tarifa_costo
        FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id WHERE o.id = $1`, [id])).rows[0];
      if (!o) continue;
      if (o.op_estado === 'cancelado') { avisos.push(`#${o.servicio_id}: está cancelado, no se asignó.`); continue; }
      if (veh && paxTotal(o) > veh.capacidad) avisos.push(`#${o.servicio_id}: ${paxTotal(o)} pax no caben en ${veh.nombre} (${veh.capacidad}).`);
      const estado = quitar ? 'por_asignar' : (['por_asignar', 'cancelado'].includes(o.op_estado) ? 'asignado' : o.op_estado);
      const datos = { chofer_id: chofer ? chofer.id : null, vehiculo_id: prov ? null : (veh ? veh.id : null), proveedor_id: prov ? prov.id : null };
      let costo = o.costo, tCosto = o.tarifa_costo;
      if (!o.costo_manual) { const p = await calcularPrecio(o, { fecha: o.op_fecha, ...datos }, { hoteles: lista, agencias: ags }); costo = p.costo; tCosto = p.tarifa_costo; }
      await client.query(`UPDATE op_servicios SET chofer_id = $1, vehiculo_id = $2, proveedor_id = $3, estado = $4, costo = $5, tarifa_costo = $6,
          notas = COALESCE($7, notas), alerta = '', asignado_por = $8, asignado_en = NOW(), actualizado = NOW() WHERE id = $9`,
        [datos.chofer_id, datos.vehiculo_id, datos.proveedor_id, estado, costo, tCosto, notas === undefined ? null : txt(notas, 500), u.usuario, id]);
      await evento(id, 'asignado', quitar ? 'Quitó la asignación' : `Asignado a ${chofer ? chofer.nombre : prov.nombre}${veh && !prov ? ' · ' + veh.nombre : ''}`, u.usuario);
    }
    await registrar(u, 'op_asignar', 'servicio', ids.join(','), '', chofer ? chofer.nombre : prov ? prov.nombre : 'sin asignar', `${ids.length} servicio(s)`);
    // Choques con lo que ya tenía ese chofer ese día.
    if (chofer || veh) {
      const fechas = [...new Set((await client.query('SELECT fecha FROM op_servicios WHERE id = ANY($1::int[])', [ids])).rows.map(r => r.fecha))];
      for (const f of fechas) {
        const dia = await listar({ fecha: f });
        for (const s of dia.filter(x => ids.includes(x.id) && x.choques.length)) avisos.push(`#${s.reserva} (${s.recogida}) se cruza con otro servicio de ${s.chofer || s.vehiculo}.`);
      }
    }
    const wa = await cfg('whatsapp', WHATSAPP_INICIAL), mods = await modulos();
    if (mods.whatsapp && wa.auto_al_asignar && !quitar) for (const id of ids) await enviarWhatsApp(u, id).catch(e => avisos.push('WhatsApp: ' + e.message));
    return { ok: true, avisos };
  }
  async function cambiarEstado(u, id, estado, nota) {
    if (!ESTADOS.includes(estado)) throw error('Estado no válido.');
    const r = await client.query('UPDATE op_servicios SET estado = $1, actualizado = NOW() WHERE id = $2 RETURNING id', [estado, Number(id)]);
    if (!r.rowCount) throw error('No existe ese servicio.', 404);
    await evento(Number(id), 'estado', NOMBRE_ESTADO[estado] + (nota ? ' · ' + txt(nota, 300) : ''), u.usuario || u);
    return { ok: true };
  }
  async function ajustarPrecio(u, id, { precio, costo, motivo }) {
    const o = (await client.query('SELECT * FROM op_servicios WHERE id = $1', [Number(id)])).rows[0];
    if (!o) throw error('No existe ese servicio.', 404);
    if (!txt(motivo)) throw error('Escribe el motivo del cambio de precio.');
    const nuevoP = precio === '' || precio === null || precio === undefined ? o.precio : dinero(num(precio));
    const nuevoC = costo === '' || costo === null || costo === undefined ? o.costo : dinero(num(costo));
    await client.query('UPDATE op_servicios SET precio = $1, costo = $2, precio_manual = TRUE, costo_manual = $3, precio_motivo = $4, actualizado = NOW() WHERE id = $5',
      [nuevoP, nuevoC, costo !== '' && costo !== null && costo !== undefined, txt(motivo, 300), o.id]);
    await evento(o.id, 'precio', `Precio ${o.precio ?? '—'} → ${nuevoP ?? '—'}, costo ${o.costo ?? '—'} → ${nuevoC ?? '—'}: ${txt(motivo, 300)}`, u.usuario);
    await registrar(u, 'op_precio', 'servicio', o.servicio_id, `${o.precio}/${o.costo}`, `${nuevoP}/${nuevoC}`, txt(motivo, 300));
    return { ok: true };
  }
  async function recalcular(u, ids) {
    const lista = await hoteles(), ags = await agencias();
    const filas = (await client.query(`SELECT c.*, o.id AS op_id, o.estado AS op_estado, o.fecha AS op_fecha, o.chofer_id, o.proveedor_id
      FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id WHERE o.id = ANY($1::int[]) OR $2`, [ids || [], !ids])).rows;
    let n = 0;
    for (const o of filas) {
      if (o.op_estado === 'cancelado') continue;
      const p = await calcularPrecio(o, { fecha: o.op_fecha, chofer_id: o.chofer_id, proveedor_id: o.proveedor_id }, { hoteles: lista, agencias: ags });
      await client.query(`UPDATE op_servicios SET precio = CASE WHEN precio_manual THEN precio ELSE $1 END, tarifa_venta = $2,
          costo = CASE WHEN costo_manual THEN costo ELSE $3 END, tarifa_costo = $4 WHERE id = $5`, [p.precio, p.tarifa_venta, p.costo, p.tarifa_costo, o.op_id]);
      n++;
    }
    return { ok: true, recalculados: n };
  }

  // ---------- reserva manual y paquetes ----------
  async function crearReservaManual(u, f) {
    const cliente = txt(f.cliente, 200);
    if (!cliente) throw error('Escribe el nombre del cliente.');
    const servicios = (Array.isArray(f.servicios) ? f.servicios : []).slice(0, 40);
    if (!servicios.length) throw error('Agrega al menos un servicio.');
    const mid = 'manual-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    const agencia = txt(f.agencia, 120) || 'Directo (oficina)';
    const ids = [];
    let i = 0;
    for (const s of servicios) {
      i++;
      const tipo = ['IN', 'OUT', 'INTERHOTEL', 'ACTIVIDAD'].includes(String(s.tipo).toUpperCase()) ? String(s.tipo).toUpperCase() : 'ACTIVIDAD';
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(s.fecha || '') ? s.fecha : '';
      if (!fecha) throw error(`Servicio ${i}: falta la fecha (AAAA-MM-DD).`);
      const r = await client.query(`INSERT INTO clasificacion (categoria, remitente, asunto, estado, fecha, message_id, buzon, agencia, tipo_servicio, nombre_cliente,
          hora_servicio, vuelo, hotel, punto_partida, punto_llegada, fecha_servicio, adultos, ninos, infantes, numero_servicio, aeropuerto, actividad, telefono, motivo, cuerpo)
        VALUES ('RESERVA', $1, $2, 'registrada', $3, $4, 'manual', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING id`,
        [`${u.nombre || u.usuario} (manual)`, `Reserva manual · ${cliente}${f.referencia ? ' · ' + txt(f.referencia, 60) : ''}`, new Date().toISOString(), mid, agencia, tipo, cliente,
          /^\d{2}:\d{2}$/.test(s.hora || '') ? s.hora : '', txt(s.vuelo, 40), txt(s.hotel || f.hotel, 200), txt(s.desde, 200), txt(s.hasta, 200), fecha,
          entero(s.adultos ?? f.adultos), entero(s.ninos ?? f.ninos), entero(s.infantes ?? f.infantes), i, txt(s.aeropuerto, 10).toUpperCase(), txt(s.actividad, 300),
          txt(f.telefono, 120), txt(s.nota || f.nota, 300), txt(f.nota, 2000)]);
      ids.push(r.rows[0].id);
    }
    await registrar(u, 'reserva_manual', 'reserva', ids[0], '', `${servicios.length} servicio(s)`, `${cliente} · ${agencia}`);
    await sincronizar(true);
    const ops = (await client.query('SELECT id, servicio_id FROM op_servicios WHERE servicio_id = ANY($1::int[])', [ids])).rows;
    for (const o of ops) await evento(o.id, 'nuevo', 'Reserva manual creada por ' + (u.nombre || u.usuario), u.usuario);
    // Precios forzados (paquete): se respetan.
    for (let k = 0; k < servicios.length; k++) {
      const s = servicios[k], o = ops.find(x => x.servicio_id === ids[k]);
      if (!o) continue;
      if (s.clase === 'entrada') await client.query("UPDATE op_servicios SET clase = 'entrada' WHERE id = $1", [o.id]);
      if (s.precio !== undefined && s.precio !== null && s.precio !== '') await client.query('UPDATE op_servicios SET precio = $1, costo = $2, precio_manual = TRUE, costo_manual = $3, tarifa_venta = $4, precio_motivo = $5 WHERE id = $6',
        [dinero(num(s.precio)), s.costo === undefined || s.costo === '' ? null : dinero(num(s.costo)), s.costo !== undefined && s.costo !== '', txt(s.tarifa || 'Paquete', 200), 'Precio del paquete', o.id]);
    }
    return { ok: true, reserva: ids[0], servicios: ids.length, referencia: mid };
  }
  // Cotiza un paquete: cada pieza busca su tarifa (venta y costo del proveedor que se elija).
  async function cotizarPaquete(f) {
    const ags = await agencias();
    const agencia = f.agencia_id ? ags.find(a => a.id === Number(f.agencia_id)) || null : null;
    const tv = await tarifarioVenta(agencia ? agencia : { modalidad: 'privado' });
    const tarifasV = tv ? await tarifasDe(tv.id) : [];
    const costos = (await client.query("SELECT t.*, tf.nombre AS tarifario FROM op_tarifas t JOIN op_tarifarios tf ON tf.id = t.tarifario_id WHERE tf.tipo = 'costo' AND tf.activo")).rows;
    const pax = { adultos: entero(f.adultos), ninos: entero(f.ninos), infantes: entero(f.infantes) };
    const total = pax.adultos + pax.ninos + pax.infantes || 1;
    const lista = await hoteles();
    const zona = zonaDe(f.hotel, lista);
    const lineas = [];
    for (const p of (Array.isArray(f.piezas) ? f.piezas : []).slice(0, 30)) {
      if (p.quitar) continue;
      const dias = Math.max(1, entero(p.dias) || 1);
      const tipo = String(p.tipo || 'ACTIVIDAD').toUpperCase();
      const filtro = { tipo: tipo === 'EXTRA' ? 'OTRO' : tipo, nombre: p.nombre, aeropuerto: txt(f.aeropuerto, 3).toUpperCase(), zona, modalidad: (agencia && agencia.modalidad) || 'privado', pax: total, fecha: p.fecha || f.desde || '' };
      const tv1 = mejorTarifa(tarifasV, filtro);
      const tc1 = mejorTarifa(costos, filtro);
      const porDia = ['TRANSPORTE', 'EXTRA'].includes(tipo) && p.dias;
      const v = importe(tv1, pax, p.hora), c = importe(tc1, pax, p.hora);
      lineas.push({ ...p, tipo, dias, precio: v === null ? null : dinero(v * (porDia ? dias : 1)), costo: c === null ? null : dinero(c * (porDia ? dias : 1)),
        tarifa: tv1 ? describir(tv1) : 'Sin tarifa: ponla en Configuración → Tarifarios', opcional: Boolean(p.opcional) });
    }
    const incluidas = lineas.filter(l => !l.opcional || l.incluir);
    const venta = dinero(incluidas.reduce((a, l) => a + (l.precio || 0), 0)), costo = dinero(incluidas.reduce((a, l) => a + (l.costo || 0), 0));
    return { lineas, venta, costo, ganancia: dinero(venta - costo), tarifario: tv ? tv.nombre : 'Sin tarifario de venta', faltan: lineas.filter(l => l.precio === null).length, zona };
  }

  // ---------- reportes ----------
  async function reporte({ desde, hasta, tipo, sede, clave }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde || '') || !/^\d{4}-\d{2}-\d{2}$/.test(hasta || '')) throw error('Elige las fechas del reporte.');
    await sincronizar();
    const params = [desde, hasta];
    let extra = "o.estado <> 'cancelado'";
    if (sede) { params.push(sede); extra += ` AND o.sede = $${params.length}`; }
    const filas = (await client.query(`SELECT o.*, c.nombre_cliente, c.tipo_servicio, c.actividad, c.vuelo, c.hotel, c.adultos, c.ninos, c.infantes, c.aeropuerto, c.message_id,
        ch.nombre AS chofer, p.nombre AS proveedor, p.tipo AS proveedor_tipo
      FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id LEFT JOIN op_choferes ch ON ch.id = o.chofer_id LEFT JOIN op_proveedores p ON p.id = o.proveedor_id
      WHERE o.fecha >= $1 AND o.fecha <= $2 AND ${extra} ORDER BY o.fecha, o.hora`, params)).rows;
    const quien = s => tipo === 'proveedor' ? (s.proveedor || (s.chofer ? 'Chofer: ' + s.chofer : 'Sin asignar')) : tipo === 'general' ? 'Todo' : (s.agencia || 'Sin agencia');
    const grupos = new Map();
    for (const s of filas) {
      const k = quien(s);
      if (!grupos.has(k)) grupos.set(k, { nombre: k, servicios: 0, pax: 0, venta: 0, costo: 0, sin_precio: 0, detalle: [] });
      const g = grupos.get(k);
      g.servicios++; g.pax += paxTotal(s); g.venta += Number(s.precio) || 0; g.costo += Number(s.costo) || 0; if (s.precio === null) g.sin_precio++;
      if (!clave || clave === k) g.detalle.push({ fecha: s.fecha, reserva: s.servicio_id, cliente: s.nombre_cliente, servicio: tipoDe(s) === 'ACTIVIDAD' ? s.actividad : `${tipoDe(s)} ${s.vuelo || ''} ${s.hotel || ''}`.trim(),
        pax: paxTotal(s), precio: s.precio === null ? null : Number(s.precio), costo: s.costo === null ? null : Number(s.costo), agencia: s.agencia, proveedor: s.proveedor || s.chofer || '', estado: NOMBRE_ESTADO[s.estado] });
    }
    const lista = [...grupos.values()].map(g => ({ ...g, venta: dinero(g.venta), costo: dinero(g.costo), ganancia: dinero(g.venta - g.costo) })).sort((a, b) => b.venta - a.venta || b.costo - a.costo);
    const tot = lista.reduce((a, g) => ({ servicios: a.servicios + g.servicios, pax: a.pax + g.pax, venta: a.venta + g.venta, costo: a.costo + g.costo }), { servicios: 0, pax: 0, venta: 0, costo: 0 });
    return { desde, hasta, tipo: tipo || 'agencia', sede: sede || '', grupos: lista, total: { ...tot, venta: dinero(tot.venta), costo: dinero(tot.costo), ganancia: dinero(tot.venta - tot.costo) } };
  }

  // ---------- vuelos en vivo ----------
  function identVuelo(v) { const m = String(v || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z0-9]{2,3}?)(\d{1,4})[A-Z]?$/); return m ? m[1] + m[2] : ''; }
  async function consultarVuelo(vc, ident, fecha) {
    const conf = await cfg('vuelos', VUELOS_INICIAL);
    const prov = vc || conf.proveedor;
    const llave = descifrar((await cfg('llaves', {}))[prov] || '');
    if (!llave) throw error(`Falta la llave de ${prov === 'flightaware' ? 'FlightAware' : 'AeroDataBox'} (Configuración → Vuelos).`);
    const control = new AbortController(); const reloj = setTimeout(() => control.abort(), 20000);
    try {
      if (prov === 'flightaware') {
        const ini = new Date(fecha + 'T00:00:00Z'); const fin = new Date(ini.getTime() + 36 * 3600 * 1000);
        const r = await fetch(`https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}?start=${ini.toISOString().slice(0, 19)}Z&end=${fin.toISOString().slice(0, 19)}Z`, { headers: { 'x-apikey': llave, Accept: 'application/json' }, signal: control.signal });
        if (!r.ok) throw error(`FlightAware respondió ${r.status}`, 502);
        const d = await r.json();
        const f = (d.flights || [])[0];
        if (!f) return null;
        return { fuente: 'FlightAware', estado: f.cancelled ? 'cancelado' : f.diverted ? 'desviado' : f.actual_on || f.actual_in ? 'aterrizó' : f.actual_off || f.actual_out ? 'en vuelo' : 'programado', texto: f.status || '',
          llegada_programada: f.scheduled_in || f.scheduled_on || '', llegada_estimada: f.estimated_in || f.estimated_on || '', llegada_real: f.actual_in || f.actual_on || '',
          salida_programada: f.scheduled_out || f.scheduled_off || '', salida_estimada: f.estimated_out || f.estimated_off || '', salida_real: f.actual_out || f.actual_off || '',
          retraso_min: Math.round((Number(f.arrival_delay) || Number(f.departure_delay) || 0) / 60), terminal: f.terminal_destination || '', puerta: f.gate_destination || '' };
      }
      const host = conf.rapidapi_host || 'aerodatabox.p.rapidapi.com';
      const r = await fetch(`https://${host}/flights/number/${encodeURIComponent(ident)}/${fecha}?withAircraftImage=false&withLocation=false`, { headers: { 'X-RapidAPI-Key': llave, 'X-RapidAPI-Host': host, Accept: 'application/json' }, signal: control.signal });
      if (r.status === 204) return null;
      if (!r.ok) throw error(`AeroDataBox respondió ${r.status}`, 502);
      const d = await r.json();
      const f = (Array.isArray(d) ? d : [d])[0];
      if (!f) return null;
      const t = x => x && (x.local || x.utc || x) || '';
      const a = f.arrival || {}, s = f.departure || {};
      const prog = t(a.scheduledTime) || a.scheduledTimeLocal || '', est = t(a.revisedTime) || t(a.predictedTime) || a.actualTimeLocal || '', real = t(a.runwayTime) || '';
      const ret = prog && est ? Math.round((Date.parse(String(est).replace(' ', 'T')) - Date.parse(String(prog).replace(' ', 'T'))) / 60000) : 0;
      return { fuente: 'AeroDataBox', estado: /cancel/i.test(f.status) ? 'cancelado' : /divert/i.test(f.status) ? 'desviado' : /arriv|landed/i.test(f.status) ? 'aterrizó' : /enroute|departed|airborne/i.test(f.status) ? 'en vuelo' : 'programado', texto: f.status || '',
        llegada_programada: prog, llegada_estimada: est, llegada_real: real, salida_programada: t(s.scheduledTime) || '', salida_estimada: t(s.revisedTime) || '', salida_real: t(s.runwayTime) || '',
        retraso_min: Number.isFinite(ret) ? ret : 0, terminal: a.terminal || '', puerta: a.gate || '' };
    } finally { clearTimeout(reloj); }
  }
  const horaLocal = iso => { const m = String(iso || '').match(/(\d{2}):(\d{2})/); return m ? m[1] + ':' + m[2] : ''; };
  let vuelosCorriendo = false;
  async function vigilarVuelos(forzar) {
    const mods = await modulos();
    if (!mods.vuelos || vuelosCorriendo) return { ok: false };
    vuelosCorriendo = true;
    try {
      const reglas = await cfg('reglas', REGLAS_INICIALES);
      const hoy = hoyLocal();
      const filas = (await client.query(`SELECT o.id, o.vuelo AS vivo, o.fecha, o.chofer_id, o.proveedor_id, c.vuelo, c.hora_servicio, c.tipo_servicio, c.hotel, c.punto_partida, c.punto_llegada, c.aeropuerto, c.actividad
        FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id WHERE o.fecha IN ($1, $2) AND o.estado NOT IN ('cancelado', 'completado', 'no_show') AND c.vuelo <> ''`, [hoy, masDias(hoy, 1)])).rows;
      const ahora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santo_Domingo' }));
      const minAhora = ahora.getHours() * 60 + ahora.getMinutes();
      let consultas = 0;
      const lista = await hoteles();
      for (const s of filas) {
        const ident = identVuelo(String(s.vuelo).split(/[,;/]/)[0]);
        if (!ident) continue;
        const h = minutos(s.hora_servicio);
        const cerca = s.fecha === hoy ? (h === null || (h - minAhora < 6 * 60 && minAhora - h < 3 * 60)) : (h !== null && h < 6 * 60 && minAhora > 20 * 60);
        const ultima = s.vivo && s.vivo.consultado ? Date.parse(s.vivo.consultado) : 0;
        if (!forzar && (!cerca || Date.now() - ultima < (Number(reglas.consultar_vuelos_cada_min) || 10) * 60000)) continue;
        if (consultas++ > 60) break;
        let info;
        try { info = await consultarVuelo(null, ident, s.fecha); } catch (e) { await client.query('UPDATE op_servicios SET vuelo = $1 WHERE id = $2', [JSON.stringify({ ...(s.vivo || {}), error: e.message, consultado: new Date().toISOString() }), s.id]); continue; }
        if (!info) { await client.query('UPDATE op_servicios SET vuelo = $1 WHERE id = $2', [JSON.stringify({ estado: 'sin datos', consultado: new Date().toISOString() }), s.id]); continue; }
        const tipo = tipoDe(s);
        const horaEst = horaLocal(tipo === 'OUT' ? (info.salida_estimada || info.salida_programada) : (info.llegada_estimada || info.llegada_real || info.llegada_programada));
        const vivo = { ...info, hora_estimada: horaEst, consultado: new Date().toISOString() };
        const antes = s.vivo && s.vivo.hora_estimada;
        let alerta = '';
        const mov = antes && horaEst ? Math.abs(minutos(horaEst) - minutos(antes)) : (horaEst && s.hora_servicio ? Math.abs(minutos(horaEst) - minutos(s.hora_servicio)) : 0);
        if (info.estado === 'cancelado' || info.estado === 'desviado') alerta = `Vuelo ${ident} ${info.estado}.`;
        else if (mov >= (Number(reglas.aviso_retraso_min) || 15)) alerta = `Vuelo ${ident}: nueva hora ${horaEst} (antes ${antes || s.hora_servicio}).`;
        const zona = zonaDe(tipo === 'OUT' ? (s.hotel || s.punto_partida) : (s.hotel || s.punto_llegada), lista);
        const tm = tiempos({ ...s, hora_servicio: horaEst || s.hora_servicio }, null, reglas, zona);
        await client.query(`UPDATE op_servicios SET vuelo = $1, hora_recogida = CASE WHEN $2 <> '' THEN $2 ELSE hora_recogida END, alerta = CASE WHEN $3 <> '' THEN $3 ELSE alerta END, actualizado = NOW() WHERE id = $4`,
          [JSON.stringify(vivo), tm.recogida, alerta, s.id]);
        if (alerta) await evento(s.id, 'vuelo', alerta, 'sistema');
      }
      return { ok: true, consultas };
    } finally { vuelosCorriendo = false; }
  }

  // ---------- WhatsApp por Chatwoot ----------
  async function enviarWhatsApp(u, id) {
    const mods = await modulos();
    if (!mods.whatsapp) throw error('WhatsApp está apagado (Configuración → Módulos).');
    const wa = await cfg('whatsapp', WHATSAPP_INICIAL);
    const token = descifrar((await cfg('llaves', {})).chatwoot || '');
    if (!wa.chatwoot_url || !wa.cuenta || !wa.inbox_id || !token) throw error('Falta configurar Chatwoot (dirección, cuenta, bandeja de WhatsApp y token).');
    const f0 = (await client.query('SELECT fecha FROM op_servicios WHERE id = $1', [Number(id)])).rows[0];
    const s = f0 ? (await listar({ fecha: f0.fecha })).find(x => x.id === Number(id)) : null;
    if (!s) throw error('No existe ese servicio.', 404);
    const tel = String(s.telefono || '').split(/[,;/]/)[0].replace(/[^\d+]/g, '');
    if (tel.replace(/\D/g, '').length < 8) throw error('El servicio no tiene un teléfono válido del pasajero.');
    const empresa = ((await client.query('SELECT nombre, marca_nombre FROM empresa_datos WHERE id = 1').catch(() => ({ rows: [] }))).rows[0] || {});
    const valores = { cliente: s.cliente.split(',')[0], empresa: empresa.marca_nombre || empresa.nombre || '', fecha: s.fecha, recogida: s.recogida || s.hora, chofer: s.chofer || s.proveedor || 'por confirmar',
      vehiculo: s.vehiculo || '', placa: s.placa || '', punto: s.tipo === 'IN' ? `Aeropuerto ${s.aeropuerto}${s.vuelo_vivo && s.vuelo_vivo.terminal ? ', terminal ' + s.vuelo_vivo.terminal : ''}` : s.desde, vuelo: s.vuelo };
    const texto = String(wa.mensaje || WHATSAPP_INICIAL.mensaje).replace(/\{(\w+)\}/g, (m, k) => valores[k] ?? '');
    const base = String(wa.chatwoot_url).replace(/\/$/, '') + '/api/v1/accounts/' + encodeURIComponent(wa.cuenta);
    const h = { api_access_token: token, 'Content-Type': 'application/json' };
    const telE164 = tel.startsWith('+') ? tel : '+' + tel;
    let contacto = null;
    const b = await fetch(base + '/contacts/search?q=' + encodeURIComponent(telE164), { headers: h });
    if (b.ok) { const d = await b.json(); contacto = (d.payload || [])[0] || null; }
    if (!contacto) {
      const c = await fetch(base + '/contacts', { method: 'POST', headers: h, body: JSON.stringify({ inbox_id: Number(wa.inbox_id), name: valores.cliente || telE164, phone_number: telE164 }) });
      const d = await c.json().catch(() => ({}));
      if (!c.ok) throw error('Chatwoot no creó el contacto: ' + (d.message || c.status), 502);
      contacto = d.payload && d.payload.contact ? d.payload.contact : d.payload || d;
    }
    const mensaje = { content: texto };
    if (wa.plantilla) mensaje.template_params = { name: wa.plantilla, category: 'UTILITY', language: wa.idioma || 'es', processed_params: Object.fromEntries(['cliente', 'fecha', 'recogida', 'chofer', 'placa', 'punto'].map((k, i) => [String(i + 1), String(valores[k] || '')])) };
    const conv = await fetch(base + '/conversations', { method: 'POST', headers: h, body: JSON.stringify({ inbox_id: Number(wa.inbox_id), contact_id: contacto.id, message: mensaje }) });
    const dc = await conv.json().catch(() => ({}));
    if (!conv.ok) throw error('Chatwoot no envió el mensaje: ' + (dc.message || dc.error || conv.status), 502);
    await client.query('UPDATE op_servicios SET wa = $1 WHERE id = $2', [JSON.stringify({ enviado: new Date().toISOString(), conversacion: dc.id || null, por: u.usuario || 'sistema' }), s.id]);
    await evento(s.id, 'whatsapp', 'WhatsApp enviado al cliente: ' + texto.slice(0, 200), u.usuario || 'sistema');
    return { ok: true, texto };
  }

  // ---------- app del chofer ----------
  // Sesión del chofer firmada (sobrevive a reinicios del panel). Cambiar el PIN la invalida.
  const COOKIE_CHOFER = 'zentralia_chofer';
  const firmaChofer = (id, vence, pinHash) => crypto.createHmac('sha256', llaveCifrado()).update(`chofer|${id}|${vence}|${String(pinHash || '').slice(-12)}`).digest('hex').slice(0, 40);
  function choferDeReq(req) {
    const c = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE_CHOFER + '='));
    const m = (c ? c.slice(COOKIE_CHOFER.length + 1) : '').match(/^(\d+)\.(\d+)\.([a-f0-9]{40})$/);
    if (!m || Number(m[2]) < Date.now()) return null;
    return { chofer_id: Number(m[1]), vence: Number(m[2]), firma: m[3] };
  }
  const intentosChofer = new Map();
  async function manejarChofer(req, res, url, { json, leerCuerpo, esLocal }) {
    const mods = await modulos();
    if (!mods.app_chofer) return json(res, 403, { error: 'La app del chofer todavía no está activa. Pregunta en la oficina.' });
    if (req.method === 'POST' && url === '/api/chofer/entrar') {
      const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '');
      const n = intentosChofer.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - n.t > 15 * 60000) { n.n = 0; n.t = Date.now(); }
      if (n.n >= 8) return json(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
      const f = await leerCuerpo(req);
      const ch = (await client.query('SELECT * FROM op_choferes WHERE lower(codigo) = lower($1) AND activo', [txt(f.codigo, 40)])).rows[0];
      if (!ch || !ch.pin_hash || !(await bcrypt.compare(String(f.pin || ''), ch.pin_hash))) { n.n++; intentosChofer.set(ip, n); return json(res, 401, { error: 'Código o PIN incorrecto.' }); }
      const vence = Date.now() + 14 * 24 * 3600 * 1000;
      const token = `${ch.id}.${vence}.${firmaChofer(ch.id, vence, ch.pin_hash)}`;
      const segura = /https/.test(String(req.headers['cf-visitor'] || req.headers['x-forwarded-proto'] || '')) ? '; Secure' : '';
      return json(res, 200, { ok: true, nombre: ch.nombre }, { 'Set-Cookie': `${COOKIE_CHOFER}=${token}; HttpOnly; Path=/; Max-Age=${14 * 24 * 3600}; SameSite=Lax${segura}` });
    }
    const s = choferDeReq(req);
    if (!s) return json(res, 401, { error: 'Entra con tu código y PIN.' });
    if (req.method === 'POST' && url === '/api/chofer/salir') return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE_CHOFER}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax` });
    const ch = (await client.query('SELECT id, nombre, telefono, pin_hash FROM op_choferes WHERE id = $1 AND activo', [s.chofer_id])).rows[0];
    if (!ch) return json(res, 401, { error: 'Tu usuario de chofer está inactivo.' });
    const esperada = firmaChofer(ch.id, s.vence, ch.pin_hash);
    if (!crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(s.firma))) return json(res, 401, { error: 'Entra otra vez con tu código y PIN.' });
    delete ch.pin_hash;
    if (req.method === 'GET' && url.startsWith('/api/chofer/hoy')) {
      const p = new URL(req.url, 'http://x').searchParams;
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(p.get('fecha') || '') ? p.get('fecha') : hoyLocal();
      const lista = (await listar({ fecha })).filter(x => x.chofer_id === ch.id && x.estado !== 'cancelado')
        .map(x => ({ id: x.id, reserva: x.reserva, estado: x.estado, estado_nombre: x.estado_nombre, recogida: x.recogida, hora: x.hora, tipo: x.tipo, vuelo: x.vuelo, vuelo_vivo: x.vuelo_vivo,
          cliente: x.cliente, telefono: x.telefono, pax: x.pax_total, desde: x.desde, hasta: x.hasta, nota: x.nota, notas: x.notas, vehiculo: x.vehiculo, placa: x.placa }));
      return json(res, 200, { chofer: ch.nombre, fecha, servicios: lista });
    }
    if (req.method === 'POST' && url === '/api/chofer/estado') {
      const f = await leerCuerpo(req);
      const o = (await client.query('SELECT id FROM op_servicios WHERE id = $1 AND chofer_id = $2', [Number(f.id), ch.id])).rows[0];
      if (!o) return json(res, 404, { error: 'Ese servicio no es tuyo.' });
      if (!['en_camino', 'en_sitio', 'recogido', 'completado', 'no_show'].includes(f.estado)) return json(res, 400, { error: 'Estado no válido.' });
      await cambiarEstado({ usuario: 'chofer:' + ch.nombre }, o.id, f.estado, txt(f.nota, 300));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/chofer/ubicacion') {
      const f = await leerCuerpo(req);
      const lat = Number(f.lat), lng = Number(f.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return json(res, 400, { error: 'Ubicación no válida.' });
      await client.query(`INSERT INTO op_ubicaciones (chofer_id, lat, lng, precision, fecha) VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (chofer_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, precision = EXCLUDED.precision, fecha = NOW()`, [ch.id, lat, lng, Number(f.precision) || null]);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Ruta no encontrada' });
  }

  // ---------- catálogos (Configuración) ----------
  const CATALOGOS = {
    choferes: { tabla: 'op_choferes', campos: { nombre: 'txt', telefono: 'txt', licencia: 'txt', licencia_vence: 'fecha', vehiculo_id: 'id', sede: 'txt', pago_servicio: 'num', codigo: 'txt', activo: 'bool', libre_desde: 'fecha', libre_hasta: 'fecha', notas: 'txt' } },
    vehiculos: { tabla: 'op_vehiculos', campos: { nombre: 'txt', placa: 'txt', capacidad: 'int', tipo: 'txt', sede: 'txt', seguro_vence: 'fecha', marbete_vence: 'fecha', activo: 'bool', notas: 'txt' } },
    proveedores: { tabla: 'op_proveedores', campos: { nombre: 'txt', tipo: 'txt', contacto: 'txt', telefono: 'txt', email: 'txt', sede: 'txt', activo: 'bool', notas: 'txt' } },
    agencias: { tabla: 'op_agencias', campos: { nombre: 'txt', alias: 'txt', tarifario_id: 'id', modalidad: 'txt', contacto: 'txt', telefono: 'txt', email: 'txt', activo: 'bool', notas: 'txt' } },
    hoteles: { tabla: 'op_hoteles', campos: { hotel: 'txt', zona: 'txt', sede: 'txt' } },
    tarifarios: { tabla: 'op_tarifarios', campos: { nombre: 'txt', tipo: 'txt', agencia_id: 'id', proveedor_id: 'id', moneda: 'txt', activo: 'bool', notas: 'txt' } },
    tarifas: { tabla: 'op_tarifas', campos: { tarifario_id: 'id', servicio: 'txt', nombre: 'txt', aeropuerto: 'txt', zona: 'txt', modalidad: 'txt', cobro: 'txt', pax_desde: 'int', pax_hasta: 'int',
      precio_vehiculo: 'num', precio_adulto: 'num', precio_nino: 'num', precio_infante: 'num', desde: 'fecha', hasta: 'fecha', nocturno_pct: 'num', nocturno_desde: 'hora', nocturno_hasta: 'hora', notas: 'txt' } },
    paquetes: { tabla: 'op_paquetes', campos: { nombre: 'txt', sede: 'txt', icono: 'txt', descripcion: 'txt', piezas: 'json', activo: 'bool', orden: 'int' } }
  };
  function limpiarCampo(tipo, v) {
    if (tipo === 'txt') return txt(v, 500);
    if (tipo === 'num') return dinero(num(v));
    if (tipo === 'int') return entero(v);
    if (tipo === 'id') return v === '' || v === null || v === undefined ? null : Number(v) || null;
    if (tipo === 'bool') return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
    if (tipo === 'fecha') return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
    if (tipo === 'hora') return /^\d{2}:\d{2}$/.test(String(v || '')) ? String(v) : '';
    if (tipo === 'json') return JSON.stringify(Array.isArray(v) || (v && typeof v === 'object') ? v : []);
    return v;
  }
  async function guardarCatalogo(u, nombre, f) {
    const c = CATALOGOS[nombre];
    if (!c) throw error('Catálogo no válido.');
    const filas = Object.entries(c.campos).filter(([k]) => f[k] !== undefined).map(([k, t]) => [k, limpiarCampo(t, f[k])]);
    if (nombre === 'tarifas' && f.servicio && !TIPOS_TARIFA.includes(String(f.servicio).toUpperCase())) throw error('Tipo de servicio no válido.');
    if (nombre === 'proveedores' && f.tipo && !TIPOS_PROVEEDOR.includes(f.tipo)) throw error('Tipo de proveedor no válido.');
    let id = Number(f.id) || 0;
    if (id) {
      if (filas.length) await client.query(`UPDATE ${c.tabla} SET ${filas.map(([k], i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${filas.length + 1}`, [...filas.map(x => x[1]), id]);
    } else {
      if (!filas.length) throw error('Faltan datos.');
      id = (await client.query(`INSERT INTO ${c.tabla} (${filas.map(x => x[0]).join(', ')}) VALUES (${filas.map((x, i) => '$' + (i + 1)).join(', ')}) RETURNING id`, filas.map(x => x[1]))).rows[0].id;
    }
    if (nombre === 'choferes' && f.pin) {
      if (!/^\d{4,8}$/.test(String(f.pin))) throw error('El PIN del chofer debe tener de 4 a 8 números.');
      await client.query('UPDATE op_choferes SET pin_hash = $1 WHERE id = $2', [await bcrypt.hash(String(f.pin), 10), id]);
    }
    cacheHoteles.t = 0; cacheAgencias.t = 0;
    await registrar(u, 'op_config_' + nombre, nombre, id, '', '', f.nombre || f.hotel || '');
    return { ok: true, id };
  }
  async function borrarCatalogo(u, nombre, id) {
    const c = CATALOGOS[nombre];
    if (!c) throw error('Catálogo no válido.');
    if (nombre === 'tarifarios') await client.query('DELETE FROM op_tarifas WHERE tarifario_id = $1', [Number(id)]);
    await client.query(`DELETE FROM ${c.tabla} WHERE id = $1`, [Number(id)]);
    cacheHoteles.t = 0; cacheAgencias.t = 0;
    await registrar(u, 'op_config_borrar_' + nombre, nombre, id, '', '', '');
    return { ok: true };
  }
  // Importar tarifas u hoteles desde Excel (columnas con nombre en la primera fila).
  const COLUMNAS_TARIFAS = { servicio: ['servicio', 'tipo'], nombre: ['nombre', 'tour', 'parque', 'actividad', 'descripcion'], aeropuerto: ['aeropuerto', 'airport'], zona: ['zona', 'destino', 'hotel zona'],
    modalidad: ['modalidad', 'privado compartido'], cobro: ['cobro', 'por'], pax_desde: ['pax desde', 'desde pax', 'min pax'], pax_hasta: ['pax hasta', 'hasta pax', 'max pax'],
    precio_vehiculo: ['precio vehiculo', 'vehiculo', 'precio'], precio_adulto: ['adulto', 'precio adulto'], precio_nino: ['nino', 'precio nino', 'menor'], precio_infante: ['infante', 'precio infante'],
    desde: ['temporada desde', 'vigente desde'], hasta: ['temporada hasta', 'vigente hasta'], nocturno_pct: ['nocturno', 'recargo nocturno'], notas: ['notas', 'nota'] };
  async function importarExcel(u, f) {
    const buf = Buffer.from(String(f.base64 || ''), 'base64');
    if (!buf.length || buf.length > 15 * 1024 * 1024) throw error('Sube un Excel (.xlsx) de menos de 15 MB.');
    const hojas = leerExcel(buf);
    const hoja = hojas.find(h => h.filas.length > 1);
    if (!hoja) throw error('El Excel está vacío.');
    const cab = hoja.filas[0];
    const cols = Object.fromEntries(Object.entries(cab).map(([col, c]) => [col, norm(c.v)]));
    const fila = r => Object.fromEntries(Object.entries(cols).map(([col, n]) => [n, r[col] ? r[col].v : '']));
    let n = 0;
    if (f.tipo === 'hoteles') {
      for (const r of hoja.filas.slice(1)) {
        const x = fila(r); const hotel = txt(x.hotel || x.nombre, 200);
        if (!hotel) continue;
        await client.query('INSERT INTO op_hoteles (hotel, zona, sede) VALUES ($1, $2, $3) ON CONFLICT (hotel) DO UPDATE SET zona = EXCLUDED.zona, sede = EXCLUDED.sede', [hotel, txt(x.zona, 100), txt(x.sede, 60)]);
        n++;
      }
      cacheHoteles.t = 0;
    } else {
      const tf = Number(f.tarifario_id);
      if (!(await client.query('SELECT 1 FROM op_tarifarios WHERE id = $1', [tf])).rowCount) throw error('Elige el tarifario donde van las tarifas.');
      if (f.reemplazar) await client.query('DELETE FROM op_tarifas WHERE tarifario_id = $1', [tf]);
      for (const r of hoja.filas.slice(1)) {
        const x = fila(r); const d = { tarifario_id: tf };
        for (const [campo, nombres] of Object.entries(COLUMNAS_TARIFAS)) { const k = nombres.map(norm).find(nm => x[nm] !== undefined && x[nm] !== ''); if (k) d[campo] = x[k]; }
        if (!d.nombre && !d.zona && !d.precio_vehiculo && !d.precio_adulto) continue;
        d.servicio = TIPOS_TARIFA.includes(String(d.servicio || '').toUpperCase()) ? String(d.servicio).toUpperCase() : /llegad|arriv|\bin\b/i.test(d.servicio || '') ? 'IN' : /salid|depart|\bout\b/i.test(d.servicio || '') ? 'OUT' : /entrada|ticket/i.test(d.servicio || '') ? 'ENTRADA' : /tour|excurs/i.test(d.servicio || '') ? 'ACTIVIDAD' : 'TRASLADO';
        d.cobro = /persona|pax|adult/i.test(d.cobro || '') || d.precio_adulto ? 'persona' : 'vehiculo';
        d.pax_desde = d.pax_desde || 1; d.pax_hasta = d.pax_hasta || 99;
        await guardarCatalogo(u, 'tarifas', d); n++;
      }
    }
    return { ok: true, importadas: n, hoja: hoja.nombre };
  }

  // ---------- rutas del panel ----------
  async function estadoPublico(u) {
    const publico = await cfg('publico', false);
    return { publico: Boolean(publico), puedeVer: u.grupo === 'Programador' || Boolean(publico), modulos: await modulos() };
  }
  async function manejar(req, res, url, u, { json, leerCuerpo, puede }) {
    const p = new URL(req.url, 'http://localhost').searchParams;
    const est = await estadoPublico(u);
    if (req.method === 'GET' && url === '/api/op/estado') return json(res, 200, { ...est, ok: true });
    if (!est.puedeVer) return json(res, 403, { error: 'Operaciones está en construcción. ¡Próximamente!', proximamente: true });
    const prog = u.grupo === 'Programador';
    const pide = (perm, msg) => { if (!prog && !puede(perm)) throw error(msg || 'No tienes permiso para esto.', 403); };
    const mod = (m, nombre) => { if (!est.modulos[m]) throw error(`${nombre} está apagado (Configuración → Módulos).`, 403); };
    try {
      if (req.method === 'GET' && url === '/api/op/inicio') {
        pide('ver_operaciones');
        const [choferes, vehiculos, proveedores, ags, paquetes] = await Promise.all([
          client.query('SELECT id, nombre, telefono, vehiculo_id, sede, activo, libre_desde, libre_hasta, licencia_vence FROM op_choferes ORDER BY nombre'),
          client.query('SELECT id, nombre, placa, capacidad, tipo, sede, activo, seguro_vence, marbete_vence FROM op_vehiculos ORDER BY nombre'),
          client.query('SELECT id, nombre, tipo, telefono, sede, activo FROM op_proveedores ORDER BY nombre'),
          client.query('SELECT id, nombre, modalidad FROM op_agencias WHERE activo ORDER BY nombre'),
          client.query('SELECT * FROM op_paquetes WHERE activo ORDER BY orden, id')]);
        const empresa = ((await client.query('SELECT nombre, marca_nombre, logo IS NOT NULL AS logo, rnc, direccion FROM empresa_datos WHERE id = 1').catch(() => ({ rows: [] }))).rows[0] || {});
        const perms = ['ver_operaciones', 'asignar_servicios', 'crear_reservas', 'ver_precios', 'ver_reportes_op', 'ver_choferes_vivo', 'imprimir_operativo', 'crear_paquetes', 'configurar_operaciones']
          .reduce((a, k) => ({ ...a, [k]: prog || puede(k) }), {});
        return json(res, 200, { ...est, permisos: perms, usuario: { nombre: u.nombre, grupo: u.grupo, usuario: u.usuario }, empresa, hoy: hoyLocal(),
          choferes: choferes.rows, vehiculos: vehiculos.rows, proveedores: proveedores.rows, agencias: ags.rows, paquetes: paquetes.rows,
          plantillas: await cfg('plantillas', PLANTILLAS_INICIALES), reglas: await cfg('reglas', REGLAS_INICIALES), estados: NOMBRE_ESTADO });
      }
      if (req.method === 'GET' && url === '/api/op/servicios') {
        pide('ver_operaciones'); mod('operaciones', 'Operaciones');
        let lista = await listar({ fecha: p.get('fecha'), sede: p.get('sede') || '', desde: p.get('desde'), hasta: p.get('hasta'), sinFecha: p.get('sinfecha') === '1' });
        const sinFecha = Number((await client.query("SELECT count(*) FROM op_servicios WHERE fecha = '' AND estado NOT IN ('cancelado', 'completado')")).rows[0].count);
        if (!prog && !puede('ver_precios')) lista = lista.map(x => ({ ...x, precio: undefined, costo: undefined, tarifa_venta: undefined, tarifa_costo: undefined }));
        const ubic = est.modulos.app_chofer ? (await client.query("SELECT u.*, c.nombre FROM op_ubicaciones u JOIN op_choferes c ON c.id = u.chofer_id WHERE u.fecha > NOW() - INTERVAL '2 hours'")).rows : [];
        return json(res, 200, { servicios: lista, ubicaciones: ubic, sin_fecha: sinFecha });
      }
      if (req.method === 'GET' && url === '/api/op/eventos') {
        pide('ver_operaciones');
        const filas = (await client.query('SELECT * FROM op_eventos WHERE op_id = $1 ORDER BY id DESC LIMIT 60', [Number(p.get('id'))])).rows;
        return json(res, 200, { eventos: filas });
      }
      if (req.method === 'POST' && url === '/api/op/asignar') { pide('asignar_servicios', 'No tienes permiso para asignar choferes.'); const f = await leerCuerpo(req); return json(res, 200, await asignar(u, f.ids, f)); }
      if (req.method === 'POST' && url === '/api/op/estado-servicio') { pide('asignar_servicios'); const f = await leerCuerpo(req); return json(res, 200, await cambiarEstado(u, f.id, f.estado, f.nota)); }
      if (req.method === 'POST' && url === '/api/op/fecha') {
        pide('asignar_servicios'); const f = await leerCuerpo(req);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fecha || '')) throw error('Fecha no válida.');
        const o = (await client.query('SELECT servicio_id FROM op_servicios WHERE id = $1', [Number(f.id)])).rows[0];
        if (!o) throw error('No existe ese servicio.', 404);
        await client.query('UPDATE clasificacion SET fecha_servicio = $1, hora_servicio = COALESCE(NULLIF($2, \'\'), hora_servicio) WHERE id = $3', [f.fecha, /^\d{2}:\d{2}$/.test(f.hora || '') ? f.hora : '', o.servicio_id]);
        await client.query('UPDATE op_servicios SET fecha = $1 WHERE id = $2', [f.fecha, Number(f.id)]);
        await evento(Number(f.id), 'cambio', `Fecha puesta en Operaciones: ${f.fecha}${f.hora ? ' ' + f.hora : ''}`, u.usuario);
        ultimaSync = 0; await sincronizar(true);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/op/notas') {
        pide('asignar_servicios'); const f = await leerCuerpo(req);
        await client.query('UPDATE op_servicios SET notas = $1, alerta = CASE WHEN $2 THEN \'\' ELSE alerta END WHERE id = $3', [txt(f.notas, 1000), Boolean(f.quitarAlerta), Number(f.id)]);
        if (f.quitarAlerta) await evento(Number(f.id), 'alerta', 'Aviso revisado', u.usuario);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/op/precio') { pide('ver_precios', 'No tienes permiso para cambiar precios.'); mod('precios', 'Precios'); const f = await leerCuerpo(req); return json(res, 200, await ajustarPrecio(u, f.id, f)); }
      if (req.method === 'POST' && url === '/api/op/recalcular') { pide('configurar_operaciones'); mod('precios', 'Precios'); const f = await leerCuerpo(req); return json(res, 200, await recalcular(u, Array.isArray(f.ids) ? f.ids.map(Number) : null)); }
      if (req.method === 'POST' && url === '/api/op/reserva') { pide('crear_reservas', 'No tienes permiso para crear reservas.'); mod('reserva_manual', 'La reserva manual'); const f = await leerCuerpo(req); return json(res, 200, await crearReservaManual(u, f)); }
      if (req.method === 'POST' && url === '/api/op/paquete/cotizar') { pide('crear_paquetes', 'No tienes permiso para paquetes.'); mod('paquetes', 'Paquetes'); return json(res, 200, await cotizarPaquete(await leerCuerpo(req))); }
      if (req.method === 'POST' && url === '/api/op/entrada') {
        pide('crear_paquetes'); const f = await leerCuerpo(req);
        await client.query("UPDATE op_servicios SET entrada_codigos = $1, estado = CASE WHEN $1 <> '' THEN 'completado' ELSE 'por_asignar' END WHERE id = $2 AND clase = 'entrada'", [txt(f.codigos, 2000), Number(f.id)]);
        await evento(Number(f.id), 'entrada', f.codigos ? 'Entradas emitidas' : 'Entradas pendientes', u.usuario);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url === '/api/op/reporte') { pide('ver_reportes_op', 'No tienes permiso para los reportes.'); mod('reportes', 'Reportes'); return json(res, 200, await reporte({ desde: p.get('desde'), hasta: p.get('hasta'), tipo: p.get('tipo'), sede: p.get('sede'), clave: p.get('clave') })); }
      if (req.method === 'GET' && url === '/api/op/reporte.csv') {
        pide('ver_reportes_op'); mod('reportes', 'Reportes');
        const r = await reporte({ desde: p.get('desde'), hasta: p.get('hasta'), tipo: p.get('tipo'), sede: p.get('sede') });
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const lineas = [['Grupo', 'Fecha', 'Reserva', 'Cliente', 'Servicio', 'Pax', 'Agencia', 'Proveedor/Chofer', 'Estado', 'Precio', 'Costo', 'Ganancia'].map(esc).join(',')];
        for (const g of r.grupos) for (const d of g.detalle) lineas.push([g.nombre, d.fecha, d.reserva, d.cliente, d.servicio, d.pax, d.agencia, d.proveedor, d.estado, d.precio ?? '', d.costo ?? '', d.precio !== null && d.costo !== null ? dinero(d.precio - d.costo) : ''].map(esc).join(','));
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="reporte-${r.tipo}-${r.desde}-a-${r.hasta}.csv"` });
        return res.end('﻿' + lineas.join('\r\n'));
      }
      if (req.method === 'POST' && url === '/api/op/whatsapp') { pide('asignar_servicios'); const f = await leerCuerpo(req); return json(res, 200, await enviarWhatsApp(u, f.id)); }
      if (req.method === 'POST' && url === '/api/op/vuelos/ahora') { pide('asignar_servicios'); mod('vuelos', 'Vuelos en vivo'); return json(res, 200, await vigilarVuelos(true)); }

      // ----- Configuración (solo con "configurar_operaciones") -----
      if (url.startsWith('/api/op/config')) {
        pide('configurar_operaciones', 'Solo el Programador (o quien tenga "Configurar operaciones") cambia esto.');
        if (req.method === 'GET' && url === '/api/op/config') {
          const [tarifarios, tarifas, agencias2, hoteles2, choferes, vehiculos, proveedores, paquetes] = await Promise.all([
            client.query('SELECT * FROM op_tarifarios ORDER BY tipo, nombre'), client.query('SELECT * FROM op_tarifas ORDER BY tarifario_id, servicio, nombre, zona, pax_desde'),
            client.query('SELECT * FROM op_agencias ORDER BY nombre'), client.query('SELECT * FROM op_hoteles ORDER BY sede, zona, hotel'),
            client.query('SELECT id, nombre, telefono, licencia, licencia_vence, vehiculo_id, sede, pago_servicio, codigo, activo, libre_desde, libre_hasta, notas, (pin_hash <> \'\') AS tiene_pin FROM op_choferes ORDER BY nombre'),
            client.query('SELECT * FROM op_vehiculos ORDER BY nombre'), client.query('SELECT * FROM op_proveedores ORDER BY nombre'), client.query('SELECT * FROM op_paquetes ORDER BY orden, id')]);
          const llaves = await cfg('llaves', {});
          return json(res, 200, { publico: await cfg('publico', false), modulos: await modulos(), reglas: await cfg('reglas', REGLAS_INICIALES), plantillas: await cfg('plantillas', PLANTILLAS_INICIALES),
            whatsapp: await cfg('whatsapp', WHATSAPP_INICIAL), vuelos: await cfg('vuelos', VUELOS_INICIAL), llaves: Object.fromEntries(Object.keys(llaves).map(k => [k, Boolean(llaves[k])])),
            tarifarios: tarifarios.rows, tarifas: tarifas.rows, agencias: agencias2.rows, hoteles: hoteles2.rows, choferes: choferes.rows, vehiculos: vehiculos.rows, proveedores: proveedores.rows, paquetes: paquetes.rows,
            tipos_tarifa: TIPOS_TARIFA, tipos_proveedor: TIPOS_PROVEEDOR });
        }
        const f = req.method === 'POST' ? await leerCuerpo(req) : {};
        if (url === '/api/op/config/publico') { await guardarCfg('publico', Boolean(f.publico)); await registrar(u, 'op_publicar', 'operaciones', '', '', String(Boolean(f.publico)), ''); return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/modulos') { const m = { ...(await modulos()) }; for (const k of Object.keys(MODULOS_INICIALES)) if (f[k] !== undefined) m[k] = Boolean(f[k]); await guardarCfg('modulos', m); await registrar(u, 'op_modulos', 'operaciones', '', '', JSON.stringify(m), ''); return json(res, 200, { ok: true, modulos: m }); }
        if (url === '/api/op/config/reglas') { const r = { ...(await cfg('reglas', REGLAS_INICIALES)) }; for (const k of Object.keys(REGLAS_INICIALES)) if (f[k] !== undefined) r[k] = k === 'tiempos_zona' ? Object.fromEntries(Object.entries(f[k] || {}).map(([z, m]) => [txt(z, 60), entero(m)]).filter(([z]) => z)) : entero(f[k]); await guardarCfg('reglas', r); return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/plantillas') { const pl = { ...(await cfg('plantillas', PLANTILLAS_INICIALES)) }; for (const k of Object.keys(PLANTILLAS_INICIALES)) if (f[k] && typeof f[k] === 'object') pl[k] = { ...pl[k], ...Object.fromEntries(Object.entries(f[k]).map(([a, b]) => [a, Array.isArray(b) ? b.map(x => txt(x, 30)) : typeof b === 'boolean' || typeof b === 'number' ? b : txt(b, 1500)])) }; await guardarCfg('plantillas', pl); return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/whatsapp') { const w = { ...(await cfg('whatsapp', WHATSAPP_INICIAL)) }; for (const k of Object.keys(WHATSAPP_INICIAL)) if (f[k] !== undefined) w[k] = k === 'auto_al_asignar' ? Boolean(f[k]) : txt(f[k], 1000); await guardarCfg('whatsapp', w); if (f.token) { const l = await cfg('llaves', {}); l.chatwoot = cifrar(txt(f.token, 200)); await guardarCfg('llaves', l); } return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/vuelos') { const v = { ...(await cfg('vuelos', VUELOS_INICIAL)) }; if (['aerodatabox', 'flightaware'].includes(f.proveedor)) v.proveedor = f.proveedor; if (f.rapidapi_host) v.rapidapi_host = txt(f.rapidapi_host, 100); await guardarCfg('vuelos', v); const l = await cfg('llaves', {}); for (const k of ['aerodatabox', 'flightaware']) if (f['llave_' + k]) l[k] = cifrar(txt(f['llave_' + k], 300)); await guardarCfg('llaves', l); return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/vuelos/probar') { const r = await consultarVuelo(f.proveedor, identVuelo(f.vuelo), /^\d{4}-\d{2}-\d{2}$/.test(f.fecha || '') ? f.fecha : hoyLocal()); return json(res, 200, { ok: true, resultado: r }); }
        if (url === '/api/op/config/importar') return json(res, 200, await importarExcel(u, f));
        const m = url.match(/^\/api\/op\/config\/(\w+)\/(guardar|borrar)$/);
        if (m) return json(res, 200, m[2] === 'guardar' ? await guardarCatalogo(u, m[1], f) : await borrarCatalogo(u, m[1], f.id));
      }
      return json(res, 404, { error: 'Ruta no encontrada' });
    } catch (e) {
      if (e.code === '23505') return json(res, 400, { error: /codigo/.test(e.constraint || '') ? 'Ese usuario de la app ya lo tiene otro chofer.' : /hotel/.test(e.constraint || '') ? 'Ese hotel ya está en la lista.' : 'Ya existe un registro igual.' });
      if (e.code === '23503') return json(res, 400, { error: 'No se puede borrar: otros datos lo están usando (servicios, tarifas o choferes).' });
      return json(res, e.codigo || 500, { error: e.message });
    }
  }

  function iniciar() {
    setTimeout(() => sincronizar(true).catch(e => console.log('Operaciones:', e.message)), 15000);
    setInterval(() => sincronizar().catch(e => console.log('Operaciones:', e.message)), 60 * 1000);
    setInterval(() => vigilarVuelos().catch(e => console.log('Vuelos:', e.message)), 2 * 60 * 1000);
  }

  return { preparar, iniciar, manejar, manejarChofer, estadoPublico, sincronizar, _probar: { mejorTarifa, importe, tiempos, marcarChoques, identVuelo, cifrar, descifrar, agenciaDe, zonaDe } };
};
