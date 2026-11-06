// Clasificación con IA: mismo texto, mismas reglas y mismas capturas que los nodos de n8n
// "Traducir correo", "Limpiar texto", "IA Claude" y "Code in JavaScript".

const MALAS = { 'Ã¡': 'á', 'Ã©': 'é', 'Ã­': 'í', 'Ã³': 'ó', 'Ãº': 'ú', 'Ã±': 'ñ', 'Ã‘': 'Ñ', 'Ã‰': 'É', 'Ã“': 'Ó', 'Ãš': 'Ú', 'Ã¼': 'ü', 'â€¢': '•', 'â€“': '–', 'â€œ': '"', 'â€\x9d': '"' };

function decodificar(s) {
  return String(s || '')
    .replace(/Ã[¡©­³º±‘‰“š¼]|â€[¢“œ\x9d]/g, m => MALAS[m] || m)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function htmlATexto(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

// Un mensaje de Microsoft Graph en el mismo formato que usaba n8n.
function desdeGraph(m, buzon) {
  const de = (m.from && m.from.emailAddress) || {};
  const cuerpo = (m.body && m.body.content) || '';
  return {
    id: m.id,
    buzon,
    from: decodificar(de.name ? `${de.name} <${de.address}>` : (de.address || '')),
    subject: decodificar(m.subject || ''),
    date: m.receivedDateTime || '',
    textPlain: decodificar(m.body && m.body.contentType === 'html' ? htmlATexto(cuerpo) : cuerpo)
  };
}

/* ---------- Capturas (Hito 2) ---------- */

const MAX_IMAGENES = 5;
const MIN_BASE64 = 16000;
const MAX_BASE64 = 5000000;
const MAX_BASE64_TOTAL = 15000000;
const REPETIDA_EN = 2;

function tipoReal(b64) {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR') && Buffer.from(b64.slice(0, 16), 'base64').toString('latin1').slice(8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function huella(b64) {
  const pasos = 64;
  let muestra = b64.length + ':';
  for (let i = 0; i < pasos; i++) muestra += b64.substr(Math.floor((b64.length - 8) * i / pasos), 8);
  let h = 2166136261;
  for (let i = 0; i < muestra.length; i++) { h ^= muestra.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36) + '-' + b64.length.toString(36);
}

// vistas(huella, id) devuelve en cuántos correos distintos apareció esa imagen (contando este).
async function elegirImagenes(id, adjuntos, vistas) {
  const elegidas = [];
  let total = 0;
  for (const a of adjuntos || []) {
    const b64 = typeof a.contentBytes === 'string' ? a.contentBytes : '';
    if (!b64 || b64.length < MIN_BASE64 || b64.length > MAX_BASE64) continue;
    const tipo = tipoReal(b64);
    if (!tipo) continue;
    const n = await vistas(huella(b64), id);
    if (n - 1 >= REPETIDA_EN) continue;
    if (elegidas.length >= MAX_IMAGENES || total + b64.length > MAX_BASE64_TOTAL) continue;
    total += b64.length;
    elegidas.push({ type: 'image_url', image_url: { url: `data:${tipo};base64,${b64}` } });
  }
  return elegidas;
}

/* ---------- Pedido a la IA ---------- */

// La empresa que recibe los correos: la IA no debe ponerla como agencia ni tomar sus teléfonos como del pasajero.
const PERFIL_SOMOS_VIAJES = { nombre: 'Somos Viaje', dominios: ['somosviajepuntacana.com', 'somosviajeorlando.com'], telefonos: ['+18493622139', '+18097957625'] };

function pedidoIA(correo, imagenes, modelo, perfil) {
  const P = Object.assign({}, PERFIL_SOMOS_VIAJES, perfil || {});
  const dominiosP = P.dominios && P.dominios.length ? ` (${P.dominios.join(', ')})` : '';
  const telefonosP = P.telefonos && P.telefonos.length ? ` (${P.telefonos.join(', ')})` : '';
  const dominio = ((correo.from || '').match(/@([^>\s]+)/) || [])[1] || '';
  const recibido = new Date(correo.date);
  const fechaRecibido = isNaN(recibido) ? '' : recibido.toISOString().slice(0, 10);
  const sobreImagenes = imagenes.length
      ? `Este correo trae ${imagenes.length} imagen(es) adjunta(s) despues del texto: pueden ser capturas de reservas, itinerarios, boletos, confirmaciones de vuelo o vouchers. Leelas con cuidado y usa sus datos igual que los del texto (pasajeros, pax, vuelo, aerolinea, fecha, hora, aeropuerto, hotel, telefono). Si el texto y una imagen no coinciden, manda el dato del mensaje mas reciente. Ignora logos, firmas, banners, publicidad y fotos que no tengan datos de la reserva. `
      : 'Si la informacion de vuelos esta solo en una imagen que no recibiste, deja vuelo vacio. ';
    const instruccion = `Clasifica este correo en una categoria: RESERVA, MODIFICACION, SEGUIMIENTO, CONSULTA, PUBLICIDAD, FACTURA, OTRO, NO_ENTENDIDO. RESERVA es una solicitud de servicio nueva. MODIFICACION es un cambio a una reserva ya enviada (cambiar fecha, hora, hotel, pasajeros o cancelar). Cadenas de correos (RE:, RV:, Fwd:, Reenviado): el mensaje mas reciente esta arriba y los anteriores debajo, despues de lineas como De:, From:, Enviado:, Asunto: o Forwarded message; el pedido original de la agencia suele estar al final. Lee toda la cadena antes de decidir. Si alguien reenvia un pedido de reserva (por ejemplo ${P.nombre} reenviando el correo de una agencia), es RESERVA con los datos del pedido original. Si el mensaje mas reciente pide un cambio sobre una reserva de la cadena, es MODIFICACION: llena todos los datos de la reserva con los valores nuevos y toma de la cadena los que no cambian. Si el mensaje mas reciente solo agradece, confirma o pregunta algo sin datos nuevos, es SEGUIMIENTO. Si el asunto empieza con Leido:, Leído:, Read: o Lu:, es un aviso automatico de que alguien leyo un correo (acuse de lectura): categoria OTRO, aunque el asunto diga reserva. El asunto suele traer el nombre del pasajero y la cantidad de pax (por ejemplo PAX MEDINA JUAN X 09 son 9 pasajeros a nombre de Medina Juan): usalo junto con el cuerpo. Devuelve solo JSON valido, sin texto extra. Formato: {"categoria": "...", "agencia": "...", "clientes": [], "telefono": "", "pax": {"adultos": 0, "ninos": 0, "infantes": 0}, "aeropuerto": "", "servicios": []}. Regla: si la categoria es RESERVA o MODIFICACION, llena agencia, clientes, pax, aeropuerto y servicios con los datos del correo (en MODIFICACION usa los datos nuevos). Para agencia: escribe SOLO el nombre de la empresa de viajes. Nunca pongas el nombre de una persona ni el nombre del remitente. Busca el nombre de la empresa en la firma o el pie de pagina escritos; si el dominio no es gmail, hotmail, yahoo, outlook ni de ${P.nombre}, puedes usarlo. Si no encuentras el nombre de la empresa, deja agencia vacia. ${P.nombre}${dominiosP} es la empresa que RECIBE los correos: nunca pongas ${P.nombre} como agencia; si el correo es una respuesta o reenvio de ${P.nombre}, busca la agencia en el mensaje original. Ignora banners y anuncios de publicidad (excursiones, parques, paquetes) al buscar la agencia. Para telefono: escribe el numero de contacto del pasajero o cliente (el que viaja o el contacto para el traslado), con codigo de pais si aparece, por ejemplo +593939601335. Si hay varios, separalos con coma. Nunca pongas telefonos de ${P.nombre}${telefonosP} ni los telefonos de la firma de la agencia o de la persona que escribe; si no hay telefono del pasajero, deja telefono vacio. Si la categoria es otra, deja agencia en blanco, clientes vacio, telefono vacio, pax en 0 y servicios vacio. Para RESERVA y MODIFICACION llena servicios con tipo_servicio, actividad, aeropuerto, hora_servicio, fecha_servicio, vuelo, hotel, punto_partida, punto_llegada. Reglas de vuelos y traslados: lee el itinerario completo en el texto y en TODAS las imagenes; un itinerario puede tener varios vuelos y escalas (por ejemplo Quito UIO a Panama PTY y Panama PTY a Punta Cana PUJ). A ${P.nombre} solo le interesan los traslados en el destino. Crea un servicio por cada llegada al destino y otro por cada salida del destino: actividad Traslado llegada (check-in) del aeropuerto al hotel o atraccion, y actividad Traslado salida (check-out) del hotel al aeropuerto; si el correo dice el tipo (privado, compartido, entre hoteles, hacia un parque o excursion) agregalo a la actividad. En el traslado de llegada: aeropuerto es el del destino donde aterriza, fecha_servicio es el dia de esa llegada, hora_servicio es la hora en que aterriza el ultimo vuelo en el destino, y vuelo lleva todos los vuelos de la ida en orden separados por coma y espacio (por ejemplo CM 427, CM 213). En el traslado de salida: aeropuerto es el del destino desde donde despega, fecha_servicio es el dia de ese vuelo, hora_servicio es la hora en que despega del destino, y vuelo lleva todos los vuelos de la vuelta en orden separados por coma. En vuelo escribe siempre el codigo de 2 letras de la aerolinea y el numero (AA 327, B6 1801, CM 213); si solo viene el nombre de la aerolinea, ponlo con el numero (Copa 213); nunca pongas solo el numero si la aerolinea aparece en el correo o en una imagen. Si el correo da una hora de recogida o pickup, esa manda sobre la hora del vuelo. Pasajeros: en pax pon los pasajeros que usan el traslado o el servicio, no los que van en el vuelo; si el boleto o la imagen dice 12 pasajeros pero el correo pide el traslado para 8, pax es 8. Vocabulario: IN, arrival, llegada y entrada son llegadas; OUT, departure, salida, regreso y return son salidas; RT, round trip, ida y vuelta o in-out piden llegada y salida; OW o one way piden un solo trayecto; ETA es hora de llegada y ETD hora de salida; PNR, record o localizador es el codigo de la reserva aerea y no es un numero de vuelo; una escala o conexion no es un traslado. Los codigos de 3 letras como UIO, PTY, BOG, MIA o JFK son aeropuertos de origen o de escala: en aeropuerto pon solo el aeropuerto del destino donde se hace cada traslado (PUJ, SDQ, LRM, POP, STI o MCO). Formatos obligatorios: fecha_servicio en AAAA-MM-DD (si el correo no trae el año, usa el año de la fecha de recibido, o el siguiente si esa fecha ya paso; en hotel usa la fecha de entrada); hora_servicio en HH:MM de 24 horas; aeropuerto en codigo IATA de 3 letras (por ejemplo PUJ, SDQ, LRM, POP, STI, MCO) solo si el correo o una imagen lo dice. Si hay hotel o fechas en el texto, llenalos dentro de servicios aunque el servicio no tenga actividad. Ignora el bloque de Vision general creada por IA y los textos de firma o confidencialidad. ${sobreImagenes}Responde directamente con el JSON, sin razonar en voz alta. Fecha de recibido: ${fechaRecibido}. Dominio del remitente: ${dominio}. Asunto: ${String(correo.subject || '').replace(/\s+/g, ' ')}. Correo: `;
  const limpio = String(correo.textPlain || '')
    .replace(/\[cid:[^\]]*\]/g, ' ')
    .replace(/<(?:https?:|mailto:)[^>]*>/g, ' ')
    .replace(/\[https?:[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S{80,}/g, ' ')
    .replace(/\[(?:Facebook|LinkedIn|Instagram|YouTube|Tiktok|TikTok|Twitter|WhatsApp)\]/gi, ' ')
    .replace(/\s+/g, ' ');
  const texto = limpio.length > 12000 ? limpio.slice(0, 6000) + ' [...] ' + limpio.slice(-6000) : limpio;
  const contenido = imagenes.length ? [{ type: 'text', text: instruccion + texto }, ...imagenes] : instruccion + texto;
  return { model: modelo, max_tokens: 4000, messages: [{ role: 'user', content: contenido }] };
}

async function llamarIA(ia, cuerpo) {
  const url = ia.url || 'https://openrouter.ai/api/v1/chat/completions';
  let ultimo = null;
  for (let intento = 1; intento <= 2; intento++) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 60000);
    try {
      const r = await fetch(url, {
        method: 'POST', signal: control.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ia.apiKey },
        body: JSON.stringify(cuerpo)
      });
      const datos = await r.json().catch(() => ({}));
      if (r.ok && !datos.error) return datos;
      const detalle = (datos.error && (datos.error.message || JSON.stringify(datos.error))) || ('código ' + r.status);
      ultimo = { error: { message: `Request failed with status code ${r.status} - ${detalle}` } };
    } catch (e) {
      ultimo = { error: { message: e.name === 'AbortError' ? 'La IA tardó más de 60 segundos' : e.message } };
    } finally {
      clearTimeout(reloj);
    }
    if (intento === 1) await new Promise(r => setTimeout(r, ia.esperaReintento ?? 5000));
  }
  return ultimo;
}

/* ---------- Respuesta de la IA → filas del panel (igual que "Code in JavaScript") ---------- */

function filasDesdeRespuesta(correo, respuesta) {
  const texto = (respuesta && respuesta.choices && respuesta.choices[0] && respuesta.choices[0].message && respuesta.choices[0].message.content) || '';
  let datos = {};
  let error_ia = false;
  let motivo = '';
  if (!respuesta || respuesta.error) {
    error_ia = true;
    const e = respuesta && respuesta.error;
    const detalle = typeof e === 'string' ? e : ((e && e.message) || JSON.stringify(e || 'sin respuesta'));
    motivo = ('Error de la IA: ' + detalle).slice(0, 300);
  } else {
    try {
      const m = texto.match(/\{[\s\S]*\}/);
      datos = JSON.parse(m ? m[0] : texto);
    } catch (e) {
      error_ia = true;
      motivo = 'No se pudo leer la respuesta de la IA';
    }
  }
  const categoria = String(datos.categoria || 'NO_ENTENDIDO').toUpperCase();
  const esReserva = ['RESERVA', 'MODIFICACION'].includes(categoria);
  const pax = datos.pax || {};
  const clientes = esReserva && Array.isArray(datos.clientes) ? datos.clientes.join(', ') : '';
  const servicios = esReserva && Array.isArray(datos.servicios) && datos.servicios.length > 0 ? datos.servicios : [{}];
  let estado;
  if (categoria === 'PUBLICIDAD' || categoria === 'OTRO') estado = 'sin accion';
  else if (esReserva) {
    const primero = servicios[0] || {};
    estado = (primero.fecha_servicio || primero.hotel) ? 'pendiente de transcribir' : 'revisar';
  } else estado = 'revisar';
  const base = {
    categoria, remitente: correo.from || '', asunto: correo.subject || '', estado, fecha: correo.date || '',
    cuerpo: correo.textPlain || '', message_id: correo.id, buzon: correo.buzon,
    agencia: esReserva ? (datos.agencia || '') : '', nombre_cliente: clientes, telefono: datos.telefono || '',
    adultos: esReserva ? (Number(pax.adultos) || 0) : 0, ninos: esReserva ? (Number(pax.ninos) || 0) : 0,
    infantes: esReserva ? (Number(pax.infantes) || 0) : 0, error_ia, motivo
  };
  return servicios.map((s, n) => ({
    ...base,
    numero_servicio: n + 1,
    tipo_servicio: s.tipo_servicio || '', actividad: s.actividad || '',
    aeropuerto: s.aeropuerto || datos.aeropuerto || '', fecha_servicio: s.fecha_servicio || '',
    hora_servicio: s.hora_servicio || '', vuelo: s.vuelo || '', hotel: s.hotel || '',
    punto_partida: s.punto_partida || '', punto_llegada: s.punto_llegada || ''
  }));
}

module.exports = { decodificar, htmlATexto, desdeGraph, elegirImagenes, pedidoIA, llamarIA, filasDesdeRespuesta, huella };
