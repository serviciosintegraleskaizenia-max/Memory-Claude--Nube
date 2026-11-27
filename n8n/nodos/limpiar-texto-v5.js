// Modelo de IA en OpenRouter. Copia el ID exacto desde openrouter.ai/models.
const MODELO = "anthropic/claude-haiku-5.5";

// Lectura de capturas (Hito 2): fotos de reservas, itinerarios, boletos o vouchers que vienen en el correo.
const MAX_IMAGENES = 5;              // capturas por correo que se mandan a la IA
const MIN_BASE64 = 16000;            // menos de ~12 KB suele ser un logo o un icono de firma
const MAX_BASE64 = 5000000;          // límite de la IA por imagen (~3.7 MB)
const MAX_BASE64_TOTAL = 15000000;   // límite por correo (~11 MB en total)
const REPETIDA_EN = 2;               // si la misma imagen chica ya vino en 2 correos distintos, es un logo o banner
const TAMANO_LOGO = 150000;          // solo las imágenes más chicas que esto se consideran logos repetidos
const FALLOS_SIN_IMAGENES = 99;      // PRUEBA: ignora la memoria de fallos
// Panel de la empresa (en este mismo PC): de ahí salen las correcciones de los asesores para que la IA aprenda.
const PANEL = 'http://127.0.0.1:3001';

// Vocabulario real de Somos Viajes (tarifarios y lo que indicó el dueño). La IA debe usar estos nombres.
const GLOSARIO = `VOCABULARIO DE SOMOS VIAJES (úsalo tal cual; estos términos son normales en su negocio y nunca digas que no los reconoces):
- Tipos de servicio: IN = llegada del aeropuerto al hotel. OUT = salida del hotel al aeropuerto. INTERHOTEL = traslado entre hoteles o de hotel a una actividad. ACTIVIDAD = excursión, tour, parque, entrada o experiencia. "IF" y "OFF" escritos en el correo significan IN y OUT.
- Vehículos según el grupo: carro privado para 1 a 6 pasajeros; GUAGUA = bus para 7 a 21 pasajeros (un grupo de 16 o 18 viaja en una sola guagua); buses grandes para 22 a 33 y 34 a 54 pasajeros; Luxury = vehículo de lujo para grupos pequeños. Anota el vehículo en la nota del servicio si el correo lo dice.
- Actividades comunes (nombre tal como aparece en tarifarios): Isla Saona (Full Day; variantes Eco Adventure, Carlitos, VIP, Mano Juan); Isla Catalina con Snorkel; Isla Catalina con Buceo; Velero con tortugas = Catamarán + Snorkel (Party Boat); Buggies (Single, Doble, Familiar, Cuatrimoto, Buggy Blast); Paseo a caballo (Caballos); ATV o Four wheel; delfines (Dolphin Discovery, Dolphin Explorer, Explorer, Excellence, Swim Adventure, Royal Swim); Santo Domingo tour histórico; Parque Nacional Los Haitises + Montaña Redonda; Samaná + Cayo Levantado + Cascada El Limón; Samaná + Playa Rincón; Scape Park; El Dorado Water Park; Imagine Punta Cana; Altos de Chavón.
- Bebidas y fiesta: Open Bar, Premium Open Bar, Gold Member, Front Row (CocoBongo y similares); discoteca; bebidas extra.
- Otras actividades que pueden aparecer: tirolesa (zip line), tubing, kayak, paddle board, snorkel, safari, cueva o cenote, rappel, parque acuático, lancha rápida, party boat.
- Regla para actividades que no están en esta lista: escribe el nombre exactamente como aparece en el correo, en el campo actividad. No la marques como duda por no reconocerla. Solo marca duda si falta un dato (fecha, hora, pasajeros, vuelo).
- Vuelo y aeropuerto según el tipo de servicio: en ACTIVIDAD, INTERHOTEL y CRUCERO el vuelo va como "N/A", porque no vienen de un vuelo. En ACTIVIDAD el aeropuerto también va como "N/A". Solo los IN y OUT de aeropuerto llevan vuelo y aeropuerto reales.
- Crucero: si el correo habla de un crucero, barco, muelle o puerto de cruceros (por ejemplo Puerto Plata), en aeropuerto escribe el nombre del puerto tal como aparece (por ejemplo "Puerto de Puerto Plata"), y en vuelo escribe "N/A". Las actividades de los cruceristas se tratan como actividad normal.
- Hora: no es obligatoria. Si el correo no la trae, deja hora_servicio vacía y no la marques como duda: a veces se confirma el día anterior o a última hora.
- Datos obligatorios de una reserva completa: día (fecha_servicio), nombre del pasajero y hotel donde se hospeda. Con esos tres la reserva está completa, salvo que el correo cancele, suspenda o cambie algo.`;

const correos = $('Traducir correo').all().map(x => x.json);
const pendientes = $('If').all(0).map(x => x.json);
const resultados = $input.all().map(x => x.json);

const memoria = $getWorkflowStaticData('global');
memoria.imagenes = memoria.imagenes || {};
memoria.fallosImagen = memoria.fallosImagen || {};
// Una sola vez: se vacía la memoria de imágenes que descartaba capturas de reservas repetidas en reenvíos.
if (!memoria.version || memoria.version < 2) { memoria.imagenes = {}; memoria.version = 2; }
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
  if (b64.startsWith('R0lGOD')) return 'image/gif';
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
    // Solo se descartan como logo las imágenes chicas que se repiten; una captura de reserva grande se conserva.
    if (otrosCorreos >= REPETIDA_EN && b64.length < TAMANO_LOGO) continue;
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

// Correcciones que hicieron los asesores en correos anteriores de cada remitente (si el panel no responde, se sigue sin ellas).
const leccionesDe = {};
for (const pendiente of pendientes) {
  const c = correos.find(x => x.metadata['message-id'] === pendiente.message_id) || {};
  const de = String(c.from || '').toLowerCase();
  if (!de || leccionesDe[de] !== undefined) continue;
  try {
    const r = await this.helpers.httpRequest({ url: PANEL + '/api/ia/lecciones?remitente=' + encodeURIComponent(de), json: true, timeout: 3000 });
    leccionesDe[de] = (r && Array.isArray(r.lecciones)) ? r.lecciones : [];
  } catch (e) { leccionesDe[de] = []; }
}

const salida = pendientes.map((pendiente, i) => {
  const correo = correos.find(c => c.metadata['message-id'] === pendiente.message_id) || {};
  const id = pendiente.message_id || '';
  const fallos = (memoria.fallosImagen[id] || {}).n || 0;
  const imagenes = fallos >= FALLOS_SIN_IMAGENES ? [] : elegirImagenes(id, resultados[i]);
  const dominio = ((correo.from || '').match(/@([^>\s]+)/) || [])[1] || '';
  const lecciones = leccionesDe[String(correo.from || '').toLowerCase()] || [];
  const textoLecciones = lecciones.length ? 'CORRECCIONES DE LOS ASESORES EN CORREOS ANTERIORES DE ESTE REMITENTE (aprende de ellas y no repitas el error): ' + lecciones.join(' ') + ' ' : '';
  const recibido = new Date(correo.date);
  const fechaRecibido = isNaN(recibido) ? '' : recibido.toISOString().slice(0, 10);
  const sobreImagenes = imagenes.length
    ? `Este correo trae ${imagenes.length} imagen(es) adjunta(s) despues del texto: pueden ser capturas de reservas, itinerarios, boletos, confirmaciones de vuelo o vouchers. Leelas con cuidado y usa sus datos igual que los del texto (pasajeros, pax, vuelo, aerolinea, fecha, hora, aeropuerto, hotel, telefono). Si el texto y una imagen no coinciden, manda el dato del mensaje mas reciente. Ignora logos, firmas, banners, publicidad y fotos que no tengan datos de la reserva. `
    : 'Si la informacion de vuelos esta solo en una imagen que no recibiste, deja vuelo vacio. ';
  const instruccion = `Clasifica este correo en una categoria: RESERVA, MODIFICACION, SEGUIMIENTO, CONSULTA, PUBLICIDAD, FACTURA, OTRO, NO_ENTENDIDO. RESERVA es una solicitud de servicio nueva. MODIFICACION es un cambio a una reserva ya enviada (cambiar fecha, hora, hotel, pasajeros o cancelar). Cadenas de correos (RE:, RV:, Fwd:, Reenviado): el mensaje mas reciente esta arriba y los anteriores debajo, despues de lineas como De:, From:, Enviado:, Asunto: o Forwarded message; el pedido original de la agencia suele estar al final. Lee toda la cadena antes de decidir. Si alguien reenvia un pedido de reserva (por ejemplo Somos Viaje reenviando el correo de una agencia), es RESERVA con los datos del pedido original. Si el mensaje mas reciente pide un cambio sobre una reserva de la cadena, es MODIFICACION: llena todos los datos de la reserva con los valores nuevos y toma de la cadena los que no cambian. Si el mensaje mas reciente solo agradece, confirma o pregunta algo sin datos nuevos, es SEGUIMIENTO. Si el asunto empieza con Leido:, Leído:, Read: o Lu:, es un aviso automatico de que alguien leyo un correo (acuse de lectura): categoria OTRO, aunque el asunto diga reserva. El asunto suele traer el nombre del pasajero y la cantidad de pax (por ejemplo PAX MEDINA JUAN X 09 son 9 pasajeros a nombre de Medina Juan): usalo junto con el cuerpo. Devuelve solo JSON valido, sin texto extra. Formato: {"categoria": "...", "agencia": "...", "clientes": [], "telefono": "", "pax": {"adultos": 0, "ninos": 0, "infantes": 0}, "aeropuerto": "", "servicios": [{"tipo_servicio": "IN", "actividad": "", "aeropuerto": "", "fecha_servicio": "", "hora_servicio": "", "vuelo": "", "hotel": "", "punto_partida": "", "punto_llegada": "", "pax": {"adultos": 0, "ninos": 0, "infantes": 0}, "pasajeros": [], "nota": "", "dudas": []}]}. Regla: si la categoria es RESERVA o MODIFICACION, llena agencia, clientes, pax, aeropuerto y servicios con los datos del correo (en MODIFICACION usa los datos nuevos). Para agencia: escribe SOLO el nombre de la empresa de viajes. Nunca pongas el nombre de una persona ni el nombre del remitente. Busca el nombre de la empresa en la firma o el pie de pagina escritos; si el dominio no es gmail, hotmail, yahoo, outlook ni de Somos Viaje, puedes usarlo. Si no encuentras el nombre de la empresa, deja agencia vacia. Somos Viaje (somosviajepuntacana.com, somosviajeorlando.com) es la empresa que RECIBE los correos: nunca pongas Somos Viaje como agencia; si el correo es una respuesta o reenvio de Somos Viaje, busca la agencia en el mensaje original. Ignora banners y anuncios de publicidad (excursiones, parques, paquetes) al buscar la agencia. Para telefono: escribe el numero de contacto del pasajero o cliente (el que viaja o el contacto para el traslado), con codigo de pais si aparece, por ejemplo +593939601335. Si hay varios, separalos con coma. Nunca pongas telefonos de Somos Viaje (+18493622139, +18097957625) ni los telefonos de la firma de la agencia o de la persona que escribe; si no hay telefono del pasajero, deja telefono vacio. Si la categoria es otra, deja agencia en blanco, clientes vacio, telefono vacio, pax en 0 y servicios vacio. Reglas de servicios de Somos Viaje: una reserva es UN expediente con uno o varios servicios; devuelve todos los servicios de la reserva dentro de servicios (nunca la partas en reservas distintas). Hay 4 tipos de servicio y van en tipo_servicio escritos asi: IN (llegada: se recoge a los pasajeros en el aeropuerto y se llevan al hotel o alojamiento), OUT (salida: se recogen en el hotel o alojamiento y se llevan al aeropuerto para su vuelo), INTERHOTEL (traslado por tierra entre dos alojamientos o del hotel a un punto de encuentro de un evento o actividad), ACTIVIDAD (excursion, tour, parque, safari, entrada o experiencia; en actividad escribe su nombre). Lo comun es IN + OUT juntos (round trip) mas una o varias actividades, pero puede venir cualquier combinacion: 2 IN y 1 OUT, varios OUT, solo actividades, un interhotel. Cada servicio lleva: tipo_servicio, actividad (nombre del tour o tipo de traslado: privado, compartido, VIP), aeropuerto, fecha_servicio, hora_servicio, vuelo, hotel, punto_partida, punto_llegada, pax ({"adultos": 0, "ninos": 0, "infantes": 0} de los pasajeros que usan ESE servicio), pasajeros (nombres de los que usan ese servicio, si se saben) y nota. Aeropuertos locales: en Republica Dominicana PUJ (Punta Cana), SDQ (Las Americas) y JBQ (La Isabela) en Santo Domingo (STO es el codigo de ciudad de Santo Domingo: tratalo como SDQ), STI (Santiago), LRM (La Romana), POP (Puerto Plata), AZS (Samana) y BRX (Barahona); en Orlando MCO y SFB. Vuelos: lee el texto y TODAS las imagenes (itinerarios, tablas de vuelos y capturas de sistemas de reservas aereas; por ejemplo la linea AA2256 Q 11NOV ORDPUJ 0814 1452 es el vuelo AA 2256 del 11 de noviembre de ORD a PUJ que sale 08:14 y llega 14:52). Todo vuelo valido trae fecha y hora. Solo cuentan los tramos que llegan a un aeropuerto local o salen de un aeropuerto local: ignora escalas y tramos entre aeropuertos extranjeros (por ejemplo GYE a PTY o PTY a GYE). Un tramo de un aeropuerto extranjero a uno local es un IN: aeropuerto es el local, fecha_servicio el dia que aterriza, hora_servicio la hora de LLEGADA de ese tramo, vuelo ese vuelo, punto_partida el aeropuerto local y punto_llegada el hotel. Un tramo de un aeropuerto local a uno extranjero es un OUT: aeropuerto es el local, fecha_servicio el dia del vuelo, hora_servicio la hora de SALIDA de ese tramo, vuelo ese vuelo, punto_partida el hotel y punto_llegada el aeropuerto local. Cuando hay dos traslados de aeropuerto para la misma gente, el de fecha mas temprana es el IN y el posterior es el OUT. En vuelo escribe el codigo de 2 letras de la aerolinea y el numero (CM 425, AA 2256, B6 1801); si solo viene el nombre de la aerolinea, ponlo con el numero (Copa 425). Si el correo da una hora de recogida o pickup, esa manda sobre la hora del vuelo. Pasajeros por vuelo: si el correo dice que unos pasajeros llegan o salen en un vuelo y otros en otro, crea un servicio para cada grupo, con su vuelo y su pax. Si dice que alguien llega o sale en otro vuelo pero no dice cual, y no aparece en ninguna imagen, crea igual el servicio de ese grupo con vuelo vacio y en nota escribe Falta el vuelo de N pax. Si hay vuelos a o desde un aeropuerto local que no sabes a que grupo de pasajeros pertenecen, no los ignores: crea sus servicios y en nota escribe Revisar: posible segundo grupo de vuelos. nota es un texto corto para el asesor con lo que falta o hay que revisar (vuelo, hora, hotel, pasajeros); dejala vacia si todo esta claro. dudas es la lista de los datos de ese servicio de los que NO estas seguro (por ejemplo los leiste de una imagen borrosa o cortada, o los dedujiste sin que el correo los diga): usa los nombres fecha_servicio, hora_servicio, vuelo, hotel, aeropuerto, pax o tipo_servicio; dejala vacia si estas seguro de todo. Cancelaciones, esperas y cambios: si el mensaje mas reciente cancela, anula o deja en espera uno o varios servicios (cancelar, anular, desestimar el servicio, ya no lo necesita, se va por su cuenta, no viajan, standby, en espera, posponer), es MODIFICACION: devuelve todos los servicios de la reserva y en la nota de cada servicio afectado escribe CANCELADO: o EN ESPERA: seguido del motivo y de los pasajeros afectados (si cancelan toda la reserva, esa nota va en todos los servicios). Si cambia un vuelo, una hora o una fecha, el servicio va con los datos nuevos y en su nota escribe CAMBIO: y lo que cambio (por ejemplo CAMBIO: nuevo vuelo CM 729 el 7 nov 05:33 para Camacho). Un comprobante de pago, un link de pago o un voucher enviado sin cambios en los servicios es SEGUIMIENTO, aunque la cadena traiga la reserva original. Tambien van en nota las peticiones del cliente que cambian la operacion (por ejemplo no necesita recogida, silla de ruedas, viaja con bebe) y las preguntas de la agencia que el asesor debe contestar (por ejemplo que dia seria la actividad). Extras que se cobran y hay que preparar en la operacion: silla de bebe o de infante para el carro (car seat), booster o elevador, silla de ruedas o asistencia, equipaje extra o especial (palos de golf, tabla de surf, bicicleta, coche de bebe), parada en supermercado, botella o decoracion; en la nota del servicio escribe EXTRA: y lo que piden con la cantidad (por ejemplo EXTRA: 1 silla de bebe). Si una MODIFICACION solo agrega o quita un extra (por ejemplo agregar la silla), es MODIFICACION: devuelve los servicios de la reserva y pon la nota EXTRA: en los que lo llevan. Abreviaturas de pasajeros: ADL o ADT es adulto, CHD o CHILD es nino, INF es infante; en el asunto X 5 + CHD son 5 adultos y 1 nino (6 pasajeros), y en la lista de nombres (ADL) y (CHD) junto a cada nombre te dicen que es cada uno. Si el vuelo viene incompleto (solo las letras de la aerolinea, como CM, sin el numero, por ejemplo porque la imagen esta cortada), pon en vuelo lo que se vea y en nota escribe Vuelo incompleto: falta el numero. En pax general de la reserva pon el total de pasajeros; en el pax de cada servicio solo los que usan ese servicio (si el boleto dice 12 pero el traslado es para 8, pax es 8). Infantes son los menores de 2 anos y ninos de 2 a 11, salvo que el correo diga otra cosa. Vocabulario: IN, arrival, llegada y entrada son llegadas; OUT, departure, salida, regreso y return son salidas; RT, round trip, ida y vuelta o in-out piden IN y OUT; OW o one way piden un solo trayecto; ETA es hora de llegada y ETD hora de salida; PNR, record o localizador es el codigo de la reserva aerea y no es un vuelo; una escala o conexion no es un traslado. Ejemplo: 3 adultos y 1 infante con los vuelos CM 214 GYE-PTY 11NOV 04:22-06:34, CM 425 PTY-PUJ 11NOV 07:58-11:32, CM 426 PUJ-PTY 16NOV 12:43-14:27 y CM 378 PTY-GYE 16NOV 15:19-17:35 son 2 servicios: IN del 11 de noviembre a las 11:32 en el CM 425 a PUJ y OUT del 16 de noviembre a las 12:43 en el CM 426 desde PUJ, los dos con 3 adultos y 1 infante; el CM 214 y el CM 378 se ignoran porque no tocan un aeropuerto local. Formatos obligatorios: fecha_servicio en AAAA-MM-DD (si el correo no trae el año, usa el año de la fecha de recibido, o el siguiente si esa fecha ya paso; en hotel usa la fecha de entrada); hora_servicio en HH:MM de 24 horas; aeropuerto en codigo IATA de 3 letras del aeropuerto local (PUJ, SDQ, JBQ, STI, LRM, POP, AZS, BRX, MCO o SFB) solo si el correo o una imagen lo dice; en INTERHOTEL y ACTIVIDAD escribe N/A en aeropuerto y vuelo (no aplican). Si hay hotel o fechas en el texto, llenalos dentro de servicios aunque el servicio no tenga actividad. Ignora el bloque de Vision general creada por IA y los textos de firma o confidencialidad. ${GLOSARIO} ${sobreImagenes}${textoLecciones}Responde directamente con el JSON, sin razonar en voz alta. Fecha de recibido: ${fechaRecibido}. Dominio del remitente: ${dominio}. Asunto: ${String(correo.subject || '').replace(/\s+/g, ' ')}. Correo: `;
  // Se quitan imágenes [cid:...] y enlaces largos de firmas para que la IA vea el correo y el mensaje original.
  const limpio = String(correo.textPlain || '')
    .replace(/\[cid:[^\]]*\]/g, ' ')
    .replace(/<(?:https?:|mailto:)[^>]*>/g, ' ')
    .replace(/\[https?:[^\]]*\]/g, ' ')
    .replace(/https?:\/\/\S{80,}/g, ' ')
    .replace(/\[(?:Facebook|LinkedIn|Instagram|YouTube|Tiktok|TikTok|Twitter|WhatsApp)\]/gi, ' ')
    .replace(/\s+/g, ' ');
  // En cadenas largas el pedido original queda al final: se manda el principio y el final (hasta 15 000 caracteres de cada lado).
  const texto = limpio.length > 30000 ? limpio.slice(0, 15000) + ' [...] ' + limpio.slice(-15000) : limpio;
  const contenido = imagenes.length
    ? [{ type: 'text', text: instruccion + texto }, ...imagenes]
    : instruccion + texto;
  return {
    json: {
      body: {
        model: MODELO,
        max_tokens: 8000,
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
