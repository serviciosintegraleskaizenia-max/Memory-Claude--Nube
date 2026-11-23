// CRM de Zentralia (servicio aparte, por cliente).
// Lo ve el Programador siempre, y los demás usuarios solo si la empresa tiene el módulo "crm" contratado
// y el usuario tiene el permiso "ver_crm". Tablas propias en la base de cada empresa.
//
// Piezas:
//  - Pipeline: etapas de venta editables; el tablero mueve personas entre etapas.
//  - Seguimientos programados (24 h, 48 h, 2 semanas, 1 mes). Un temporizador los envía cuando llega la hora.
//  - Etiquetas automáticas: la IA lee cada mensaje nuevo y propone etiquetas (si no hay IA, reglas de palabras).
//  - Historial completo de cada persona: mensajes, notas, cambios de etapa, etiquetas y seguimientos.
//  - Conexión con Chatwoot (la misma de Operaciones) para traer conversaciones y responder.
//
// Regla de Meta: en WhatsApp, Instagram y Messenger solo se puede escribir libremente dentro de las 24 h
// desde el último mensaje de la persona. Fuera de ese plazo, el seguimiento queda como "requiere plantilla".

const CANALES = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', tiktok: 'TikTok', web: 'Web / chat', correo: 'Correo', manual: 'Carga manual' };
// Redes sociales que se guardan en la ficha (mismas claves que los canales).
const REDES_CRM = ['instagram', 'messenger', 'tiktok'];
const redesDeCanal = (canal, identificador) => (REDES_CRM.includes(canal) ? { [canal]: identificador } : {});
const { escribirExcel } = require('./lector-xlsx');
const ETAPAS_INICIALES = [
  { clave: 'nuevo', nombre: 'Nuevo' }, { clave: 'interesado', nombre: 'Interesado' }, { clave: 'cotizado', nombre: 'Cotizado' },
  { clave: 'cerrado', nombre: 'Cerrado' }, { clave: 'perdido', nombre: 'Perdido' }
];
const DIRECCIONES = ['entrante', 'saliente', 'nota'];
const PLAZOS = { '24h': 24 * 3600e3, '48h': 48 * 3600e3, '2s': 14 * 86400e3, '1m': 30 * 86400e3 };
const ETIQUETAS_IA = ['interesado', 'pidió precio', 'quiere cotización', 'quiere reservar', 'pago pendiente', 'pago confirmado',
  'queja', 'pide hablar con persona', 'sorteo', 'solo consulta', 'compra', 'no le interesa'];
const PALABRAS = [
  [/precio|cuánto|cuanto|costo|tarifa/i, 'pidió precio'], [/cotiz|presupuesto/i, 'quiere cotización'],
  [/reserv|apartar|separar/i, 'quiere reservar'], [/yape|plin|transferencia|pagué|pago/i, 'pago pendiente'],
  [/queja|reclamo|mal servicio|molest/i, 'queja'], [/asesor|persona|humano|llamen|llamar/i, 'pide hablar con persona'],
  [/sorteo|ticket|boleto/i, 'sorteo'], [/no me interesa|no gracias|ya no/i, 'no le interesa']
];
const PAGINA_CHATWOOT = 25;
const PAGINAS_MAX = 8;

// ---------- Reglas del CRM sin base de datos (se prueban en crm.test.js) ----------
const HORA_MS = 3600e3;
// «Te toca a ti» (CRM-2): la persona escribió después de nuestro último mensaje y llevamos esperando 2 h o más.
function prioridadDe(c, ahora = Date.now()) {
  const entrante = c.ultimo_entrante ? new Date(c.ultimo_entrante).getTime() : 0;
  const saliente = c.ultimo_saliente ? new Date(c.ultimo_saliente).getTime() : 0;
  if (!entrante || entrante <= saliente) return null;
  const horas = (ahora - entrante) / HORA_MS;
  if (horas < 2) return null;
  return { motivo: 'Sin responder', detalle: horas >= 24 ? `${Math.floor(horas / 24)} d` : `${Math.floor(horas)} h`, nivel: horas >= 24 ? 'rojo' : horas >= 8 ? 'ambar' : 'verde', horas };
}
// Tablero por estado (CRM-3): lo que espera nuestra respuesta, lo que tiene visita y lo que atiende el asistente.
function estadoAutoDe(c, citasFuturas = 0, ahora = Date.now()) {
  if (prioridadDe(c, ahora)) return 'te_toca';
  if (citasFuturas > 0) return 'con_visita';
  return 'con_asistente';
}
// Botones de la ficha (CRM-3): cambian las etiquetas de la persona.
const ACCIONES = {
  lo_llevo_yo: { titulo: 'Lo llevo yo', add: 'lo llevo yo' },
  devolver_asistente: { titulo: 'Devolver a asistente', quitar: 'lo llevo yo' },
  es_publicidad: { titulo: 'Es publicidad', add: 'publicidad' }
};
function etiquetasConAccion(etiquetas, accion) {
  const a = ACCIONES[accion];
  if (!a) return null;
  const set = new Set(Array.isArray(etiquetas) ? etiquetas : []);
  if (a.add) set.add(a.add);
  if (a.quitar) set.delete(a.quitar);
  return [...set].slice(0, 20);
}
// Números permitidos del modo prueba (CRM-8): al menos uno, formato internacional, sin repetir, como mucho diez.
const MAX_PERMITIDOS = 10;
function revisarPermitidos(entrada) {
  if (!Array.isArray(entrada)) return { error: 'Escribe al menos un número.' };
  const limpios = [];
  for (const [i, x] of entrada.entries()) {
    const t = String(x ?? '').replace(/[\s()-]/g, '');
    if (!t) continue;
    if (!/^\+?\d{6,15}$/.test(t)) return { error: `El número ${i + 1} no es válido. Usa el formato internacional, por ejemplo +18095551234.`, indice: i };
    const solo = t.replace(/^\+/, '');
    if (!limpios.includes(solo)) limpios.push(solo);
  }
  if (!limpios.length) return { error: 'Escribe al menos un número.' };
  if (limpios.length > MAX_PERMITIDOS) return { error: `Como mucho ${MAX_PERMITIDOS} números.` };
  return { numeros: limpios };
}

module.exports = function crearCrm({ client, cuenta, registrar, chatwoot, claveIA }) {
  const error = (m, codigo = 400) => Object.assign(new Error(m), { codigo });
  const texto = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const etiquetasDe = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => texto(x, 40).toLowerCase()).filter(Boolean).slice(0, 20);
  const claveDe = t => texto(t, 60).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'etapa';

  async function preparar() {
    await client.query(`CREATE TABLE IF NOT EXISTS crm_contactos (
      id SERIAL PRIMARY KEY, canal TEXT NOT NULL, identificador TEXT NOT NULL, nombre TEXT NOT NULL DEFAULT '',
      telefono TEXT NOT NULL DEFAULT '', correo TEXT NOT NULL DEFAULT '', origen TEXT NOT NULL DEFAULT '',
      etiquetas JSONB NOT NULL DEFAULT '[]', etapa TEXT NOT NULL DEFAULT 'nuevo', notas TEXT NOT NULL DEFAULT '',
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (canal, identificador))`);
    for (const c of ['conv_id BIGINT', 'ultimo_entrante TIMESTAMPTZ', 'ultimo_saliente TIMESTAMPTZ', "etiquetado_en TIMESTAMPTZ"]) {
      await client.query(`ALTER TABLE crm_contactos ADD COLUMN IF NOT EXISTS ${c}`);
    }
    // Dirección y redes sociales de la persona (redes = { instagram, messenger, tiktok }).
    await client.query("ALTER TABLE crm_contactos ADD COLUMN IF NOT EXISTS direccion TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE crm_contactos ADD COLUMN IF NOT EXISTS redes JSONB NOT NULL DEFAULT '{}'::jsonb");
    await client.query('CREATE INDEX IF NOT EXISTS crm_contactos_ultimo ON crm_contactos (ultimo_entrante)');
    // Visitas y citas del CRM (CRM-5): separadas del calendario de operaciones.
    await client.query(`CREATE TABLE IF NOT EXISTS crm_citas (id SERIAL PRIMARY KEY,
      contacto_id INTEGER NOT NULL REFERENCES crm_contactos(id) ON DELETE CASCADE, cuando TIMESTAMPTZ NOT NULL,
      nota TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT 'programada', creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query('CREATE INDEX IF NOT EXISTS crm_citas_cuando ON crm_citas (cuando)');
    await client.query(`CREATE TABLE IF NOT EXISTS crm_mensajes (
      id SERIAL PRIMARY KEY, contacto_id INTEGER NOT NULL REFERENCES crm_contactos(id) ON DELETE CASCADE,
      direccion TEXT NOT NULL, texto TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query("ALTER TABLE crm_mensajes ADD COLUMN IF NOT EXISTS ref TEXT NOT NULL DEFAULT ''");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS crm_mensajes_ref ON crm_mensajes (contacto_id, ref) WHERE ref <> ''");
    await client.query(`CREATE TABLE IF NOT EXISTS crm_historial (
      id SERIAL PRIMARY KEY, contacto_id INTEGER NOT NULL REFERENCES crm_contactos(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL, detalle TEXT NOT NULL DEFAULT '', quien TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS crm_seguimientos (
      id SERIAL PRIMARY KEY, contacto_id INTEGER NOT NULL REFERENCES crm_contactos(id) ON DELETE CASCADE,
      plazo TEXT NOT NULL, cuando TIMESTAMPTZ NOT NULL, mensaje TEXT NOT NULL DEFAULT '',
      estado TEXT NOT NULL DEFAULT 'pendiente', resultado TEXT NOT NULL DEFAULT '', quien TEXT NOT NULL DEFAULT '',
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), enviado TIMESTAMPTZ)`);
    await client.query(`CREATE TABLE IF NOT EXISTS crm_etapas (
      clave TEXT PRIMARY KEY, nombre TEXT NOT NULL, orden INTEGER NOT NULL DEFAULT 0, activa BOOLEAN NOT NULL DEFAULT TRUE)`);
    if (!(await client.query('SELECT 1 FROM crm_etapas LIMIT 1')).rowCount) {
      for (const [i, e] of ETAPAS_INICIALES.entries()) {
        await client.query('INSERT INTO crm_etapas (clave, nombre, orden) VALUES ($1, $2, $3)', [e.clave, e.nombre, i + 1]);
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS crm_config (clave TEXT PRIMARY KEY, valor JSONB NOT NULL DEFAULT '{}'::jsonb)`);
    setInterval(() => procesarSeguimientos().catch(e => console.log('CRM seguimientos:', e.message)), 60e3).unref();
    // Sincronización automática con Chatwoot cada 2 minutos (solo las 25 conversaciones más recientes).
    // Así el CRM se mantiene al día sin depender de n8n. Si Chatwoot no está configurado, no hace nada.
    setInterval(() => sincronizarAutomatica().catch(e => console.log('CRM sincronía:', e.message)), 120e3).unref();
  }

  // Quién puede entrar: el Programador siempre; los demás, con el servicio contratado y el permiso.
  async function puede(u) {
    if (!u) return false;
    if (u.grupo === 'Programador') return true;
    if (!(await cuenta.tiene('crm'))) return false;
    return Boolean(u.permisos && u.permisos.ver_crm);
  }
  const puedeEditarEtapas = u => Boolean(u && (u.grupo === 'Programador' || (u.permisos && u.permisos.configurar_empresa)));
  async function estadoPublico(u) {
    return { puedeVer: await puede(u), servicio: await cuenta.tiene('crm') };
  }

  const quien = u => (u && (u.nombre || u.usuario)) || 'sistema';
  async function histo(contactoId, tipo, detalle, por = 'sistema') {
    await client.query('INSERT INTO crm_historial (contacto_id, tipo, detalle, quien) VALUES ($1, $2, $3, $4)', [contactoId, tipo, texto(detalle, 500), por]);
  }
  const ventanaAbierta = c => Boolean(c.ultimo_entrante) && (Date.now() - new Date(c.ultimo_entrante).getTime()) < 24 * 3600e3;

  async function etapas() {
    return (await client.query('SELECT clave, nombre, activa FROM crm_etapas ORDER BY orden, clave')).rows;
  }

  async function estado(u) {
    const cw = chatwoot ? await chatwoot().catch(() => null) : null;
    const sync = (await client.query("SELECT valor FROM crm_config WHERE clave = 'sincronizacion'")).rows[0];
    const plantilla = (await client.query("SELECT valor FROM crm_config WHERE clave = 'plantilla_wa'")).rows[0];
    const conexion = Boolean(cw && cw.url && cw.cuenta && cw.token);
    const personas = Number((await client.query('SELECT COUNT(*)::int AS n FROM crm_contactos')).rows[0].n);
    const citas = Number((await client.query('SELECT COUNT(*)::int AS n FROM crm_citas')).rows[0].n);
    const revisadas = (await client.query("SELECT 1 FROM crm_config WHERE clave = 'etapas_revisadas'")).rowCount > 0;
    const ajustes = (await client.query("SELECT 1 FROM crm_config WHERE clave = 'ajustes_crm'")).rowCount > 0;
    return {
      puedeVer: true, servicio: await cuenta.tiene('crm'), editarEtapas: puedeEditarEtapas(u),
      chatwoot: conexion, sincronizado: sync ? sync.valor : null,
      ia: Boolean(claveIA && await claveIA().catch(() => '')), plantilla: plantilla ? plantilla.valor : null,
      etapas: await etapas(), canales: CANALES, etiquetas_ia: ETIQUETAS_IA,
      pasos: [
        { clave: 'conexion', titulo: 'Conectar los mensajes', hecho: conexion, ayuda: 'Chatwoot o WhatsApp directo. Lo conecta el Programador en Operaciones.' },
        { clave: 'etapas', titulo: 'Revisar las etapas de venta', hecho: revisadas, ayuda: 'Nombres y etapas que usa tu negocio.' },
        { clave: 'persona', titulo: 'Cargar la primera persona', hecho: personas > 0, ayuda: 'Con «+ Nueva persona» o esperando un mensaje.' },
        { clave: 'cita', titulo: 'Agendar la primera visita', hecho: citas > 0, ayuda: 'Desde la ficha de una persona, pestaña Visitas.' },
        { clave: 'avisos', titulo: 'Elegir cómo te avisamos', hecho: ajustes, ayuda: 'Sonido y modo prueba, en Ajustes del CRM.' }
      ]
    };
  }

  // Filtros comunes: texto, etapa, canal, etiqueta, horas sin respuesta y seguimiento pendiente.
  function filtrosDe(p) {
    const f = {
      q: texto(p.get('q'), 100).toLowerCase(), etapa: texto(p.get('etapa'), 60), canal: texto(p.get('canal'), 20),
      etiqueta: texto(p.get('etiqueta'), 40).toLowerCase(), sinRespuesta: Math.min(Number(p.get('sin_respuesta_horas')) || 0, 24 * 365),
      seguimiento: p.get('seguimiento') === 'pendiente',
      telefono: texto(p.get('telefono'), 25).replace(/\D/g, ''), correo: texto(p.get('correo'), 120).toLowerCase(),
      desde: /^\d{4}-\d{2}-\d{2}$/.test(p.get('desde') || '') ? p.get('desde') : '',
      hasta: /^\d{4}-\d{2}-\d{2}$/.test(p.get('hasta') || '') ? p.get('hasta') : '',
      campo: p.get('campo') === 'alta' ? 'alta' : 'ultimo',
      horaDesde: /^\d{1,2}$/.test(p.get('hora_desde') || '') ? Math.min(Number(p.get('hora_desde')), 23) : null,
      horaHasta: /^\d{1,2}$/.test(p.get('hora_hasta') || '') ? Math.min(Number(p.get('hora_hasta')), 23) : null
    };
    const where = [], val = [];
    const ph = v => { val.push(v); return '$' + val.length; };
    // Fecha y hora de referencia en hora de Lima: último mensaje del cliente (o alta si nunca escribió).
    const fechaRef = f.campo === 'alta' ? 'creado' : 'COALESCE(ultimo_entrante, creado)';
    const enLima = `(${fechaRef} AT TIME ZONE 'America/Lima')`;
    if (f.q) { const n = ph(f.q); where.push(`(lower(nombre) LIKE '%' || ${n} || '%' OR lower(telefono) LIKE '%' || ${n} || '%' OR lower(correo) LIKE '%' || ${n} || '%' OR lower(direccion) LIKE '%' || ${n} || '%' OR lower(redes::text) LIKE '%' || ${n} || '%')`); }
    if (f.telefono) where.push(`regexp_replace(telefono, '[^0-9]', '', 'g') LIKE '%' || ${ph(f.telefono)} || '%'`);
    if (f.correo) where.push(`lower(correo) LIKE '%' || ${ph(f.correo)} || '%'`);
    if (f.etapa) where.push(`etapa = ${ph(f.etapa)}`);
    if (f.canal) { const n = ph(f.canal); where.push(`(canal = ${n} OR redes ? ${n})`); }
    if (f.desde) where.push(`${enLima}::date >= ${ph(f.desde)}::date`);
    if (f.hasta) where.push(`${enLima}::date <= ${ph(f.hasta)}::date`);
    if (f.horaDesde !== null) where.push(`EXTRACT(HOUR FROM ${enLima}) >= ${ph(f.horaDesde)}`);
    if (f.horaHasta !== null) where.push(`EXTRACT(HOUR FROM ${enLima}) <= ${ph(f.horaHasta)}`);
    if (f.etiqueta) where.push(`etiquetas ? ${ph(f.etiqueta)}`);
    if (f.sinRespuesta) where.push(`ultimo_entrante IS NOT NULL AND ultimo_entrante < NOW() - (${ph(String(f.sinRespuesta))} || ' hours')::interval`);
    if (f.seguimiento) where.push("EXISTS (SELECT 1 FROM crm_seguimientos s WHERE s.contacto_id = crm_contactos.id AND s.estado IN ('pendiente','requiere_plantilla'))");
    return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', val, f };
  }

  const COLUMNAS = 'id, canal, identificador, nombre, telefono, correo, direccion, redes, origen, etiquetas, etapa, ultimo_entrante, ultimo_saliente, conv_id, TO_CHAR(creado AT TIME ZONE \'America/Lima\', \'YYYY-MM-DD HH24:MI\') AS creado, TO_CHAR(actualizado, \'YYYY-MM-DD HH24:MI\') AS actualizado';

  async function listar(p) {
    const f = filtrosDe(p);
    const filas = (await client.query(`SELECT ${COLUMNAS} FROM crm_contactos ${f.sql} ORDER BY COALESCE(ultimo_entrante, actualizado) DESC LIMIT 300`, f.val)).rows;
    return { contactos: filas, etapas: await etapas(), canales: CANALES };
  }

  // Exporta a Excel las personas que se ven con los mismos filtros de la lista.
  async function exportar(p) {
    const f = filtrosDe(p);
    const nombresEtapa = Object.fromEntries((await etapas()).map(e => [e.clave, e.nombre]));
    const filas = (await client.query(`SELECT nombre, canal, etapa, telefono, correo, direccion, redes, etiquetas, notas, origen,
        TO_CHAR(creado AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS alta,
        TO_CHAR(ultimo_entrante AT TIME ZONE 'America/Lima', 'YYYY-MM-DD HH24:MI') AS ultimo
      FROM crm_contactos ${f.sql} ORDER BY COALESCE(ultimo_entrante, creado) DESC LIMIT 5000`, f.val)).rows;
    const fila = valores => Object.fromEntries(valores.map((v, i) => [i + 1, { v: v === null || v === undefined ? '' : String(v) }]));
    const cab = ['Nombre', 'Canal', 'Etapa', 'Teléfono', 'Correo', 'Dirección', 'Instagram', 'Messenger (Facebook)', 'TikTok', 'Etiquetas', 'Notas', 'Origen', 'Alta', 'Último mensaje del cliente'];
    const cuerpo = filas.map(r => fila([r.nombre, CANALES[r.canal] || r.canal, nombresEtapa[r.etapa] || r.etapa, r.telefono, r.correo, r.direccion,
      (r.redes || {}).instagram, (r.redes || {}).messenger, (r.redes || {}).tiktok, (r.etiquetas || []).join(', '), r.notas, r.origen, r.alta, r.ultimo]));
    return escribirExcel([{ nombre: 'Contactos', filas: [fila(cab), ...cuerpo] }]);
  }

  // Tablero: columnas por etapa, con el total real de cada una.
  async function tablero(p) {
    const f = filtrosDe(p);
    const cols = await etapas();
    const filas = (await client.query(`SELECT ${COLUMNAS} FROM crm_contactos ${f.sql} ORDER BY COALESCE(ultimo_entrante, actualizado) DESC LIMIT 1200`, f.val)).rows;
    const pendientes = (await client.query(`SELECT contacto_id, COUNT(*)::int AS n FROM crm_seguimientos WHERE estado IN ('pendiente','requiere_plantilla') GROUP BY contacto_id`)).rows;
    const pend = Object.fromEntries(pendientes.map(r => [r.contacto_id, r.n]));
    const conVisita = Object.fromEntries((await client.query(`SELECT contacto_id, COUNT(*)::int AS n FROM crm_citas WHERE estado = 'programada' AND cuando >= NOW() GROUP BY contacto_id`)).rows.map(r => [r.contacto_id, r.n]));
    const ahora = Date.now();
    const conEstado = filas.map(x => ({ ...x, seguimientos: pend[x.id] || 0, estado_auto: estadoAutoDe(x, conVisita[x.id] || 0, ahora), prioridad: prioridadDe(x, ahora) }));
    return {
      columnas: cols.map(c => {
        const de = conEstado.filter(x => x.etapa === c.clave);
        return { clave: c.clave, nombre: c.nombre, activa: c.activa, total: de.length, contactos: de.slice(0, 80) };
      }),
      porEstado: ['te_toca', 'con_visita', 'con_asistente'].map(k => {
        const de = conEstado.filter(x => x.estado_auto === k);
        return { clave: k, total: de.length, contactos: de.slice(0, 80) };
      }),
      total: filas.length
    };
  }

  async function ver(id) {
    const c = (await client.query('SELECT * FROM crm_contactos WHERE id = $1', [id])).rows[0];
    if (!c) throw error('Ese contacto ya no existe.', 404);
    const mensajes = (await client.query(`SELECT id, direccion, texto, creado FROM crm_mensajes WHERE contacto_id = $1 ORDER BY creado DESC LIMIT 300`, [id])).rows;
    const historial = (await client.query(`SELECT id, tipo, detalle, quien, creado FROM crm_historial WHERE contacto_id = $1 ORDER BY creado DESC LIMIT 300`, [id])).rows;
    const seguimientos = (await client.query(`SELECT id, plazo, cuando, mensaje, estado, resultado, quien, creado, enviado FROM crm_seguimientos WHERE contacto_id = $1 ORDER BY cuando DESC LIMIT 50`, [id])).rows;
    const citas = (await client.query(`SELECT id, cuando, nota, estado FROM crm_citas WHERE contacto_id = $1 ORDER BY cuando DESC LIMIT 50`, [id])).rows;
    return { contacto: c, mensajes, historial, seguimientos, citas, ventana_abierta: ventanaAbierta(c), prioridad: prioridadDe(c) };
  }

  // Redes de la ficha: solo las claves conocidas y texto corto.
  function redesDe(r) {
    const salida = {};
    for (const k of REDES_CRM) { const v = texto(r && r[k], 120); if (v) salida[k] = v; }
    return salida;
  }

  async function guardar(f, u) {
    const canal = Object.prototype.hasOwnProperty.call(CANALES, f.canal) ? f.canal : 'manual';
    const etapa = texto(f.etapa, 60) || 'nuevo';
    if (!(await client.query('SELECT 1 FROM crm_etapas WHERE clave = $1 AND activa', [etapa])).rowCount) throw error('Esa etapa no existe o está apagada.');
    const nombre = texto(f.nombre, 120);
    const identificador = texto(f.identificador || f.telefono || f.correo || nombre, 120);
    if (!identificador) throw error('Escribe al menos el nombre, teléfono o correo de la persona.');
    const etiquetas = JSON.stringify(etiquetasDe(f.etiquetas));
    const redes = redesDe(f.redes);
    const v = [canal, identificador, nombre, texto(f.telefono, 40), texto(f.correo, 120), texto(f.origen, 120), etiquetas, etapa, texto(f.notas, 2000), texto(f.direccion, 300), JSON.stringify(redes)];
    const id = Number(f.id) || 0;
    if (id) {
      const previo = (await client.query('SELECT etapa, etiquetas, nombre, telefono, correo, direccion, redes FROM crm_contactos WHERE id = $1', [id])).rows[0];
      if (!previo) throw error('Ese contacto ya no existe.', 404);
      try {
        await client.query(`UPDATE crm_contactos SET canal=$1, identificador=$2, nombre=$3, telefono=$4, correo=$5,
          origen=$6, etiquetas=$7::jsonb, etapa=$8, notas=$9, direccion=$10, redes=$11::jsonb, actualizado=NOW() WHERE id=$12`, [...v, id]);
      } catch (e) {
        if (e.code === '23505') throw error('Ya existe otra persona con ese dato en este canal.', 409);
        throw e;
      }
      // Historial: qué datos de la persona cambiaron (quién y cuándo queda en el historial).
      const cambiosDatos = [['nombre', nombre, previo.nombre], ['teléfono', v[3], previo.telefono], ['correo', v[4], previo.correo], ['dirección', v[9], previo.direccion]]
        .filter(([, nuevo, viejo]) => String(nuevo) !== String(viejo || '')).map(([k]) => k);
      if (JSON.stringify(redes) !== JSON.stringify(previo.redes || {})) cambiosDatos.push('redes sociales');
      if (cambiosDatos.length) await histo(id, 'datos', `Cambió: ${cambiosDatos.join(', ')}`, quien(u));
      if (previo.etapa !== etapa) {
        const nombreEtapa = (await client.query('SELECT nombre FROM crm_etapas WHERE clave = $1', [etapa])).rows[0].nombre;
        await histo(id, 'etapa', `Pasó a ${nombreEtapa}`, quien(u));
      }
      if (JSON.stringify(previo.etiquetas) !== etiquetas) await histo(id, 'etiquetas', `Etiquetas: ${etiquetasDe(f.etiquetas).join(', ') || 'ninguna'}`, quien(u));
      await registrar(u, 'crm_contactos', 'crm', nombre || identificador, '', '', 'editado');
      return { id };
    }
    const existe = (await client.query('SELECT id FROM crm_contactos WHERE canal = $1 AND identificador = $2', [canal, identificador])).rows[0];
    if (existe) throw error('Ya existe una persona con ese dato en este canal.', 409);
    const r = await client.query(`INSERT INTO crm_contactos (canal, identificador, nombre, telefono, correo, origen, etiquetas, etapa, notas, direccion, redes)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb) RETURNING id`, v);
    await histo(r.rows[0].id, 'creado', `Persona creada (${CANALES[canal]})`, quien(u));
    await registrar(u, 'crm_contactos', 'crm', nombre || identificador, '', '', 'creado');
    return { id: r.rows[0].id };
  }

  async function moverEtapa(f, u) {
    const id = Number(f.id) || 0;
    const etapa = texto(f.etapa, 60);
    if (!(await client.query('SELECT 1 FROM crm_etapas WHERE clave = $1 AND activa', [etapa])).rowCount) throw error('Esa etapa no existe o está apagada.');
    const previo = (await client.query('SELECT etapa FROM crm_contactos WHERE id = $1', [id])).rows[0];
    if (!previo) throw error('Ese contacto ya no existe.', 404);
    if (previo.etapa === etapa) return { ok: true };
    await client.query('UPDATE crm_contactos SET etapa = $2, actualizado = NOW() WHERE id = $1', [id, etapa]);
    const nombreEtapa = (await client.query('SELECT nombre FROM crm_etapas WHERE clave = $1', [etapa])).rows[0].nombre;
    await histo(id, 'etapa', `Pasó a ${nombreEtapa}`, quien(u));
    return { ok: true };
  }

  async function nota(f, u) {
    const contacto = Number(f.contacto_id) || 0;
    const direccion = DIRECCIONES.includes(f.direccion) ? f.direccion : 'nota';
    const t = texto(f.texto, 2000);
    if (!contacto) throw error('Falta la persona.');
    if (!t) throw error('Escribe el mensaje o la nota.');
    const existe = (await client.query('SELECT 1 FROM crm_contactos WHERE id = $1', [contacto])).rowCount;
    if (!existe) throw error('Ese contacto ya no existe.', 404);
    await client.query('INSERT INTO crm_mensajes (contacto_id, direccion, texto) VALUES ($1, $2, $3)', [contacto, direccion, t]);
    await client.query('UPDATE crm_contactos SET actualizado = NOW() WHERE id = $1', [contacto]);
    await histo(contacto, direccion === 'nota' ? 'nota' : 'mensaje', direccion === 'nota' ? 'Nota interna' : (direccion === 'entrante' ? 'Mensaje del cliente (manual)' : 'Mensaje enviado (manual)'), quien(u));
    return { ok: true };
  }

  // ---------- Seguimientos ----------
  async function programar(f, u) {
    const id = Number(f.contacto_id) || 0;
    const plazo = texto(f.plazo, 4);
    if (!PLAZOS[plazo]) throw error('Elige 24 h, 48 h, 2 semanas o 1 mes.');
    if (!(await client.query('SELECT 1 FROM crm_contactos WHERE id = $1', [id])).rowCount) throw error('Ese contacto ya no existe.', 404);
    const cuando = new Date(Date.now() + PLAZOS[plazo]);
    const r = await client.query(`INSERT INTO crm_seguimientos (contacto_id, plazo, cuando, mensaje, quien) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [id, plazo, cuando, texto(f.mensaje, 1000), quien(u)]);
    const etiqueta = { '24h': '24 horas', '48h': '48 horas', '2s': '2 semanas', '1m': '1 mes' }[plazo];
    await histo(id, 'seguimiento', `Seguimiento programado a ${etiqueta}`, quien(u));
    return { id: r.rows[0].id, cuando };
  }

  async function cancelarSeguimiento(f, u) {
    const id = Number(f.id) || 0;
    const r = await client.query(`UPDATE crm_seguimientos SET estado = 'cancelado' WHERE id = $1 AND estado IN ('pendiente','requiere_plantilla') RETURNING contacto_id`, [id]);
    if (!r.rows[0]) throw error('Ese seguimiento ya no está pendiente.');
    await histo(r.rows[0].contacto_id, 'seguimiento', 'Seguimiento cancelado', quien(u));
    return { ok: true };
  }

  async function seguimientosPendientes() {
    return (await client.query(`SELECT s.id, s.contacto_id, s.plazo, s.cuando, s.estado, s.mensaje, c.nombre, c.canal, c.telefono
      FROM crm_seguimientos s JOIN crm_contactos c ON c.id = s.contacto_id
      WHERE s.estado IN ('pendiente','requiere_plantilla') ORDER BY s.cuando LIMIT 200`)).rows;
  }

  // Redacta el texto de un seguimiento con la IA (si hay clave) a partir de la conversación. Sin clave, usa un texto base.
  async function redactarSeguimiento(c) {
    const base = `Hola ${c.nombre || ''}`.trim().replace(/ $/, '') + ', ¿pudiste revisar lo que hablamos? Con gusto te ayudo a seguir.';
    const clave = claveIA ? await claveIA().catch(() => '') : '';
    if (!clave) return base;
    const hist = (await client.query('SELECT direccion, texto FROM crm_mensajes WHERE contacto_id = $1 ORDER BY creado DESC LIMIT 12', [c.id])).rows.reverse();
    const conv = hist.map(m => `${m.direccion === 'entrante' ? 'Cliente' : 'Nosotros'}: ${m.texto}`).join('\n');
    const r = await llamarIA(clave, 'Escribe un seguimiento breve y amable para retomar la conversación con esta persona, en su idioma. No inventes precios, fechas ni promociones. Máximo 3 frases. Responde solo con el texto del mensaje.', conv || 'Sin conversación previa.');
    return r || base;
  }

  async function llamarIA(clave, sistema, usuario) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + clave, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'anthropic/claude-haiku-5.5', messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }], max_tokens: 300 }),
        signal: AbortSignal.timeout(20000)
      });
      if (!r.ok) return '';
      const d = await r.json();
      return String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
    } catch (e) { return ''; }
  }

  // Etiquetas automáticas: la IA propone de la lista; sin IA se usan palabras clave.
  async function etiquetarMensaje(contactoId, textoMensaje) {
    const t = texto(textoMensaje, 1500);
    if (!t) return [];
    let propuestas = [];
    const clave = claveIA ? await claveIA().catch(() => '') : '';
    // Si la IA responde, manda ella. Si no hay clave o la llamada falla, se usan las palabras clave.
    const r = clave ? await llamarIA(clave, `Clasifica el mensaje de una persona interesada en nuestro negocio. Elige solo etiquetas de esta lista: ${ETIQUETAS_IA.join(', ')}. Responde solo un arreglo JSON de texto, por ejemplo ["pidió precio"]. Si no aplica ninguna, responde [].`, t) : '';
    if (r) {
      try { const m = r.match(/\[[\s\S]*\]/); propuestas = m ? JSON.parse(m[0]) : []; } catch (e) { propuestas = []; }
    } else {
      propuestas = PALABRAS.filter(([re]) => re.test(t)).map(([, etq]) => etq);
    }
    propuestas = propuestas.filter(x => typeof x === 'string' && ETIQUETAS_IA.includes(x.toLowerCase())).map(x => x.toLowerCase());
    if (!propuestas.length) return [];
    const fila = (await client.query('SELECT etiquetas FROM crm_contactos WHERE id = $1', [contactoId])).rows[0];
    if (!fila) return [];
    const actuales = Array.isArray(fila.etiquetas) ? fila.etiquetas : [];
    const nuevas = propuestas.filter(x => !actuales.includes(x));
    if (!nuevas.length) return [];
    const todas = [...actuales, ...nuevas].slice(0, 20);
    await client.query('UPDATE crm_contactos SET etiquetas = $2::jsonb, etiquetado_en = NOW() WHERE id = $1', [contactoId, JSON.stringify(todas)]);
    await histo(contactoId, 'etiquetas', `La IA agregó: ${nuevas.join(', ')}`, 'IA');
    return nuevas;
  }

  // Envía un texto por Chatwoot (la misma conexión de Operaciones).
  async function enviarChatwoot(conv, mensaje) {
    const cw = chatwoot ? await chatwoot() : null;
    if (!cw || !cw.url || !cw.cuenta || !cw.token) throw error('Chatwoot no está configurado.', 502);
    const r = await fetch(`${String(cw.url).replace(/\/$/, '')}/api/v1/accounts/${encodeURIComponent(cw.cuenta)}/conversations/${conv}/messages`, {
      method: 'POST', headers: { api_access_token: cw.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: mensaje, message_type: 'outgoing', private: false }), signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw error(`Chatwoot respondió ${r.status}.`, 502);
    return r.json();
  }

  // Temporizador: envía los seguimientos cuya hora ya llegó.
  async function procesarSeguimientos() {
    const vencidos = (await client.query(`SELECT s.id, s.contacto_id, s.mensaje FROM crm_seguimientos s
      WHERE s.estado = 'pendiente' AND s.cuando <= NOW() ORDER BY s.cuando LIMIT 20`)).rows;
    for (const s of vencidos) {
      const c = (await client.query('SELECT * FROM crm_contactos WHERE id = $1', [s.contacto_id])).rows[0];
      if (!c) { await client.query("UPDATE crm_seguimientos SET estado = 'omitido', resultado = 'La persona ya no existe' WHERE id = $1", [s.id]); continue; }
      if (!c.conv_id) { await client.query("UPDATE crm_seguimientos SET estado = 'omitido', resultado = 'Sin conversación en Chatwoot' WHERE id = $1", [s.id]); continue; }
      if (!ventanaAbierta(c)) {
        // Fuera de las 24 h: Meta solo deja enviar plantillas aprobadas. Queda pendiente para revisarlo.
        await client.query(`UPDATE crm_seguimientos SET estado = 'requiere_plantilla', resultado = 'Pasó la ventana de 24 h: se necesita una plantilla aprobada' WHERE id = $1`, [s.id]);
        await histo(c.id, 'seguimiento', 'Seguimiento vencido: requiere plantilla aprobada de Meta', 'sistema');
        continue;
      }
      try {
        const mensaje = s.mensaje || await redactarSeguimiento(c);
        await enviarChatwoot(c.conv_id, mensaje);
        await client.query(`INSERT INTO crm_mensajes (contacto_id, direccion, texto) VALUES ($1, 'saliente', $2)`, [c.id, mensaje]);
        await client.query("UPDATE crm_seguimientos SET estado = 'enviado', enviado = NOW(), mensaje = $2, resultado = 'Enviado por la IA' WHERE id = $1", [s.id, mensaje]);
        await histo(c.id, 'seguimiento', 'Seguimiento enviado (IA)', 'IA');
      } catch (e) {
        await client.query("UPDATE crm_seguimientos SET estado = 'error', resultado = $2 WHERE id = $1", [s.id, texto(e.message, 200)]);
        await histo(c.id, 'seguimiento', 'Seguimiento no enviado: ' + texto(e.message, 120), 'sistema');
      }
    }
  }

  // Vuelve a etiquetar con la IA a partir del último mensaje del cliente.
  async function etiquetarManual(f, u) {
    const id = Number(f.id) || 0;
    const m = (await client.query("SELECT texto FROM crm_mensajes WHERE contacto_id = $1 AND direccion = 'entrante' ORDER BY creado DESC LIMIT 1", [id])).rows[0];
    if (!m) throw error('Esa persona todavía no tiene mensajes del cliente.');
    return { nuevas: await etiquetarMensaje(id, m.texto) };
  }

  // ---------- Chatwoot ----------
  const CANAL_CHATWOOT = { 'Channel::Whatsapp': 'whatsapp', 'Channel::FacebookPage': 'messenger', 'Channel::Instagram': 'instagram', 'Channel::Tiktok': 'tiktok', 'Channel::WebWidget': 'web' };
  let sincronizando = false;
  async function sincronizarAutomatica() {
    if (sincronizando || !chatwoot) return;
    const cw = await chatwoot().catch(() => null);
    if (!cw || !cw.url || !cw.cuenta || !cw.token) return;
    sincronizando = true;
    try { await sincronizar({ usuario: 'sistema', nombre: 'Sistema' }, { automatica: true }); }
    finally { sincronizando = false; }
  }

  async function sincronizar(u, { automatica = false } = {}) {
    const cw = chatwoot ? await chatwoot() : null;
    if (!cw || !cw.url || !cw.cuenta || !cw.token) throw error('Chatwoot no está configurado en esta empresa. El Programador lo configura en Operaciones (WhatsApp).');
    const base = String(cw.url).replace(/\/$/, '') + '/api/v1/accounts/' + encodeURIComponent(cw.cuenta);
    const pedir = async ruta => {
      let r;
      try {
        r = await fetch(base + ruta, { headers: { api_access_token: cw.token }, signal: AbortSignal.timeout(15000) });
      } catch (e) {
        throw error(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Chatwoot no respondió en 15 segundos.' : 'No hay conexión con Chatwoot: ' + e.message, 502);
      }
      if (!r.ok) throw error(`Chatwoot respondió ${r.status}${r.status === 401 ? ' (token no válido)' : ''}.`, 502);
      return r.json();
    };
    let contactosNuevos = 0, mensajesNuevos = 0, conversaciones = 0, etiquetas = 0;
    for (let pagina = 1; pagina <= (automatica ? 1 : PAGINAS_MAX); pagina++) {
      const lista = (await pedir(`/conversations?status=all&page=${pagina}`))?.data?.payload || [];
      for (const conv of lista) {
        const sender = conv.meta && conv.meta.sender;
        if (!sender) continue;
        conversaciones++;
        const canal = CANAL_CHATWOOT[(conv.meta && conv.meta.channel) || ''] || 'web';
        const telefono = String(sender.phone_number || '');
        const identificador = canal === 'whatsapp' && telefono ? telefono.replace(/\D/g, '') : (sender.identifier || ('cw-' + sender.id));
        const r = await client.query(`INSERT INTO crm_contactos (canal, identificador, nombre, telefono, correo, origen, conv_id, redes)
          VALUES ($1, $2, $3, $4, $5, 'Chatwoot', $6, $7::jsonb)
          ON CONFLICT (canal, identificador) DO UPDATE SET
            nombre = CASE WHEN crm_contactos.nombre = '' THEN EXCLUDED.nombre ELSE crm_contactos.nombre END,
            telefono = CASE WHEN crm_contactos.telefono = '' THEN EXCLUDED.telefono ELSE crm_contactos.telefono END,
            correo = CASE WHEN crm_contactos.correo = '' THEN EXCLUDED.correo ELSE crm_contactos.correo END,
            redes = crm_contactos.redes || EXCLUDED.redes,
            conv_id = EXCLUDED.conv_id
          RETURNING id, (xmax = 0) AS nuevo`, [canal, identificador, texto(sender.name, 120), texto(telefono, 40), texto(sender.email, 120), conv.id, JSON.stringify(redesDeCanal(canal, identificador))]);
        const contactoId = r.rows[0].id;
        if (r.rows[0].nuevo) { contactosNuevos++; await histo(contactoId, 'creado', `Llegó por ${CANALES[canal]} (Chatwoot)`, 'Chatwoot'); }
        const mensajes = (await pedir(`/conversations/${conv.id}/messages`))?.payload || [];
        let ultimoEntranteNuevo = null;
        for (const m of mensajes) {
          if (![0, 1].includes(m.message_type) || m.private || !texto(m.content, 2000)) continue;
          const entrante = m.message_type === 0;
          const ins = await client.query(`INSERT INTO crm_mensajes (contacto_id, direccion, texto, creado, ref)
            VALUES ($1, $2, $3, TO_TIMESTAMP($4), $5) ON CONFLICT (contacto_id, ref) WHERE ref <> '' DO NOTHING RETURNING id`,
            [contactoId, entrante ? 'entrante' : 'saliente', texto(m.content, 2000), Number(m.created_at) || Date.now() / 1000, 'cw-' + m.id]);
          if (ins.rowCount) {
            mensajesNuevos++;
            if (entrante) ultimoEntranteNuevo = texto(m.content, 1500);
          }
        }
        // Últimos mensajes de cada lado (para la ventana de 24 h y los seguimientos).
        await client.query(`UPDATE crm_contactos SET
            ultimo_entrante = (SELECT MAX(creado) FROM crm_mensajes WHERE contacto_id = $1 AND direccion = 'entrante'),
            ultimo_saliente = (SELECT MAX(creado) FROM crm_mensajes WHERE contacto_id = $1 AND direccion = 'saliente'),
            actualizado = GREATEST(actualizado, COALESCE((SELECT MAX(creado) FROM crm_mensajes WHERE contacto_id = $1), actualizado))
          WHERE id = $1`, [contactoId]);
        // Etiquetas automáticas solo para mensajes nuevos del cliente (no se gastan IA en historial viejo).
        if (ultimoEntranteNuevo) etiquetas += (await etiquetarMensaje(contactoId, ultimoEntranteNuevo)).length;
      }
      if (lista.length < PAGINA_CHATWOOT) break;
    }
    const resumen = { contactos_nuevos: contactosNuevos, mensajes_nuevos: mensajesNuevos, conversaciones, etiquetas_ia: etiquetas, en: new Date().toISOString() };
    await client.query(`INSERT INTO crm_config (clave, valor) VALUES ('sincronizacion', $1)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [JSON.stringify(resumen)]);
    if (!automatica) await registrar(u, 'crm_contactos', 'crm', 'Chatwoot', '', '', 'sincronizado');
    return resumen;
  }

  async function guardarEtapas(f, u) {
    if (!puedeEditarEtapas(u)) throw error('Solo el Programador o quien tenga «Configurar empresa» puede cambiar las etapas.', 403);
    const lista = Array.isArray(f.etapas) ? f.etapas.slice(0, 20) : [];
    if (!lista.length) throw error('Debe quedar al menos una etapa.');
    if (!lista.some(e => e && e.activa !== false && texto(e.nombre, 40))) throw error('Debe quedar al menos una etapa activa.');
    const existentes = (await client.query('SELECT clave FROM crm_etapas')).rows.map(r => r.clave);
    const usadas = new Set();
    for (const [i, e] of lista.entries()) {
      const nombre = texto(e && e.nombre, 40);
      if (!nombre) throw error('Cada etapa necesita un nombre.');
      let clave = texto(e.clave, 60);
      if (!clave || !existentes.includes(clave)) {
        const base = claveDe(nombre); clave = base; let n = 2;
        while (existentes.includes(clave) || usadas.has(clave)) clave = base + '_' + (n++);
      }
      if (usadas.has(clave)) throw error('Hay dos etapas con el mismo nombre.');
      usadas.add(clave);
      await client.query(`INSERT INTO crm_etapas (clave, nombre, orden, activa) VALUES ($1, $2, $3, $4)
        ON CONFLICT (clave) DO UPDATE SET nombre = EXCLUDED.nombre, orden = EXCLUDED.orden, activa = EXCLUDED.activa`,
        [clave, nombre, i + 1, e.activa !== false]);
    }
    await client.query('UPDATE crm_etapas SET activa = FALSE WHERE NOT (clave = ANY($1::text[]))', [[...usadas]]);
    await client.query(`INSERT INTO crm_config (clave, valor) VALUES ('etapas_revisadas', 'true') ON CONFLICT (clave) DO UPDATE SET valor = 'true'`);
    await registrar(u, 'crm_etapas', 'crm', 'etapas', '', '', 'editadas');
    return { ok: true };
  }

  // ---------- «Te toca a ti» (CRM-2), citas (CRM-5), acciones, novedades, ajustes y reintento (CRM-4, CRM-8) ----------
  async function hoy() {
    const ahora = Date.now();
    const sinResponder = (await client.query(`SELECT ${COLUMNAS} FROM crm_contactos WHERE ultimo_entrante IS NOT NULL AND (ultimo_saliente IS NULL OR ultimo_saliente < ultimo_entrante) ORDER BY ultimo_entrante ASC LIMIT 200`)).rows;
    const prioridades = sinResponder.map(c => ({ ...c, prioridad: prioridadDe(c, ahora) })).filter(x => x.prioridad)
      .sort((a, b) => b.prioridad.horas - a.prioridad.horas).slice(0, 30);
    const inicio = new Date(); inicio.setHours(0, 0, 0, 0);
    const fin = new Date(inicio.getTime() + 2 * 24 * HORA_MS);
    const citas = (await client.query(`SELECT k.id, k.cuando, k.nota, c.id AS contacto_id, c.nombre, c.telefono, c.correo, c.identificador FROM crm_citas k JOIN crm_contactos c ON c.id = k.contacto_id WHERE k.estado = 'programada' AND k.cuando >= $1 AND k.cuando < $2 ORDER BY k.cuando`, [inicio.toISOString(), fin.toISOString()])).rows;
    const seguimientos = (await client.query(`SELECT s.id, s.cuando, s.mensaje, c.id AS contacto_id, c.nombre, c.telefono, c.correo, c.identificador FROM crm_seguimientos s JOIN crm_contactos c ON c.id = s.contacto_id WHERE s.estado IN ('pendiente','requiere_plantilla') AND s.cuando < $1 ORDER BY s.cuando LIMIT 30`, [fin.toISOString()])).rows;
    return { prioridades, citas, seguimientos };
  }
  async function guardarCita(f, u) {
    const id = Number(f.contacto_id) || 0;
    if (!(await client.query('SELECT 1 FROM crm_contactos WHERE id = $1', [id])).rowCount) throw error('Esa persona ya no existe.', 404);
    const cuando = new Date(String(f.cuando || ''));
    if (Number.isNaN(cuando.getTime())) throw error('Elige la fecha y la hora de la visita.');
    const nota = texto(f.nota, 300);
    const r = await client.query(`INSERT INTO crm_citas (contacto_id, cuando, nota) VALUES ($1, $2, $3) RETURNING id`, [id, cuando.toISOString(), nota]);
    await histo(id, 'cita', `Visita programada para ${cuando.toLocaleString('es-PE', { timeZone: 'America/Lima' })}${nota ? ' · ' + nota : ''}`, quien(u));
    return { ok: true, id: r.rows[0].id };
  }
  async function cancelarCita(f, u) {
    const r = await client.query(`UPDATE crm_citas SET estado = 'cancelada' WHERE id = $1 AND estado = 'programada' RETURNING contacto_id`, [Number(f.id) || 0]);
    if (!r.rowCount) throw error('Esa visita ya no está programada.', 404);
    await histo(r.rows[0].contacto_id, 'cita', 'Visita cancelada', quien(u));
    return { ok: true };
  }
  async function accion(f, u) {
    const id = Number(f.id) || 0;
    const c = (await client.query('SELECT etiquetas FROM crm_contactos WHERE id = $1', [id])).rows[0];
    if (!c) throw error('Ese contacto ya no existe.', 404);
    const nuevas = etiquetasConAccion(c.etiquetas, texto(f.accion, 40));
    if (!nuevas) throw error('Esa acción no existe.');
    await client.query('UPDATE crm_contactos SET etiquetas = $2, actualizado = NOW() WHERE id = $1', [id, JSON.stringify(nuevas)]);
    await histo(id, 'etiqueta', `Acción: ${ACCIONES[f.accion].titulo}`, quien(u));
    return { ok: true, etiquetas: nuevas };
  }
  // Novedades para el aviso del panel: cuántas personas nuevas hay desde el último número visto.
  async function novedades(p) {
    const desde = Number(p.get('desde')) || 0;
    const r = (await client.query('SELECT COALESCE(MAX(id), 0)::int AS ultimo, COUNT(*) FILTER (WHERE id > $1)::int AS nuevos FROM crm_contactos', [desde])).rows[0];
    return { ultimo: r.ultimo, nuevos: r.nuevos, sonido: (await ajustesLeer()).sonido };
  }
  const AJUSTES_INICIALES = { sonido: true, modo_prueba: { activo: false, numeros: [] }, plantilla_retomar_aprobada: false };
  async function ajustesLeer() {
    const fila = (await client.query("SELECT valor FROM crm_config WHERE clave = 'ajustes_crm'")).rows[0];
    return { ...AJUSTES_INICIALES, ...(fila ? fila.valor : {}) };
  }
  async function ajustesGuardar(f, u) {
    const actual = await ajustesLeer();
    const nuevo = { ...actual, sonido: f.sonido === undefined ? actual.sonido : Boolean(f.sonido) };
    if (f.modo_prueba !== undefined) {
      if (!puedeEditarEtapas(u)) throw error('Solo el Programador o quien tenga «Configurar empresa» puede cambiar el modo prueba.', 403);
      const activo = Boolean(f.modo_prueba && f.modo_prueba.activo);
      const lista = revisarPermitidos((f.modo_prueba && f.modo_prueba.numeros) || []);
      if (lista.error && activo) throw error(lista.error);
      nuevo.modo_prueba = { activo, numeros: lista.numeros || [] };
    }
    if (f.plantilla_retomar_aprobada !== undefined) {
      if (!puedeEditarEtapas(u)) throw error('Solo el Programador o quien tenga «Configurar empresa» puede cambiar esto.', 403);
      nuevo.plantilla_retomar_aprobada = Boolean(f.plantilla_retomar_aprobada);
    }
    await client.query(`INSERT INTO crm_config (clave, valor) VALUES ('ajustes_crm', $1) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [JSON.stringify(nuevo)]);
    return nuevo;
  }
  // Reintento (CRM-4): solo después de 24 h. Necesita la plantilla «retomar_conversacion» aprobada por Meta.
  async function retomar(f, u) {
    const c = (await client.query(`SELECT ${COLUMNAS} FROM crm_contactos WHERE id = $1`, [Number(f.id) || 0])).rows[0];
    if (!c) throw error('Ese contacto ya no existe.', 404);
    if (ventanaAbierta(c)) throw error('La ventana de 24 h sigue abierta: puedes escribirle con normalidad.');
    if (!(await ajustesLeer()).plantilla_retomar_aprobada) {
      throw error('Falta la plantilla «retomar_conversacion» aprobada por Meta. Envíala a aprobar en Ajustes → Conexiones.', 409);
    }
    throw error('El envío de la plantilla todavía no está conectado. Pendiente en el hito CRM-4.', 501);
  }

  async function manejar(req, res, url, u, { json, leerCuerpo }) {
    if (!(await puede(u))) {
      if (u && u.grupo !== 'Programador' && !(await cuenta.tiene('crm'))) {
        return json(res, 403, { error: 'Tu empresa no tiene contratado el servicio CRM. Consulta con Kaizen IA.' });
      }
      return json(res, 403, { error: 'No tienes acceso al CRM. Pide al Programador que te dé el permiso «Ver CRM».' });
    }
    const p = new URL(req.url, 'http://localhost').searchParams;
    try {
      if (req.method === 'GET' && url === '/api/crm/estado') return json(res, 200, await estado(u));
      if (req.method === 'GET' && url === '/api/crm/tablero') return json(res, 200, await tablero(p));
      if (req.method === 'GET' && url === '/api/crm/contactos') return json(res, 200, await listar(p));
      if (req.method === 'GET' && url === '/api/crm/seguimientos') return json(res, 200, { seguimientos: await seguimientosPendientes() });
      const ficha = url.match(/^\/api\/crm\/contactos\/(\d+)$/);
      if (req.method === 'GET' && ficha) return json(res, 200, await ver(Number(ficha[1])));
      if (req.method === 'POST' && url === '/api/crm/contactos/guardar') return json(res, 200, await guardar(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/contactos/etapa') return json(res, 200, await moverEtapa(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/mensajes') return json(res, 200, await nota(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/seguimientos/programar') return json(res, 200, await programar(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/seguimientos/cancelar') return json(res, 200, await cancelarSeguimiento(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/etapas/guardar') return json(res, 200, await guardarEtapas(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/sincronizar') return json(res, 200, await sincronizar(u));
      if (req.method === 'POST' && url === '/api/crm/etiquetar') return json(res, 200, await etiquetarManual(await leerCuerpo(req), u));
      if (req.method === 'GET' && url === '/api/crm/hoy') return json(res, 200, await hoy());
      if (req.method === 'GET' && url === '/api/crm/novedades') return json(res, 200, await novedades(p));
      if (req.method === 'GET' && url === '/api/crm/ajustes') return json(res, 200, await ajustesLeer());
      if (req.method === 'POST' && url === '/api/crm/ajustes') return json(res, 200, await ajustesGuardar(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/citas/guardar') return json(res, 200, await guardarCita(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/citas/cancelar') return json(res, 200, await cancelarCita(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/accion') return json(res, 200, await accion(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/retomar') return json(res, 200, await retomar(await leerCuerpo(req), u));
      if (req.method === 'GET' && url === '/api/crm/exportar') {
        const libro = await exportar(p);
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="contactos-${new Date().toISOString().slice(0, 10)}.xlsx"`, 'Cache-Control': 'no-store' });
        return res.end(libro);
      }
      return json(res, 404, { error: 'No existe esa ruta del CRM.' });
    } catch (e) {
      if (!e.codigo) console.log('CRM:', e.message);
      return json(res, e.codigo || 500, { error: e.codigo ? e.message : 'No se pudo guardar en el CRM. Revisa tu conexión e inténtalo de nuevo; si sigue, avisa al Programador.' });
    }
  }

  return { preparar, puede, estadoPublico, manejar, procesarSeguimientos, etiquetarMensaje, _probar: { filtrosDe, PALABRAS, PLAZOS, prioridadDe, estadoAutoDe, etiquetasConAccion, revisarPermitidos, ACCIONES, MAX_PERMITIDOS } };
};
