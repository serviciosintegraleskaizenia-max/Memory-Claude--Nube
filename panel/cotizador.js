// Cotizador del panel: calcula el precio sugerido de cada servicio con tarifas/tarifas.json.
// El precio es una sugerencia para revisar; nunca se guarda ni se envía solo.
const fs = require('fs');
const path = require('path');

const RUTA_TARIFAS = path.join(__dirname, 'tarifas', 'tarifas.json');
const RUTA_SCRIPT = path.join(__dirname, 'cotizador-panel.js');

let tarifas = null;
let versionTarifas = 0;

// Se vuelve a leer tarifas.json si cambió, sin reiniciar el panel.
function cargarTarifas() {
  let stat;
  try { stat = fs.statSync(RUTA_TARIFAS); } catch (e) { return null; }
  if (!tarifas || stat.mtimeMs !== versionTarifas) {
    tarifas = JSON.parse(fs.readFileSync(RUTA_TARIFAS, 'utf8'));
    versionTarifas = stat.mtimeMs;
  }
  return tarifas;
}

const AEROPUERTOS_RD = {
  PUJ: 'PUNTA CANA AIRPORT (PUJ)',
  SDQ: 'SANTO DOMINGO AIRPORT (SDQ)',
  LRM: 'PUERTO DE LA ROMANA (LRM)'
};
const AEROPUERTOS_ORLANDO = {
  MCO: 'ORLANDO INTERNATIONAL AIRPORT (MCO)',
  SFB: 'ORLANDO SANFORD AIRPORT (SFB)',
  MIA: 'MIAMI INTERNATIONAL AIRPORT (MIA)'
};

// Zona del hotel -> hoja de actividades con salida desde esa zona.
const HOJA_ACTIVIDADES = {
  'PUNTA CANA': 'Bavaro - Punta Cana', 'UVERO ALTO': 'Uvero Alto - Cap Cana', 'CAP CANA': 'Uvero Alto - Cap Cana',
  'BAYAHIBE': 'Bayahibe', 'LA ROMANA': 'La Romana', 'JUAN DOLIO': 'Juan Dolio - Boca Chica',
  'BOCA CHICA': 'Juan Dolio - Boca Chica', 'SANTO DOMINGO': 'Santo Domingo', 'PUERTO PLATA': 'Puerto Plata',
  'CABARETE': 'Puerto Plata', 'MICHES': 'Miches'
};

// Si el hotel no está en el listado, la zona se busca por palabras del texto (las más específicas primero).
const ZONAS_POR_PALABRA = [
  ['uvero alto', 'UVERO ALTO'], ['cap cana', 'CAP CANA'], ['bayahibe', 'BAYAHIBE'], ['dominicus', 'BAYAHIBE'],
  ['la romana', 'LA ROMANA'], ['casa de campo', 'LA ROMANA'], ['juan dolio', 'JUAN DOLIO'], ['boca chica', 'BOCA CHICA'],
  ['santo domingo', 'SANTO DOMINGO'], ['zona colonial', 'SANTO DOMINGO'], ['miches', 'MICHES'], ['samana', 'SAMANA'],
  ['las terrenas', 'SAMANA'], ['cabarete', 'CABARETE'], ['sosua', 'PUERTO PLATA'], ['puerto plata', 'PUERTO PLATA'],
  ['playa dorada', 'PUERTO PLATA'], ['santiago', 'STGO DE LOS CABALLEROS'], ['bavaro', 'PUNTA CANA'],
  ['arena gorda', 'PUNTA CANA'], ['cabeza de toro', 'PUNTA CANA'], ['macao', 'PUNTA CANA'], ['punta cana', 'PUNTA CANA']
];

const ZONAS_ORLANDO = [
  [['championsgate', 'reunion', 'davenport', 'four corners', 'solara', 'windsor'], 'CHAMPIONSGATE / REUNION / DAVENPORT'],
  [['disney', 'lake buena vista', 'epcot', 'magic kingdom', 'animal kingdom', 'hollywood studios', 'bonnet creek', 'flamingo crossings'], 'WALT DISNEY WORLD / LAKE BUENA VISTA / DISNEY SPRINGS'],
  [['international drive', 'i drive', 'idrive', 'universal', 'seaworld', 'sea world', 'kissimmee', 'convention center', 'icon park'], 'INTERNATIONAL DRIVE / UNIVERSAL / SEAWORLD / KISSIMMEE'],
  [['downtown'], 'DOWNTOWN ORLANDO'],
  [['tampa'], 'TAMPA AREA'],
  [['daytona'], 'DAYTONA BEACH AREA'],
  [['canaveral', 'cocoa beach'], 'PORT CANAVERAL / COCOA BEACH']
];

const VACIAS = new Set(['hotel', 'hoteles', 'resort', 'resorts', 'spa', 'the', 'and', 'by', 'all', 'inclusive', 'todo', 'incluido',
  'adults', 'only', 'y', 'de', 'del', 'la', 'el', 'los', 'las', 'en', 'a', 'al', 'con', 'para', 'htl', 'tour', 'excursion',
  'excursiones', 'actividad', 'servicio', 'traslado', 'traslados', 'privado', 'compartido']);

function normal(texto) {
  return String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function palabras(texto) {
  return normal(texto).split(' ').filter(p => p && !VACIAS.has(p));
}

function numero(valor) {
  const n = parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function dinero(valor) {
  return 'US$ ' + (Math.round(valor * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// El hotel del listado que coincide con más palabras (todas sus palabras deben estar en el texto).
function buscarHotel(texto, t) {
  const dadas = new Set(palabras(texto));
  if (!dadas.size) return null;
  let mejor = null;
  for (const h of t.rd.hoteles) {
    const suyas = palabras(h.hotel);
    if (!suyas.length || !suyas.every(p => dadas.has(p))) continue;
    if (!mejor || suyas.length > mejor.n) mejor = { ...h, n: suyas.length };
  }
  return mejor;
}

function zonaPorPalabra(texto) {
  const n = ' ' + normal(texto) + ' ';
  const hallada = ZONAS_POR_PALABRA.find(([palabra]) => n.includes(' ' + palabra + ' '));
  return hallada ? hallada[1] : null;
}

function zonaRD(texto, t, avisos) {
  if (!normal(texto)) return null;
  const hotel = buscarHotel(texto, t);
  if (hotel) return { zona: hotel.zona, como: `hotel ${hotel.hotel} (${hotel.zonaOriginal})` };
  const zona = zonaPorPalabra(texto);
  if (zona) {
    avisos.push(`"${texto}" no está en el listado de hoteles: la zona ${zona} se tomó por el nombre.`);
    return { zona, como: `zona ${zona} por el nombre` };
  }
  return null;
}

function aeropuertoDe(fila, sede) {
  const lista = sede === 'orlando' ? AEROPUERTOS_ORLANDO : AEROPUERTOS_RD;
  const codigo = String(fila.aeropuerto || '').toUpperCase().trim();
  if (lista[codigo]) return { codigo, nombre: lista[codigo] };
  const texto = ' ' + normal([fila.punto_partida, fila.punto_llegada].join(' ')) + ' ';
  for (const [c, nombre] of Object.entries(lista)) {
    if (texto.includes(' ' + c.toLowerCase() + ' ')) return { codigo: c, nombre };
  }
  return codigo ? { codigo, nombre: null } : null;
}

function sedeDe(fila) {
  const codigo = String(fila.aeropuerto || '').toUpperCase();
  if (AEROPUERTOS_ORLANDO[codigo]) return 'orlando';
  const texto = normal([fila.hotel, fila.punto_partida, fila.punto_llegada, fila.actividad].join(' '));
  return /\b(orlando|disney|kissimmee|universal|seaworld|championsgate|davenport|miami)\b/.test(texto) ? 'orlando' : 'rd';
}

function esTraslado(texto) {
  return /traslad|transfer|shuttle|aeropuerto|airport|llegada|salida del hotel|check ?in|check ?out|arrival|departure|\bin\b|\bout\b/.test(normal(texto));
}

function esSalida(texto) {
  return /salida|check ?out|departure|\bout\b|regreso|return|vuelta/.test(normal(texto));
}

function modalidadDe(texto) {
  const n = normal(texto);
  if (/luxury|lujo|\bvip\b/.test(n)) return 'luxury';
  if (/privad|private/.test(n)) return 'privado';
  if (/compartid|shared|regular|colectiv/.test(n)) return 'compartido';
  return '';
}

function buscarRuta(lista, a, b) {
  return lista.find(r => r.origen === a && r.destino === b) || lista.find(r => r.origen === b && r.destino === a) || null;
}

function porTamano(escalas, pax) {
  return escalas.find(e => pax >= e.min && pax <= e.max && e.precio !== null) || null;
}

function cotizarTrasladoRD(fila, t, pax, modalidad, avisos) {
  const salida = esSalida(fila.actividad || fila.tipo_servicio);
  const textoHotel = fila.hotel || (salida ? fila.punto_partida : fila.punto_llegada) || '';
  const aeropuerto = aeropuertoDe(fila, 'rd');
  const zona = zonaRD(textoHotel, t, avisos);
  const opciones = [];
  const detalle = { sentido: salida ? 'Salida (hotel → aeropuerto)' : 'Llegada (aeropuerto → hotel)' };

  if (!zona) {
    avisos.push(textoHotel ? `No encontré la zona del hotel "${textoHotel}".` : 'El servicio no tiene hotel: no sé a qué zona va.');
    return { detalle, opciones };
  }
  detalle.zona = zona.como;

  let origen = aeropuerto && aeropuerto.nombre;
  if (!origen) {
    // Traslado entre hoteles: la otra punta se busca en el punto de partida o de llegada.
    const otro = zonaRD(salida ? fila.punto_llegada : fila.punto_partida, t, []);
    if (otro && otro.zona !== zona.zona) origen = 'HTL ' + otro.zona;
  }
  if (!origen) {
    avisos.push(aeropuerto && aeropuerto.codigo
      ? `No hay tarifas desde el aeropuerto ${aeropuerto.codigo} en la base de conocimiento.`
      : 'El servicio no dice el aeropuerto.');
    return { detalle, opciones };
  }

  const destino = 'HTL ' + zona.zona;
  detalle.ruta = salida ? `${destino} → ${origen}` : `${origen} → ${destino}`;
  const ruta = buscarRuta(t.rd.traslados, origen, destino);
  const lujo = buscarRuta(t.rd.luxury, origen, destino);
  if (!ruta && !lujo) {
    avisos.push(`No hay tarifa para la ruta ${origen} - ${destino}.`);
    return { detalle, opciones };
  }

  if (ruta && (!modalidad || modalidad === 'compartido')) {
    if (ruta.adulto === null) {
      if (modalidad === 'compartido') avisos.push('Esta ruta no tiene servicio compartido: solo privado.');
    } else {
      const total = pax.adultos * ruta.adulto + pax.ninos * (ruta.nino ?? ruta.adulto);
      const partes = [`${pax.adultos} adulto(s) × ${dinero(ruta.adulto)}`];
      if (pax.ninos) partes.push(`${pax.ninos} niño(s) 2-10 años × ${dinero(ruta.nino ?? ruta.adulto)}`);
      opciones.push({ nombre: 'Compartido (por persona)', total, desglose: partes.join(' + ') });
    }
  }

  const totalPax = pax.adultos + pax.ninos + pax.infantes;
  if (ruta && (!modalidad || modalidad === 'privado')) {
    const escala = porTamano(ruta.privado, totalPax);
    if (escala) opciones.push({ nombre: 'Privado (por vehículo)', total: escala.precio, desglose: `${totalPax} pax, tarifa de ${escala.min} a ${escala.max} pax` });
    else avisos.push(`No hay tarifa privada para ${totalPax} pax en esta ruta.`);
  }

  if (modalidad === 'luxury') {
    const escala = lujo && porTamano(lujo.privado, totalPax);
    if (escala) opciones.push({ nombre: 'Luxury (por vehículo)', total: escala.precio, desglose: `${totalPax} pax, tarifa de ${escala.min} a ${escala.max} pax` });
    else avisos.push(lujo ? `No hay tarifa luxury para ${totalPax} pax en esta ruta.` : 'Esta ruta no tiene tarifa luxury.');
  }

  if (!modalidad && opciones.length > 1) avisos.push('El correo no dice si el traslado es compartido o privado: confírmalo.');
  if (pax.infantes) {
    const silla = t.rd.agregados.find(a => /silla de bebe/i.test(normal(a.servicio)));
    avisos.push(`Hay ${pax.infantes} infante(s): el tarifario no dice su precio en compartido; en privado se contaron como pax.` +
      (silla ? ` Silla de bebé: ${dinero(silla.precio)} por trayecto si la piden.` : ''));
  }
  return { detalle, opciones };
}

function cotizarTrasladoOrlando(fila, t, pax, avisos) {
  const salida = esSalida(fila.actividad || fila.tipo_servicio);
  const textoHotel = fila.hotel || (salida ? fila.punto_partida : fila.punto_llegada) || '';
  const aeropuerto = aeropuertoDe(fila, 'orlando');
  const detalle = { sentido: salida ? 'Salida (hotel → aeropuerto)' : 'Llegada (aeropuerto → hotel)' };
  const opciones = [];
  const n = ' ' + normal(textoHotel) + ' ';
  const zona = (ZONAS_ORLANDO.find(([claves]) => claves.some(c => n.includes(' ' + c + ' '))) || [])[1];

  if (!aeropuerto || !aeropuerto.nombre) {
    avisos.push('El servicio no dice el aeropuerto (MCO, SFB o MIA).');
    return { detalle, opciones };
  }
  if (!zona) {
    avisos.push(textoHotel ? `No sé en qué zona de Orlando está "${textoHotel}".` : 'El servicio no tiene hotel: no sé a qué zona va.');
    return { detalle, opciones };
  }
  detalle.zona = zona;
  detalle.ruta = salida ? `${zona} → ${aeropuerto.nombre}` : `${aeropuerto.nombre} → ${zona}`;
  const ruta = buscarRuta(t.orlando.traslados, aeropuerto.nombre, zona);
  if (!ruta) {
    avisos.push(`No hay tarifa para la ruta ${aeropuerto.nombre} - ${zona}.`);
    return { detalle, opciones };
  }
  const totalPax = pax.adultos + pax.ninos + pax.infantes;
  const caben = ruta.vehiculos.filter(v => totalPax >= v.min && totalPax <= v.max && v.ida !== null);
  if (!caben.length) avisos.push(`No hay vehículo para ${totalPax} pax en esta ruta.`);
  for (const v of caben) {
    opciones.push({
      nombre: `Somos Viaje ${v.vehiculo} (${v.min}-${v.max} pax)`, total: v.ida,
      desglose: `Un trayecto. Ida y vuelta: ${dinero(v.idaYVuelta)} en total (en vez de dos trayectos sueltos).`
    });
  }
  return { detalle, opciones };
}

function cotizarActividadRD(fila, t, pax, avisos) {
  const opciones = [];
  const detalle = {};
  const zona = zonaRD(fila.hotel || fila.punto_partida || '', t, avisos);
  let hoja = zona && HOJA_ACTIVIDADES[zona.zona];
  if (!hoja) {
    hoja = 'Bavaro - Punta Cana';
    avisos.push(zona ? `No hay actividades con salida desde ${zona.zona}: se usaron las de Bávaro - Punta Cana.`
      : 'No sé desde qué hotel sale: se usaron las tarifas con salida desde Bávaro - Punta Cana.');
  }
  detalle.zona = `Salida desde ${hoja}` + (zona ? ` (${zona.como})` : '');

  const buscadas = new Set(palabras(fila.actividad || fila.tipo_servicio));
  if (!buscadas.size) {
    avisos.push('El servicio no dice qué actividad es.');
    return { detalle, opciones };
  }
  const candidatas = (t.rd.actividades[hoja] || []).map(a => {
    const suyas = palabras(a.producto);
    const delTipo = palabras(a.tipo);
    const coinciden = suyas.filter(p => buscadas.has(p)).length;
    // Cuenta lo que cubre del nombre del producto o de lo que escribió la agencia ("CocoBongo" = "CocoBongo Punta Cana").
    const enProducto = Math.max(coinciden / (suyas.length || 1), 0.9 * coinciden / buscadas.size);
    const enTipo = delTipo.filter(p => buscadas.has(p)).length / (delTipo.length || 1);
    return { a, puntos: enProducto * 2 + enTipo };
  }).filter(c => c.puntos >= 1).sort((x, y) => y.puntos - x.puntos);

  if (!candidatas.length) {
    avisos.push(`No encontré "${fila.actividad || fila.tipo_servicio}" en las actividades con salida desde ${hoja}.`);
    return { detalle, opciones };
  }
  const mejor = candidatas[0].puntos;
  for (const { a, puntos } of candidatas.slice(0, 5)) {
    if (puntos < mejor - 0.5) break;
    const pvp = pax.adultos * (a.pvpAdulto || 0) + pax.ninos * (a.pvpMenor ?? a.pvpAdulto ?? 0);
    const net = pax.adultos * (a.netAdulto || 0) + pax.ninos * (a.netMenor ?? a.netAdulto ?? 0);
    const partes = [`${pax.adultos} adulto(s) × ${dinero(a.pvpAdulto || 0)}`];
    if (pax.ninos) partes.push(`${pax.ninos} menor(es) × ${dinero(a.pvpMenor ?? a.pvpAdulto ?? 0)}`);
    opciones.push({
      nombre: `${a.producto} · ${a.tipo}`, total: pvp, neto: net,
      desglose: `${partes.join(' + ')}. ${a.dias}, ${a.duracion}.`
    });
    if (pax.ninos && a.pvpMenor === null) avisos.push(`${a.producto} · ${a.tipo} no tiene precio de menor: se usó el de adulto.`);
  }
  if (opciones.length > 1) avisos.push('Hay varias opciones parecidas: elige la que pidió la agencia.');
  if (pax.infantes) avisos.push(`Hay ${pax.infantes} infante(s): el tarifario no dice su precio.`);
  return { detalle, opciones };
}

// fila: un servicio de la tabla clasificacion. cambios: valores corregidos a mano en el panel.
function cotizar(fila, cambios = {}) {
  const t = cargarTarifas();
  if (!t) return { error: 'Falta el archivo tarifas/tarifas.json. Ejecuta: node tarifas/generar-tarifas.js' };
  const f = { ...fila };
  for (const campo of ['actividad', 'hotel', 'aeropuerto', 'adultos', 'ninos', 'infantes']) {
    if (cambios[campo] !== undefined && cambios[campo] !== null) f[campo] = cambios[campo];
  }
  const avisos = [];
  const pax = { adultos: numero(f.adultos), ninos: numero(f.ninos), infantes: numero(f.infantes) };
  if (!pax.adultos && !pax.ninos) avisos.push('El servicio no dice cuántos pasajeros son.');
  const sede = sedeDe(f);
  const textoServicio = [f.actividad, f.tipo_servicio].join(' ');
  const tipo = esTraslado(textoServicio) ? 'traslado' : 'actividad';
  const modalidad = cambios.modalidad !== undefined ? cambios.modalidad : modalidadDe(textoServicio);

  let resultado;
  if (tipo === 'traslado') {
    resultado = sede === 'orlando' ? cotizarTrasladoOrlando(f, t, pax, avisos) : cotizarTrasladoRD(f, t, pax, modalidad, avisos);
  } else if (sede === 'orlando') {
    avisos.push('Todavía no cotizo actividades ni entradas de Orlando: la hoja de entradas llegó vacía.');
    resultado = { detalle: {}, opciones: [] };
  } else {
    resultado = cotizarActividadRD(f, t, pax, avisos);
  }
  return {
    id: fila.id, sede: sede === 'orlando' ? 'Orlando' : 'República Dominicana', tipo, modalidad,
    pax, ...resultado, avisos,
    datos: { actividad: f.actividad || '', hotel: f.hotel || '', aeropuerto: f.aeropuerto || '' },
    tarifas: t.generado
  };
}

// Rutas del cotizador. Devuelve true si atendió la petición.
async function atender(req, res, { client, puede, json, leerCuerpo }) {
  const url = req.url.split('?')[0];
  if (url !== '/api/cotizar') return false;
  if (!puede('ver_reservas')) { json(res, 403, { error: 'No tienes permiso para ver las reservas.' }); return true; }
  let id, cambios = {};
  if (req.method === 'POST') {
    const cuerpo = await leerCuerpo(req);
    id = Number(cuerpo.id);
    cambios = cuerpo.cambios || {};
  } else {
    id = Number(new URL(req.url, 'http://localhost').searchParams.get('id'));
  }
  if (!Number.isInteger(id)) { json(res, 400, { error: 'Falta el id del servicio.' }); return true; }
  const r = await client.query(
    'SELECT id, categoria, aeropuerto, actividad, tipo_servicio, hotel, punto_partida, punto_llegada, adultos, ninos, infantes FROM clasificacion WHERE id = $1',
    [id]
  );
  if (!r.rows[0]) { json(res, 404, { error: 'No encontré ese servicio.' }); return true; }
  const resultado = cotizar(r.rows[0], cambios);
  json(res, resultado.error ? 500 : 200, resultado);
  return true;
}

// El script del panel se sirve antes de iniciar sesión (lo pide la página al cargar).
function servirScript(req, res) {
  if (req.method !== 'GET' || req.url.split('?')[0] !== '/cotizador-panel.js') return false;
  fs.readFile(RUTA_SCRIPT, (err, data) => {
    if (err) { res.writeHead(404); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(data);
  });
  return true;
}

module.exports = { cotizar, atender, servirScript };
