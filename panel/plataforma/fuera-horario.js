// Respuesta automática fuera de horario (pedido del dueño, 28 nov).
// A quien manda una reserva (o un cambio de reserva) a operaciones@ fuera del horario de atención se le responde,
// dentro de la misma conversación, que la recibimos y que mañana (o el lunes) un asesor la revisa.
// Una sola respuesta por remitente cada 12 horas; nunca a correos automáticos (noreply, rebotes, otras respuestas automáticas).
'use strict';

const DESFASE_HORAS = -4;   // Punta Cana (America/Santo_Domingo): UTC-4 todo el año, sin horario de verano.
const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const POR_DEFECTO = { activo: true, buzon: '', dias: [1, 2, 3, 4, 5, 6], desde: 8, hasta: 19, whatsapp: '', firma: '' };
const HORAS_MAXIMO = 14;     // no se responde a correos de hace más de esto (ej. después de un apagón)
const HORAS_POR_REMITENTE = 12;

// Hora local de Punta Cana de una fecha: día de la semana, hora con decimales y la fecha (año, mes, día).
function local(fecha) {
  const d = new Date(new Date(fecha).getTime() + DESFASE_HORAS * 3600 * 1000);
  return { dia: d.getUTCDay(), hora: d.getUTCHours() + d.getUTCMinutes() / 60, anio: d.getUTCFullYear(), mes: d.getUTCMonth(), fechaDia: d.getUTCDate(), clave: d.toISOString().slice(0, 10) };
}
function abierto(cfg, fecha) {
  const l = local(fecha);
  return cfg.dias.includes(l.dia) && l.hora >= cfg.desde && l.hora < cfg.hasta;
}
// Cuándo vuelve a abrir la oficina después de esta fecha (fecha local del día de apertura).
function proximaApertura(cfg, fecha) {
  const l = local(fecha);
  if (cfg.dias.includes(l.dia) && l.hora < cfg.desde) return { ...l, diasDespues: 0 };
  for (let n = 1; n <= 7; n++) {
    const x = local(new Date(fecha).getTime() + n * 86400000);
    if (cfg.dias.includes(x.dia)) return { ...x, diasDespues: n };
  }
  return { ...l, diasDespues: 1 };
}
const horaTexto = (h, idioma) => {
  const hh = Math.floor(h), mm = String(Math.round((h - hh) * 60)).padStart(2, '0');
  const h12 = hh % 12 || 12;
  return idioma === 'en' ? `${h12}:${mm} ${hh < 12 ? 'a.m.' : 'p.m.'}` : `${h12}:${mm} ${hh < 12 ? 'a. m.' : 'p. m.'}`;
};
// «de lunes a sábado» / «Monday to Saturday» (o la lista si no son seguidos).
function diasTexto(dias, idioma) {
  const nombres = idioma === 'en' ? DIAS_EN : DIAS_ES;
  const orden = [1, 2, 3, 4, 5, 6, 0].filter(d => dias.includes(d));
  const seguidos = orden.every((d, i) => i === 0 || [1, 2, 3, 4, 5, 6, 0].indexOf(d) === [1, 2, 3, 4, 5, 6, 0].indexOf(orden[i - 1]) + 1);
  if (orden.length === 7) return idioma === 'en' ? 'every day' : 'todos los días';
  if (seguidos && orden.length > 2) return idioma === 'en' ? `${nombres[orden[0]]} to ${nombres[orden[orden.length - 1]]}` : `de ${nombres[orden[0]]} a ${nombres[orden[orden.length - 1]]}`;
  const lista = orden.map(d => nombres[d]);
  return lista.slice(0, -1).join(', ') + (lista.length > 1 ? (idioma === 'en' ? ' and ' : ' y ') : '') + lista[lista.length - 1];
}
function cuandoTexto(cfg, recibido, idioma) {
  const a = proximaApertura(cfg, recibido);
  if (idioma === 'en') {
    if (a.diasDespues === 0) return `Today from ${horaTexto(cfg.desde, 'en')}`;
    const fecha = `${DIAS_EN[a.dia]}, ${MESES_EN[a.mes]} ${a.fechaDia}`;
    return a.diasDespues === 1 ? `Tomorrow, ${fecha}, first thing in the morning` : `On ${fecha}, first thing in the morning`;
  }
  if (a.diasDespues === 0) return `Hoy a partir de las ${horaTexto(cfg.desde, 'es')}`;
  const fecha = `${DIAS_ES[a.dia]} ${a.fechaDia} de ${MESES_ES[a.mes]}`;
  return a.diasDespues === 1 ? `Mañana, ${fecha}, a primera hora` : `El ${fecha}, a primera hora`;
}

// Idioma del correo: inglés si tiene claramente más palabras en inglés que en español.
const PAL_EN = ['the', 'and', 'please', 'thank', 'thanks', 'booking', 'pickup', 'pick', 'arrival', 'departure', 'we', 'you', 'your', 'with', 'for', 'from', 'dear', 'regards', 'kind', 'guest', 'guests', 'adults', 'children', 'transfer', 'confirm', 'confirmation', 'is', 'are', 'will'];
const PAL_ES = ['el', 'la', 'los', 'las', 'por', 'para', 'gracias', 'reserva', 'llegada', 'salida', 'favor', 'saludos', 'buenas', 'buenos', 'con', 'del', 'de', 'estimado', 'estimados', 'traslado', 'adultos', 'niños', 'confirmar', 'es', 'son', 'que', 'una', 'un'];
function idiomaDe(texto) {
  const palabras = String(texto || '').toLowerCase().slice(0, 4000).match(/[a-záéíóúñü]+/g) || [];
  let en = 0, es = 0;
  for (const p of palabras) { if (PAL_EN.includes(p)) en++; if (PAL_ES.includes(p)) es++; }
  return en > es * 1.3 && en >= 3 ? 'en' : 'es';
}

// Remitentes a los que nunca se responde: sistemas automáticos y el propio buzón o dominio.
function motivoNoResponder(email, buzon, asunto) {
  if (!email) return 'sin correo válido';
  const e = email.toLowerCase();
  if (/(^|[._-])(no-?reply|do-?not-?reply|donotreply|noreply|mailer-daemon|postmaster|bounce[s]?|notification[s]?|notificaciones|alert[s]?)([._+-]|@)/.test(e)) return 'remitente automático';
  const dominio = String(buzon || '').toLowerCase().split('@')[1];
  if (dominio && e.endsWith('@' + dominio)) return 'es de la misma empresa';
  if (/^\s*(re:\s*)?(auto(matic)?[ -]?(reply|response)|respuesta autom|out of (the )?office|fuera de (la )?oficina|undeliverable|no se puede entregar|delivery status|mail delivery|returned mail)/i.test(asunto || '')) return 'respuesta automática o rebote';
  return '';
}

function armarTexto(cfg, { idioma, asunto, recibido, empresa }) {
  const cuando = cuandoTexto(cfg, recibido, idioma);
  const firma = String(cfg.firma || '').trim() || (idioma === 'en'
    ? `Operations Team\n${empresa || ''}\n${cfg.buzon}`.replace(/\n\n/g, '\n')
    : `Equipo de Operaciones\n${empresa || ''}\n${cfg.buzon}`.replace(/\n\n/g, '\n'));
  const asuntoCorto = String(asunto || '').replace(/^\s*((re|fw|fwd|rv)\s*:\s*)+/i, '').trim().slice(0, 120);
  if (idioma === 'en') {
    return [
      'Hello! 👋',
      '',
      `Thank you for writing to us. We have received your booking${asuntoCorto ? ` "${asuntoCorto}"` : ''} and it is safely saved with us.`,
      '',
      `Our team is currently out of office (we work ${diasTexto(cfg.dias, 'en')}, ${horaTexto(cfg.desde, 'en')} to ${horaTexto(cfg.hasta, 'en')}, Punta Cana time). ${cuando}, one of our agents will review it and get back to you with the confirmation.`,
      cfg.whatsapp ? `\nIf it is urgent (a service in the next few hours), please message us on WhatsApp at ${cfg.whatsapp}.` : '',
      '',
      'Have a great evening!',
      '',
      firma,
      '',
      '🔒 This is an automatic reply. We will never ask you for passwords or card details by email. There is no need to reply to this message.'
    ].join('\n').replace(/\n{3,}/g, '\n\n');
  }
  return [
    '¡Hola! 👋',
    '',
    `Gracias por escribirnos. Recibimos tu reserva${asuntoCorto ? ` «${asuntoCorto}»` : ''} y ya está guardada con nosotros.`,
    '',
    `En este momento nuestro equipo está fuera de horario (atendemos ${diasTexto(cfg.dias, 'es')}, de ${horaTexto(cfg.desde, 'es')} a ${horaTexto(cfg.hasta, 'es')}, hora de Punta Cana). ${cuando}, uno de nuestros asesores la revisa y te confirma.`,
    cfg.whatsapp ? `\nSi es una urgencia (un servicio en las próximas horas), escríbenos por WhatsApp al ${cfg.whatsapp}.` : '',
    '',
    '¡Que tengas muy buena noche!',
    '',
    firma,
    '',
    '🔒 Respuesta automática. Nunca te pediremos claves ni datos de tarjeta por correo. No hace falta responder este mensaje.'
  ].join('\n').replace(/\n{3,}/g, '\n\n');
}

function crearFueraHorario({ client, enviar, buzonesEnvio, emailDeRemitente, registrar }) {
  let listo = false;
  async function preparar() {
    if (listo) return;
    await client.query(`CREATE TABLE IF NOT EXISTS respuesta_fuera_horario (
      id INT PRIMARY KEY DEFAULT 1, activo BOOLEAN NOT NULL DEFAULT TRUE, buzon TEXT NOT NULL DEFAULT '',
      dias JSONB NOT NULL DEFAULT '[1,2,3,4,5,6]', desde NUMERIC NOT NULL DEFAULT 8, hasta NUMERIC NOT NULL DEFAULT 19,
      whatsapp TEXT NOT NULL DEFAULT '', firma TEXT NOT NULL DEFAULT '', actualizado TIMESTAMPTZ DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS respuestas_automaticas (
      message_id TEXT PRIMARY KEY, para TEXT NOT NULL DEFAULT '', asunto TEXT NOT NULL DEFAULT '', idioma TEXT NOT NULL DEFAULT '',
      enviado TIMESTAMPTZ NOT NULL DEFAULT NOW(), estado TEXT NOT NULL DEFAULT 'enviada', detalle TEXT NOT NULL DEFAULT '')`);
    await client.query('CREATE INDEX IF NOT EXISTS respuestas_automaticas_para ON respuestas_automaticas (para, enviado)');
    listo = true;
  }
  // El buzón de operaciones: el configurado, o el primero de envío por Microsoft que empiece con «operaciones@».
  async function ajustes() {
    await preparar();
    const fila = (await client.query('SELECT * FROM respuesta_fuera_horario WHERE id = 1')).rows[0];
    const buzones = buzonesEnvio();
    const deOperaciones = buzones.find(b => /^operaciones@/i.test(b)) || '';
    const cfg = fila ? { activo: fila.activo, buzon: fila.buzon, dias: (fila.dias || []).map(Number), desde: Number(fila.desde), hasta: Number(fila.hasta), whatsapp: fila.whatsapp, firma: fila.firma }
      : { ...POR_DEFECTO, activo: Boolean(deOperaciones) };
    if (!cfg.buzon || !buzones.includes(cfg.buzon)) cfg.buzon = deOperaciones;
    return { ...cfg, buzones, guardado: Boolean(fila) };
  }
  async function guardar(f, u) {
    await preparar();
    const buzones = buzonesEnvio();
    const dias = [...new Set((Array.isArray(f.dias) ? f.dias : []).map(Number).filter(d => d >= 0 && d <= 6))].sort();
    const desde = Number(f.desde), hasta = Number(f.hasta);
    if (!dias.length) throw Object.assign(new Error('Marca al menos un día de atención.'), { codigo: 400 });
    if (!(desde >= 0 && desde < 24 && hasta > desde && hasta <= 24)) throw Object.assign(new Error('Revisa el horario: la hora de cierre debe ser después de la de apertura.'), { codigo: 400 });
    if (f.buzon && !buzones.includes(f.buzon)) throw Object.assign(new Error('Ese buzón no está configurado para enviar correos.'), { codigo: 400 });
    const whatsapp = String(f.whatsapp || '').trim().slice(0, 40);
    if (whatsapp && !/^[+\d][\d ()-]{6,}$/.test(whatsapp)) throw Object.assign(new Error('El WhatsApp solo lleva números, espacios, +, ( ) y -.'), { codigo: 400 });
    await client.query(`INSERT INTO respuesta_fuera_horario (id, activo, buzon, dias, desde, hasta, whatsapp, firma, actualizado) VALUES (1, $1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id) DO UPDATE SET activo = $1, buzon = $2, dias = $3, desde = $4, hasta = $5, whatsapp = $6, firma = $7, actualizado = NOW()`,
      [Boolean(f.activo), String(f.buzon || ''), JSON.stringify(dias), desde, hasta, whatsapp, String(f.firma || '').slice(0, 600)]);
    if (registrar && u) await registrar(u, 'respuesta_fuera_horario', 'empresa', 1, '', '', `${f.activo ? 'Activa' : 'Apagada'} · ${diasTexto(dias, 'es')} ${horaTexto(desde, 'es')}–${horaTexto(hasta, 'es')}`);
    return ajustes();
  }
  async function empresaNombre() {
    return ((await client.query('SELECT nombre FROM empresa_datos WHERE id = 1').catch(() => ({ rows: [] }))).rows[0] || {}).nombre || '';
  }
  // Vista previa para la pantalla de ajustes.
  async function muestra(idioma = 'es', ahora = new Date()) {
    const cfg = await ajustes();
    // Ejemplo: una reserva que llega a las 8:30 p. m. del próximo día de atención.
    let recibido = new Date(ahora);
    for (let i = 0; i < 24 * 8; i++) {
      const t = new Date(Math.floor(ahora.getTime() / 3600000) * 3600000 + i * 3600000 + 30 * 60000), l = local(t);
      if (Math.floor(l.hora) === 20 && cfg.dias.includes(l.dia) && !abierto(cfg, t)) { recibido = t; break; }
    }
    return armarTexto(cfg, { idioma, asunto: idioma === 'en' ? 'Booking PAX Smith x2 - Arrival PUJ' : 'Reserva PAX Fernández Lucía x3', recibido, empresa: await empresaNombre() });
  }
  async function ultimas() {
    await preparar();
    return (await client.query("SELECT message_id, para, asunto, idioma, estado, detalle, TO_CHAR(enviado AT TIME ZONE 'America/Santo_Domingo', 'YYYY-MM-DD HH24:MI') AS enviado FROM respuestas_automaticas ORDER BY enviado DESC LIMIT 30")).rows;
  }

  let corriendo = false;
  async function revisar(ahora = new Date()) {
    if (corriendo) return;
    corriendo = true;
    try {
      const cfg = await ajustes();
      if (!cfg.activo || !cfg.buzon || abierto(cfg, ahora)) return;
      const filas = (await client.query(`SELECT DISTINCT ON (c.message_id) c.message_id, c.remitente, c.asunto, c.fecha, c.creado, LEFT(c.cuerpo, 4000) AS cuerpo
        FROM clasificacion c
        WHERE c.buzon = $1 AND c.categoria IN ('RESERVA', 'MODIFICACION') AND c.message_id IS NOT NULL AND c.message_id <> ''
          AND c.creado > NOW() - INTERVAL '${HORAS_MAXIMO} hours'
          AND NOT EXISTS (SELECT 1 FROM respuestas_automaticas r WHERE r.message_id = c.message_id)
        ORDER BY c.message_id, c.id LIMIT 40`, [cfg.buzon])).rows;
      const empresa = await empresaNombre();
      for (const c of filas) {
        const recibido = Date.parse(c.fecha) || new Date(c.creado).getTime();
        const para = emailDeRemitente(c.remitente);
        let motivo = '';
        if (abierto(cfg, recibido)) motivo = 'llegó en horario de atención';
        else if (ahora.getTime() - recibido > HORAS_MAXIMO * 3600000) motivo = 'es de hace más de ' + HORAS_MAXIMO + ' h';
        else motivo = motivoNoResponder(para, cfg.buzon, c.asunto);
        if (!motivo && (await client.query(`SELECT 1 FROM respuestas_automaticas WHERE para = $1 AND estado = 'enviada' AND enviado > NOW() - INTERVAL '${HORAS_POR_REMITENTE} hours' LIMIT 1`, [para])).rowCount) {
          motivo = 'ya se le respondió esta noche';
        }
        const idioma = idiomaDe(`${c.asunto || ''}\n${c.cuerpo || ''}`);
        // Primero se anota (así nunca se responde dos veces, aunque el servidor se reinicie a mitad).
        const nuevo = await client.query(`INSERT INTO respuestas_automaticas (message_id, para, asunto, idioma, estado, detalle) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (message_id) DO NOTHING`, [c.message_id, para || '', String(c.asunto || '').slice(0, 300), idioma, motivo ? 'omitida' : 'enviando', motivo]);
        if (!nuevo.rowCount || motivo) continue;
        try {
          await enviar({ accion: 'responder', buzon: cfg.buzon, message_id: c.message_id, texto: armarTexto(cfg, { idioma, asunto: c.asunto, recibido, empresa }) });
          await client.query("UPDATE respuestas_automaticas SET estado = 'enviada', enviado = NOW() WHERE message_id = $1", [c.message_id]);
        } catch (err) {
          await client.query("UPDATE respuestas_automaticas SET estado = 'error', detalle = $2 WHERE message_id = $1", [c.message_id, String(err.message || err).slice(0, 300)]);
        }
      }
    } finally { corriendo = false; }
  }
  return { ajustes, guardar, revisar, muestra, ultimas };
}

module.exports = { crearFueraHorario, abierto, proximaApertura, cuandoTexto, idiomaDe, motivoNoResponder, armarTexto, diasTexto, POR_DEFECTO };
