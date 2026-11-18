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
const viator = require('../viator');
const bcrypt = require('bcryptjs');
const { leerExcel } = require('./lector-xlsx');
const crearImportador = require('./op-importar');
const fs = require('fs');
const path = require('path');

const AEROPUERTOS_RD = ['PUJ', 'SDQ', 'LRM', 'POP', 'STI', 'JBQ', 'AZS', 'BRX', 'STO'];
const AEROPUERTOS_ORL = ['MCO', 'SFB', 'TPA', 'MIA', 'FLL'];
const ESTADOS = ['por_asignar', 'asignado', 'en_camino', 'en_sitio', 'recogido', 'completado', 'no_show', 'cancelado'];
const NOMBRE_ESTADO = { por_asignar: 'Por asignar', asignado: 'Asignado', en_camino: 'En camino', en_sitio: 'En el lugar', recogido: 'Recogido', completado: 'Completado', no_show: 'No show', cancelado: 'Cancelado' };
const TIPOS_TARIFA = ['TRASLADO', 'IN', 'OUT', 'INOUT', 'INTERHOTEL', 'ACTIVIDAD', 'ENTRADA', 'TRANSPORTE', 'OTRO'];
const TIPOS_PROVEEDOR = ['transportista', 'tours', 'entradas', 'otro'];

const MODULOS_INICIALES = { operaciones: true, reserva_manual: true, operativo: true, precios: true, reportes: true, paquetes: true, vuelos: false, aviones: true, app_chofer: false, whatsapp: false };
const REGLAS_INICIALES = {
  antes_aeropuerto_min: 180,   // salida: el cliente debe estar en el aeropuerto X minutos antes del vuelo
  espera_llegada_min: 30,      // llegada: tiempo de espera del chofer desde que aterriza
  minutos_entre_servicios: 15, // margen mínimo entre dos servicios del mismo chofer
  duracion_traslado_min: 60,   // si la zona no tiene tiempo propio
  duracion_actividad_min: 240,
  tiempos_zona: { 'Bávaro': 30, 'Punta Cana': 25, 'Cap Cana': 20, 'Uvero Alto': 50, 'Macao': 40, 'Bayahíbe': 75, 'La Romana': 70, 'Santo Domingo': 150, 'Juan Dolio': 120, 'Boca Chica': 140,
    'Miches': 120, 'Samaná': 240, 'Santiago': 240, 'Puerto Plata': 300, 'Cabarete': 310, 'Puerto La Romana': 70, 'International Drive': 20, 'Lake Buena Vista': 25, 'Kissimmee': 30, 'Disney': 25 },
  aviso_retraso_min: 15,       // vuelos: avisar si se mueve más que esto
  consultar_vuelos_cada_min: 10,
  // Precios de traslados (documento de Somos Viaje):
  una_via_mitad_inout: true,   // una sola vía sin tarifa propia = mitad del In/Out de adulto, redondeada hacia arriba (todos como adulto)
  base_doble_un_pax: true,     // un pasajero solo paga doble ("base doble"), confirmado en el documento del 13-nov-2026
  base_doble_excepciones: 'Discover', // agencias a las que NO se les cobra base doble (separadas por coma)
  modalidad_defecto: 'compartido', // si la reserva no dice regular o privado
  privado_por_trayecto: true,  // el privado se cobra por cada trayecto (ida y vuelta = dos cobros)
  // Compartido (regular): solo en estas zonas y en este horario; fuera de horario, suplemento fijo por vehículo y por trayecto.
  zonas_compartido: 'Punta Cana, Bávaro, Cabeza de Toro, Arena Gorda, Uvero Alto, Macao, Cap Cana',
  zonas_privado: 'Santo Domingo', // siempre privado (también si el vuelo es por SDQ)
  puertos_privado: true,       // traslados a puertos: privado, salvo que la reserva diga compartido (orden de gerencia)
  horario_desde: '09:00', horario_hasta: '19:00',
  suplemento_fuera_horario: 20, // US$ por vehículo y por trayecto (llegadas: hora del vuelo; salidas: hora de recogida)
  cargo_puerto_pp: 10           // US$ por pasajero que el cliente paga en el puerto (solo aviso, no se cobra)
};
const PLANTILLAS_INICIALES = {
  operativo: { titulo: 'Operativo del día', subtitulo: '', columnas: ['hora', 'servicio', 'pasajero', 'pax', 'vuelo', 'recoger', 'llevar', 'agencia', 'notas'], pie: 'Llegar 10 minutos antes. Cartel con el nombre del pasajero en llegadas.', firmas: true },
  voucher: { titulo: 'Voucher de servicio', texto: 'Presente este voucher (impreso o en el celular) a su chofer o guía. Ante cualquier cambio comuníquese con nosotros.', cartel: 'Le esperamos con un cartel a nombre de {nombre}.', pie: '' },
  proforma: { titulo: 'Proforma de liquidación', texto: 'Liquidación de los servicios de la reserva. Los precios incluyen las cortesías con costo indicadas.', pie: 'Documento de pre-facturación. No es una factura fiscal.' },
  cotizacion: { titulo: 'Cotización', texto: 'Precios en dólares estadounidenses, sujetos a disponibilidad y confirmación al momento de reservar.', validez_dias: 7, pie: '' },
  reporte: { titulo: 'Reporte de servicios', pie: 'Documento interno para facturación. No es una factura fiscal.' }
};
const WHATSAPP_INICIAL = { chatwoot_url: '', cuenta: '', inbox_id: '', plantilla: '', idioma: 'es', auto_al_asignar: false,
  mensaje: 'Hola {cliente}, le saluda {empresa}. Su traslado del {fecha} a las {recogida}: chofer {chofer}, vehículo {vehiculo} {placa}. Punto de encuentro: {punto}. Cualquier duda, responda a este mensaje.' };
const VUELOS_INICIAL = { proveedor: 'aerodatabox', rapidapi_host: 'aerodatabox.p.rapidapi.com', opensky_url: 'https://opensky-network.org/api', opensky_cada_min: 10 };
// Código IATA de la aerolínea (como viene en la reserva: "CM 241") → código OACI que usan los aviones en el aire ("CMP241").
const AEROLINEAS_OACI = { CM: ['CMP'], AV: ['AVA', 'LRC', 'TAI'], LA: ['LAN', 'LPE', 'LNE', 'TAM', 'LXP', 'ARE'], JJ: ['TAM'], DM: ['DWI'], B6: ['JBU'], AA: ['AAL'], UA: ['UAL'], DL: ['DAL'],
  WN: ['SWA'], NK: ['NKS'], F9: ['FFT'], AC: ['ACA'], RV: ['ROU'], WS: ['WJA'], WG: ['SWG'], TS: ['TSC'], UX: ['AEA'], IB: ['IBE'], AF: ['AFR'], KL: ['KLM'], LH: ['DLH'], BA: ['BAW'],
  DE: ['CFG'], X3: ['TUI'], BY: ['TOM'], H2: ['SKU'], P5: ['RPB'], JA: ['JAT'], G3: ['GLO'], AD: ['AZU'], AR: ['ARG'], Y4: ['VOI'], Q6: ['VOC'], AM: ['AMX'], OB: ['BOV'], SY: ['SCX'],
  G4: ['AAY'], MX: ['MXY'], '9V': ['ROI'], L5: ['LCU'], CU: ['CUB'], '4O': ['AIJ'], VB: ['VIV'], XP: ['CXP'], Z0: ['NOS'], PU: ['PUE'], '2K': ['GLG'], E9: ['EVE'] };
// Zona del mapa donde se buscan los aviones: Caribe, Centroamérica, norte de Sudamérica y Florida.
const ZONA_AVIONES = { lamin: 5, lomin: -100, lamax: 36, lomax: -55 };

module.exports = function crearOperaciones({ client, config, registrar, fechaServicioISO, hoyLocal, esCancelacion, indiceReservas, originalDe }) {
  let ultimaSync = 0, sincronizando = null;
  const importador = crearImportador({ client });

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
  // ---------- Mapa de choferes: ubicar lugares (Mapbox) y calcular rutas con km y minutos. Todo se guarda en caché para gastar lo menos posible. ----------
  const AEROPUERTOS_COORD = { PUJ: [18.5674, -68.3634], SDQ: [18.4297, -69.6689], POP: [19.7579, -70.5700], LRM: [18.4507, -68.9118], STI: [19.4061, -70.6047], AZS: [19.2670, -69.7420], MCO: [28.4312, -81.3081], SFB: [28.7776, -81.2375] };
  const mapboxBase = () => String(config.mapbox_base || 'https://api.mapbox.com');
  // Lugar (hotel, actividad) → coordenadas. Si Mapbox responde "no existe", se guarda vacío para no volver a preguntar.
  async function geocodificar(texto) {
    const t = String(texto || '').trim();
    if (!t) return null;
    const previa = (await client.query('SELECT lat, lng FROM op_lugares WHERE texto = $1', [t])).rows[0];
    if (previa) return previa.lat === null ? null : { lat: previa.lat, lng: previa.lng };
    const tok = await llaveDeOficina('api_mapas');
    if (!tok) return null;
    let lugar = null, definitivo = false;
    try {
      const r = await fetch(`${mapboxBase()}/geocoding/v5/mapbox.places/${encodeURIComponent(t + ', República Dominicana')}.json?access_token=${encodeURIComponent(tok)}&limit=1&proximity=-68.3634,18.5674`);
      const d = await r.json().catch(() => ({}));
      if (r.ok) { definitivo = true; const f = d.features && d.features[0]; if (f) lugar = { lat: f.center[1], lng: f.center[0] }; }
    } catch (e) { lugar = null; }
    if (definitivo) await client.query('INSERT INTO op_lugares (texto, lat, lng) VALUES ($1, $2, $3) ON CONFLICT (texto) DO NOTHING', [t, lugar ? lugar.lat : null, lugar ? lugar.lng : null]);
    return lugar;
  }
  // Ruta de conducción entre dos puntos: km, minutos y el trazo para dibujarlo.
  async function rutaEntre(a, b) {
    const clave = `${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
    const previa = (await client.query('SELECT km, minutos, geometria FROM op_rutas WHERE clave = $1', [clave])).rows[0];
    if (previa) return { km: Number(previa.km), minutos: Number(previa.minutos), geometria: previa.geometria };
    const tok = await llaveDeOficina('api_mapas');
    if (!tok) return null;
    const r = await fetch(`${mapboxBase()}/directions/v5/mapbox/driving/${a.lng},${a.lat};${b.lng},${b.lat}?geometries=geojson&overview=full&access_token=${encodeURIComponent(tok)}`);
    const d = await r.json().catch(() => ({}));
    const ruta = d.routes && d.routes[0];
    if (!r.ok || !ruta) return null;
    const out = { km: Math.round(ruta.distance / 100) / 10, minutos: Math.round(ruta.duration / 60), geometria: ruta.geometry.coordinates };
    await client.query('INSERT INTO op_rutas (clave, km, minutos, geometria) VALUES ($1, $2, $3, $4) ON CONFLICT (clave) DO NOTHING', [clave, out.km, out.minutos, JSON.stringify(out.geometria)]);
    return out;
  }
  // Ruta de un chofer en un día: aeropuerto e hoteles en orden de hora, con el tramo entre cada parada.
  async function rutaDelChofer(choferId, fecha) {
    const filas = (await client.query(`SELECT o.id, o.hora, c.tipo_servicio, c.aeropuerto, c.hotel, c.punto_partida, c.punto_llegada, c.actividad, c.nombre_cliente
      FROM op_servicios o LEFT JOIN clasificacion c ON c.id = o.servicio_id
      WHERE o.chofer_id = $1 AND o.fecha = $2 AND o.estado <> 'cancelado' ORDER BY o.hora, o.id`, [choferId, fecha])).rows;
    const avisos = [], paradas = [];
    const codigo = t => { const m = String(t || '').match(/\(([A-Z]{3})\)/); return m ? m[1] : ''; };
    for (const f of filas) {
      const tipo = String(f.tipo_servicio || '').toUpperCase();
      const aero = (f.aeropuerto ? String(f.aeropuerto).toUpperCase().slice(0, 3) : '') || codigo(f.punto_partida) || codigo(f.punto_llegada) || 'PUJ';
      const hotel = f.hotel || (tipo === 'IN' ? f.punto_llegada : f.punto_partida) || '';
      const lista = tipo === 'IN' ? [{ nombre: 'Aeropuerto ' + aero, aero }, { nombre: hotel }]
        : tipo === 'OUT' ? [{ nombre: hotel }, { nombre: 'Aeropuerto ' + aero, aero }]
        : [{ nombre: hotel || f.actividad || '' }];
      for (const p of lista) {
        if (!p.nombre) continue;
        const coord = p.aero && AEROPUERTOS_COORD[p.aero] ? { lat: AEROPUERTOS_COORD[p.aero][0], lng: AEROPUERTOS_COORD[p.aero][1] } : await geocodificar(p.nombre);
        if (!coord) { avisos.push(`No encontré la ubicación de "${p.nombre}".`); continue; }
        const ultima = paradas[paradas.length - 1];
        if (ultima && Math.abs(ultima.lat - coord.lat) < 1e-5 && Math.abs(ultima.lng - coord.lng) < 1e-5) continue;
        paradas.push({ nombre: p.nombre, lat: coord.lat, lng: coord.lng, hora: f.hora || '', cliente: f.nombre_cliente || '' });
      }
    }
    const tramos = [];
    for (let i = 0; i < paradas.length - 1; i++) {
      const t = await rutaEntre(paradas[i], paradas[i + 1]);
      tramos.push({ desde: paradas[i].nombre, hasta: paradas[i + 1].nombre, km: t ? t.km : null, minutos: t ? t.minutos : null, geometria: t ? t.geometria : [] });
      if (!t) avisos.push(`No pude calcular la ruta de ${paradas[i].nombre} a ${paradas[i + 1].nombre}. Revisa la llave de mapas en Oficina.`);
    }
    const sumar = k => Math.round(tramos.reduce((s, t) => s + (Number(t[k]) || 0), 0) * 10) / 10;
    return { paradas, tramos, totalKm: sumar('km'), totalMinutos: Math.round(sumar('minutos')), avisos };
  }
  // Llaves de Oficina (APIs y suscripciones): llegan a esta empresa en zentralia_ajustes. Sin llave de Oficina: ''.
  async function llaveDeOficina(clave) {
    try { const r = await client.query('SELECT valor FROM zentralia_ajustes WHERE clave = $1', [clave]); return r.rows[0] ? r.rows[0].valor : ''; } catch (e) { return ''; }
  }
  // Comprobantes de pago: carpeta propia (se puede cambiar con vouchers_carpeta en config.js).
  const CARPETA_VOUCHERS = config.vouchers_carpeta || path.join(__dirname, '..', 'vouchers');
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
    await q("ALTER TABLE op_tarifas ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT ''"); // inter-hotel: zona de salida
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
    // Tarifarios por mercado (país) y tipo de agencia (mayorista / minorista).
    for (const t of ['op_agencias', 'op_tarifarios']) {
      await q(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS mercado TEXT NOT NULL DEFAULT ''`);
      await q(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS tipo_agencia TEXT NOT NULL DEFAULT ''`);
    }
    // Cortesías ("El valor de nuestros servicios"): unas se cobran (van a la proforma) y otras son gratis.
    await q(`CREATE TABLE IF NOT EXISTS op_cortesias (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, precio NUMERIC NOT NULL DEFAULT 0,
      cobra BOOLEAN NOT NULL DEFAULT FALSE, por_persona BOOLEAN NOT NULL DEFAULT FALSE, activo BOOLEAN NOT NULL DEFAULT TRUE, orden INTEGER NOT NULL DEFAULT 0, notas TEXT NOT NULL DEFAULT '')`);
    // Tarifarios que el programador sube en la Oficina (Base del asistente → 💲 Tarifarios): llegan aquí y se cargan en los precios.
    await q(`CREATE TABLE IF NOT EXISTS op_cuentas_pago (id SERIAL PRIMARY KEY, tipo TEXT NOT NULL DEFAULT 'otro', nombre TEXT NOT NULL, titular TEXT NOT NULL DEFAULT '', cuenta_fin TEXT NOT NULL DEFAULT '', numero_enc TEXT, detalle TEXT NOT NULL DEFAULT '', activa BOOLEAN NOT NULL DEFAULT TRUE, creado TIMESTAMP NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS op_pagos (id SERIAL PRIMARY KEY, reserva TEXT NOT NULL, monto NUMERIC NOT NULL, moneda TEXT NOT NULL DEFAULT 'US$', metodo TEXT NOT NULL DEFAULT 'Otro', cuenta_id INTEGER, referencia TEXT NOT NULL DEFAULT '', fecha DATE, voucher_ruta TEXT, voucher_nombre TEXT, voucher_hash TEXT, estado TEXT NOT NULL DEFAULT 'por_verificar', registrado_por TEXT NOT NULL DEFAULT '', verificado_por TEXT, verificado_en TIMESTAMP, nota TEXT NOT NULL DEFAULT '', creado TIMESTAMP NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS archivo_reservas (reserva_id INTEGER PRIMARY KEY, anio INTEGER NOT NULL DEFAULT 0, cliente TEXT NOT NULL DEFAULT '', agencia TEXT NOT NULL DEFAULT '', buscable TEXT NOT NULL DEFAULT '', fecha_servicio TEXT NOT NULL DEFAULT '', total NUMERIC NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, huella TEXT NOT NULL, snapshot JSONB NOT NULL, creado TIMESTAMP NOT NULL DEFAULT NOW(), actualizado TIMESTAMP NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS archivo_reservas_versiones (id SERIAL PRIMARY KEY, reserva_id INTEGER NOT NULL, version INTEGER NOT NULL, huella TEXT NOT NULL, snapshot JSONB NOT NULL, cambios TEXT NOT NULL DEFAULT '', creado TIMESTAMP NOT NULL DEFAULT NOW(), UNIQUE (reserva_id, version))`);
    await q(`CREATE INDEX IF NOT EXISTS archivo_reservas_anio ON archivo_reservas (anio)`);
    await q(`CREATE TABLE IF NOT EXISTS op_lugares (texto TEXT PRIMARY KEY, lat DOUBLE PRECISION, lng DOUBLE PRECISION, creado TIMESTAMP NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS op_rutas (clave TEXT PRIMARY KEY, km NUMERIC NOT NULL, minutos NUMERIC NOT NULL, geometria JSONB NOT NULL, creado TIMESTAMP NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS op_cola_tarifarios (id SERIAL PRIMARY KEY, origen_id INTEGER, archivo TEXT NOT NULL, datos BYTEA,
      estado VARCHAR(12) NOT NULL DEFAULT 'pendiente', resultado JSONB, creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), procesado TIMESTAMPTZ)`);
    await q(`CREATE TABLE IF NOT EXISTS op_servicio_cortesias (id SERIAL PRIMARY KEY, op_id INTEGER NOT NULL, cortesia_id INTEGER, nombre TEXT NOT NULL,
      cantidad INTEGER NOT NULL DEFAULT 1, precio NUMERIC NOT NULL DEFAULT 0, cobra BOOLEAN NOT NULL DEFAULT FALSE, creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q('CREATE INDEX IF NOT EXISTS op_servicio_cortesias_op ON op_servicio_cortesias (op_id)');
    await q('ALTER TABLE op_servicios ADD COLUMN IF NOT EXISTS extras NUMERIC NOT NULL DEFAULT 0');
    if (!(await client.query('SELECT 1 FROM op_cortesias LIMIT 1')).rowCount) {
      const ej = [['Bebida de bienvenida', 0, false, true], ['Toallitas frías', 0, false, true], ['Asistencia con el equipaje', 0, false, false], ['Silla de bebé', 0, false, false],
        ['Parada en el supermercado', 10, true, false], ['Botella de champaña', 25, true, false], ['Espera extra (por hora)', 15, true, false]];
      let i = 0;
      for (const [nombre, precio, cobra, porPersona] of ej) await client.query('INSERT INTO op_cortesias (nombre, precio, cobra, por_persona, orden) VALUES ($1,$2,$3,$4,$5)', [nombre, precio, cobra, porPersona, i++]);
    }
    const def = async (clave, valor) => client.query('INSERT INTO op_config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING', [clave, JSON.stringify(valor)]);
    // Documento del 13-nov-2026: base doble confirmada y privado por trayecto. Se aplica una sola vez a las reglas ya guardadas.
    if (!(await client.query("SELECT 1 FROM op_config WHERE clave = 'migr_doc_nov26'")).rowCount) {
      const g = (await client.query("SELECT valor FROM op_config WHERE clave = 'reglas'")).rows[0];
      if (g) await client.query("UPDATE op_config SET valor = $1 WHERE clave = 'reglas'", [JSON.stringify({ ...g.valor, base_doble_un_pax: true, privado_por_trayecto: true })]);
      // Cortesías del documento (las que falten).
      const cort = [['Renta silla de bebé (por trayecto)', 0, false, false], ['Sim card con internet ilimitado (5 días)', 0, false, true], ['Botella extra de mamajuana (125 ml)', 0, false, false],
        ['Cerveza Presidente en lata (273 ml)', 0, false, true], ['Champagne Moët (750 ml)', 0, false, false], ['Champagne JP Chenet (750 ml)', 0, false, false],
        ['Ron Barceló (705 ml)', 0, false, false], ['Café Santo Domingo (1/2 lb)', 0, false, false], ['Bizcocho de cumpleaños (1/2 lb)', 0, false, false]];
      let orden = Number((await client.query('SELECT COALESCE(MAX(orden), 0) AS m FROM op_cortesias')).rows[0].m) + 1;
      for (const [nombre, precio, cobra, porPersona] of cort) await client.query('INSERT INTO op_cortesias (nombre, precio, cobra, por_persona, orden) SELECT $1::text, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM op_cortesias WHERE lower(nombre) = lower($1::text))', [nombre, precio, cobra, porPersona, orden++]);
      await client.query("INSERT INTO op_config (clave, valor) VALUES ('migr_doc_nov26', 'true')");
    }
    await def('publico', false);
    await def('modulos', MODULOS_INICIALES);
    await def('reglas', REGLAS_INICIALES);
    await def('plantillas', PLANTILLAS_INICIALES);
    await def('whatsapp', WHATSAPP_INICIAL);
    await def('vuelos', VUELOS_INICIAL);
    // Las agencias sin modalidad propia usan la de la empresa (Reglas → regular por defecto).
    await q("ALTER TABLE op_agencias ALTER COLUMN modalidad SET DEFAULT ''");
    if (!(await cfg('migr_modalidad', false))) { await q("UPDATE op_agencias SET modalidad = '' WHERE modalidad = 'privado'"); await guardarCfg('migr_modalidad', true); }
    await cargarDatosIniciales();
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
    return { nombre: a ? a.nombre : (base || 'Sin agencia'), id: a ? a.id : null, modalidad: a ? a.modalidad : '', tarifario_id: a ? a.tarifario_id : null, mercado: a ? a.mercado : '', tipo_agencia: a ? a.tipo_agencia : '' };
  }
  const paxDe = s => ({ adultos: entero(s.adultos), ninos: entero(s.ninos), infantes: entero(s.infantes) });
  const paxTotal = s => entero(s.adultos) + entero(s.ninos) + entero(s.infantes);

  // Hora de recogida y bloque de tiempo que ocupa el servicio (para avisar choques).
  function tiempos(s, op, reglas, zona) {
    const t = tipoDe(s, op);
    const h = minutos(op && op.vuelo && op.vuelo.hora_estimada ? op.vuelo.hora_estimada : s.hora_servicio);
    const tz = { ...REGLAS_INICIALES.tiempos_zona, ...(reglas.tiempos_zona || {}) };
    const clave = Object.keys(tz).find(k => norm(k) === norm(zona));
    const viaje = Number(clave ? tz[clave] : 0) || Number(reglas.duracion_traslado_min) || 60;
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
    // Por mercado (país) y tipo de agencia: el más específico que encaje; si no, el general.
    return (await client.query(`SELECT * FROM op_tarifarios WHERE tipo = 'venta' AND agencia_id IS NULL AND activo
        AND (mercado = '' OR lower(mercado) = lower($1)) AND (tipo_agencia = '' OR lower(tipo_agencia) = lower($2))
      ORDER BY (mercado <> '')::int + (tipo_agencia <> '')::int DESC, id LIMIT 1`, [(agencia && agencia.mercado) || '', (agencia && agencia.tipo_agencia) || ''])).rows[0] || null;
  }
  // Todos los tarifarios de venta que le tocan a una agencia, del más específico al general:
  // el propio de la agencia → mercado + tipo (mayorista/minorista) → solo mercado → solo tipo → general.
  async function tarifariosVenta(agencia) {
    const todos = (await client.query("SELECT * FROM op_tarifarios WHERE tipo = 'venta' AND activo ORDER BY id")).rows;
    const lista = [];
    if (agencia && agencia.tarifario_id) lista.push(...todos.filter(t => t.id === agencia.tarifario_id));
    if (agencia && agencia.id) lista.push(...todos.filter(t => t.agencia_id === agencia.id));
    const m = norm(agencia && agencia.mercado), tp = norm(agencia && agencia.tipo_agencia);
    const enMercado = t => !t.mercado || String(t.mercado).split(',').some(x => norm(x) === m);
    const puntos = t => (t.mercado ? 2 : 0) + (t.tipo_agencia ? 1 : 0);
    lista.push(...todos.filter(t => !t.agencia_id && enMercado(t) && (!t.tipo_agencia || norm(t.tipo_agencia) === tp)).sort((a, b) => puntos(b) - puntos(a)));
    return [...new Map(lista.map(t => [t.id, t])).values()];
  }
  // Busca la tarifa que mejor encaja: tipo, nombre (tours/entradas), aeropuerto, zona, modalidad, pax, temporada.
  function mejorTarifa(tarifas, { tipo, nombre, aeropuerto, zona, origen, modalidad, pax, fecha }) {
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
      if (t.origen) { if (norm(t.origen) !== norm(origen)) continue; p += 3; }
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
    return dinero(conNocturno(v, t, hora));
  }
  function describir(t) {
    if (!t) return '';
    const partes = [t.servicio, t.nombre, t.aeropuerto, t.origen ? t.origen + ' →' : '', t.zona, t.modalidad, `${t.pax_desde}-${t.pax_hasta} pax`].filter(Boolean);
    return partes.join(' · ') + (t.cobro === 'persona' ? ` · ad ${num(t.precio_adulto)} / niño ${num(t.precio_nino)}` : ` · ${num(t.precio_vehiculo)} por vehículo`);
  }
  // ¿La reserva tiene la llegada y la salida del mismo pasajero? Entonces es un paquete In/Out.
  async function parejaInOut(s, tipo) {
    if (!s.message_id || !['IN', 'OUT'].includes(tipo)) return false;
    const otros = (await client.query("SELECT * FROM clasificacion WHERE message_id = $1 AND id <> $2 AND NOT COALESCE(error_ia, FALSE)", [s.message_id, s.id || s.sid])).rows;
    const nombre = norm(s.nombre_cliente);
    return otros.some(o => tipoDe(o) === (tipo === 'IN' ? 'OUT' : 'IN') && !/^\s*CANCELAD/i.test(o.motivo || '') && (!nombre || !norm(o.nombre_cliente) || norm(o.nombre_cliente) === nombre));
  }
  const conNocturno = (v, t, hora) => {
    const h = minutos(hora), d = minutos(t.nocturno_desde), a = minutos(t.nocturno_hasta);
    return num(t.nocturno_pct) && h !== null && d !== null && a !== null && (d <= a ? h >= d && h < a : h >= d || h < a) ? v * (1 + num(t.nocturno_pct) / 100) : v;
  };
  // Una sola vía con la tarifa In/Out: mitad redondeada hacia arriba; todos los pasajeros cuentan como adulto.
  function importeUnaVia(t, pax, hora) {
    const v = t.cobro === 'persona'
      ? (pax.adultos + pax.ninos) * Math.ceil(num(t.precio_adulto) / 2) + pax.infantes * Math.ceil(num(t.precio_infante) / 2)
      : Math.ceil(num(t.precio_vehiculo) / 2);
    return dinero(conNocturno(v, t, hora));
  }
  // ¿El texto o la zona están en una lista de zonas separadas por coma ("Punta Cana, Bávaro")?
  const enZonas = (lista, ...textos) => { const zs = String(lista || '').split(',').map(norm).filter(Boolean); return textos.some(t => { const n = norm(t); return n && zs.some(z => n === z || n.includes(z)); }); };
  const esPuerto = (texto, zona) => norm(zona) === norm('Puerto La Romana') || /puerto de |\bport\b|muelle|crucero|cruise|sans souci|terminal de cruceros/i.test(String(texto || ''));
  const dentroHorario = (hora, desde, hasta) => { const h = minutos(hora), d = minutos(desde), a = minutos(hasta); return h === null || d === null || a === null || (h >= d && h < a); };
  function avisoPuerto(s, reglas) {
    const r = reglas || REGLAS_INICIALES;
    if (!num(r.cargo_puerto_pp)) return '';
    return [s.hotel, s.punto_partida, s.punto_llegada, s.desde, s.hasta, s.zona].some(t => esPuerto(t, t)) ? `Cargo de acceso de USD ${num(r.cargo_puerto_pp)} por pasajero, pagadero directamente en el puerto y no incluido en la tarifa.` : '';
  }
  // Precio de venta y costo de un servicio de la bandeja.
  async function calcularPrecio(s, op, ctx) {
    const lista = ctx.hoteles || await hoteles();
    const reglas = ctx.reglas || await cfg('reglas', REGLAS_INICIALES);
    const agencia = ctx.agencia || agenciaDe(s, ctx.agencias || await agencias());
    const tipo = tipoDe(s);
    // Zona del hotel (lista de hoteles); si no está, por el nombre de la zona escrito en la reserva.
    const zonaTexto = t => zonaDe(t, lista) || importador.zonaConocida(t);
    const zona = tipo === 'INTERHOTEL' ? zonaTexto(s.punto_llegada || s.actividad || s.hotel) : zonaTexto(tipo === 'OUT' ? (s.hotel || s.punto_partida) : (s.hotel || s.punto_llegada));
    const origen = tipo === 'INTERHOTEL' ? zonaTexto(s.punto_partida || s.hotel) : '';
    const texto = [s.motivo, s.actividad, s.asunto, s.nota].join(' ');
    const pideCompartido = /compartid|shared|regular|colectiv/i.test(texto);
    let modalidad = pideCompartido ? 'compartido' : /luxury|lujo|vip/i.test(texto) && tipo !== 'ACTIVIDAD' ? 'luxury' : /privad|private/i.test(texto) ? 'privado' : agencia.modalidad || reglas.modalidad_defecto || 'compartido';
    // Reglas de zonas: Santo Domingo (y vuelos por SDQ) siempre privado; puertos privado salvo orden (la reserva dice compartido);
    // el compartido solo existe en las zonas habilitadas.
    let porRegla = '';
    if (['IN', 'OUT', 'INTERHOTEL'].includes(tipo) && modalidad === 'compartido') {
      const lugares = [s.hotel, s.punto_partida, s.punto_llegada].join(' ');
      if (enZonas(reglas.zonas_privado, zona, origen) || (enZonas(reglas.zonas_privado, 'Santo Domingo') && aeropuertoDe(s.aeropuerto) === 'SDQ')) { modalidad = 'privado'; porRegla = 'Santo Domingo: siempre privado'; }
      else if (reglas.puertos_privado !== false && !pideCompartido && esPuerto(lugares, zona)) { modalidad = 'privado'; porRegla = 'puerto: privado'; }
      else if (String(reglas.zonas_compartido || '').trim() && zona && !(enZonas(reglas.zonas_compartido, zona) && (tipo !== 'INTERHOTEL' || !origen || enZonas(reglas.zonas_compartido, origen)))) { modalidad = 'privado'; porRegla = `${zona}: sin compartido`; }
    }
    const fecha = (op && op.fecha) || fechaServicioISO(s.fecha_servicio, s.fecha) || '';
    const pax = paxDe(s), total = paxTotal(s) || 1;
    const filtro = { tipo, nombre: s.actividad || '', aeropuerto: aeropuertoDe(s.aeropuerto), zona, origen, modalidad, pax: total, fecha };
    const tvs = await tarifariosVenta(agencia);
    const porTarifario = new Map();
    for (const tv of tvs) porTarifario.set(tv.id, await tarifasDe(tv.id));
    // Primera tarifa que encaje, del tarifario más específico al general.
    const buscar = f => { for (const tv of tvs) { const t = mejorTarifa(porTarifario.get(tv.id), f); if (t) return { t, tv }; } return null; };
    const traslado = ['IN', 'OUT', 'INTERHOTEL'].includes(tipo);
    const exentaDoble = enZonas(reglas.base_doble_excepciones, agencia.nombre, s.agencia);
    const doble = traslado && reglas.base_doble_un_pax && !exentaDoble && pax.adultos + pax.ninos === 1;
    // El privado nunca lleva recargo nocturno: se calcula sin hora.
    const horaDe = f => (f.modalidad === 'privado' ? null : s.hora_servicio);
    const pareja = await parejaInOut(s, tipo);
    function precioCon(f) {
      // 1. Paquete conjunto (llegada + salida en la misma reserva): precio In/Out, mitad en cada tramo.
      if (pareja) {
        const r = buscar({ ...f, tipo: 'INOUT' });
        if (r) {
          const todo = importe(r.t, pax, horaDe(f)) * (doble ? 2 : 1), mitad = Math.ceil(todo / 2);
          return { precio: dinero(tipo === 'IN' ? mitad : todo - mitad), etiqueta: `${r.tv.nombre}: In/Out (paquete) ${dinero(todo)} · mitad en la llegada y mitad en la salida · ${describir(r.t)}${doble ? ' · base doble (1 pax)' : ''}` };
        }
      }
      // 2. Tarifa propia del servicio (traslado privado por ruta, inter-hotel, tour...).
      const r = buscar(f);
      if (r) {
        let precio = importe(r.t, pax, horaDe(f)), extra = '';
        if (r.t.cobro === 'vehiculo' && String(r.t.servicio).toUpperCase() === 'TRASLADO' && reglas.privado_por_trayecto === false && ['IN', 'OUT'].includes(tipo)) { precio = dinero(Math.ceil(precio / 2)); extra = ' · mitad (la tarifa es ida y vuelta)'; }
        return { precio, etiqueta: `${r.tv.nombre}: ${describir(r.t)}${extra}` };
      }
      // 3. Una sola vía sin tarifa propia: mitad del In/Out de adulto, redondeada hacia arriba (todos como adulto).
      if (traslado && reglas.una_via_mitad_inout !== false) {
        const r2 = buscar({ ...f, tipo: 'INOUT' });
        if (r2) return { precio: importeUnaVia(r2.t, pax, horaDe(f)), etiqueta: `${r2.tv.nombre}: una sola vía = mitad del In/Out redondeada hacia arriba (todos como adulto) · ${describir(r2.t)}` };
      }
      return null;
    }
    let res = precioCon(filtro), modalidadFinal = modalidad;
    if (res && porRegla) res.etiqueta += ' · ' + porRegla;
    // Si no hay tarifa regular para esa ruta (en el tarifario sale X o 0), se cotiza privado.
    if (!res && modalidad === 'compartido' && traslado) { res = precioCon({ ...filtro, modalidad: 'privado' }); if (res) { res.etiqueta += ' · no hay regular para esta ruta: privado'; modalidadFinal = 'privado'; } }
    let precio = res ? res.precio : null, etiqueta = res ? res.etiqueta : '';
    // 4. Base doble en una sola vía (en el paquete ya se aplicó al total).
    if (precio !== null && doble && !/In\/Out \(paquete\)/.test(etiqueta)) { precio = dinero(precio * 2); etiqueta += ' · base doble (1 pax)'; }
    if (precio !== null && traslado && exentaDoble && pax.adultos + pax.ninos === 1 && reglas.base_doble_un_pax) etiqueta += ' · sin base doble (excepción de la agencia)';
    // 5. Compartido fuera de horario: suplemento fijo por vehículo y por trayecto (llegada: hora del vuelo; salida: hora de recogida en el hotel).
    if (precio !== null && traslado && modalidadFinal === 'compartido' && num(reglas.suplemento_fuera_horario)) {
      const hora = tipo === 'OUT' ? (op && op.recogida) || tiempos(s, op, reglas, zona).recogida : s.hora_servicio;
      if (hora && !dentroHorario(hora, reglas.horario_desde || '09:00', reglas.horario_hasta || '19:00')) {
        precio = dinero(precio + num(reglas.suplemento_fuera_horario));
        etiqueta += ` · fuera de horario (${tipo === 'OUT' ? 'recogida' : 'vuelo'} ${hora}) +${num(reglas.suplemento_fuera_horario)}`;
      }
    }
    // Correo de Viator con un solo servicio: lo que se cobra es el monto que paga Viator (manda sobre el tarifario).
    if (s.cuerpo && /Viator amount/i.test(s.cuerpo)) {
      const m = String(s.cuerpo).match(/Viator amount\s*:?\s*(?:USD|US\$|\$)?\s*([0-9][0-9.,]*)/i);
      const solo = !s.message_id || Number((await client.query('SELECT COUNT(*)::int AS n FROM clasificacion WHERE message_id = $1', [s.message_id])).rows[0].n) <= 1;
      if (m && solo) { const antes = etiqueta; precio = dinero(Number(m[1].replace(/,/g, ''))); etiqueta = 'Monto de Viator (lo que paga Viator por esta reserva)' + (antes ? ` · el tarifario decía: ${antes}` : ''); }
    }
    const tv = tvs[0] || null;
    let costo = null, tc = null, tCosto = '';
    if (op && op.proveedor_id) {
      tc = (await client.query("SELECT * FROM op_tarifarios WHERE proveedor_id = $1 AND tipo = 'costo' AND activo ORDER BY id DESC LIMIT 1", [op.proveedor_id])).rows[0];
      const t = tc ? mejorTarifa(await tarifasDe(tc.id), filtro) : null;
      costo = importe(t, pax, s.hora_servicio); tCosto = t ? `${tc.nombre}: ${describir(t)}` : '';
    } else if (op && op.chofer_id) {
      const ch = (await client.query('SELECT nombre, pago_servicio FROM op_choferes WHERE id = $1', [op.chofer_id])).rows[0];
      if (ch && num(ch.pago_servicio)) { costo = dinero(ch.pago_servicio); tCosto = `Pago al chofer ${ch.nombre}`; }
    }
    // Tours sin proveedor asignado: costo estimado con los netos generales (lo que paga Somos Viaje).
    if (costo === null && tipo === 'ACTIVIDAD') {
      const generales = (await client.query("SELECT * FROM op_tarifarios WHERE tipo = 'costo' AND proveedor_id IS NULL AND activo ORDER BY id")).rows;
      for (const g of generales) { const t = mejorTarifa(await tarifasDe(g.id), { ...filtro, modalidad: '' }); if (t) { costo = importe(t, pax, s.hora_servicio); tCosto = `Estimado · ${g.nombre}: ${describir(t)}`; break; } }
    }
    return { precio, tarifa_venta: etiqueta || (tv ? `Sin tarifa para este servicio${agencia.mercado ? '' : ' · ¿la agencia tiene mercado?'} (${zona || 'zona desconocida'}${filtro.aeropuerto ? ' · ' + filtro.aeropuerto : ''})` : 'Sin tarifario: pon el mercado de la agencia o crea un tarifario general'),
      costo, tarifa_costo: tCosto, zona, modalidad: modalidadFinal, agencia, aviso: avisoPuerto({ ...s, zona }, reglas) };
  }

  // ---------- Archivo de reservas: copia de cada reserva con su historial de versiones. Nunca se borra nada. ----------
  const CATEGORIAS_ARCHIVO = ['RESERVA', 'MODIFICACION'];
  function diferencias(a, b) {
    const claves = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    return [...claves].filter(k => JSON.stringify((a || {})[k]) !== JSON.stringify((b || {})[k])).join(', ');
  }
  // Guarda la reserva tal como está ahora. Si no cambió desde la última copia, no hace nada.
  async function archivarReservas(ids) {
    if (!ids || !ids.length) return 0;
    const filas = (await client.query('SELECT c.* FROM clasificacion c WHERE c.id = ANY($1::int[]) AND c.categoria = ANY($2::text[]) ORDER BY c.id', [ids, CATEGORIAS_ARCHIVO])).rows;
    let guardadas = 0;
    for (const c of filas) {
      const servicios = (await client.query(`SELECT o.id, o.estado, o.fecha, o.hora, o.precio, o.costo, ch.nombre AS chofer, v.nombre AS vehiculo, pr.nombre AS proveedor
        FROM op_servicios o LEFT JOIN op_choferes ch ON ch.id = o.chofer_id LEFT JOIN op_vehiculos v ON v.id = o.vehiculo_id LEFT JOIN op_proveedores pr ON pr.id = o.proveedor_id
        WHERE o.servicio_id = $1 ORDER BY o.id`, [c.id])).rows.map(s => ({ ...s, precio: s.precio === null ? null : Number(s.precio), costo: s.costo === null ? null : Number(s.costo) }));
      const snap = { reserva: c.id, recibido: c.creado, buzon: c.buzon || '', remitente: c.remitente || '', asunto: c.asunto || '', categoria: c.categoria || '', estado_correo: c.estado || '', agencia: c.agencia || '', cliente: c.nombre_cliente || '', telefono: c.telefono || '', tipo: c.tipo_servicio || '', fecha_servicio: c.fecha_servicio || '', hora: c.hora_servicio || '', hotel: c.hotel || '', desde: c.punto_partida || '', hasta: c.punto_llegada || '', vuelo: c.vuelo || '', aeropuerto: c.aeropuerto || '', actividad: c.actividad || '', adultos: c.adultos || 0, ninos: c.ninos || 0, infantes: c.infantes || 0, servicios };
      const huella = crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');
      const anio = Number((String(c.fecha_servicio || '').match(/\d{4}/) || [])[0]) || new Date(c.creado).getFullYear();
      const total = servicios.reduce((s, x) => s + (x.precio || 0), 0);
      const buscable = [c.nombre_cliente, c.agencia, c.hotel, c.vuelo, c.asunto, c.remitente, c.punto_partida, c.punto_llegada, String(c.id)].filter(Boolean).join(' | ').toLowerCase();
      const previa = (await client.query('SELECT version, huella, snapshot FROM archivo_reservas WHERE reserva_id = $1', [c.id])).rows[0];
      if (!previa) {
        await client.query('INSERT INTO archivo_reservas (reserva_id, anio, cliente, agencia, buscable, fecha_servicio, total, version, huella, snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9)', [c.id, anio, snap.cliente, snap.agencia, buscable, snap.fecha_servicio, total, huella, JSON.stringify(snap)]);
        await client.query('INSERT INTO archivo_reservas_versiones (reserva_id, version, huella, snapshot, cambios) VALUES ($1,1,$2,$3,$4)', [c.id, huella, JSON.stringify(snap), 'Primera copia en el archivo']);
        guardadas++;
      } else if (previa.huella !== huella) {
        const version = previa.version + 1;
        const cambios = diferencias(previa.snapshot, snap);
        await client.query('UPDATE archivo_reservas SET anio=$2, cliente=$3, agencia=$4, buscable=$5, fecha_servicio=$6, total=$7, version=$8, huella=$9, snapshot=$10, actualizado=NOW() WHERE reserva_id=$1', [c.id, anio, snap.cliente, snap.agencia, buscable, snap.fecha_servicio, total, version, huella, JSON.stringify(snap)]);
        await client.query('INSERT INTO archivo_reservas_versiones (reserva_id, version, huella, snapshot, cambios) VALUES ($1,$2,$3,$4,$5)', [c.id, version, huella, JSON.stringify(snap), 'Cambió: ' + cambios]);
        guardadas++;
      }
    }
    return guardadas;
  }
  // Reservas que todavía no están en el archivo, y las de los últimos 3 días (por si cambiaron).
  async function archivarPendientes() {
    const ids = (await client.query(`SELECT c.id FROM clasificacion c WHERE c.categoria = ANY($1::text[]) AND NOT COALESCE(c.error_ia, FALSE)
      AND (c.creado > NOW() - INTERVAL '3 days' OR NOT EXISTS (SELECT 1 FROM archivo_reservas a WHERE a.reserva_id = c.id))
      ORDER BY c.id LIMIT 400`, [CATEGORIAS_ARCHIVO])).rows.map(x => x.id);
    return archivarReservas(ids);
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
      await archivarPendientes().catch(e => console.log('Archivo de reservas:', e.message));
      ultimaSync = Date.now();
    })().finally(() => { sincronizando = null; });
    return sincronizando;
  }
  function haceDias(n) { const d = new Date(hoyLocal() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
  function masDias(f, n) { const d = new Date((f || hoyLocal()) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

  // ---------- lista del día ----------
  async function listar({ fecha, sede, desde, hasta, sinFecha, grupoDe }) {
    await sincronizar();
    const reglas = await cfg('reglas', REGLAS_INICIALES), lista = await hoteles();
    const params = [], cond = [];
    // Todos los servicios de la misma reserva (mismo correo) que el servicio grupoDe: para la proforma y los vouchers.
    if (grupoDe) { params.push(Number(grupoDe)); cond.push(`(c.id = (SELECT servicio_id FROM op_servicios WHERE id = $1) OR (c.message_id IS NOT NULL AND c.message_id <> '' AND c.message_id = (SELECT c2.message_id FROM op_servicios o2 JOIN clasificacion c2 ON c2.id = o2.servicio_id WHERE o2.id = $1)))`); }
    else if (sinFecha) cond.push("o.fecha = '' AND o.estado <> 'cancelado'");
    else if (desde || hasta) { params.push(desde || '0000'); cond.push(`o.fecha >= $${params.length}`); params.push(hasta || '9999'); cond.push(`o.fecha <= $${params.length}`); }
    else { params.push(fecha || hoyLocal()); cond.push(`o.fecha = $${params.length}`); }
    if (sede) { params.push(sede); cond.push(`o.sede = $${params.length}`); }
    const filas = (await client.query(`SELECT o.*, o.vuelo AS vuelo_vivo, c.id AS sid, c.message_id, c.categoria, c.tipo_servicio, c.nombre_cliente, c.hora_servicio, c.vuelo, c.hotel, c.punto_partida,
        c.punto_llegada, c.fecha_servicio, c.adultos, c.ninos, c.infantes, c.aeropuerto, c.actividad, c.telefono, c.motivo, c.asunto, c.remitente,
        ${viator.SQL},
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
        entrada_codigos: s.entrada_codigos, extras: Number(s.extras) || 0, grupo: s.message_id || 'id:' + s.sid, cortesias: [], viator: viator.detalles(s)
      };
    });
    if (servicios.length) {
      const cs = (await client.query('SELECT * FROM op_servicio_cortesias WHERE op_id = ANY($1::int[]) ORDER BY id', [servicios.map(x => x.id)])).rows;
      for (const c of cs) { const x = servicios.find(y => y.id === c.op_id); if (x) x.cortesias.push({ id: c.id, nombre: c.nombre, cantidad: c.cantidad, precio: Number(c.precio), cobra: c.cobra, total: dinero(Number(c.precio) * c.cantidad) }); }
    }
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

  // ---------- cortesías de un servicio ----------
  async function totalExtras(opId) {
    await client.query('UPDATE op_servicios SET extras = COALESCE((SELECT SUM(precio * cantidad) FROM op_servicio_cortesias WHERE op_id = $1 AND cobra), 0) WHERE id = $1', [opId]);
  }
  async function agregarCortesia(u, f) {
    const opId = Number(f.id);
    const c = (await client.query('SELECT * FROM op_cortesias WHERE id = $1', [Number(f.cortesia_id)])).rows[0];
    if (!c) throw error('Elige la cortesía.');
    const o = (await client.query('SELECT c.adultos, c.ninos, c.infantes FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id WHERE o.id = $1', [opId])).rows[0];
    if (!o) throw error('No existe ese servicio.', 404);
    const cantidad = Math.max(1, entero(f.cantidad) || (c.por_persona ? paxTotal(o) || 1 : 1));
    await client.query('INSERT INTO op_servicio_cortesias (op_id, cortesia_id, nombre, cantidad, precio, cobra) VALUES ($1,$2,$3,$4,$5,$6)', [opId, c.id, c.nombre, cantidad, num(c.precio), c.cobra]);
    await totalExtras(opId);
    await evento(opId, 'cortesia', `Cortesía: ${c.nombre} ×${cantidad}${c.cobra ? ' · ' + dinero(num(c.precio) * cantidad) : ' (sin costo)'}`, u.usuario);
    return { ok: true };
  }
  async function quitarCortesia(u, f) {
    const r = (await client.query('DELETE FROM op_servicio_cortesias WHERE id = $1 RETURNING op_id, nombre', [Number(f.id)])).rows[0];
    if (!r) throw error('No existe esa cortesía.', 404);
    await totalExtras(r.op_id);
    await evento(r.op_id, 'cortesia', `Cortesía quitada: ${r.nombre}`, u.usuario);
    return { ok: true };
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
        [`${u.nombre || u.usuario} (manual)`, `Reserva manual${f.canal ? ' (' + txt(f.canal, 40) + ')' : ''} · ${cliente}${f.referencia ? ' · ' + txt(f.referencia, 60) : ''}`, new Date().toISOString(), mid, agencia, tipo, txt(s.pasajero, 200) || cliente,
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
      g.servicios++; g.pax += paxTotal(s); g.venta += (Number(s.precio) || 0) + (Number(s.extras) || 0); g.costo += Number(s.costo) || 0; if (s.precio === null) g.sin_precio++;
      if (!clave || clave === k) g.detalle.push({ fecha: s.fecha, reserva: s.servicio_id, cliente: s.nombre_cliente, servicio: tipoDe(s) === 'ACTIVIDAD' ? s.actividad : `${tipoDe(s)} ${s.vuelo || ''} ${s.hotel || ''}`.trim(),
        pax: paxTotal(s), precio: s.precio === null ? null : dinero(Number(s.precio) + (Number(s.extras) || 0)), costo: s.costo === null ? null : Number(s.costo), agencia: s.agencia, proveedor: s.proveedor || s.chofer || '', estado: NOMBRE_ESTADO[s.estado] });
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
    const llave = await llaveDeOficina('api_vuelos');
    if (!llave) throw error(`Falta la llave de ${prov === 'flightaware' ? 'FlightAware' : 'AeroDataBox'}: se pone en Oficina → APIs y suscripciones.`);
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
    agencias: { tabla: 'op_agencias', campos: { nombre: 'txt', alias: 'txt', tarifario_id: 'id', mercado: 'txt', tipo_agencia: 'txt', modalidad: 'txt', contacto: 'txt', telefono: 'txt', email: 'txt', activo: 'bool', notas: 'txt' } },
    hoteles: { tabla: 'op_hoteles', campos: { hotel: 'txt', zona: 'txt', sede: 'txt' } },
    tarifarios: { tabla: 'op_tarifarios', campos: { nombre: 'txt', tipo: 'txt', agencia_id: 'id', proveedor_id: 'id', mercado: 'txt', tipo_agencia: 'txt', moneda: 'txt', activo: 'bool', notas: 'txt' } },
    tarifas: { tabla: 'op_tarifas', campos: { tarifario_id: 'id', servicio: 'txt', nombre: 'txt', aeropuerto: 'txt', origen: 'txt', zona: 'txt', modalidad: 'txt', cobro: 'txt', pax_desde: 'int', pax_hasta: 'int',
      precio_vehiculo: 'num', precio_adulto: 'num', precio_nino: 'num', precio_infante: 'num', desde: 'fecha', hasta: 'fecha', nocturno_pct: 'num', nocturno_desde: 'hora', nocturno_hasta: 'hora', notas: 'txt' } },
    cortesias: { tabla: 'op_cortesias', campos: { nombre: 'txt', precio: 'num', cobra: 'bool', por_persona: 'bool', activo: 'bool', orden: 'int', notas: 'txt' } },
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

  // ---------- Excel de Somos Viaje (tarifarios por mercado, actividades, hoteles, agregados) ----------
  async function importarSomos(u, archivo, buf) {
    if (!buf.length || buf.length > 20 * 1024 * 1024) throw error('Sube un Excel (.xlsx) de menos de 20 MB.');
    const r = await importador.importar(txt(archivo, 200) || 'archivo.xlsx', buf);
    cacheHoteles.t = 0; cacheAgencias.t = 0;
    if (u) await registrar(u, 'op_importar', 'tarifario', '', '', txt(archivo, 120), JSON.stringify(r).slice(0, 300));
    return r;
  }
  // Una sola vez al instalar: carga lo que venga en datos-iniciales/operaciones (Excel + catalogo.json). Nunca está en el repositorio.
  async function cargarDatosIniciales() {
    const dir = path.join(__dirname, '..', 'datos-iniciales', 'operaciones');
    // Hoteles y zonas del documento de Somos Viaje (una vez): agrega los que falten, con su zona.
    const hz = path.join(dir, 'hoteles-zonas.json');
    if (fs.existsSync(hz) && !(await cfg('semilla_hoteles_zonas', false))) {
      try {
        const lista = JSON.parse(fs.readFileSync(hz, 'utf8')).hoteles || [];
        const vistos = new Map(); let n = 0;
        for (const [hotel, zonaTxt] of lista) {
          const zona = importador.zonaCanonica(zonaTxt);
          let nombre = String(hotel).trim();
          if (vistos.has(norm(nombre)) && vistos.get(norm(nombre)) !== zona) nombre = `${nombre} (${zona})`;
          vistos.set(norm(nombre), zona);
          const r = await client.query('INSERT INTO op_hoteles (hotel, zona, sede) SELECT $1::text, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM op_hoteles WHERE lower(hotel) = lower($1::text))', [nombre, zona, 'Punta Cana']);
          n += r.rowCount;
        }
        cacheHoteles.t = 0;
        await guardarCfg('semilla_hoteles_zonas', { fecha: new Date().toISOString(), agregados: n });
        console.log(`Operaciones: ${n} hoteles nuevos con su zona (documento de Somos Viaje).`);
      } catch (e) { console.log('Operaciones (hoteles):', e.message); }
    }
    if (!fs.existsSync(dir) || await cfg('semilla_operaciones', false)) return;
    const resumen = [];
    try {
      const archivos = fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f)).sort((a, b) => (/transfer|trasnfer/i.test(b) ? 1 : 0) - (/transfer|trasnfer/i.test(a) ? 1 : 0));
      for (const f of archivos) { try { resumen.push(await importarSomos(null, f, fs.readFileSync(path.join(dir, f)))); } catch (e) { resumen.push({ archivo: f, error: e.message }); } }
      const cat = path.join(dir, 'catalogo.json');
      if (fs.existsSync(cat)) {
        const c = JSON.parse(fs.readFileSync(cat, 'utf8'));
        for (const n of c.choferes || []) await client.query('INSERT INTO op_choferes (nombre, sede) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM op_choferes WHERE lower(nombre) = lower($1))', [n, 'Punta Cana']);
        for (const n of c.transportistas || []) await client.query("INSERT INTO op_proveedores (nombre, tipo, sede) SELECT $1, 'transportista', $2 WHERE NOT EXISTS (SELECT 1 FROM op_proveedores WHERE lower(nombre) = lower($1))", [n, 'Punta Cana']);
        for (const n of c.agencias || []) await client.query("INSERT INTO op_agencias (nombre, modalidad) SELECT $1, '' WHERE NOT EXISTS (SELECT 1 FROM op_agencias WHERE lower(nombre) = lower($1))", [n]);
        // Grupos de usuarios por perfil (se pueden cambiar en Herramientas → Grupos).
        for (const g of c.grupos || []) await client.query('INSERT INTO grupos (nombre, permisos, protegido) SELECT $1::varchar, $2::jsonb, FALSE WHERE NOT EXISTS (SELECT 1 FROM grupos WHERE nombre = $1::varchar)', [String(g.nombre).slice(0, 40), JSON.stringify(g.permisos || {})]).catch(() => {});
        resumen.push({ archivo: 'catalogo.json', choferes: (c.choferes || []).length, transportistas: (c.transportistas || []).length, agencias: (c.agencias || []).length, grupos: (c.grupos || []).length });
      }
      await guardarCfg('semilla_operaciones', { fecha: new Date().toISOString(), resumen });
      console.log('Operaciones: datos iniciales cargados:', resumen.map(r => r.archivo + (r.error ? ' (error)' : '')).join(', '));
    } catch (e) { console.error('Operaciones: no se pudieron cargar los datos iniciales:', e.message); }
  }

  // ---------- Reservas: servicios agrupados por reserva (mismo correo o misma reserva manual) ----------
  const ESTADO_RESERVA = { activa: 'Activa', completada: 'Completada', cancelada: 'Cancelada', parcial: 'Parcialmente cancelada' };
  async function listaReservas(p, conPrecios, admin = false) {
    const cond = ["c.estado = 'registrada' OR c.message_id LIKE 'manual-%'"].map(x => `(${x})`), v = [];
    const par = x => { v.push(x); return '$' + v.length; };
    const fechaOk = x => /^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : '';
    const desde = fechaOk(p.get('desde')), hasta = fechaOk(p.get('hasta')), altaDesde = fechaOk(p.get('alta_desde')), altaHasta = fechaOk(p.get('alta_hasta'));
    if (desde) cond.push(`o.fecha >= ${par(desde)}`);
    if (hasta) cond.push(`o.fecha <= ${par(hasta)}`);
    if (altaDesde) cond.push(`c.creado >= ${par(altaDesde)}::date`);
    if (altaHasta) cond.push(`c.creado < ${par(altaHasta)}::date + 1`);
    if (!desde && !hasta && !altaDesde && !altaHasta) cond.push(`(o.fecha >= ${par(masDias(hoyLocal(), -30))} OR c.creado > NOW() - INTERVAL '30 days')`);
    const agencia = txt(p.get('agencia'), 120); if (agencia) cond.push(`lower(c.agencia) = lower(${par(agencia)})`);
    const sede = txt(p.get('sede'), 60); if (sede) cond.push(`o.sede = ${par(sede)}`);
    const vuelo = txt(p.get('vuelo'), 20).replace(/\s+/g, ''); if (vuelo) cond.push(`replace(upper(c.vuelo), ' ', '') LIKE ${par(vuelo.toUpperCase() + '%')}`);
    const q = txt(p.get('q'), 120);
    if (q) { const k = par('%' + q.toLowerCase() + '%'); cond.push(`(lower(c.nombre_cliente) LIKE ${k} OR lower(c.agencia) LIKE ${k} OR lower(c.vuelo) LIKE ${k} OR lower(c.hotel) LIKE ${k} OR lower(c.asunto) LIKE ${k} OR c.id::text = ${par(q.replace(/^#/, ''))})`); }
    const filas = (await client.query(`SELECT o.id, o.servicio_id, o.estado, o.fecha, o.precio, o.costo, o.extras, o.chofer_id, o.proveedor_id, o.sede, o.costo_manual,
        c.message_id, c.creado, c.agencia, c.nombre_cliente, c.tipo_servicio, c.vuelo, c.hotel, c.hora_servicio, c.adultos, c.ninos, c.infantes, c.asunto, c.remitente,
        c.punto_partida, c.punto_llegada, c.actividad, c.numero_servicio, COALESCE(a.usuario, '') AS asesor
      FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id
      LEFT JOIN asignaciones a ON a.clave = COALESCE(NULLIF(c.message_id, ''), 'id:' || c.id)
      WHERE ${cond.join(' AND ')} ORDER BY c.creado DESC, o.fecha, o.id LIMIT 3000`, v)).rows;
    const tipos = String(p.get('tipo') || '').split(',').filter(Boolean), estados = String(p.get('estado') || '').split(',').filter(Boolean);
    const asesor = txt(p.get('asesor'), 50), grupo = p.get('grupo') || '', aerolinea = txt(p.get('aerolinea'), 4).toUpperCase(), origen = p.get('origen') || '';
    const porClave = new Map();
    for (const f of filas) {
      const k = f.message_id || 'id:' + f.servicio_id;
      if (!porClave.has(k)) porClave.set(k, []);
      porClave.get(k).push(f);
    }
    let lista = [...porClave.entries()].map(([clave, l]) => {
      const vivos = l.filter(x => x.estado !== 'cancelado');
      const estado = !vivos.length ? 'cancelada' : vivos.every(x => ['completado', 'no_show'].includes(x.estado)) ? 'completada' : vivos.length < l.length ? 'parcial' : 'activa';
      const venta = vivos.reduce((a, x) => a + (x.precio === null ? 0 : Number(x.precio) + Number(x.extras || 0)), 0);
      const costo = vivos.reduce((a, x) => a + (x.costo === null ? 0 : Number(x.costo)), 0);
      const fechas = l.map(x => x.fecha).filter(Boolean).sort();
      const manual = String(clave).startsWith('manual-');
      return {
        clave, numero: Math.min(...l.map(x => x.servicio_id)), op_id: l[0].id, creado: l.reduce((m, x) => (x.creado < m ? x.creado : m), l[0].creado),
        agencia: l[0].agencia || '', clientes: [...new Set(l.map(x => (x.nombre_cliente || '').trim()).filter(Boolean))],
        asesor: l[0].asesor || (manual ? String(l[0].remitente || '').replace(/\s*\(manual\)$/, '') : ''),
        pax: Math.max(...l.map(x => paxTotal(x))), estado, estado_nombre: ESTADO_RESERVA[estado], origen: manual ? 'manual' : 'correo',
        canal: manual ? ((String(l[0].asunto || '').match(/^Reserva manual \(([^)]+)\)/) || [])[1] || 'Oficina').trim() : 'Correo',
        desde: fechas[0] || '', hasta: fechas[fechas.length - 1] || '',
        servicios: l.map(x => ({ id: x.id, tipo: tipoDe(x), fecha: x.fecha, hora: x.hora_servicio || '', vuelo: x.vuelo || '', estado: x.estado, pax: paxTotal(x),
          asignado: Boolean(x.chofer_id || x.proveedor_id), asigna: x.chofer_id ? 'chofer' : (x.proveedor_id ? 'proveedor' : ''), cliente: x.nombre_cliente || '', lugar: x.hotel || x.actividad || x.punto_llegada || '' })),
        ...(conPrecios ? { venta: dinero(venta), costo: dinero(costo), ganancia: dinero(venta - costo), sin_precio: vivos.filter(x => x.precio === null).length, sin_costo: vivos.filter(x => x.costo === null).length } : {})
      };
    });
    if (tipos.length) lista = lista.filter(r => r.servicios.some(x => tipos.includes(x.tipo)));
    if (estados.length) lista = lista.filter(r => estados.includes(r.estado));
    if (asesor) lista = lista.filter(r => r.asesor === asesor);
    if (grupo === 'grupo') lista = lista.filter(r => r.pax >= 10); else if (grupo === 'individual') lista = lista.filter(r => r.pax < 10);
    if (aerolinea) lista = lista.filter(r => r.servicios.some(x => x.vuelo.replace(/\s+/g, '').toUpperCase().startsWith(aerolinea)));
    if (origen) lista = lista.filter(r => r.origen === origen);
    const resumen = { reservas: lista.length, pax: lista.reduce((a, r) => a + r.pax, 0), servicios: lista.reduce((a, r) => a + r.servicios.length, 0) };
    if (conPrecios) Object.assign(resumen, { venta: dinero(lista.reduce((a, r) => a + r.venta, 0)), costo: dinero(lista.reduce((a, r) => a + r.costo, 0)), sin_precio: lista.reduce((a, r) => a + (r.sin_precio || 0), 0) });
    const asesores = [...new Set(lista.map(r => r.asesor).filter(Boolean))].sort();
    return { reservas: lista.slice(0, admin ? 1500 : 600), resumen, asesores, total: lista.length };
  }
  async function detalleReserva(opId, conPrecios) {
    let servicios = await listar({ grupoDe: opId });
    if (!servicios.length) throw error('No existe esa reserva.', 404);
    const reglas = await cfg('reglas', REGLAS_INICIALES);
    servicios = servicios.map(x => ({ ...x, aviso: avisoPuerto(x, reglas) }));
    if (!conPrecios) servicios = servicios.map(x => ({ ...x, precio: undefined, costo: undefined, extras: undefined, tarifa_venta: undefined, tarifa_costo: undefined }));
    const ids = servicios.map(x => x.servicio_id);
    const c = (await client.query('SELECT id, remitente, asunto, buzon, creado, message_id, agencia FROM clasificacion WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows;
    const primero = c[0] || {};
    const manual = String(primero.message_id || '').startsWith('manual-');
    const ag = agenciaDe({ agencia: primero.agencia }, await agencias());
    const fichaAg = ag && ag.id ? (await client.query('SELECT id, nombre, contacto, telefono, email, mercado, tipo_agencia FROM op_agencias WHERE id = $1', [ag.id])).rows[0] : null;
    const correoRemitente = String(primero.remitente || '').match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    const asesor = (await client.query('SELECT usuario FROM asignaciones WHERE clave = $1', [primero.message_id || 'id:' + primero.id])).rows[0]
      || (manual ? { usuario: String(primero.remitente || '').replace(/\s*\(manual\)$/, '') } : null);
    const eventos = (await client.query('SELECT op_id, tipo, texto, usuario, fecha AS creado FROM op_eventos WHERE op_id = ANY($1::int[]) ORDER BY fecha DESC LIMIT 60', [servicios.map(x => x.id)]).catch(() => ({ rows: [] }))).rows;
    return {
      numero: Math.min(...ids), servicios, manual, asesor: asesor ? asesor.usuario : '',
      correo: manual ? null : { id: primero.id, remitente: primero.remitente || '', asunto: primero.asunto || '', buzon: primero.buzon || '', creado: primero.creado },
      agencia: { nombre: primero.agencia || (fichaAg && fichaAg.nombre) || '', email: (fichaAg && fichaAg.email) || (correoRemitente ? correoRemitente[0] : ''), telefono: (fichaAg && fichaAg.telefono) || '', contacto: (fichaAg && fichaAg.contacto) || '', mercado: (fichaAg && fichaAg.mercado) || '' },
      eventos
    };
  }
  // ---------- Administración: ganancias por día / mes / agencia / tipo ----------
  async function ganancias(p) {
    const fechaOk = x => /^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : '';
    const hoy = hoyLocal();
    const desde = fechaOk(p.get('desde')) || hoy.slice(0, 8) + '01', hasta = fechaOk(p.get('hasta')) || hoy;
    const sede = txt(p.get('sede'), 60);
    const filas = (await client.query(`SELECT o.id, o.fecha, o.precio, o.costo, o.extras, o.sede, o.chofer_id, o.proveedor_id, c.agencia, c.tipo_servicio, c.actividad, c.adultos, c.ninos, c.infantes, c.message_id, c.id AS sid
      FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id
      WHERE o.estado <> 'cancelado' AND o.fecha BETWEEN $1 AND $2 AND ($3 = '' OR o.sede = $3)`, [desde, hasta, sede])).rows;
    const suma = (l) => { const venta = l.reduce((a, x) => a + (x.precio === null ? 0 : Number(x.precio) + Number(x.extras || 0)), 0), costo = l.reduce((a, x) => a + (x.costo === null ? 0 : Number(x.costo)), 0);
      return { servicios: l.length, reservas: new Set(l.map(x => x.message_id || 'id:' + x.sid)).size, pax: l.reduce((a, x) => a + paxTotal(x), 0), venta: dinero(venta), costo: dinero(costo), ganancia: dinero(venta - costo),
        margen: venta ? Math.round((venta - costo) / venta * 1000) / 10 : 0, sin_precio: l.filter(x => x.precio === null).length, sin_costo: l.filter(x => x.costo === null).length }; };
    const agrupar = (fn) => { const m = new Map(); for (const x of filas) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return [...m.entries()].map(([k, l]) => ({ k, ...suma(l) })); };
    const dias = agrupar(x => x.fecha).sort((a, b) => a.k.localeCompare(b.k));
    const meses = agrupar(x => String(x.fecha).slice(0, 7)).sort((a, b) => a.k.localeCompare(b.k));
    const porAgencia = agrupar(x => x.agencia || 'Sin agencia').sort((a, b) => b.venta - a.venta);
    const NOMBRE_TIPO = { IN: 'Llegadas', OUT: 'Salidas', INTERHOTEL: 'Inter-hotel', ACTIVIDAD: 'Tours y actividades', OTRO: 'Otros' };
    const porTipo = agrupar(x => NOMBRE_TIPO[tipoDe(x)] || 'Otros').sort((a, b) => b.venta - a.venta);
    const porQuien = agrupar(x => x.proveedor_id ? 'Transportistas' : x.chofer_id ? 'Choferes propios' : 'Sin asignar').sort((a, b) => b.venta - a.venta);
    // El mismo período anterior, para comparar.
    const dias_n = Math.round((new Date(hasta) - new Date(desde)) / 864e5) + 1;
    const antDesde = masDias(desde, -dias_n), antHasta = masDias(desde, -1);
    const ant = (await client.query(`SELECT COALESCE(SUM(COALESCE(precio, 0) + COALESCE(extras, 0)), 0) AS venta, COALESCE(SUM(COALESCE(costo, 0)), 0) AS costo FROM op_servicios
      WHERE estado <> 'cancelado' AND fecha BETWEEN $1 AND $2 AND ($3 = '' OR sede = $3)`, [antDesde, antHasta, sede])).rows[0];
    return { desde, hasta, total: suma(filas), dias, meses, porAgencia: porAgencia.slice(0, 25), porTipo, porQuien,
      anterior: { desde: antDesde, hasta: antHasta, venta: dinero(Number(ant.venta)), ganancia: dinero(Number(ant.venta) - Number(ant.costo)) } };
  }
  // ---------- Administración: directorio de agencias con sus números ----------
  async function directorioAgencias() {
    const ags = (await client.query('SELECT * FROM op_agencias ORDER BY lower(nombre)')).rows;
    const stats = (await client.query(`SELECT lower(c.agencia) AS k, COUNT(DISTINCT COALESCE(NULLIF(c.message_id, ''), 'id:' || c.id))::int AS reservas,
        COALESCE(SUM(CASE WHEN o.estado <> 'cancelado' THEN COALESCE(o.precio, 0) + COALESCE(o.extras, 0) END), 0) AS venta, MAX(c.creado) AS ultima
      FROM op_servicios o JOIN clasificacion c ON c.id = o.servicio_id GROUP BY lower(c.agencia)`)).rows;
    const correos = (await client.query('SELECT lower(agencia) AS k, array_agg(DISTINCT remitente) AS l FROM agencias_conocidas GROUP BY lower(agencia)').catch(() => ({ rows: [] }))).rows;
    return { agencias: ags.map(a => {
      const claves = [a.nombre, ...String(a.alias || '').split(',')].map(x => x.trim().toLowerCase()).filter(Boolean);
      const st = stats.filter(x => claves.includes(x.k));
      const cs = correos.filter(x => claves.includes(x.k)).flatMap(x => x.l || []);
      return { ...a, reservas: st.reduce((s, x) => s + x.reservas, 0), venta: dinero(st.reduce((s, x) => s + Number(x.venta), 0)), ultima: st.map(x => x.ultima).filter(Boolean).sort().pop() || null,
        correos: [...new Set([a.email, ...cs].filter(Boolean))].slice(0, 6) };
    }) };
  }

  // ---------- rutas del panel ----------
  async function estadoPublico(u) {
    const publico = await cfg('publico', false);
    return { publico: Boolean(publico), puedeVer: u.grupo === 'Programador' || Boolean(publico), modulos: await modulos() };
  }
  async function manejar(req, res, url, u, { json, leerCuerpo, puede }) {
    const p = new URL(req.url, 'http://localhost').searchParams;
    const est = await estadoPublico(u);
    // Vistas guardadas de Reservas: cada usuario ve solo las suyas.
    if (req.method === 'GET' && url === '/api/op/vistas') {
      await client.query("CREATE TABLE IF NOT EXISTS op_vistas_usuario (id SERIAL PRIMARY KEY, usuario TEXT NOT NULL, nombre TEXT NOT NULL, filtros JSONB NOT NULL DEFAULT '{}', creado TIMESTAMP NOT NULL DEFAULT NOW())");
      const r = await client.query('SELECT id, nombre, filtros FROM op_vistas_usuario WHERE usuario = $1 ORDER BY id', [u.usuario]);
      return json(res, 200, r.rows);
    }
    if (req.method === 'POST' && url === '/api/op/vistas') {
      await client.query("CREATE TABLE IF NOT EXISTS op_vistas_usuario (id SERIAL PRIMARY KEY, usuario TEXT NOT NULL, nombre TEXT NOT NULL, filtros JSONB NOT NULL DEFAULT '{}', creado TIMESTAMP NOT NULL DEFAULT NOW())");
      const f = await leerCuerpo(req);
      const nombre = String(f.nombre || '').trim().slice(0, 60);
      if (!nombre) return json(res, 400, { error: 'Ponle un nombre a la vista.' });
      const filtros = f.filtros && typeof f.filtros === 'object' ? f.filtros : {};
      await client.query('INSERT INTO op_vistas_usuario (usuario, nombre, filtros) VALUES ($1, $2, $3)', [u.usuario, nombre, JSON.stringify(filtros)]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/op/vistas/quitar') {
      await client.query("CREATE TABLE IF NOT EXISTS op_vistas_usuario (id SERIAL PRIMARY KEY, usuario TEXT NOT NULL, nombre TEXT NOT NULL, filtros JSONB NOT NULL DEFAULT '{}', creado TIMESTAMP NOT NULL DEFAULT NOW())");
      const f = await leerCuerpo(req);
      await client.query('DELETE FROM op_vistas_usuario WHERE id = $1 AND usuario = $2', [Number(f.id), u.usuario]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url === '/api/op/estado') return json(res, 200, { ...est, ok: true });
    if (!est.puedeVer) return json(res, 403, { error: 'Operaciones está en construcción. ¡Próximamente!', proximamente: true });
    const prog = u.grupo === 'Programador';
    const pide = (perm, msg) => { if (!prog && !puede(perm)) throw error(msg || 'No tienes permiso para esto.', 403); };
    const mod = (m, nombre) => { if (!est.modulos[m]) throw error(`${nombre} está apagado (Configuración → Módulos).`, 403); };
    try {
      if (req.method === 'GET' && url === '/api/op/inicio') {
        pide('ver_operaciones');
        const [choferes, vehiculos, proveedores, ags, paquetes, cortesias] = await Promise.all([
          client.query('SELECT id, nombre, telefono, vehiculo_id, sede, activo, libre_desde, libre_hasta, licencia_vence FROM op_choferes ORDER BY nombre'),
          client.query('SELECT id, nombre, placa, capacidad, tipo, sede, activo, seguro_vence, marbete_vence FROM op_vehiculos ORDER BY nombre'),
          client.query('SELECT id, nombre, tipo, telefono, sede, activo FROM op_proveedores ORDER BY nombre'),
          client.query('SELECT id, nombre, modalidad FROM op_agencias WHERE activo ORDER BY nombre'),
          client.query('SELECT * FROM op_paquetes WHERE activo ORDER BY orden, id'),
          client.query('SELECT * FROM op_cortesias WHERE activo ORDER BY orden, nombre')]);
        const empresa = ((await client.query('SELECT nombre, marca_nombre, logo IS NOT NULL AS logo, rnc, direccion FROM empresa_datos WHERE id = 1').catch(() => ({ rows: [] }))).rows[0] || {});
        const perms = ['ver_operaciones', 'asignar_servicios', 'crear_reservas', 'ver_precios', 'ver_reportes_op', 'ver_choferes_vivo', 'imprimir_operativo', 'crear_paquetes', 'configurar_operaciones',
          'ver_reservas_op', 'ver_vuelos', 'ver_administracion', 'ver_boletas', 'editar_costos', 'ver_agencias', 'editar_agencias', 'ver_pagos']
          .reduce((a, k) => ({ ...a, [k]: prog || puede(k) }), {});
        return json(res, 200, { ...est, permisos: perms, usuario: { nombre: u.nombre, grupo: u.grupo, usuario: u.usuario }, empresa, hoy: hoyLocal(),
          choferes: choferes.rows, vehiculos: vehiculos.rows, proveedores: proveedores.rows, agencias: ags.rows, paquetes: paquetes.rows, cortesias: cortesias.rows.map(c => ({ ...c, precio: Number(c.precio) })),
          plantillas: await cfg('plantillas', PLANTILLAS_INICIALES), reglas: await cfg('reglas', REGLAS_INICIALES), estados: NOMBRE_ESTADO, vuelosCada: (await cfg('vuelos', VUELOS_INICIAL)).opensky_cada_min || 10 });
      }
      if (req.method === 'GET' && url === '/api/op/servicios') {
        pide('ver_operaciones'); mod('operaciones', 'Operaciones');
        let lista = await listar({ fecha: p.get('fecha'), sede: p.get('sede') || '', desde: p.get('desde'), hasta: p.get('hasta'), sinFecha: p.get('sinfecha') === '1' });
        const sinFecha = Number((await client.query("SELECT count(*) FROM op_servicios WHERE fecha = '' AND estado NOT IN ('cancelado', 'completado')")).rows[0].count);
        if (!prog && !puede('ver_precios')) lista = lista.map(x => ({ ...x, precio: undefined, costo: undefined, tarifa_venta: undefined, tarifa_costo: undefined }));
        const ubic = est.modulos.app_chofer ? (await client.query(`SELECT u.*, c.nombre, v.nombre AS vehiculo, v.placa FROM op_ubicaciones u JOIN op_choferes c ON c.id = u.chofer_id
          LEFT JOIN op_vehiculos v ON v.id = c.vehiculo_id WHERE u.fecha > NOW() - INTERVAL '2 hours'`)).rows : [];
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
      if (req.method === 'POST' && url === '/api/op/cortesia') { pide('asignar_servicios'); return json(res, 200, await agregarCortesia(u, await leerCuerpo(req))); }
      if (req.method === 'POST' && url === '/api/op/cortesia/quitar') { pide('asignar_servicios'); return json(res, 200, await quitarCortesia(u, await leerCuerpo(req))); }
      // Proforma (una por reserva) y vouchers (uno por pasajero): todos los servicios de la misma reserva.
      if (req.method === 'GET' && url === '/api/op/documentos') {
        pide('ver_operaciones');
        let lista = await listar({ grupoDe: p.get('id') });
        if (!prog && !puede('ver_precios')) lista = lista.map(x => ({ ...x, precio: undefined, costo: undefined, extras: undefined }));
        const rg = await cfg('reglas', REGLAS_INICIALES);
        return json(res, 200, { servicios: lista.map(x => ({ ...x, aviso: avisoPuerto(x, rg) })), numero: lista.length ? Math.min(...lista.map(x => x.reserva)) : 0 });
      }
      if (req.method === 'GET' && url === '/api/op/aviones') { pide('ver_vuelos', 'No tienes permiso para ver los vuelos.'); return json(res, 200, await buscarAviones(p.get('ahora') === '1')); }
      // ---------- Reservas (lo registrado en el panel de correo + las manuales) ----------
      if (req.method === 'GET' && url === '/api/op/reservas') { pide('ver_reservas_op', 'No tienes permiso para ver las reservas.'); return json(res, 200, await listaReservas(p, prog || puede('ver_precios'))); }
      if (req.method === 'GET' && url === '/api/op/reserva-detalle') { pide('ver_reservas_op', 'No tienes permiso para ver las reservas.'); return json(res, 200, await detalleReserva(Number(p.get('id')), prog || puede('ver_precios'))); }
      // ---------- Administración (gerencia) ----------
      // ---------- Pagos (permiso "Ver pagos"): cuentas, pagos por reserva, comprobantes y verificación ----------
      if (req.method === 'GET' && url === '/api/op/pagos') {
        pide('ver_pagos', 'Solo quien tiene el permiso "Ver pagos" puede ver los pagos.');
        const cuentas = (await client.query('SELECT id, tipo, nombre, titular, cuenta_fin, detalle, activa FROM op_cuentas_pago ORDER BY activa DESC, id')).rows;
        const pagos = (await client.query(`SELECT p.id, p.reserva, p.monto, p.moneda, p.metodo, p.cuenta_id, p.referencia, to_char(p.fecha, 'YYYY-MM-DD') AS fecha, p.voucher_nombre, p.estado, p.registrado_por, p.verificado_por, p.nota, to_char(p.creado, 'YYYY-MM-DD HH24:MI') AS creado, c.nombre AS cuenta FROM op_pagos p LEFT JOIN op_cuentas_pago c ON c.id = p.cuenta_id ORDER BY p.creado DESC LIMIT 300`)).rows;
        const suma = estado => pagos.filter(x => x.estado === estado).reduce((s, x) => s + Number(x.monto), 0);
        return json(res, 200, {
          cuentas,
          pagos: pagos.map(p => ({ ...p, monto: Number(p.monto) })),
          totales: { por_verificar: pagos.filter(x => x.estado === 'por_verificar').length, verificado_usd: suma('verificado'), rechazados: pagos.filter(x => x.estado === 'rechazado').length }
        });
      }
      if (req.method === 'POST' && url === '/api/op/pagos/cuenta/guardar') {
        pide('ver_pagos', 'Solo quien tiene el permiso "Ver pagos" puede cambiar las cuentas.');
        const f = await leerCuerpo(req);
        const nombre = String(f.nombre || '').trim().slice(0, 80);
        if (!nombre) return json(res, 400, { error: 'Escribe el nombre de la cuenta (por ejemplo: Banco ahorros o PayPal de cobros).' });
        const tipo = ['banco', 'paypal', 'otro'].includes(f.tipo) ? f.tipo : 'otro';
        const titular = String(f.titular || '').trim().slice(0, 100);
        const numero = String(f.numero || '').replace(/\s+/g, '');
        const cuentaFin = numero ? numero.slice(-4) : '';
        const numeroEnc = numero ? cifrar(numero) : null;
        const detalle = String(f.detalle || '').trim().slice(0, 300);
        const id = Number(f.id) || 0;
        if (id) {
          await client.query('UPDATE op_cuentas_pago SET tipo=$2, nombre=$3, titular=$4, cuenta_fin=COALESCE(NULLIF($5, \'\'), cuenta_fin), numero_enc=COALESCE($6, numero_enc), detalle=$7 WHERE id=$1', [id, tipo, nombre, titular, cuentaFin, numeroEnc, detalle]);
        } else {
          await client.query('INSERT INTO op_cuentas_pago (tipo, nombre, titular, cuenta_fin, numero_enc, detalle) VALUES ($1,$2,$3,$4,$5,$6)', [tipo, nombre, titular, cuentaFin, numeroEnc, detalle]);
        }
        await registrar(u, 'op_pago_cuenta', 'pagos', nombre, '', '', id ? 'cuenta editada' : 'cuenta nueva');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/op/pagos/cuenta/borrar') {
        pide('ver_pagos', 'Solo quien tiene el permiso "Ver pagos" puede cambiar las cuentas.');
        const f = await leerCuerpo(req);
        await client.query('UPDATE op_cuentas_pago SET activa = FALSE WHERE id = $1', [Number(f.id) || 0]);
        await registrar(u, 'op_pago_cuenta', 'pagos', f.id, '', '', 'cuenta desactivada (el historial de pagos se conserva)');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url === '/api/op/pagos/registrar') {
        pide('ver_pagos', 'Solo quien tiene el permiso "Ver pagos" puede registrar pagos.');
        const f = await leerCuerpo(req);
        const reserva = String(f.reserva || '').trim().slice(0, 40);
        if (!reserva) return json(res, 400, { error: 'Escribe el número de reserva.' });
        const monto = Number(f.monto);
        if (!Number.isFinite(monto) || monto <= 0) return json(res, 400, { error: 'El monto tiene que ser mayor que cero.' });
        const moneda = ['US$', 'RD$', '€'].includes(f.moneda) ? f.moneda : 'US$';
        const metodo = ['Transferencia', 'PayPal', 'Efectivo', 'Depósito', 'Otro'].includes(f.metodo) ? f.metodo : 'Otro';
        const cuentaId = Number(f.cuenta_id) || null;
        const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(f.fecha || '')) ? String(f.fecha) : hoyLocal();
        const referencia = String(f.referencia || '').trim().slice(0, 80);
        let vRuta = null, vNombre = null, vHash = null;
        if (f.voucher && f.voucher.base64) {
          const buf = Buffer.from(String(f.voucher.base64), 'base64');
          if (!buf.length || buf.length > 5 * 1024 * 1024) return json(res, 400, { error: 'El comprobante tiene que pesar menos de 5 MB.' });
          const ext = path.extname(String(f.voucher.nombre || '')).toLowerCase();
          if (!['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext)) return json(res, 400, { error: 'El comprobante tiene que ser JPG, PNG, WEBP o PDF.' });
          const carpeta = path.join(CARPETA_VOUCHERS, fecha.slice(0, 4), fecha.slice(5, 7));
          fs.mkdirSync(carpeta, { recursive: true });
          vRuta = path.join(carpeta, crypto.randomBytes(8).toString('hex') + ext);
          fs.writeFileSync(vRuta, buf);
          vNombre = String(f.voucher.nombre).replace(/[^\w.\- ]/g, '_').slice(0, 120);
          vHash = crypto.createHash('sha256').update(buf).digest('hex');
        }
        const r = await client.query(`INSERT INTO op_pagos (reserva, monto, moneda, metodo, cuenta_id, referencia, fecha, voucher_ruta, voucher_nombre, voucher_hash, estado, registrado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'por_verificar',$11) RETURNING id`,
          [reserva, monto, moneda, metodo, cuentaId, referencia, fecha, vRuta, vNombre, vHash, u.usuario]);
        await registrar(u, 'op_pago', 'pagos', reserva, '', '', `${moneda} ${monto} · ${metodo}${vNombre ? ' · con comprobante' : ' · sin comprobante'}`);
        return json(res, 200, { ok: true, id: r.rows[0].id });
      }
      if (req.method === 'POST' && url === '/api/op/pagos/verificar') {
        pide('ver_pagos', 'Solo quien tiene el permiso "Ver pagos" puede verificar pagos.');
        const f = await leerCuerpo(req);
        const decision = f.decision === 'verificado' ? 'verificado' : f.decision === 'rechazado' ? 'rechazado' : '';
        if (!decision) return json(res, 400, { error: 'Elige verificar o rechazar el pago.' });
        const nota = String(f.nota || '').trim().slice(0, 300);
        const r = await client.query('UPDATE op_pagos SET estado = $2, verificado_por = $3, verificado_en = NOW(), nota = $4 WHERE id = $1 RETURNING id', [Number(f.id) || 0, decision, u.usuario, nota]);
        if (!r.rowCount) return json(res, 404, { error: 'No existe ese pago.' });
        await registrar(u, 'op_pago_verificar', 'pagos', f.id, '', '', decision + (nota ? ' · ' + nota : ''));
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url === '/api/op/pagos/voucher') {
        pide('ver_pagos', 'Solo quien tiene el permiso "Ver pagos" puede ver los comprobantes.');
        const id = Number(new URL(req.url, 'http://localhost').searchParams.get('id')) || 0;
        const p = (await client.query('SELECT voucher_ruta, voucher_nombre, voucher_hash FROM op_pagos WHERE id = $1', [id])).rows[0];
        if (!p || !p.voucher_ruta || !fs.existsSync(p.voucher_ruta)) return json(res, 404, { error: 'Este pago no tiene comprobante.' });
        const buf = fs.readFileSync(p.voucher_ruta);
        if (crypto.createHash('sha256').update(buf).digest('hex') !== p.voucher_hash) return json(res, 409, { error: 'El comprobante cambió desde que se guardó. No lo uses hasta revisarlo.' });
        const tipos = { '.pdf': 'application/pdf', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
        res.writeHead(200, { 'Content-Type': tipos[path.extname(p.voucher_ruta).toLowerCase()] || 'application/octet-stream', 'Content-Disposition': 'inline; filename="' + String(p.voucher_nombre || 'comprobante').replace(/"/g, '') + '"' });
        return res.end(buf);
      }
      // ---------- Archivo de reservas: búsqueda de cualquier reserva, de cualquier año ----------
      if (req.method === 'GET' && url === '/api/op/archivo') {
        pide('ver_reservas_op', 'No tienes permiso para ver las reservas.');
        const p = new URL(req.url, 'http://localhost').searchParams;
        const busca = String(p.get('q') || '').trim().toLowerCase().slice(0, 80).replace(/[%_\\]/g, '\\$&');
        const anio = Number(p.get('anio')) || 0;
        const pagina = Math.max(1, Number(p.get('pagina')) || 1);
        const total = Number((await client.query(`SELECT COUNT(*)::int AS n FROM archivo_reservas WHERE ($1 = '' OR buscable LIKE '%' || $1 || '%') AND ($2 = 0 OR anio = $2)`, [busca, anio])).rows[0].n);
        const filas = (await client.query(`SELECT reserva_id, anio, cliente, agencia, fecha_servicio, total, version, actualizado FROM archivo_reservas WHERE ($1 = '' OR buscable LIKE '%' || $1 || '%') AND ($2 = 0 OR anio = $2) ORDER BY reserva_id DESC LIMIT 50 OFFSET $3`, [busca, anio, (pagina - 1) * 50])).rows;
        return json(res, 200, { total, pagina, reservas: filas.map(r => ({ ...r, total: Number(r.total) })) });
      }
      if (req.method === 'GET' && url === '/api/op/archivo/detalle') {
        pide('ver_reservas_op', 'No tienes permiso para ver las reservas.');
        const id = Number(new URL(req.url, 'http://localhost').searchParams.get('reserva')) || 0;
        const r = (await client.query('SELECT reserva_id, anio, cliente, agencia, fecha_servicio, total, version, huella, snapshot, creado, actualizado FROM archivo_reservas WHERE reserva_id = $1', [id])).rows[0];
        if (!r) return json(res, 404, { error: 'Esa reserva no está en el archivo.' });
        const versiones = (await client.query('SELECT version, cambios, creado FROM archivo_reservas_versiones WHERE reserva_id = $1 ORDER BY version DESC', [id])).rows;
        const pagos = prog || puede('ver_pagos') ? (await client.query(`SELECT id, monto, moneda, metodo, referencia, estado, voucher_nombre, to_char(fecha, 'YYYY-MM-DD') AS fecha FROM op_pagos WHERE reserva = $1 ORDER BY creado`, [String(id)])).rows : null;
        return json(res, 200, { reserva: { ...r, total: Number(r.total) }, versiones, pagos });
      }
      if (req.method === 'POST' && url === '/api/op/archivo/reconstruir') {
        pide('configurar_operaciones', 'Solo el Programador puede reconstruir el archivo.');
        let guardadas = 0;
        for (let i = 0; i < 100; i++) { const n = await archivarPendientes(); guardadas += n; if (!n) break; }
        return json(res, 200, { ok: true, guardadas });
      }
      if (req.method === 'GET' && url === '/api/op/mapas-config') { pide('ver_choferes_vivo', 'No tienes permiso para el mapa.'); return json(res, 200, { mapbox: await llaveDeOficina('api_mapas') }); }
      if (req.method === 'GET' && url === '/api/op/ruta-chofer') {
        pide('ver_choferes_vivo', 'No tienes permiso para ver el mapa de choferes.');
        const p = new URL(req.url, 'http://localhost').searchParams;
        const chofer = Number(p.get('chofer')) || 0;
        if (!chofer) return json(res, 400, { error: 'Elige un chofer.' });
        const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(p.get('fecha') || '')) ? String(p.get('fecha')) : hoyLocal();
        return json(res, 200, await rutaDelChofer(chofer, fecha));
      }
      if (req.method === 'GET' && url === '/api/op/admin/ganancias') { pide('ver_administracion', 'Solo gerencia puede ver la administración.'); return json(res, 200, await ganancias(p)); }
      if (req.method === 'GET' && url === '/api/op/admin/boletas') { pide('ver_boletas', 'No tienes permiso para las boletas.'); return json(res, 200, await listaReservas(p, true, true)); }
      if (req.method === 'POST' && url === '/api/op/admin/costo') {
        pide('editar_costos', 'No tienes permiso para corregir costos.');
        const f = await leerCuerpo(req);
        return json(res, 200, await ajustarPrecio(u, f.id, { costo: f.costo, motivo: f.motivo || 'Costo corregido en Administración' }));
      }
      if (req.method === 'GET' && url === '/api/op/admin/agencias') { pide('ver_agencias', 'No tienes permiso para ver las agencias.'); return json(res, 200, await directorioAgencias()); }
      if (req.method === 'POST' && url === '/api/op/admin/agencia') { pide('editar_agencias', 'No tienes permiso para editar agencias.'); const f = await leerCuerpo(req); cacheAgencias.t = 0; return json(res, 200, await guardarCatalogo(u, 'agencias', f)); }
      if (req.method === 'POST' && url === '/api/op/whatsapp') { pide('asignar_servicios'); const f = await leerCuerpo(req); return json(res, 200, await enviarWhatsApp(u, f.id)); }
      if (req.method === 'POST' && url === '/api/op/vuelos/ahora') { pide('asignar_servicios'); mod('vuelos', 'Vuelos en vivo'); return json(res, 200, await vigilarVuelos(true)); }

      // ----- Configuración (solo con "configurar_operaciones") -----
      if (url.startsWith('/api/op/config')) {
        pide('configurar_operaciones', 'Solo el Programador (o quien tenga "Configurar operaciones") cambia esto.');
        if (req.method === 'GET' && url === '/api/op/config') {
          const [tarifarios, tarifas, agencias2, hoteles2, choferes, vehiculos, proveedores, paquetes, cortesias] = await Promise.all([
            client.query('SELECT * FROM op_tarifarios ORDER BY tipo, nombre'), client.query('SELECT * FROM op_tarifas ORDER BY tarifario_id, servicio, nombre, zona, pax_desde'),
            client.query('SELECT * FROM op_agencias ORDER BY nombre'), client.query('SELECT * FROM op_hoteles ORDER BY sede, zona, hotel'),
            client.query('SELECT id, nombre, telefono, licencia, licencia_vence, vehiculo_id, sede, pago_servicio, codigo, activo, libre_desde, libre_hasta, notas, (pin_hash <> \'\') AS tiene_pin FROM op_choferes ORDER BY nombre'),
            client.query('SELECT * FROM op_vehiculos ORDER BY nombre'), client.query('SELECT * FROM op_proveedores ORDER BY nombre'), client.query('SELECT * FROM op_paquetes ORDER BY orden, id'),
            client.query('SELECT * FROM op_cortesias ORDER BY orden, nombre')]);
          const llaves = await cfg('llaves', {});
          return json(res, 200, { publico: await cfg('publico', false), modulos: await modulos(), reglas: await cfg('reglas', REGLAS_INICIALES), plantillas: await cfg('plantillas', PLANTILLAS_INICIALES),
            whatsapp: await cfg('whatsapp', WHATSAPP_INICIAL), vuelos: await cfg('vuelos', VUELOS_INICIAL), llaves: Object.fromEntries(Object.keys(llaves).map(k => [k, Boolean(llaves[k])])),
            tarifarios: tarifarios.rows, tarifas: tarifas.rows, agencias: agencias2.rows, hoteles: hoteles2.rows, choferes: choferes.rows, vehiculos: vehiculos.rows, proveedores: proveedores.rows, paquetes: paquetes.rows, cortesias: cortesias.rows.map(c => ({ ...c, precio: Number(c.precio) })),
            tipos_tarifa: TIPOS_TARIFA, tipos_proveedor: TIPOS_PROVEEDOR });
        }
        const f = req.method === 'POST' ? await leerCuerpo(req) : {};
        if (url === '/api/op/config/publico') { await guardarCfg('publico', Boolean(f.publico)); await registrar(u, 'op_publicar', 'operaciones', '', '', String(Boolean(f.publico)), ''); return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/modulos') { const m = { ...(await modulos()) }; for (const k of Object.keys(MODULOS_INICIALES)) if (f[k] !== undefined) m[k] = Boolean(f[k]); await guardarCfg('modulos', m); await registrar(u, 'op_modulos', 'operaciones', '', '', JSON.stringify(m), ''); return json(res, 200, { ok: true, modulos: m }); }
        if (url === '/api/op/config/reglas') { const r = { ...(await cfg('reglas', REGLAS_INICIALES)) }; for (const k of Object.keys(REGLAS_INICIALES)) if (f[k] !== undefined) r[k] = k === 'tiempos_zona' ? Object.fromEntries(Object.entries(f[k] || {}).map(([z, m]) => [txt(z, 60), entero(m)]).filter(([z]) => z)) : typeof REGLAS_INICIALES[k] === 'boolean' ? Boolean(f[k]) : typeof REGLAS_INICIALES[k] === 'string' ? txt(f[k], 600) : entero(f[k]); await guardarCfg('reglas', r); return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/plantillas') { const pl = { ...(await cfg('plantillas', PLANTILLAS_INICIALES)) }; for (const k of Object.keys(PLANTILLAS_INICIALES)) if (f[k] && typeof f[k] === 'object') pl[k] = { ...pl[k], ...Object.fromEntries(Object.entries(f[k]).map(([a, b]) => [a, Array.isArray(b) ? b.map(x => txt(x, 30)) : typeof b === 'boolean' || typeof b === 'number' ? b : txt(b, 1500)])) }; await guardarCfg('plantillas', pl); return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/whatsapp') { const w = { ...(await cfg('whatsapp', WHATSAPP_INICIAL)) }; for (const k of Object.keys(WHATSAPP_INICIAL)) if (f[k] !== undefined) w[k] = k === 'auto_al_asignar' ? Boolean(f[k]) : txt(f[k], 1000); await guardarCfg('whatsapp', w); if (f.token) { const l = await cfg('llaves', {}); l.chatwoot = cifrar(txt(f.token, 200)); await guardarCfg('llaves', l); } return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/vuelos') { const v = { ...(await cfg('vuelos', VUELOS_INICIAL)) }; if (['aerodatabox', 'flightaware'].includes(f.proveedor)) v.proveedor = f.proveedor; if (f.rapidapi_host) v.rapidapi_host = txt(f.rapidapi_host, 100); if (f.opensky_cliente !== undefined) v.opensky_cliente = txt(f.opensky_cliente, 120); if (f.opensky_cada_min) v.opensky_cada_min = Math.max(2, entero(f.opensky_cada_min)); await guardarCfg('vuelos', v); const l = await cfg('llaves', {}); for (const k of ['opensky']) if (f['llave_' + k]) l[k] = cifrar(txt(f['llave_' + k], 300)); await guardarCfg('llaves', l); aviones.t = 0; return json(res, 200, { ok: true }); }
        if (url === '/api/op/config/vuelos/probar') { const r = await consultarVuelo(f.proveedor, identVuelo(f.vuelo), /^\d{4}-\d{2}-\d{2}$/.test(f.fecha || '') ? f.fecha : hoyLocal()); return json(res, 200, { ok: true, resultado: r }); }
        if (url === '/api/op/config/importar') return json(res, 200, await importarExcel(u, f));
        if (url === '/api/op/config/importar-somos') {
          const r = await importarSomos(u, f.archivo, Buffer.from(String(f.base64 || ''), 'base64'));
          // Los servicios que vienen (sin precio a mano) toman los precios nuevos.
          const ids = (await client.query("SELECT id FROM op_servicios WHERE fecha >= $1 AND estado <> 'cancelado' AND NOT precio_manual", [hoyLocal()])).rows.map(x => x.id);
          if (ids.length) await recalcular(u, ids);
          return json(res, 200, { ok: true, ...r, recalculados: ids.length });
        }
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

  // ---------- aviones en el mapa (OpenSky, gratis) ----------
  // Cada pocos minutos se piden los aviones que vuelan sobre el Caribe y se buscan los vuelos de las llegadas y salidas de hoy.
  let aviones = { t: 0, lista: [], error: '', consultado: null };
  let tokenOpenSky = { valor: '', vence: 0 };
  function callsignsDe(vuelo) {
    const m = String(vuelo || '').toUpperCase().replace(/[^A-Z0-9]/g, '').match(/^([A-Z0-9]{2})(\d{1,4})[A-Z]?$/);
    if (!m) return [];
    const numero = String(Number(m[2]));
    return (AEROLINEAS_OACI[m[1]] || []).map(p => p + numero);
  }
  async function tokenSky(v) {
    const l = await cfg('llaves', {});
    if (!v.opensky_cliente || !l.opensky) return '';
    if (tokenOpenSky.valor && tokenOpenSky.vence > Date.now() + 60000) return tokenOpenSky.valor;
    const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: v.opensky_cliente, client_secret: descifrar(l.opensky) }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('OpenSky no aceptó la cuenta (' + r.status + ')');
    const d = await r.json();
    tokenOpenSky = { valor: d.access_token, vence: Date.now() + (Number(d.expires_in) || 1800) * 1000 };
    return tokenOpenSky.valor;
  }
  async function buscarAviones(forzar) {
    const mods = await modulos();
    if (!mods.aviones) return aviones;
    const v = await cfg('vuelos', VUELOS_INICIAL);
    const cada = Math.max(2, Number(v.opensky_cada_min) || 10) * 60000;
    if (!forzar && Date.now() - aviones.t < cada) return aviones;
    // Vuelos de hoy (llegadas que aún no completan y salidas que aún no despegan hace mucho).
    const hoy = hoyLocal();
    const servicios = (await listar({ fecha: hoy })).filter(x => ['IN', 'OUT'].includes(x.tipo) && x.vuelo && x.estado !== 'cancelado');
    aviones.t = Date.now();
    if (!servicios.length) { aviones = { ...aviones, lista: [], error: '', consultado: new Date().toISOString() }; return aviones; }
    try {
      const token = await tokenSky(v).catch(e => { aviones.error = e.message; return ''; });
      const q = new URLSearchParams(Object.entries(ZONA_AVIONES).map(([k, x]) => [k, String(x)]));
      const r = await fetch(`${v.opensky_url || VUELOS_INICIAL.opensky_url}/states/all?${q}`, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(r.status === 429 ? 'OpenSky: se pasó el límite gratis de consultas de hoy (pon una cuenta gratis en Configuración → Vuelos en vivo)' : 'OpenSky respondió ' + r.status);
      const d = await r.json();
      const porCallsign = new Map((d.states || []).map(e => [String(e[1] || '').trim().toUpperCase(), e]));
      const lista = [];
      const vistos = new Set();
      for (const x of servicios) {
        const clave = x.vuelo.toUpperCase().replace(/\s+/g, '');
        if (vistos.has(clave + x.tipo)) { const ya = lista.find(a => a.vuelo === clave && a.tipo === x.tipo); if (ya) { ya.servicios.push(x.id); ya.pax += x.pax_total; } continue; }
        vistos.add(clave + x.tipo);
        const cs = callsignsDe(x.vuelo).find(c => porCallsign.has(c));
        const e = cs ? porCallsign.get(cs) : null;
        lista.push({ vuelo: clave, tipo: x.tipo, hora: x.hora, aeropuerto: x.aeropuerto, servicios: [x.id], pax: x.pax_total, cliente: x.cliente,
          callsign: cs || '', en_mapa: Boolean(e && e[6] !== null && e[5] !== null),
          lat: e ? e[6] : null, lng: e ? e[5] : null, rumbo: e ? e[10] : null, altura_m: e ? Math.round(e[13] || e[7] || 0) : null,
          velocidad_kmh: e && e[9] !== null ? Math.round(e[9] * 3.6) : null, en_tierra: e ? Boolean(e[8]) : null, visto: e && e[4] ? new Date(e[4] * 1000).toISOString() : null });
      }
      aviones = { t: Date.now(), lista, error: token || !aviones.error ? '' : aviones.error, consultado: new Date().toISOString() };
    } catch (e) { aviones = { ...aviones, error: e.message, consultado: new Date().toISOString() }; }
    return aviones;
  }

  // Carga los tarifarios que llegaron desde la Oficina y recalcula los servicios que vienen (los de precio a mano no se tocan).
  let colaOcupada = false;
  async function procesarColaTarifarios() {
    if (colaOcupada) return; colaOcupada = true;
    try {
      const filas = (await client.query("SELECT id, archivo, datos FROM op_cola_tarifarios WHERE estado = 'pendiente' ORDER BY id LIMIT 10")).rows;
      for (const f of filas) {
        let estado = 'listo', resultado;
        try {
          resultado = await importarSomos(null, f.archivo, f.datos || Buffer.alloc(0));
          if (resultado.error) estado = 'error';
          else {
            const ids = (await client.query("SELECT id FROM op_servicios WHERE fecha >= $1 AND estado <> 'cancelado' AND NOT precio_manual", [hoyLocal()])).rows.map(x => x.id);
            if (ids.length) await recalcular(null, ids);
            resultado.recalculados = ids.length;
          }
        } catch (e) { estado = 'error'; resultado = { error: e.message }; }
        await client.query("UPDATE op_cola_tarifarios SET estado = $1, resultado = $2, procesado = NOW(), datos = NULL WHERE id = $3", [estado, JSON.stringify(resultado), f.id]);
        console.log(`Operaciones: tarifario de la Oficina "${f.archivo}" → ${estado}`);
      }
    } catch (e) { console.log('Operaciones (tarifarios):', e.message); }
    colaOcupada = false;
  }

  function iniciar() {
    setTimeout(() => sincronizar(true).catch(e => console.log('Operaciones:', e.message)), 15000);
    setTimeout(procesarColaTarifarios, 5000);
    setInterval(procesarColaTarifarios, 30 * 1000);
    setInterval(() => sincronizar().catch(e => console.log('Operaciones:', e.message)), 60 * 1000);
    setInterval(() => vigilarVuelos().catch(e => console.log('Vuelos:', e.message)), 2 * 60 * 1000);
    setInterval(() => buscarAviones().catch(e => console.log('Aviones:', e.message)), 60 * 1000);
  }

  return { preparar, iniciar, manejar, manejarChofer, estadoPublico, sincronizar, _probar: { mejorTarifa, importe, tiempos, marcarChoques, identVuelo, cifrar, descifrar, agenciaDe, zonaDe } };
};
