// Modelo de IA en OpenRouter. Copia el ID exacto desde openrouter.ai/models.
const MODELO = "anthropic/claude-haiku-5.5";

// Lectura de capturas (Hito 2): fotos de reservas, itinerarios, boletos o vouchers que vienen en el correo.
const MAX_IMAGENES = 5;              // capturas por correo que se mandan a la IA
const MIN_BASE64 = 16000;            // menos de ~12 KB suele ser un logo o un icono de firma
const MAX_BASE64 = 5000000;          // límite de la IA por imagen (~3.7 MB)
const MAX_BASE64_TOTAL = 15000000;   // límite por correo (~11 MB en total)
const REPETIDA_EN = 2;               // si la misma imagen ya vino en 2 correos distintos, es un logo o banner
const FALLOS_SIN_IMAGENES = 2;       // si la IA falla 2 veces con imágenes, se reintenta solo con el texto

const correos = $('Traducir correo').all().map(x => x.json);
const pendientes = $('If').all(0).map(x => x.json);
const resultados = $input.all().map(x => x.json);

const memoria = $getWorkflowStaticData('global');
memoria.imagenes = memoria.imagenes || {};
memoria.fallosImagen = memoria.fallosImagen || {};
const ahora = Date.now();
const DIA = 24 * 60 * 60 * 1000;
// Se olvidan las imágenes de hace más de 60 días y los fallos de hace más de 7 días.
for (const [k, v] of Object.entries(memoria.imagenes)) if (ahora - v.t > 60 * DIA) delete memoria.imagenes[k];
for (const [k, v] of Object.entries(memoria.fallosImagen)) if (ahora - v.t > 7 * DIA) delete memoria.fallosImagen[k];

// El tipo real se lee de los primeros bytes: la IA rechaza una imagen si el tipo no coincide.
function tipoReal(b64) {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR') && Buffer.from(b64.slice(0, 16), 'base64').toString('latin1').slice(8, 12) === 'WEBP') return 'image/webp';
  return '';
}

// Huella corta de la imagen para reconocer logos y banners que se repiten en muchos correos.
function huella(b64) {
  const pasos = 64;
  let muestra = b64.length + ':';
  for (let i = 0; i < pasos; i++) muestra += b64.substr(Math.floor((b64.length - 8) * i / pasos), 8);
  let h = 2166136261;
  for (let i = 0; i < muestra.length; i++) { h ^= muestra.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36) + '-' + b64.length.toString(36);
}

function elegirImagenes(id, respuesta) {
  const lista = respuesta && Array.isArray(respuesta.value) ? respuesta.value : [];
  const elegidas = [];
  let total = 0;
  for (const a of lista) {
    const b64 = typeof a.contentBytes === 'string' ? a.contentBytes : '';
    if (!b64 || b64.length < MIN_BASE64 || b64.length > MAX_BASE64) continue;
    const tipo = tipoReal(b64);
    if (!tipo) continue;
    const h = huella(b64);
    const vista = memoria.imagenes[h] || { n: 0, correos: [], t: ahora };
    if (!vista.correos.includes(id)) {
      vista.correos = [...vista.correos, id].slice(-5);
      vista.n += 1;
    }
    vista.t = ahora;
    memoria.imagenes[h] = vista;
    const otrosCorreos = vista.n - 1;
    if (otrosCorreos >= REPETIDA_EN) continue;
    if (elegidas.length >= MAX_IMAGENES || total + b64.length > MAX_BASE64_TOTAL) continue;
    total += b64.length;
    elegidas.push({ type: 'image_url', image_url: { url: `data:${tipo};base64,${b64}` } });
  }
  return elegidas;
}

// Que la memoria no crezca sin límite: se quedan las 3000 imágenes más recientes.
function recortarMemoria() {
  const claves = Object.keys(memoria.imagenes);
  if (claves.length <= 3000) return;
  claves.sort((a, b) => memoria.imagenes[a].t - memoria.imagenes[b].t);
  for (const k of claves.slice(0, claves.length - 3000)) delete memoria.imagenes[k];
}

const salida = pendientes.map((pendiente, i) => {
  const correo = correos.find(c => c.metadata['message-id'] === pendiente.message_id) || {};
  const id = pendiente.message_id || '';
  const fallos = (memoria.fallosImagen[id] || {}).n || 0;
  const imagenes = fallos >= FALLOS_SIN_IMAGENES ? [] : elegirImagenes(id, resultados[i]);
  const dominio = ((correo.from || '').match(/@([^>\s]+)/) || [])[1] || '';
  const recibido = new Date(correo.date);
  const fechaRecibido = isNaN(recibido) ? '' : recibido.toISOString().slice(0, 10);
  const sobreImagenes = imagenes.length
    ? `Este correo trae ${imagenes.length} imagen(es) adjunta(s) despues del texto: pueden ser capturas de reservas, itinerarios, boletos, confirmaciones de vuelo o vouchers. Leelas con cuidado y usa sus datos igual que los del texto (pasajeros, pax, vuelo, aerolinea, fecha, hora, aeropuerto, hotel, telefono). Si el texto y una imagen no coinciden, manda el dato del mensaje mas reciente. Ignora logos, firmas, banners, publicidad y fotos que no tengan datos de la reserva. `
    : 'Si la informacion de vuelos esta solo en una imagen que no recibiste, deja vuelo vacio. ';
  const instruccion = `Clasifica este correo en una categoria: RESERVA, MODIFICACION, SEGUIMIENTO, CONSULTA, PUBLICIDAD, FACTURA, OTRO, NO_ENTENDIDO. RESERVA es una solicitud de servicio nueva. MODIFICACION es un cambio a una reserva ya enviada (cambiar fecha, hora, hotel, pasajeros o cancelar). Cadenas de correos (RE:, RV:, Fwd:, Reenviado): el mensaje mas reciente esta arriba y los anteriores debajo, despues de lineas como De:, From:, Enviado:, Asunto: o Forwarded message; el pedido original de la agencia suele estar al final. Lee toda la cadena antes de decidir. Si alguien reenvia un pedido de reserva (por ejemplo Somos Viaje reenviando el correo de una agencia), es RESERVA con los datos del pedido original. Si el mensaje mas reciente pide un cambio sobre una reserva de la cadena, es MODIFICACION: llena todos los datos de la reserva con los valores nuevos y toma de la cadena los que no cambian. Si el mensaje mas reciente solo agradece, confirma o pregunta algo sin datos nuevos, es SEGUIMIENTO. Si el asunto empieza con Leido:, Leído:, Read: o Lu:, es un aviso automatico de que alguien leyo un correo (acuse de lectura): categoria OTRO, aunque el asunto diga reserva. El asunto suele traer el nombre del pasajero y la cantidad de pax (por ejemplo PAX MEDINA JUAN X 09 son 9 pasajeros a nombre de Medina Juan): usalo junto con el cuerpo. Devuelve solo JSON valido, sin texto extra. Formato: {"categoria": "...", "agencia": "...", "clientes": [], "telefono": "", "pax": {"adultos": 0, "ninos": 0, "infantes": 0}, "aeropuerto": "", "servicios": []}. Regla: si la categoria es RESERVA o MODIFICACION, llena agencia, clientes, pax, aeropuerto y servicios con los datos del correo (en MODIFICACION usa los datos nuevos). Para agencia: escribe SOLO el nombre de la empresa de viajes. Nunca pongas el nombre de una persona ni el nombre del remitente. Busca el nombre de la empresa en la firma o el pie de pagina escritos; si el dominio no es gmail, hotmail, yahoo, outlook ni de Somos Viaje, puedes usarlo. Si no encuentras el nombre de la empresa, deja agencia vacia. Somos Viaje (somosviajepuntacana.com, somosviajeorlando.com) es la empresa que RECIBE los correos: nunca pongas Somos Viaje como agencia; si el correo es una respuesta o reenvio de Somos Viaje, busca la agencia en el mensaje original. Ignora banners y anuncios de publicidad (excursiones, parques, paquetes) al buscar la agencia. Para telefono: escribe el numero de contacto del pasajero o cliente (el que viaja o el contacto para el traslado), con codigo de pais si aparece, por ejemplo +593939601335. Si hay varios, separalos con coma. Nunca pongas telefonos de Somos Viaje (+18493622139, +18097957625) ni los telefonos de la firma de la agencia o de la persona que escribe; si no hay telefono del pasajero, deja telefono vacio. Si la categoria es otra, deja agencia en blanco, clientes vacio, telefono vacio, pax en 0 y servicios vacio. Para RESERVA y MODIFICACION llena servicios con tipo_servicio, actividad, aeropuerto, hora_servicio, fecha_servicio, vuelo, hotel, punto_partida, punto_llegada. Reglas de vuelos y traslados: lee el itinerario completo en el texto y en TODAS las imagenes; un itinerario puede tener varios vuelos y escalas (por ejemplo Quito UIO a Panama PTY y Panama PTY a Punta Cana PUJ). A Somos Viaje solo le interesan los traslados en el destino. Crea un servicio por cada llegada al destino y otro por cada salida del destino: actividad Traslado llegada (check-in) del aeropuerto al hotel o atraccion, y actividad Traslado salida (check-out) del hotel al aeropuerto; si el correo dice el tipo (privado, compartido, entre hoteles, hacia un parque o excursion) agregalo a la actividad. En el traslado de llegada: aeropuerto es el del destino donde aterriza, fecha_servicio es el dia de esa llegada, hora_servicio es la hora en que aterriza el ultimo vuelo en el destino, y vuelo lleva todos los vuelos de la ida en orden separados por coma y espacio (por ejemplo CM 427, CM 213). En el traslado de salida: aeropuerto es el del destino desde donde despega, fecha_servicio es el dia de ese vuelo, hora_servicio es la hora en que despega del destino, y vuelo lleva todos los vuelos de la vuelta en orden separados por coma. En vuelo escribe siempre el codigo de 2 letras de la aerolinea y el numero (AA 327, B6 1801, CM 213); si solo viene el nombre de la aerolinea, ponlo con el numero (Copa 213); nunca pongas solo el numero si la aerolinea aparece en el correo o en una imagen. Si el correo da una hora de recogida o pickup, esa manda sobre la hora del vuelo. Pasajeros: en pax pon los pasajeros que usan el traslado o el servicio, no los que van en el vuelo; si el boleto o la imagen dice 12 pasajeros pero el correo pide el traslado para 8, pax es 8. Vocabulario: IN, arrival, llegada y entrada son llegadas; OUT, departure, salida, regreso y return son salidas; RT, round trip, ida y vuelta o in-out piden llegada y salida; OW o one way piden un solo trayecto; ETA es hora de llegada y ETD hora de salida; PNR, record o localizador es el codigo de la reserva aerea y no es un numero de vuelo; una escala o conexion no es un traslado. Los codigos de 3 letras como UIO, PTY, BOG, MIA o JFK son aeropuertos de origen o de escala: en aeropuerto pon solo el aeropuerto del destino donde se hace cada traslado (PUJ, SDQ, LRM, POP, STI o MCO). Formatos obligatorios: fecha_servicio en AAAA-MM-DD (si el correo no trae el año, usa el año de la fecha de recibido, o el siguiente si esa fecha ya paso; en hotel usa la fecha de entrada); hora_servicio en HH:MM de 24 horas; aeropuerto en codigo IATA de 3 letras (PUJ, SDQ, LRM, POP, STI) solo si el correo o una imagen lo dice. Si hay hotel o fechas en el texto, llenalos dentro de servicios aunque el servicio no tenga actividad. Ignora el bloque de Vision general creada por IA y los textos de firma o confidencialidad. ${sobreImagenes}Responde directamente con el JSON, sin razonar en voz alta. Fecha de recibido: ${fechaRecibido}. Dominio del remitente: ${dominio}. Asunto: ${String(correo.subject || '').replace(/\s+/g, ' ')}. Correo: `;
  // Se quitan imágenes [cid:...] y enlaces largos de firmas para que la IA vea el correo y el mensaje original.
  const limpio = String(correo.textPlain || '')
    .replace(/\[cid:[^\]]*\]/g, ' ')
    .replace(/<(?:https?:|mailto:)[^>]*>/g, ' ')
    .replace(/\[https?:[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S{80,}/g, ' ')
    .replace(/\[(?:Facebook|LinkedIn|Instagram|YouTube|Tiktok|TikTok|Twitter|WhatsApp)\]/gi, ' ')
    .replace(/\s+/g, ' ');
  // En cadenas largas el pedido original queda al final: se manda el principio y el final.
  const texto = limpio.length > 12000 ? limpio.slice(0, 6000) + ' [...] ' + limpio.slice(-6000) : limpio;
  const contenido = imagenes.length
    ? [{ type: 'text', text: instruccion + texto }, ...imagenes]
    : instruccion + texto;
  return {
    json: {
      body: {
        model: MODELO,
        max_tokens: 4000,
        messages: [{ role: "user", content: contenido }]
      },
      dominio: dominio,
      imagenes: imagenes.length,
      correo: correo
    }
  };
});

recortarMemoria();
return salida;
