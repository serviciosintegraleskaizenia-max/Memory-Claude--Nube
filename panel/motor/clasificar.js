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
    const instruccion = `Clasifica este correo en una categoria: RESERVA, MODIFICACION, SEGUIMIENTO, CONSULTA, PUBLICIDAD, FACTURA, OTRO, NO_ENTENDIDO. RESERVA es una solicitud de servicio nueva. MODIFICACION es un cambio a una reserva ya enviada (cambiar fecha, hora, hotel, pasajeros o cancelar). Cadenas de correos (RE:, RV:, Fwd:, Reenviado): el mensaje mas reciente esta arriba y los anteriores debajo, despues de lineas como De:, From:, Enviado:, Asunto: o Forwarded message; el pedido original de la agencia suele estar al final. Lee toda la cadena antes de decidir. Si alguien reenvia un pedido de reserva (por ejemplo ${P.nombre} reenviando el correo de una agencia), es RESERVA con los datos del pedido original. Si el mensaje mas reciente pide un cambio sobre una reserva de la cadena, es MODIFICACION: llena todos los datos de la reserva con los valores nuevos y toma de la cadena los que no cambian. Si el mensaje mas reciente solo agradece, confirma o pregunta algo sin datos nuevos, es SEGUIMIENTO. Si el asunto empieza con Leido:, Leído:, Read: o Lu:, es un aviso automatico de que alguien leyo un correo (acuse de lectura): categoria OTRO, aunque el asunto diga reserva. El asunto suele traer el nombre del pasajero y la cantidad de pax (por ejemplo PAX MEDINA JUAN X 09 son 9 pasajeros a nombre de Medina Juan): usalo junto con el cuerpo. Devuelve solo JSON valido, sin texto extra. Formato: {"categoria": "...", "agencia": "...", "clientes": [], "telefono": "", "pax": {"adultos": 0, "ninos": 0, "infantes": 0}, "aeropuerto": "", "servicios": [{"tipo_servicio": "IN", "actividad": "", "aeropuerto": "", "fecha_servicio": "", "hora_servicio": "", "vuelo": "", "hotel": "", "punto_partida": "", "punto_llegada": "", "pax": {"adultos": 0, "ninos": 0, "infantes": 0}, "pasajeros": [], "nota": ""}]}. Regla: si la categoria es RESERVA o MODIFICACION, llena agencia, clientes, pax, aeropuerto y servicios con los datos del correo (en MODIFICACION usa los datos nuevos). Para agencia: escribe SOLO el nombre de la empresa de viajes. Nunca pongas el nombre de una persona ni el nombre del remitente. Busca el nombre de la empresa en la firma o el pie de pagina escritos; si el dominio no es gmail, hotmail, yahoo, outlook ni de ${P.nombre}, puedes usarlo. Si no encuentras el nombre de la empresa, deja agencia vacia. ${P.nombre}${dominiosP} es la empresa que RECIBE los correos: nunca pongas ${P.nombre} como agencia; si el correo es una respuesta o reenvio de ${P.nombre}, busca la agencia en el mensaje original. Ignora banners y anuncios de publicidad (excursiones, parques, paquetes) al buscar la agencia. Para telefono: escribe el numero de contacto del pasajero o cliente (el que viaja o el contacto para el traslado), con codigo de pais si aparece, por ejemplo +593939601335. Si hay varios, separalos con coma. Nunca pongas telefonos de ${P.nombre}${telefonosP} ni los telefonos de la firma de la agencia o de la persona que escribe; si no hay telefono del pasajero, deja telefono vacio. Si la categoria es otra, deja agencia en blanco, clientes vacio, telefono vacio, pax en 0 y servicios vacio. Reglas de servicios de ${P.nombre}: una reserva es UN expediente con uno o varios servicios; devuelve todos los servicios de la reserva dentro de servicios (nunca la partas en reservas distintas). Hay 4 tipos de servicio y van en tipo_servicio escritos asi: IN (llegada: se recoge a los pasajeros en el aeropuerto y se llevan al hotel o alojamiento), OUT (salida: se recogen en el hotel o alojamiento y se llevan al aeropuerto para su vuelo), INTERHOTEL (traslado por tierra entre dos alojamientos o del hotel a un punto de encuentro de un evento o actividad), ACTIVIDAD (excursion, tour, parque, safari, entrada o experiencia; en actividad escribe su nombre). Lo comun es IN + OUT juntos (round trip) mas una o varias actividades, pero puede venir cualquier combinacion: 2 IN y 1 OUT, varios OUT, solo actividades, un interhotel. Cada servicio lleva: tipo_servicio, actividad (nombre del tour o tipo de traslado: privado, compartido, VIP), aeropuerto, fecha_servicio, hora_servicio, vuelo, hotel, punto_partida, punto_llegada, pax ({"adultos": 0, "ninos": 0, "infantes": 0} de los pasajeros que usan ESE servicio), pasajeros (nombres de los que usan ese servicio, si se saben) y nota. Aeropuertos locales: en Republica Dominicana PUJ (Punta Cana), SDQ (Las Americas) y JBQ (La Isabela) en Santo Domingo (STO es el codigo de ciudad de Santo Domingo: tratalo como SDQ), STI (Santiago), LRM (La Romana), POP (Puerto Plata), AZS (Samana) y BRX (Barahona); en Orlando MCO y SFB. Vuelos: lee el texto y TODAS las imagenes (itinerarios, tablas de vuelos y capturas de sistemas de reservas aereas; por ejemplo la linea AA2256 Q 11NOV ORDPUJ 0814 1452 es el vuelo AA 2256 del 11 de noviembre de ORD a PUJ que sale 08:14 y llega 14:52). Todo vuelo valido trae fecha y hora. Solo cuentan los tramos que llegan a un aeropuerto local o salen de un aeropuerto local: ignora escalas y tramos entre aeropuertos extranjeros (por ejemplo GYE a PTY o PTY a GYE). Un tramo de un aeropuerto extranjero a uno local es un IN: aeropuerto es el local, fecha_servicio el dia que aterriza, hora_servicio la hora de LLEGADA de ese tramo, vuelo ese vuelo, punto_partida el aeropuerto local y punto_llegada el hotel. Un tramo de un aeropuerto local a uno extranjero es un OUT: aeropuerto es el local, fecha_servicio el dia del vuelo, hora_servicio la hora de SALIDA de ese tramo, vuelo ese vuelo, punto_partida el hotel y punto_llegada el aeropuerto local. Cuando hay dos traslados de aeropuerto para la misma gente, el de fecha mas temprana es el IN y el posterior es el OUT. En vuelo escribe el codigo de 2 letras de la aerolinea y el numero (CM 425, AA 2256, B6 1801); si solo viene el nombre de la aerolinea, ponlo con el numero (Copa 425). Si el correo da una hora de recogida o pickup, esa manda sobre la hora del vuelo. Pasajeros por vuelo: si el correo dice que unos pasajeros llegan o salen en un vuelo y otros en otro, crea un servicio para cada grupo, con su vuelo y su pax. Si dice que alguien llega o sale en otro vuelo pero no dice cual, y no aparece en ninguna imagen, crea igual el servicio de ese grupo con vuelo vacio y en nota escribe Falta el vuelo de N pax. Si hay vuelos a o desde un aeropuerto local que no sabes a que grupo de pasajeros pertenecen, no los ignores: crea sus servicios y en nota escribe Revisar: posible segundo grupo de vuelos. nota es un texto corto para el asesor con lo que falta o hay que revisar (vuelo, hora, hotel, pasajeros); dejala vacia si todo esta claro. Cancelaciones, esperas y cambios: si el mensaje mas reciente cancela, anula o deja en espera uno o varios servicios (cancelar, anular, desestimar el servicio, ya no lo necesita, se va por su cuenta, no viajan, standby, en espera, posponer), es MODIFICACION: devuelve todos los servicios de la reserva y en la nota de cada servicio afectado escribe CANCELADO: o EN ESPERA: seguido del motivo y de los pasajeros afectados (si cancelan toda la reserva, esa nota va en todos los servicios). Si cambia un vuelo, una hora o una fecha, el servicio va con los datos nuevos y en su nota escribe CAMBIO: y lo que cambio (por ejemplo CAMBIO: nuevo vuelo CM 729 el 7 nov 05:33 para Camacho). Un comprobante de pago, un link de pago o un voucher enviado sin cambios en los servicios es SEGUIMIENTO, aunque la cadena traiga la reserva original. Tambien van en nota las peticiones del cliente que cambian la operacion (por ejemplo no necesita recogida, silla de ruedas, viaja con bebe) y las preguntas de la agencia que el asesor debe contestar (por ejemplo que dia seria la actividad). En pax general de la reserva pon el total de pasajeros; en el pax de cada servicio solo los que usan ese servicio (si el boleto dice 12 pero el traslado es para 8, pax es 8). Infantes son los menores de 2 anos y ninos de 2 a 11, salvo que el correo diga otra cosa. Vocabulario: IN, arrival, llegada y entrada son llegadas; OUT, departure, salida, regreso y return son salidas; RT, round trip, ida y vuelta o in-out piden IN y OUT; OW o one way piden un solo trayecto; ETA es hora de llegada y ETD hora de salida; PNR, record o localizador es el codigo de la reserva aerea y no es un vuelo; una escala o conexion no es un traslado. Ejemplo: 3 adultos y 1 infante con los vuelos CM 214 GYE-PTY 11NOV 04:22-06:34, CM 425 PTY-PUJ 11NOV 07:58-11:32, CM 426 PUJ-PTY 16NOV 12:43-14:27 y CM 378 PTY-GYE 16NOV 15:19-17:35 son 2 servicios: IN del 11 de noviembre a las 11:32 en el CM 425 a PUJ y OUT del 16 de noviembre a las 12:43 en el CM 426 desde PUJ, los dos con 3 adultos y 1 infante; el CM 214 y el CM 378 se ignoran porque no tocan un aeropuerto local. Formatos obligatorios: fecha_servicio en AAAA-MM-DD (si el correo no trae el año, usa el año de la fecha de recibido, o el siguiente si esa fecha ya paso; en hotel usa la fecha de entrada); hora_servicio en HH:MM de 24 horas; aeropuerto en codigo IATA de 3 letras del aeropuerto local (PUJ, SDQ, JBQ, STI, LRM, POP, AZS, BRX, MCO o SFB) solo si el correo o una imagen lo dice; en INTERHOTEL y ACTIVIDAD dejalo vacio si no aplica. Si hay hotel o fechas en el texto, llenalos dentro de servicios aunque el servicio no tenga actividad. Ignora el bloque de Vision general creada por IA y los textos de firma o confidencialidad. ${sobreImagenes}Responde directamente con el JSON, sin razonar en voz alta. Fecha de recibido: ${fechaRecibido}. Dominio del remitente: ${dominio}. Asunto: ${String(correo.subject || '').replace(/\s+/g, ' ')}. Correo: `;
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

// Pasajeros de cada servicio (un grupo puede llegar en un vuelo y otro en otro); si la IA no los da, los de la reserva.
function paxServicio(s, base, esReserva) {
  const p = s && s.pax;
  if (!esReserva || !p || typeof p !== 'object') return {};
  const total = (Number(p.adultos) || 0) + (Number(p.ninos) || 0) + (Number(p.infantes) || 0);
  if (!total) return {};
  return { adultos: Number(p.adultos) || 0, ninos: Number(p.ninos) || 0, infantes: Number(p.infantes) || 0 };
}

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
    ...paxServicio(s, base, esReserva),
    nombre_cliente: esReserva && Array.isArray(s.pasajeros) && s.pasajeros.length ? s.pasajeros.join(', ') : base.nombre_cliente,
    motivo: base.error_ia ? base.motivo : String(s.nota || '').trim().slice(0, 300),
    numero_servicio: n + 1,
    tipo_servicio: s.tipo_servicio || '', actividad: s.actividad || '',
    aeropuerto: s.aeropuerto || datos.aeropuerto || '', fecha_servicio: s.fecha_servicio || '',
    hora_servicio: s.hora_servicio || '', vuelo: s.vuelo || '', hotel: s.hotel || '',
    punto_partida: s.punto_partida || '', punto_llegada: s.punto_llegada || ''
  }));
}

module.exports = { decodificar, htmlATexto, desdeGraph, elegirImagenes, pedidoIA, llamarIA, filasDesdeRespuesta, huella };
