// Base de conocimiento del asistente de redes (solo en el panel central, la maneja el programador desde la Oficina).
//
// El programador sube los tarifarios (Excel), las fichas (PDF) o una nota escrita de cada empresa.
// El panel los convierte en texto legible, QUITA lo interno (comisión, neto, costo) y los deja como borrador.
// El programador revisa la vista previa y publica. El chatbot (n8n) consulta lo publicado con la clave de la empresa:
//   GET /api/conocimiento/buscar?q=...&sede=...     (lo más parecido a la pregunta)
//   GET /api/conocimiento/indice?sede=...           (qué hay cargado)
//   GET /api/conocimiento/todo?sede=...             (todo el texto)
//   Cabecera: Authorization: Bearer <clave del asistente>

const crypto = require('crypto');
const { leerExcel, abrirZip, escribirExcel } = require('./lector-xlsx');

// Carpetas de la base. SOLO "chatbot" la lee el vendedor IA; las otras son de uso interno (Operaciones, reservas, políticas).
// En chatbot y tarifarios la subcarpeta es la sede (vacía = General). En operaciones es un tema (fijos + los que agregue el programador).
const CARPETAS = ['chatbot', 'tarifarios', 'operaciones'];
const TEMAS_OPERACIONES = [['reservas', 'Cómo hacer una reserva'], ['procesos', 'Procesos de operaciones'], ['politicas', 'Políticas de la empresa']];
// Palabras que delatan la sede de un documento (se suman al nombre de la sede). Sirve para cualquier empresa con estas sedes.
const PALABRAS_SEDE = {
  orlando: ['orlando', 'disney', 'magic kingdom', 'epcot', 'hollywood studios', 'animal kingdom', 'universal', 'islands of adventure', 'epic universe',
    'volcano bay', 'seaworld', 'sea world', 'aquatica', 'busch gardens', 'legoland', 'kissimmee', 'florida', 'kennedy', 'nasa', 'canaveral',
    'gatorland', 'icon park', 'outlet', 'outlets', 'miami', 'tampa', 'clearwater', 'everglades', 'typhoon lagoon', 'blizzard beach', 'international drive', 'mco'],
  'punta cana': ['punta cana', 'bavaro', 'saona', 'catalina', 'chavon', 'la romana', 'bayahibe', 'samana', 'cayo levantado', 'cayo arena', 'puerto plata',
    'santo domingo', 'sdq', 'puj', 'higuey', 'miches', 'uvero alto', 'cap cana', 'macao', 'juanillo', 'haitises', 'damajagua', 'hoyo azul', 'scape park',
    'coco bongo', 'cocobongo', 'monkeyland', 'republica dominicana', 'dominicana', 'dominicano', 'montana redonda', 'cabeza de toro', 'arena gorda',
    'boca chica', 'jarabacoa', 'constanza', 'ocean world', 'sosua', 'cabarete', 'pesos dominicanos', 'caño hondo', 'cano hondo']
};

const MAX_ARCHIVO = 15 * 1024 * 1024;
const DINERO = ['PVP', 'NET', 'PRECIO', 'COSTO', 'ONE WAY', 'ROUND', 'PAX', 'ADULTO', 'CHILD', 'TARIFA'];
// Columnas internas que el cliente final nunca debe ver.
const COLUMNA_INTERNA = /(^|[^A-Z])(COM|COMS|COMISION|COMISIONES|COMMISSION|NET|NETO|NETA|NETOS|COSTO|COSTOS|COST)([^A-Z]|$)/;
// Frases internas en textos (condiciones para agencias, notas de las fichas).
const LINEA_INTERNA = /comisi[oó]n|comisiones|commission|tarifas? netas?|precios? netos?|\bnet rates?\b|\bneto\b|\bneta\b/i;
const SECCIONES = ['DESCRIPCION', 'DATOS DE OPERACION', 'RECOMENDACIONES', 'INCLUYE', 'NO INCLUYE', 'ITINERARIO', 'OBSERVACIONES',
  'IMPORTANTE', 'REQUISITOS', 'POLITICAS', 'POLITICA DE CANCELACION', 'NOTA', 'NOTAS', 'HORARIOS', 'QUE LLEVAR', 'CONDICIONES',
  'DESCRIPTION', 'INCLUDES', 'NOT INCLUDED', 'ITINERARY', 'RECOMMENDATIONS', 'NOTES'];

function sinTildes(t) { return String(t).normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function limpio(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}
function titulo(t) { return t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); }
function esMayuscula(t) { return /\p{Lu}/u.test(t) && !/\p{Ll}/u.test(t); }
function usd(n) { return 'US$ ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\.00$/, ''); }

// Un precio escrito como texto en el Excel ("359,00", "1.199,00", "US$ 45") vale como número.
function comoNumero(t) {
  const s = String(t).replace(/\s|US\$|USD|\$/gi, '');
  if (!/^\d{1,3}([.,]\d{3})*([.,]\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(s)) return null;
  const decimal = s.match(/[.,](\d{1,2})$/);
  const entero = (decimal ? s.slice(0, -decimal[0].length) : s).replace(/[.,]/g, '');
  return Number(entero + (decimal ? '.' + decimal[1] : ''));
}
function formato(cab, v) {
  const t = limpio(v);
  if (!t || ['N/A', 'X'].includes(t.toUpperCase())) return t ? 'no disponible' : '';
  const C = cab.toUpperCase();
  if (typeof v === 'string' && comoNumero(t) !== null) v = comoNumero(t);
  if (typeof v === 'number') {
    if (DINERO.some(k => C.includes(k)) && !['DORMITORIOS', 'BAÑOS', 'OCUPACI'].some(k => C.includes(k))) return usd(v);
  }
  return t;
}
// Cabecera: 3 o más celdas de texto que no son datos. Una fila con "X" o precios escritos como texto ("359,00") es una fila de datos.
const esDato = v => /^(x|n\/a|na|-|—)$/i.test(limpio(v)) || comoNumero(limpio(v)) !== null;
const esCabecera = f => f.length >= 3 && f.every(([, c]) => typeof c.v === 'string') && !f.slice(1).some(([, c]) => esDato(c.v));

// Una hoja de Excel en líneas legibles: títulos, párrafos y una línea por fila con "Campo: valor".
function hojaATexto(filasCrudas, quitado) {
  const filas = filasCrudas.map(f => Object.entries(f).map(([c, x]) => [Number(c), x]).sort((a, b) => a[0] - b[0]));
  const lineas = [];
  let cab = null, previas = [], arrastre = {};
  const agregarTexto = t => { if (LINEA_INTERNA.test(t)) quitado.lineas.push(t); else lineas.push(t); };
  for (let i = 0; i < filas.length; i++) {
    let f = filas[i];
    const siguiente = filas[i + 1] || [];
    if (f.length === 1) {
      const t = limpio(f[0][1].v);
      if (t.length > 60) agregarTexto(t);
      else if (t) agregarTexto('### ' + t);
      previas = [];
      continue;
    }
    // Fila de 2 títulos sobre la cabecera ("TARIFA REGULAR POR PAX | TARIFA PRIVADA POR RUTA"): nombra los grupos de columnas.
    if (f.length === 2 && f.every(([, c]) => typeof c.v === 'string') && siguiente.length > 2 && esCabecera(siguiente)) {
      previas.push(Object.assign(f, { grupo: true })); agregarTexto(f.map(([, x]) => limpio(x.v)).join(' | ')); continue;
    }
    if (esCabecera(f)) {
      if (siguiente.length && esCabecera(siguiente) && siguiente.length >= f.length - 1) { previas.push(f); continue; }
      // Nombre de cada columna con las filas de cabecera de arriba (celdas combinadas: vale la última a la izquierda).
      cab = new Map();
      const etiquetas = f.slice(0, previas.some(p => p.grupo) ? 1 : 2).map(([c]) => c);
      for (const [col, x] of f) {
        const partes = [];
        for (const p of (etiquetas.includes(col) ? [] : previas.slice(-2))) {
          const antes = p.filter(([c]) => c <= col);
          if (antes.length) partes.push(limpio(antes[antes.length - 1][1].v));
        }
        partes.push(limpio(x.v));
        const nombre = partes.filter(Boolean).join(' · ');
        // "Costo" solo es interno si la tabla tiene además un precio de venta (PVP, precio, tarifa, adulto...).
        // En una lista como "Agregados · Costo por unidad" el costo ES el precio que se cobra.
        const N = sinTildes(nombre).toUpperCase();
        const soloCosto = /(^|[^A-Z])(COSTO|COSTOS|COST)([^A-Z]|$)/.test(N) && !/(^|[^A-Z])(COM|COMS|COMISION|COMISIONES|COMMISSION|NET|NETO|NETA|NETOS)([^A-Z]|$)/.test(N);
        const hayVenta = f.some(([, y]) => /PVP|PRECIO|TARIFA|ADULT|CHILD|MENOR|ONE WAY|ROUND|PAX|PRICE/.test(sinTildes(limpio(y.v)).toUpperCase()) && !/COSTO|COST/.test(sinTildes(limpio(y.v)).toUpperCase()));
        const interna = COLUMNA_INTERNA.test(N) && !(soloCosto && !hayVenta);
        if (interna && !quitado.columnas.includes(nombre)) quitado.columnas.push(nombre);
        cab.set(col, { nombre, interna });
      }
      previas = []; arrastre = {};
      continue;
    }
    if (!cab) { agregarTexto(f.map(([, x]) => limpio(x.v)).join(' | ')); continue; }
    // Celdas combinadas hacia abajo (ej. "Buggies" vale para Individual / Doble / Familiar).
    const primera = Math.min(...cab.keys());
    let m = new Map(f);
    if (!m.has(primera) && arrastre[primera]) m = new Map([[primera, arrastre[primera]], ...f]);
    if (m.has(primera)) arrastre[primera] = m.get(primera);
    const partes = [];
    for (const [col, { nombre, interna }] of [...cab.entries()].sort((a, b) => a[0] - b[0])) {
      if (!m.has(col) || interna) continue;
      const { v, enlace } = m.get(col);
      let txt = formato(nombre, v);
      if (enlace) txt = ['más detalles', 'ver aquí', 'ver aqui'].includes(txt.toLowerCase()) ? enlace : `${txt} (${enlace})`;
      if (txt) partes.push(`${esMayuscula(nombre) ? titulo(nombre) : nombre}: ${txt}`);
    }
    if (partes.length) lineas.push('- ' + partes.join('; '));
  }
  return lineas;
}

function nombreBase(archivo) {
  return archivo.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+(ESP|ENG|ES|EN)\s*$/i, '').replace(/\s+/g, ' ').trim();
}

// Sube cuando cambia cómo se lee un Excel: al arrancar, los Excel ya cargados se vuelven a leer desde el original.
// 2: "Costo por unidad" es precio cuando la hoja no tiene otro precio de venta (por ejemplo la hoja Agregados).
// 3: los títulos de grupo de 2 celdas sobre la cabecera se suman al nombre de cada columna.
// 4: filas con "X" o precios escritos como texto ya no se toman por cabeceras (desordenaban los nombres de columna).
const VERSION_EXCEL = 4;
function convertirExcel(buf, archivo) {
  const quitado = { columnas: [], lineas: [] };
  const avisos = [];
  const hojas = leerExcel(buf);
  const base = nombreBase(archivo);
  const documentos = [];
  for (const h of hojas) {
    const lineas = hojaATexto(h.filas, quitado);
    if (!lineas.length) { if (h.filas.length) avisos.push(`La hoja "${h.nombre}" no tiene datos que se puedan usar.`); continue; }
    if (lineas.every(l => l.startsWith('#'))) { avisos.push(`La hoja "${h.nombre}" está vacía (solo tiene el título): no se cargó. Pídele al cliente que la llene.`); continue; }
    documentos.push({ titulo: hojas.length > 1 ? `${base} · ${titulo(h.nombre)}` : base, hoja: h.nombre, lineas });
  }
  if (!documentos.length) avisos.push('No se encontró nada que leer en este Excel.');
  quitado.version = VERSION_EXCEL;
  return { tipo: 'tarifario', documentos, quitado, avisos };
}

// ---------- PDF ----------
let pdfParse = null;
function lectorPdf() {
  if (!pdfParse) {
    try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); }
    catch (e) { throw Object.assign(new Error('Falta el lector de PDF. En la carpeta del central ejecuta: npm install pdf-parse@1.1.1'), { codigo: 500 }); }
  }
  return pdfParse;
}
// Texto de cada página, línea por línea (como lo arma pdf-parse, pero separado por página).
// Word (.docx): párrafos y tablas como líneas de texto (sin librerías, con el mismo lector de zip del Excel).
function textoDocx(buf) {
  const leer = abrirZip(buf);
  const xml = leer('word/document.xml');
  if (!xml) throw new Error('No es un Word válido (.docx).');
  const lineas = [];
  const parrafo = p => (p.match(/<w:t[^>]*>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) || [])
    .map(x => x.startsWith('<w:tab') ? ' ' : x.startsWith('<w:br') ? ' ' : x.replace(/<[^>]+>/g, '')).join('')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();
  // Primero las tablas (cada fila = una línea "a | b | c"), después el resto de párrafos en orden.
  const cuerpo = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, t => '<w:p>' + (t.match(/<w:tr[\s\S]*?<\/w:tr>/g) || [])
    .map(tr => (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(tc => (tc.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map(parrafo).filter(Boolean).join(' ')).join(' | '))
    .map(f => `<w:t>${f.replace(/</g, '&lt;')}</w:t>`).join('</w:p><w:p>') + '</w:p>');
  for (const p of cuerpo.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) { const t = parrafo(p); if (t && !/^[|\s]+$/.test(t)) lineas.push(t); }
  return lineas;
}

async function paginasPdf(buf) {
  const paginas = [];
  await lectorPdf()(buf, {
    pagerender: pagina => pagina.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false }).then(c => {
      let ultimaY, texto = '';
      for (const item of c.items) {
        if (ultimaY === item.transform[5] || ultimaY === undefined) texto += item.str;
        else texto += '\n' + item.str;
        ultimaY = item.transform[5];
      }
      paginas.push(texto.split('\n').map(arreglarLigaduras).filter(Boolean));
      return '';
    })
  });
  return paginas;
}
// Letras dobles (ff, fi, fl) que algunos PDF guardan mal: "buYet" -> "buffet", "oZicial" -> "oficial".
function arreglarLigaduras(l) {
  return l.normalize('NFC').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/\b(B|b)u[A-Z](et|ets)\b/g, '$1uff$2').replace(/\b(O|o)[A-Z](icial|icina|icinas|iciales|ertas?|recemos|rece)\b/g, '$1f$2')
    .replace(/\b(E|e)[A-Z](ectivo|ectiva)\b/g, '$1f$2').replace(/\s+/g, ' ').trim();
}

// Cabecera / pie que se repite en cada página (dirección, teléfonos...). Solo mira el principio y el final de cada página.
function cabecerasDe(paginas) {
  if (paginas.length < 2) return [];
  const veces = new Map();
  for (const p of paginas) {
    const bordes = new Set([...p.slice(0, 8), ...p.slice(-4)]);
    for (const l of bordes) veces.set(l, (veces.get(l) || 0) + 1);
  }
  return [...veces].filter(([l, n]) => n >= 2 && l.length >= 4).map(([l]) => l);
}
const esNumeroPagina = l => /^(p[aá]g(ina)?\.?\s*)?\d{1,3}(\s*(de|of|\/)\s*\d{1,3})?$/i.test(l);

function pdfATexto(paginas, cabeceras, quitado) {
  const fuera = new Set(cabeceras);
  const lineas = [];
  let actual = '';
  const cerrar = () => {
    if (!actual) return;
    if (LINEA_INTERNA.test(actual)) quitado.lineas.push(actual); else lineas.push(actual);
    actual = '';
  };
  for (const pagina of paginas) {
    for (const l of pagina) {
      if (fuera.has(l) || esNumeroPagina(l)) { cerrar(); continue; }
      const clave = sinTildes(l).toUpperCase().replace(/:$/, '').trim();
      if (SECCIONES.includes(clave)) { cerrar(); lineas.push('## ' + titulo(l.replace(/:$/, ''))); continue; }
      if (/^(Ø|o|•|-|\*|▪|►|✓|➢)\s/.test(l) || !actual) { cerrar(); actual = l.replace(/^(Ø|•|▪|►|✓|➢)\s*/, '- ').replace(/^o\s+/, '- '); }
      else actual += ' ' + l;
    }
    cerrar();
  }
  cerrar();
  return lineas;
}

// ---------- Fragmentos para buscar ----------
function fragmentar(doc, tipo) {
  const max = tipo === 'tarifario' ? 1800 : 3500;
  const total = doc.lineas.join('\n').length;
  if (total <= max) return [{ titulo: doc.titulo, texto: doc.lineas.join('\n') }];
  const salida = [];
  let encabezado = '', actual = [], largo = 0;
  const cerrar = () => {
    if (actual.some(l => !l.startsWith('#'))) salida.push({ titulo: doc.titulo + (encabezado ? ' · ' + encabezado.replace(/^#+\s*/, '') : ''), texto: actual.join('\n') });
    actual = []; largo = 0;
  };
  for (const l of doc.lineas) {
    if (/^#{2,3} /.test(l)) {
      if (tipo === 'tarifario') {
        if (actual.some(x => !x.startsWith('#'))) cerrar();
        encabezado = l;
      }
      actual.push(l); largo += l.length + 1; continue;
    }
    if (largo + l.length > max && actual.length) { cerrar(); if (encabezado) { actual.push(encabezado + ' (sigue)'); largo = encabezado.length; } }
    actual.push(l); largo += l.length + 1;
  }
  cerrar();
  return salida;
}

const VACIAS = new Set(('a al algo algun alguna como con cual cuales cuando de del desde donde el ella en entre es esa ese eso esta este esto ' +
  'hay la las le les lo los mas me mi mis muy no nos o para pero por que se sea si sin sobre su sus te tiene tienen tu un una unas unos ' +
  'y ya yo hola buenas buenos dias tardes noches quiero quisiera favor gracias saber informacion info the and of to for in is are').split(' '));
// "coco bongo" también busca "cocobongo" (y al revés no hace falta: el texto se parte en palabras).
function conPares(lista) {
  const salida = new Set(lista);
  for (let i = 0; i + 1 < lista.length; i++) if (lista[i].length >= 3 && lista[i + 1].length >= 3) salida.add(lista[i] + lista[i + 1]);
  return [...salida];
}
// Las filas de los tarifarios que más se parecen a la pregunta (una fila = un trayecto, un tour o un agregado con sus precios).
function filasParecidas(fragmentos, consulta, n = 8) {
  const pq = new Set(conPares(palabras(consulta)));
  if (!pq.size) return [];
  const vistas = new Set(), filas = [];
  for (const fr of fragmentos) {
    for (const l of fr.texto.split('\n')) {
      if (!/US\$|\|\s*\d/.test(l) || vistas.has(l)) continue;
      vistas.add(l);
      const pl = new Set(conPares(palabras(l)));
      let s = 0;
      // Una palabra larga y rara ("cocobongo", "nickelodeon") pesa el doble que una común.
      for (const p of pq) if (pl.has(p)) s += /^\d/.test(p) ? 0.5 : p.length >= 7 ? 2 : 1;
      if (s >= 2) filas.push({ s, l: l.replace(/^\s*-\s*/, ''), titulo: fr.titulo });
    }
  }
  return filas.sort((a, b) => b.s - a.s).slice(0, n);
}

function palabras(t) {
  return sinTildes(String(t).toLowerCase()).split(/[^a-z0-9ñ]+/).filter(p => p && !VACIAS.has(p) && (p.length > 1 || /\d/.test(p)))
    .map(p => p.length > 4 ? p.replace(/(es|s)$/, '') : p);
}

// Sinónimos para buscar: el cliente dice "traslado", "transfer" o "translado"; el tarifario dice "Trayecto ... AIRPORT".
const SINONIMOS = [
  [['traslado', 'traslados', 'transfer', 'transfers', 'translado', 'shuttle', 'transporte', 'transportation', 'pickup', 'ride', 'taxi', 'trayecto'], ['traslado', 'transfer', 'trayecto']],
  [['aeropuerto', 'airport', 'aeroporto', 'aerop', 'apto'], ['aeropuerto', 'airport']],
  [['santo domingo', 'las americas', 'sdq', 'santo dgo'], ['santo', 'domingo', 'sdq']],
  [['punta cana', 'puj'], ['punta', 'cana', 'puj']],
  // Zonas de Punta Cana que en el tarifario van como "HTL PUNTA CANA".
  [['bavaro', 'arena gorda', 'cabeza de toro', 'cortecito', 'los corales', 'macao', 'white sands', 'friusa'], ['punta', 'cana', 'bavaro']],
  [['la romana', 'lrm'], ['romana', 'lrm']],
  [['puerto plata', 'pop'], ['puerto', 'plata', 'pop']],
  [['nino', 'nina', 'ninos', 'child', 'children', 'kid', 'kids', 'chd', 'crianca', 'criancas', 'menor'], ['nino', 'child', 'chd']],
  [['excursion', 'excursiones', 'tour', 'tours', 'passeio', 'passeios', 'actividad', 'activity', 'trip', 'paseo'], ['excursion', 'tour']],
  [['privado', 'private', 'privativo'], ['privado', 'private']],
  [['compartido', 'shared', 'regular', 'compartilhado'], ['compartido', 'regular', 'shared']]
];
function ampliarConsulta(texto) {
  const plano = ' ' + sinTildes(String(texto || '').toLowerCase()).replace(/[^a-z0-9ñ]+/g, ' ') + ' ';
  const extra = new Set();
  for (const [dice, agrega] of SINONIMOS) if (dice.some(d => plano.includes(' ' + d + ' '))) agrega.forEach(x => extra.add(x));
  return extra.size ? texto + ' ' + [...extra].join(' ') : texto;
}
// Listado de hoteles con su zona (por ejemplo la hoja "Hotel": "NICKELODEON | UVERO ALTO, PUNTA CANA").
// Sirve para que "de Santo Domingo al Nickelodeon" encuentre la tarifa "SDQ - HTL UVERO ALTO".
// Palabras que no identifican a un hotel (genéricas o nombres de lugares): "de Santo Domingo al ..." no es el hotel W&P Santo Domingo.
const GENERICAS_HOTEL = new Set(('hotel htl resort resorts spa beach all inclusive suites suite the by and punta cana bavaro santo domingo ' +
  'romana puerto plata samana juan dolio boca chica bayahibe uvero alto cap macao arena gorda cabeza toro cortecito playa costa').split(' '));
function hotelesYZonas(fragmentos) {
  const lista = [];
  for (const fr of fragmentos) {
    if (!/hotel/i.test(fr.titulo + ' ' + fr.texto.slice(0, 200))) continue;
    for (const l of fr.texto.split('\n')) {
      const m = l.match(/^\s*-?\s*([^|;:\n]{3,60}?)\s*\|\s*([^|\n]{3,60})\s*$/);
      if (!m || /^hotel$/i.test(m[1].trim())) continue;
      const nombre = sinTildes(m[1].toLowerCase()).replace(/[^a-z0-9ñ ]+/g, ' ').trim();
      const clave = nombre.split(/\s+/).filter(w => w.length > 2 && !GENERICAS_HOTEL.has(w));
      if (clave.length) lista.push({ hotel: m[1].trim(), zona: m[2].trim(), clave });
    }
  }
  return lista;
}
function hotelesEn(texto, lista) {
  const plano = ' ' + sinTildes(String(texto || '').toLowerCase()).replace(/[^a-z0-9ñ]+/g, ' ') + ' ';
  const hallados = lista.filter(h => h.clave.every(w => plano.includes(' ' + w + ' ')));
  // Si "excellence" y "excellence el carmen" coinciden, se queda el más largo.
  return hallados.filter(h => !hallados.some(o => o !== h && o.clave.length > h.clave.length && h.clave.every(w => o.clave.includes(w)))).slice(0, 3);
}

// ---------- El asistente (la IA que contesta en las redes) ----------
const MODELO_POR_DEFECTO = 'anthropic/claude-haiku-5.5';
const MOTIVOS = { reservar: 'Quiere reservar o pagar', reclamo: 'Reclamo o problema', no_sabe: 'No está en la base', otra_sede: 'Es de otra sede', humano: 'Pidió hablar con una persona' };

// Idioma del cliente, detectado por palabras comunes (para ordenárselo a la IA sin dudas).
const PALABRAS_IDIOMA = {
  en: 'the what how much is are rides ride price prices hello hi want would like can could please thanks thank you transfer airport ticket tickets where when have has does do my we our there and of to from with need book booking any'.split(' '),
  pt: 'olá ola oi quanto custa custam você voce vocês voces obrigado obrigada não nao gostaria preço preco ingresso ingressos aeroporto quero tem bom boa dia noite passeio passeios crianças criancas criança são sao está também tambem uma meu minha nós nos fazer reserva valor'.split(' '),
  es: 'hola cuánto cuanto cuesta cuestan precio precios quiero gracias por favor qué niños ninos niño tienen tiene buenas buenos días dias aeropuerto traslado traslados usted están también tambien una mi nosotros hacer reservar entrada entradas el la los las del y es'.split(' ')
};
const NOMBRE_IDIOMA = { es: ['español', 'Spanish'], pt: ['portugués de Brasil', 'Brazilian Portuguese'], en: ['inglés', 'English'] };
function detectarIdioma(texto) {
  const p = String(texto || '').toLowerCase().split(/[^a-záéíóúâêôãõçñü]+/).filter(Boolean);
  if (p.length < 2) return '';
  const pts = {};
  for (const [k, lista] of Object.entries(PALABRAS_IDIOMA)) pts[k] = p.filter(w => lista.includes(w)).length;
  if (/[ãõç]|ção|ções/.test(String(texto).toLowerCase())) pts.pt += 2;
  if (/[ñ¿¡]/.test(String(texto))) pts.es += 2;
  const orden = Object.entries(pts).sort((a, b) => b[1] - a[1]);
  return orden[0][1] >= 2 && orden[0][1] > orden[1][1] ? orden[0][0] : '';
}

function zonaDe(sede) {
  return /orlando|miami|florida|usa|estados unidos|new york|nueva york/i.test(sinTildes(sede || '')) ? 'America/New_York' : 'America/Santo_Domingo';
}
function instruccionesBase({ nombre, empresa, sede, otras, extra, bienvenida, primera, web }) {
  return `Eres ${nombre}, que atiende los mensajes de Facebook, Instagram y WhatsApp de ${empresa}${sede ? `, oficina de ${sede}` : ''}.
Eres un asistente virtual: si te preguntan, dilo con naturalidad. No tienes nombre propio.

IDIOMA
- Escribe tu respuesta en el idioma del ÚLTIMO mensaje del cliente: español, portugués (Brasil), inglés u otro. Si cambia de idioma, cambia tú también.
- La INFORMACIÓN está en español: tradúcela al idioma del cliente, pero deja tal cual los precios, los nombres de tours, hoteles, zonas y los enlaces.
- El resumen_para_asesor va SIEMPRE en español (los asesores hablan español).

CÓMO RESPONDER
- Tono cálido y profesional, como una buena agente de viajes.
- Mensajes cortos, para leer en el celular: 2 a 6 líneas. Usa listas cortas con "•" si hay varias opciones. Nada de tablas ni de markdown (#, **).
- Haz una sola pregunta a la vez. Si faltan datos para dar un precio (fecha, cantidad de adultos y niños con edades, hotel o zona), pregúntalos.
- Emojis: pocos (0 a 2 por mensaje).
${primera ? `- Este es el PRIMER mensaje de la conversación: empieza saludando${bienvenida ? ` con esta bienvenida (adaptada al idioma del cliente y a la hora: buenos días / buenas tardes / buenas noches): "${bienvenida}"` : ' con un saludo breve según la hora (buenos días / buenas tardes / buenas noches)'}, y en el mismo mensaje responde lo que preguntó.` : '- Ya saludaste antes: NO vuelvas a saludar ni a presentarte, ve directo a la respuesta.'}

LA INFORMACIÓN
- Usa SOLO la información de la sección INFORMACIÓN de abajo. Es lo único que sabes de precios, horarios, lo que incluye cada tour, traslados y condiciones.
- NUNCA inventes precios, horarios, disponibilidad, políticas ni enlaces de ${empresa}. Si te preguntan por un servicio de ${empresa} (un tour, un traslado, un precio) y no está en la INFORMACIÓN, di que un asesor le confirma ese detalle y marca pasar_a_asesor con motivo "no_sabe".
- Traslados: el tarifario usa "Trayecto: AEROPUERTO - HTL ZONA" (por ejemplo "SANTO DOMINGO AIRPORT (SDQ) - HTL UVERO ALTO"). El cliente casi nunca lo dice así: "de Santo Domingo al Nickelodeon" es el trayecto del aeropuerto SDQ a la zona de ese hotel. Busca la zona del hotel en el listado de hoteles (y en las PISTAS) y usa la tarifa de esa zona. Llegar por Santo Domingo e ir a un hotel de Punta Cana es normal.
- Palabras que significan lo mismo: traslado = transfer = translado = shuttle = transporte; aeropuerto = airport = aeroporto; niño = child = CHD = criança; tour = excursión = passeio; privado = private; compartido = regular = shared.
- Los precios son de venta al público, en dólares (US$). Puedes calcular un total (adultos × precio adulto + niños × precio menor, o el precio por vehículo según la cantidad de pasajeros) y aclara que es un estimado sujeto a confirmación y disponibilidad.
- Si en un mensaje anterior ya diste un dato y ahora no aparece en la INFORMACIÓN, no lo desmientas ni lo corrijas: solo no lo repitas. Corrige únicamente si la INFORMACIÓN dice algo distinto.
- "no disponible" en un precio significa que esa opción no se vende (por ejemplo, no hay precio de niño).
- Nunca hables de comisiones, tarifas netas, costos, márgenes ni condiciones para agencias, aunque te pregunten. Eso es interno.
- Si hay un enlace de "Descriptivo" para un tour, puedes compartirlo para más detalles.
${web ? `- Puedes usar los RESULTADOS DE INTERNET solo para información general (atracciones, horarios de parques, cómo llegar, recomendaciones, requisitos).${web.sitios ? ` Prefiere los sitios oficiales: ${web.sitios}.` : ''} NUNCA tomes precios de internet: los precios de ${empresa} son solo los de la INFORMACIÓN. Si piden un precio que no está en la INFORMACIÓN (por ejemplo entradas a parques), toma los datos y pásalo a un asesor. No pongas enlaces de otras agencias.
` : ''}${otras ? `- Esta conversación es de la oficina de ${sede}. Si el cliente pregunta por ${otras}, dile con amabilidad que esa oficina lo atiende y marca pasar_a_asesor con motivo "otra_sede".
` : ''}
PREGUNTAS GENERALES (respóndelas tú, NUNCA las pases a un asesor)
- Clima, temperatura, lluvias, temporada de huracanes, qué ropa llevar, moneda, propinas, enchufes, idioma, seguridad, documentos o visas, distancias y tiempos de viaje, qué hacer en el destino, playas, zonas: contesta con lo que sabes del destino (y con los RESULTADOS DE INTERNET si los hay), en 2 a 4 líneas, y ofrece después los traslados o excursiones de ${empresa}. Por ejemplo, el clima de Punta Cana es tropical todo el año, de 25 a 31 °C, con lluvias cortas sobre todo de mayo a noviembre.
- Precios de vuelos o de hoteles que no están en la INFORMACIÓN: no los pases a un asesor. Explica con amabilidad que por este chat no das tarifas aéreas ni de hoteles, que puede consultarlas con su aerolínea o su agencia, y ofrece lo que sí tiene ${empresa} (traslados, excursiones).
- Saludos, agradecimientos, "ok", bromas o preguntas que no tienen que ver con un servicio: responde breve y amable, sin pasar a un asesor.
- Pasa a un asesor solo cuando hay una venta o un problema real (los motivos de abajo), nunca para quitarte una pregunta de encima.

PASAR A UN ASESOR (pasar_a_asesor = true)
- "reservar": el cliente ya quiere reservar, confirmar o pagar. Antes de pasarlo, si faltan, pide en un solo mensaje: nombre completo, fecha, cantidad de adultos y niños (con edades) y hotel. Cuando los tenga (o si no quiere darlos), dile que un asesor le confirma la reserva y el pago.
- "reclamo": quejas, problemas con un servicio, cambios o cancelaciones de una reserva ya hecha. Responde con empatía, sin discutir ni prometer reembolsos.
- "no_sabe": pregunta por un servicio, precio o condición de ${empresa} que no está en la INFORMACIÓN (no por temas generales).
- "humano": pide hablar con una persona.
- Al pasarlo, dile que un asesor de ${sede || 'la oficina'} le escribe por este mismo chat en breve. No des horarios de respuesta que no estén en la INFORMACIÓN.
${extra ? `
INSTRUCCIONES DE LA EMPRESA
${extra}
` : ''}
FORMATO DE SALIDA
Responde SOLO con un objeto JSON, sin nada antes ni después:
{"respuesta": "texto para el cliente", "idioma": "es", "pasar_a_asesor": false, "motivo": "", "resumen_para_asesor": ""}
- idioma: código del idioma en que respondiste ("es", "pt", "en", "fr"...).
- motivo: "", "reservar", "reclamo", "no_sabe", "otra_sede" o "humano".
- resumen_para_asesor: si pasas a un asesor, 1 o 2 líneas con lo que el cliente quiere y los datos que dio (servicio, fecha, personas, hotel). Si no, "".`;
}

// Si la IA no devolvió un JSON válido, se rescata solo el texto de "respuesta".
function rescatarRespuesta(contenido) {
  const c = String(contenido || '').replace(/```(?:json)?/gi, '').trim();
  const m = c.match(/"respuesta"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
  if (m) { try { return JSON.parse('"' + m[1].replace(/\n/g, '\\n') + '"'); } catch (e) { return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'); } }
  return c.split('\n')
    .filter(l => !/resumen[_ ]para[_ ]asesor|pasar[_ ]a[_ ]asesor|"motivo"|"idioma"|^\s*[{}]\s*,?\s*$/i.test(l))
    .join('\n').replace(/^\s*\{?\s*"?respuesta"?\s*:\s*"?/i, '').replace(/"?\s*,?\s*\}?\s*$/, '').trim();
}

function leerJSON(t) {
  const limpio = String(t || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(limpio); } catch (e) {}
  const m = limpio.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

const crearSimulacion = require('./simulacion');

module.exports = function crearConocimiento({ client, config = {}, registrar, central, claveIA }) {
  const activo = central.activo;
  const indices = new Map();   // 'empresa_id' o 'empresa_id:b' (con borradores) -> { fragmentos, df, promedio }
  const olvidar = id => { indices.delete(String(id)); indices.delete(id + ':b'); };

  async function preparar() {
    if (!activo) return;
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS conocimiento_sedes TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS conocimiento_token TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS conocimiento_ajustes JSONB NOT NULL DEFAULT '{}'");
    await client.query(`CREATE TABLE IF NOT EXISTS conocimiento_archivos (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL, nombre TEXT NOT NULL, tipo VARCHAR(10) NOT NULL,
      sede TEXT NOT NULL DEFAULT '', estado VARCHAR(12) NOT NULL DEFAULT 'borrador',
      documentos JSONB NOT NULL DEFAULT '[]', quitado JSONB NOT NULL DEFAULT '{}', avisos JSONB NOT NULL DEFAULT '[]',
      crudo JSONB, original BYTEA, tamano INTEGER NOT NULL DEFAULT 0,
      subido TIMESTAMPTZ NOT NULL DEFAULT NOW(), subido_por TEXT NOT NULL DEFAULT '', publicado TIMESTAMPTZ)`);
    await client.query('CREATE INDEX IF NOT EXISTS conocimiento_archivos_empresa ON conocimiento_archivos (empresa_id, estado)');
    // Carpetas (chatbot / tarifarios / operaciones). La primera vez, lo que ya había queda en Chatbot y se ordena por sede según su contenido.
    const conCarpetas = (await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'conocimiento_archivos' AND column_name = 'carpeta'")).rows.length;
    await client.query("ALTER TABLE conocimiento_archivos ADD COLUMN IF NOT EXISTS carpeta VARCHAR(20) NOT NULL DEFAULT 'chatbot'");
    await client.query("ALTER TABLE conocimiento_archivos ADD COLUMN IF NOT EXISTS subcarpeta TEXT NOT NULL DEFAULT ''");
    // Carpetas con nombre que crea el usuario dentro de Chatbot o Tarifarios (no cambian la sede que usa el asistente).
    await client.query("ALTER TABLE conocimiento_archivos ADD COLUMN IF NOT EXISTS grupo TEXT NOT NULL DEFAULT ''");
    await client.query('ALTER TABLE conocimiento_archivos ADD COLUMN IF NOT EXISTS op_estado JSONB');
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS conocimiento_carpetas JSONB NOT NULL DEFAULT '{}'");
    if (!conCarpetas) {
      for (const e of (await client.query('SELECT id, conocimiento_sedes FROM empresas')).rows) {
        try { const c = await ordenarPorSede(e.id); if (Object.keys(c).length) console.log(`Base del asistente: empresa ${e.id} ordenada por sede`, JSON.stringify(c)); }
        catch (err) { console.error('Base del asistente: no se pudo ordenar por sede', e.id, err.message); }
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS conocimiento_ejemplos (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL, sede TEXT NOT NULL DEFAULT '', cliente TEXT NOT NULL,
      contexto JSONB NOT NULL DEFAULT '[]', respuesta TEXT NOT NULL DEFAULT '', ideal TEXT NOT NULL DEFAULT '',
      voto VARCHAR(5) NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', estado VARCHAR(12) NOT NULL DEFAULT 'nuevo',
      autor TEXT NOT NULL DEFAULT '', origen VARCHAR(10) NOT NULL DEFAULT 'oficina', creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), revisado TIMESTAMPTZ)`);
    await client.query('CREATE INDEX IF NOT EXISTS conocimiento_ejemplos_empresa ON conocimiento_ejemplos (empresa_id, estado)');
    await client.query(`CREATE TABLE IF NOT EXISTS conocimiento_cabeceras (
      empresa_id INTEGER NOT NULL, linea TEXT NOT NULL, PRIMARY KEY (empresa_id, linea))`);
    // Excel cargados con una versión anterior del lector: se vuelven a leer desde el archivo original (mismo estado y sede).
    const viejos = (await client.query(`SELECT id, nombre FROM conocimiento_archivos WHERE tipo = 'tarifario' AND original IS NOT NULL
      AND COALESCE((quitado->>'version')::int, 1) < $1`, [VERSION_EXCEL])).rows;
    for (const v of viejos) {
      try {
        const o = (await client.query('SELECT original FROM conocimiento_archivos WHERE id = $1', [v.id])).rows[0].original;
        const r = convertirExcel(o, v.nombre);
        await client.query('UPDATE conocimiento_archivos SET documentos = $1, quitado = $2, avisos = $3 WHERE id = $4',
          [JSON.stringify(r.documentos), JSON.stringify(r.quitado), JSON.stringify(r.avisos), v.id]);
      } catch (err) { console.error('Base del asistente: no se pudo volver a leer', v.nombre, err.message); }
    }
    if (viejos.length) console.log(`Base del asistente: ${viejos.length} Excel vueltos a leer con el lector nuevo.`);
    await simulacion.preparar();
  }

  const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const error = (msg, codigo = 400) => Object.assign(new Error(msg), { codigo });
  async function empresa(id) {
    const e = (await client.query('SELECT id, nombre, slug, conocimiento_sedes, conocimiento_token, conocimiento_ajustes, conocimiento_carpetas FROM empresas WHERE id = $1', [Number(id)])).rows[0];
    if (!e) throw error('Empresa no encontrada.', 404);
    return e;
  }
  const sedesDe = e => e.conocimiento_sedes.split(',').map(s => s.trim()).filter(Boolean);
  function adivinarSede(nombre, sedes) {
    const n = sinTildes(nombre).toLowerCase();
    const hallada = sedes.find(s => n.includes(sinTildes(s).toLowerCase()));
    return hallada || sedes[0] || '';
  }

  // Sede de un documento según su nombre y su texto (Punta Cana, Orlando o la que tenga la empresa). Si no está claro: General ('').
  function sedePorContenido(nombre, textoDoc, sedes) {
    if (!sedes.length) return '';
    const plano = t => ' ' + sinTildes(String(t || '')).toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ') + ' ';
    const n = plano(nombre), t = plano(String(textoDoc || '').slice(0, 60000));
    const puntos = sedes.map(s => {
      const k = sinTildes(s).toLowerCase().trim();
      let p = 0;
      for (const w of new Set([k, ...(PALABRAS_SEDE[k] || [])])) {
        const pal = ' ' + sinTildes(w).toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim() + ' ';
        if (n.includes(pal)) p += 12;
        p += Math.min(t.split(pal).length - 1, 15);
      }
      return p;
    });
    const orden = [...puntos].sort((a, b) => b - a);
    if (!orden[0] || (orden[1] && orden[1] >= orden[0] * 0.6)) return '';
    return sedes[puntos.indexOf(orden[0])];
  }
  const textoDeDocs = docs => (docs || []).map(d => [d.titulo, d.hoja, ...(d.lineas || [])].filter(Boolean).join('\n')).join('\n');
  // Ordena por sede todo lo de la carpeta Chatbot (y Tarifarios). Devuelve cuántos quedaron en cada una.
  async function ordenarPorSede(empresaId, soloIds = null) {
    const e = (await client.query('SELECT conocimiento_sedes FROM empresas WHERE id = $1', [empresaId])).rows[0];
    const sedes = e ? e.conocimiento_sedes.split(',').map(x => x.trim()).filter(Boolean) : [];
    if (!sedes.length) return {};
    const filas = (await client.query(`SELECT id, nombre, tipo, documentos FROM conocimiento_archivos WHERE empresa_id = $1 AND carpeta IN ('chatbot', 'tarifarios')
      AND ($2::int[] IS NULL OR id = ANY($2::int[]))`, [empresaId, soloIds])).rows;
    const cuenta = {};
    const elegidas = filas.map(f => ({ ...f, sede: sedePorContenido(f.nombre, textoDeDocs(f.documentos), sedes) }));
    for (const f of elegidas) {
      // Una ficha que no nombra ningún lugar va con sus parecidas (si casi todas las fichas son de una sede).
      if (!f.sede && f.tipo === 'ficha') f.sede = await sedeMayoritaria(empresaId, 'ficha', elegidas);
      await client.query('UPDATE conocimiento_archivos SET sede = $1 WHERE id = $2', [f.sede, f.id]);
      cuenta[f.sede || 'General'] = (cuenta[f.sede || 'General'] || 0) + 1;
    }
    olvidar(empresaId);
    return cuenta;
  }
  async function sedeMayoritaria(empresaId, tipo, lista = null) {
    const filas = lista ? lista.filter(x => x.tipo === tipo) : (await client.query("SELECT sede FROM conocimiento_archivos WHERE empresa_id = $1 AND tipo = $2 AND carpeta = 'chatbot' AND estado = 'publicado'", [empresaId, tipo])).rows;
    const con = filas.filter(x => x.sede);
    if (con.length < 5) return '';
    const c = {}; for (const x of con) c[x.sede] = (c[x.sede] || 0) + 1;
    const [sede, n] = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
    return n / con.length >= 0.85 ? sede : '';
  }

  // Tarifario subido a la carpeta 💲 Tarifarios: se manda a la base de la empresa y su panel lo carga en los precios de Operaciones.
  async function enviarAOperaciones(empresaId, archivoId) {
    const a = (await client.query('SELECT nombre, original FROM conocimiento_archivos WHERE id = $1', [archivoId])).rows[0];
    if (!a || !a.original || !/\.xlsx$|\.xlsm$/i.test(a.nombre)) return null;
    let estado;
    try {
      const fila = (await client.query('SELECT * FROM empresas WHERE id = $1', [empresaId])).rows[0];
      const cola = await central.ayudantes.conEmpresa(fila, async db => {
        await db.query(`CREATE TABLE IF NOT EXISTS op_cola_tarifarios (id SERIAL PRIMARY KEY, origen_id INTEGER, archivo TEXT NOT NULL, datos BYTEA,
          estado VARCHAR(12) NOT NULL DEFAULT 'pendiente', resultado JSONB, creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), procesado TIMESTAMPTZ)`);
        return (await db.query('INSERT INTO op_cola_tarifarios (origen_id, archivo, datos) VALUES ($1, $2, $3) RETURNING id', [archivoId, a.nombre, a.original])).rows[0].id;
      });
      estado = { estado: 'pendiente', cola, enviado: new Date().toISOString() };
    } catch (err) { estado = { estado: 'error', error: 'No se pudo mandar a Operaciones: ' + err.message }; }
    await client.query('UPDATE conocimiento_archivos SET op_estado = $1 WHERE id = $2', [JSON.stringify(estado), archivoId]);
    return estado;
  }
  // Mira en la base de la empresa cómo terminó la carga de los tarifarios pendientes.
  async function revisarOperaciones(empresaId) {
    const pend = (await client.query("SELECT id, op_estado FROM conocimiento_archivos WHERE empresa_id = $1 AND op_estado->>'estado' = 'pendiente'", [empresaId])).rows;
    if (!pend.length) return;
    try {
      const fila = (await client.query('SELECT * FROM empresas WHERE id = $1', [empresaId])).rows[0];
      const filas = await central.ayudantes.conEmpresa(fila, async db => (await db.query('SELECT id, estado, resultado, procesado FROM op_cola_tarifarios WHERE id = ANY($1::int[])',
        [pend.map(p => Number(p.op_estado.cola))])).rows);
      for (const p of pend) {
        const c = filas.find(x => x.id === Number(p.op_estado.cola));
        if (c && c.estado !== 'pendiente') await client.query('UPDATE conocimiento_archivos SET op_estado = $1 WHERE id = $2', [JSON.stringify({ ...p.op_estado, estado: c.estado, resultado: c.resultado, procesado: c.procesado }), p.id]);
      }
    } catch (err) { /* el panel de la empresa puede estar apagado: se vuelve a mirar la próxima vez */ }
  }
  function temasOperaciones(e) {
    const extra = ((e.conocimiento_carpetas || {}).operaciones || []).filter(x => x && x.k && x.n);
    return [...TEMAS_OPERACIONES.map(([k, n]) => ({ k, n, fijo: true })), ...extra.map(x => ({ k: x.k, n: x.n }))];
  }
  // Carpetas con nombre por carpeta: { chatbot: ['Traslados', …], tarifarios: [...] }
  function gruposDe(e) {
    const g = (e.conocimiento_carpetas || {}).grupos || {};
    const salida = {};
    for (const k of ['chatbot', 'tarifarios']) salida[k] = (Array.isArray(g[k]) ? g[k] : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 30);
    return salida;
  }

  async function reconstruirPdfs(empresaId) {
    const cab = (await client.query('SELECT linea FROM conocimiento_cabeceras WHERE empresa_id = $1', [empresaId])).rows.map(r => r.linea);
    const filas = (await client.query("SELECT id, crudo FROM conocimiento_archivos WHERE empresa_id = $1 AND tipo = 'ficha' AND estado = 'borrador'", [empresaId])).rows;
    for (const f of filas) {
      const quitado = { columnas: [], lineas: [] };
      const doc = { ...f.crudo.doc, lineas: pdfATexto(f.crudo.paginas, cab, quitado) };
      await client.query('UPDATE conocimiento_archivos SET documentos = $1, quitado = $2 WHERE id = $3', [JSON.stringify([doc]), JSON.stringify(quitado), f.id]);
    }
  }

  async function subir(u, f) {
    const e = await empresa(f.empresa_id);
    const nombre = texto(f.nombre, 180).replace(/[\\/]/g, ' ');
    if (!nombre) throw error('Falta el nombre del archivo.');
    const sedes = sedesDe(e);
    const carpeta = CARPETAS.includes(f.carpeta) ? f.carpeta : 'chatbot';
    const subcarpeta = carpeta === 'operaciones' ? (temasOperaciones(e).find(x => x.k === f.subcarpeta) || { k: 'politicas' }).k : '';
    let sede = carpeta === 'operaciones' ? texto(f.sede || '', 60) : f.sede !== undefined && f.sede !== null && f.sede !== '*' ? texto(f.sede, 60) : null;
    const grupo = carpeta === 'operaciones' ? '' : texto(f.grupo || '', 60);
    if (grupo && !gruposDe(e)[carpeta].includes(grupo)) throw error('Primero crea la carpeta "' + grupo + '".');
    let r, buf = null, crudo = null;
    if (f.nota !== undefined) {
      const t = String(f.nota || '').replace(/\r/g, '').trim().slice(0, 50000);
      if (!t) throw error('Escribe el texto de la nota.');
      const quitado = { columnas: [], lineas: [] };
      const lineas = t.split('\n').map(l => l.trim()).filter(Boolean).filter(l => LINEA_INTERNA.test(l) ? (quitado.lineas.push(l), false) : true);
      r = { tipo: 'nota', documentos: [{ titulo: nombre, lineas }], quitado, avisos: lineas.length ? [] : ['La nota quedó vacía.'] };
    } else {
      buf = Buffer.from(String(f.datos || ''), 'base64');
      if (!buf.length) throw error('El archivo está vacío.');
      if (buf.length > MAX_ARCHIVO) throw error('El archivo pesa más de 15 MB.');
      const ext = (nombre.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
      if (ext === 'xlsx' || ext === 'xlsm') {
        try { r = convertirExcel(buf, nombre); }
        catch (err) { throw error('No se pudo leer el Excel: ' + err.message); }
      } else if (ext === 'pdf') {
        let paginas;
        try { paginas = await paginasPdf(buf); }
        catch (err) { if (err.codigo) throw err; throw error('No se pudo leer el PDF (¿está dañado o con contraseña?).'); }
        const nuevas = cabecerasDe(paginas);
        for (const l of nuevas) await client.query('INSERT INTO conocimiento_cabeceras (empresa_id, linea) VALUES ($1, $2) ON CONFLICT DO NOTHING', [e.id, l]);
        const cab = (await client.query('SELECT linea FROM conocimiento_cabeceras WHERE empresa_id = $1', [e.id])).rows.map(x => x.linea);
        const quitado = { columnas: [], lineas: [] };
        const doc = { titulo: nombreBase(nombre) };
        const lineas = pdfATexto(paginas, cab, quitado);
        const avisos = [];
        if (!paginas.flat().length) avisos.push('El PDF no tiene texto (parece una imagen escaneada): el asistente no lo puede leer. Pide el PDF original o escribe una nota.');
        r = { tipo: 'ficha', documentos: [{ ...doc, lineas }], quitado, avisos };
        crudo = { doc, paginas };
        if (nuevas.length) await reconstruirPdfs(e.id);
      } else if (ext === 'docx') {
        let lineas;
        try { lineas = textoDocx(buf); } catch (err) { throw error('No se pudo leer el Word: ' + err.message); }
        const quitado = { columnas: [], lineas: [] };
        // En el chatbot se quita lo interno; en las carpetas internas se guarda completo.
        if (carpeta === 'chatbot') lineas = lineas.filter(l => LINEA_INTERNA.test(l) ? (quitado.lineas.push(l), false) : true);
        r = { tipo: 'ficha', documentos: [{ titulo: nombreBase(nombre), lineas }], quitado, avisos: lineas.length ? [] : ['El Word no tiene texto.'] };
      } else if (ext === 'xls') {
        throw error('Ese Excel es del formato viejo (.xls). Ábrelo en Excel y guárdalo como .xlsx.');
      } else {
        throw error('Solo se pueden subir Excel (.xlsx), PDF o Word (.docx). Para un texto usa "Nota escrita".');
      }
    }
    if (sede === null) sede = sedePorContenido(nombre, textoDeDocs(r.documentos), sedes) || (carpeta === 'chatbot' && r.tipo === 'ficha' ? await sedeMayoritaria(e.id, 'ficha') : '');
    // Si ya había un borrador con el mismo nombre, se reemplaza.
    await client.query("DELETE FROM conocimiento_archivos WHERE empresa_id = $1 AND LOWER(nombre) = LOWER($2) AND estado = 'borrador'", [e.id, nombre]);
    const fila = (await client.query(`INSERT INTO conocimiento_archivos (empresa_id, nombre, tipo, sede, documentos, quitado, avisos, crudo, original, tamano, subido_por, carpeta, subcarpeta, grupo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [e.id, nombre, r.tipo, sede, JSON.stringify(r.documentos), JSON.stringify(r.quitado), JSON.stringify(r.avisos), crudo ? JSON.stringify(crudo) : null,
      buf, buf ? buf.length : Buffer.byteLength(f.nota || ''), u.usuario, carpeta, subcarpeta, grupo])).rows[0];
    await registrar(u, 'conocimiento_subir', 'empresa', e.slug, '', '', `${nombre} (${r.tipo}) → ${carpeta}${subcarpeta ? '/' + subcarpeta : ''}`);
    // Lo interno no pasa por "Por revisar": el chatbot no lo lee. Queda guardado de una vez.
    if (carpeta !== 'chatbot') await publicar(u, [fila.id]);
    if (carpeta === 'tarifarios') await enviarAOperaciones(e.id, fila.id);
    return fila.id;
  }

  async function lista(empresaId) {
    return (await client.query(`SELECT id, nombre, tipo, sede, estado, avisos, tamano, subido, subido_por, publicado, carpeta, subcarpeta, grupo, op_estado,
        jsonb_array_length(documentos) AS documentos,
        (SELECT COALESCE(SUM(jsonb_array_length(d->'lineas')), 0) FROM jsonb_array_elements(documentos) d)::int AS lineas,
        (SELECT COALESCE(SUM(LENGTH(d->>'lineas')), 0) FROM jsonb_array_elements(documentos) d)::int AS caracteres,
        COALESCE(jsonb_array_length(quitado->'columnas'), 0) AS "columnasQuitadas", COALESCE(jsonb_array_length(quitado->'lineas'), 0) AS "lineasQuitadas"
      FROM conocimiento_archivos WHERE empresa_id = $1 ORDER BY estado, LOWER(nombre), subido DESC`, [empresaId])).rows;
  }

  async function publicar(u, ids) {
    const filas = (await client.query("SELECT id, empresa_id, nombre FROM conocimiento_archivos WHERE id = ANY($1) AND estado = 'borrador'", [ids.map(Number)])).rows;
    for (const f of filas) {
      // La versión publicada anterior queda guardada (una sola) para poder volver atrás.
      await client.query("DELETE FROM conocimiento_archivos WHERE empresa_id = $1 AND LOWER(nombre) = LOWER($2) AND estado = 'anterior'", [f.empresa_id, f.nombre]);
      await client.query("UPDATE conocimiento_archivos SET estado = 'anterior' WHERE empresa_id = $1 AND LOWER(nombre) = LOWER($2) AND estado = 'publicado'", [f.empresa_id, f.nombre]);
      await client.query("UPDATE conocimiento_archivos SET estado = 'publicado', publicado = NOW() WHERE id = $1", [f.id]);
      olvidar(f.empresa_id);
    }
    if (filas.length) {
      const e = await empresa(filas[0].empresa_id);
      await registrar(u, 'conocimiento_publicar', 'empresa', e.slug, '', '', filas.map(f => f.nombre).join(', ').slice(0, 500));
    }
    return filas.length;
  }

  // ---------- Búsqueda ----------
  async function indice(empresaId, conBorradores = false) {
    const clave = String(empresaId) + (conBorradores ? ':b' : '');
    if (indices.has(clave)) return indices.get(clave);
    const estados = conBorradores ? ['publicado', 'borrador'] : ['publicado'];
    const filas = (await client.query(`SELECT DISTINCT ON (LOWER(nombre)) id, nombre, tipo, sede, documentos, estado, COALESCE(publicado, subido) AS fecha
      FROM conocimiento_archivos WHERE empresa_id = $1 AND estado = ANY($2) AND carpeta = 'chatbot' ORDER BY LOWER(nombre), (estado = 'borrador') DESC`, [empresaId, estados])).rows;
    const fragmentos = [];
    for (const f of filas) {
      for (const d of f.documentos) {
        for (const x of fragmentar(d, f.tipo)) {
          const pt = palabras(x.titulo), pc = palabras(x.texto);
          const tf = new Map();
          for (const p of pc) tf.set(p, (tf.get(p) || 0) + 1);
          for (const p of pt) tf.set(p, (tf.get(p) || 0) + 3);
          fragmentos.push({ titulo: x.titulo, texto: x.texto, sede: f.sede, fuente: f.nombre + (d.hoja ? ' › ' + d.hoja : ''), tipo: f.tipo,
            fecha: f.fecha, tf, largo: pc.length + pt.length * 3, plano: ' ' + palabras(x.titulo + ' ' + x.texto).join(' ') + ' ' });
        }
      }
    }
    const df = new Map();
    for (const fr of fragmentos) for (const p of fr.tf.keys()) df.set(p, (df.get(p) || 0) + 1);
    const promedio = fragmentos.reduce((a, f) => a + f.largo, 0) / (fragmentos.length || 1);
    const ix = { fragmentos, df, promedio, archivos: filas };
    indices.set(clave, ix);
    return ix;
  }
  const mismaSede = (a, b) => sinTildes(a).toLowerCase().trim() === sinTildes(b).toLowerCase().trim();
  function enSede(fr, sede) { return !sede || !fr.sede || mismaSede(fr.sede, sede); }

  async function buscar(empresaId, q, sede, n = 4, conBorradores = false) {
    const ix = await indice(empresaId, conBorradores);
    const pq = conPares(palabras(q));
    if (!pq.length) return [];
    const N = ix.fragmentos.length;
    const resultados = [];
    for (const fr of ix.fragmentos) {
      if (!enSede(fr, sede)) continue;
      let s = 0;
      for (const p of pq) {
        const tf = fr.tf.get(p);
        if (!tf) continue;
        const idf = Math.log(1 + (N - ix.df.get(p) + 0.5) / (ix.df.get(p) + 0.5));
        s += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * fr.largo / ix.promedio));
      }
      if (!s) continue;
      // Premio si las palabras de la pregunta aparecen juntas (ej. "isla saona").
      for (let i = 0; i + 1 < pq.length; i++) if (fr.plano.includes(` ${pq[i]} ${pq[i + 1]} `)) s += 1.5;
      resultados.push({ fr, s });
    }
    resultados.sort((a, b) => b.s - a.s);
    return resultados.slice(0, Math.min(Math.max(Number(n) || 4, 1), 10)).map(({ fr, s }) => ({
      titulo: fr.titulo, sede: fr.sede || 'Todas', tipo: fr.tipo, fuente: fr.fuente, puntaje: Math.round(s * 100) / 100, texto: fr.texto
    }));
  }

  async function panelConectado(empresaId) {
    try {
      const fila = (await client.query('SELECT * FROM empresas WHERE id = $1', [empresaId])).rows[0];
      return await central.ayudantes.conEmpresa(fila, async db => {
        const r = await db.query('SELECT actualizado FROM asistente_conexion WHERE id = 1').catch(() => ({ rows: [] }));
        return r.rows[0] ? { conectado: true, desde: r.rows[0].actualizado } : { conectado: false };
      });
    } catch (err) { return { conectado: false, error: 'Sin conexión con su base' }; }
  }

  // ---------- El asistente: busca en la base y le pide la respuesta a la IA ----------
  function ajustesDe(e) {
    const a = e.conocimiento_ajustes || {};
    return { nombre: a.nombre || `el asistente de ${e.nombre}`, modelo: a.modelo || MODELO_POR_DEFECTO, instrucciones: a.instrucciones || '', sedes: a.sedes || {},
      bienvenidas: a.bienvenidas || {}, web: { sedes: (a.web && a.web.sedes) || [], palabras: (a.web && a.web.palabras) || '', sitios: (a.web && a.web.sitios) || '' } };
  }
  // modelo / instrucciones: solo para la Simulación de ventas (prueba otro modelo u otro prompt sin cambiar los ajustes guardados).
  async function responder(empresaId, { sede = '', mensajes = [], borradores = false, modelo = '', instrucciones = null }) {
    const e = await empresa(empresaId);
    const aj = ajustesDe(e);
    if (modelo) aj.modelo = modelo;
    if (instrucciones !== null && instrucciones !== undefined) aj.instrucciones = String(instrucciones);
    const sedes = sedesDe(e);
    const sedeOk = sedes.find(s => mismaSede(s, sede)) || '';
    if (sedes.length && !sedeOk) throw error(`Sede no válida. Usa una de: ${sedes.join(', ')}.`);
    const historial = (Array.isArray(mensajes) ? mensajes : []).slice(-12)
      .map(m => ({ role: m.rol === 'asistente' || m.role === 'assistant' ? 'assistant' : 'user', content: String(m.texto ?? m.content ?? '').slice(0, 2000).trim() }))
      .filter(m => m.content);
    if (!historial.length || historial[historial.length - 1].role !== 'user') throw error('El último mensaje debe ser del cliente.');
    const fila = (await client.query('SELECT * FROM empresas WHERE id = $1', [e.id])).rows[0];
    const apiKey = claveIA ? claveIA(fila) : '';
    if (!apiKey) throw error('Esta empresa no tiene clave de IA. Ponla en Clientes y cobros → Editar → clave de OpenRouter.');
    // Lo que se busca: el último mensaje del cliente y, si es corto ("¿y para niños?"), también el anterior.
    const delCliente = historial.filter(m => m.role === 'user').map(m => m.content);
    const ultimo = delCliente[delCliente.length - 1];
    const consulta = (palabras(ultimo).length < 6 && delCliente.length > 1 ? delCliente[delCliente.length - 2] + ' ' : '') + ultimo;
    // Se busca con el último mensaje y también con toda la conversación (lo que el cliente pidió y lo que ya se le contestó),
    // para no perder lo que se habló antes ("¿y para esa fecha?").
    const conversacion = historial.slice(-6).map(m => m.content).join(' ');
    // Hotel nombrado por el cliente → su zona (del listado de hoteles), para encontrar la tarifa de esa zona.
    const ix = await indice(e.id, borradores);
    const listaHoteles = hotelesYZonas(ix.fragmentos.filter(fr => enSede(fr, sedeOk)));
    const hoteles = hotelesEn(consulta, listaHoteles).length ? hotelesEn(consulta, listaHoteles) : hotelesEn(conversacion, listaHoteles);
    const zonas = hoteles.map(h => h.zona.replace(/,/g, ' ')).join(' ');
    const deUltimo = await buscar(e.id, ampliarConsulta(consulta) + (zonas ? ' ' + zonas + ' ' + zonas : ''), sedeOk, 5, borradores);
    const deConversacion = historial.length > 1 ? await buscar(e.id, ampliarConsulta(conversacion), sedeOk, 4, borradores) : [];
    const vistos = new Set();
    const encontrados = [...deUltimo, ...deConversacion].filter(x => { const k = x.titulo + '|' + x.texto.slice(0, 80); if (vistos.has(k)) return false; vistos.add(k); return true; }).slice(0, 7);
    const pistas = hoteles.length ? 'PISTAS (del listado de hoteles): ' + hoteles.map(h => `el hotel ${h.hotel} está en la zona ${h.zona}`).join('; ') +
      '. Para un traslado a ese hotel usa el trayecto que termina en esa zona (' + hoteles.map(h => h.zona.split(',').map(z => '"... - HTL ' + z.trim().toUpperCase() + '"').join(' o, si no existe, ')).join('; ') +
      '). El aeropuerto de salida lo dice el cliente (Santo Domingo = SDQ, Punta Cana = PUJ, La Romana = LRM).\n\n' : '';
    // Además de las hojas, las filas exactas más parecidas a la pregunta (por si la fila buscada quedó en otra parte de la hoja).
    const filas = filasParecidas(ix.fragmentos.filter(fr => enSede(fr, sedeOk)), ampliarConsulta(consulta) + (zonas ? ' ' + zonas : ''));
    const textoFilas = filas.length ? 'FILAS DE LOS TARIFARIOS MÁS PARECIDAS A LA PREGUNTA (precio de venta al público; cada una dice de qué hoja es):\n' +
      filas.map(f => `• ${f.titulo}: ${f.l}`).join('\n') + '\n\n' : '';
    const info = pistas + textoFilas + (encontrados.length
      ? encontrados.map((x, i) => `[${i + 1}] ${x.titulo}${x.sede && x.sede !== 'Todas' ? ` (sede ${x.sede})` : ''}\n${x.texto}`).join('\n\n')
      : '(No se encontró nada sobre esto en la base.)');
    const otras = sedes.filter(s => !mismaSede(s, sedeOk)).join(' o ');
    // Lo que no sirve en el prompt: el marcador "[AQUÍ PEGA TUS TARIFAS…]" y su título (la INFORMACIÓN se agrega sola desde 🤖 Chatbot).
    const limpiarPrompt = t => String(t || '').replace(/\[\s*AQU[IÍ][^\]]*PEGA[^\]]*\]/gi, '').replace(/^\s*#*\s*INFORMACI[ÓO]N\s*\(BASE DE CONOCIMIENTO[^)]*\)\s*$/gim, '').trim();
    const extra = [limpiarPrompt(aj.instrucciones), sedeOk && aj.sedes[sedeOk]].filter(Boolean).join('\n');
    // Búsqueda en internet: solo en las sedes elegidas, y solo si la pregunta es de los temas elegidos o la base no tiene la respuesta.
    const webSede = aj.web.sedes.some(x => mismaSede(x, sedeOk || ''));
    const temas = aj.web.palabras.split(',').map(x => palabras(x).join(' ')).filter(Boolean);
    const planoConsulta = ' ' + palabras(consulta).join(' ') + ' ';
    const porTema = temas.some(t => planoConsulta.includes(' ' + t + ' ')) || /\b(clima|tiempo|lluvia|llueve|temperatura|huracan|weather|rain|temperature|forecast|chuva|previsao)\b/.test(sinTildes(consulta.toLowerCase()));
    const mejor = encontrados.length ? encontrados[0].puntaje : 0;
    const usarWeb = webSede && (porTema || (palabras(consulta).length >= 3 && mejor < 5));
    // Ejemplos aprobados (entrenamiento): los más parecidos a la pregunta.
    const ejemplos = (await client.query("SELECT sede, cliente, ideal FROM conocimiento_ejemplos WHERE empresa_id = $1 AND estado = 'aprobado' ORDER BY revisado DESC NULLS LAST, id DESC LIMIT 200", [e.id])).rows
      .filter(x => !x.sede || !sedeOk || mismaSede(x.sede, sedeOk));
    const pq = new Set(palabras(consulta));
    const elegidos = ejemplos.map((x, i) => ({ x, n: palabras(x.cliente).filter(w => pq.has(w)).length, i }))
      .sort((a, b) => b.n - a.n || a.i - b.i).slice(0, 6).map(y => y.x);
    const textoEjemplos = elegidos.length ? '\n\nEJEMPLOS DE CÓMO RESPONDER (aprobados por la empresa: imita el estilo, el tono y el criterio; los precios sácalos siempre de la INFORMACIÓN)\n' +
      elegidos.map(x => `Cliente: ${x.cliente}\nRespuesta ideal: ${x.ideal}`).join('\n---\n') : '';
    const primera = !historial.some(m => m.role === 'assistant');
    // Idioma: el del último mensaje del cliente; si es muy corto ("ok"), el del anterior.
    const idiomaCliente = detectarIdioma(ultimo) || (delCliente.length > 1 ? detectarIdioma(delCliente[delCliente.length - 2]) : '');
    const zona = zonaDe(sedeOk);
    const sistema = instruccionesBase({ nombre: aj.nombre, empresa: e.nombre, sede: sedeOk, otras: sedeOk ? otras : '', extra,
      bienvenida: (sedeOk && aj.bienvenidas[sedeOk]) || aj.bienvenidas[''] || '', primera, web: usarWeb ? aj.web : null }) +
      `\n\nFECHA Y HORA EN ${sedeOk ? sedeOk.toUpperCase() : 'LA OFICINA'}: ${new Date().toLocaleString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zona })}` +
      textoEjemplos + `\n\nINFORMACIÓN\n${info}` +
      (idiomaCliente && idiomaCliente !== 'es' ? `\n\nIDIOMA DE ESTA RESPUESTA: el cliente escribe en ${NOMBRE_IDIOMA[idiomaCliente][0]}. Escribe el campo "respuesta" COMPLETO en ${NOMBRE_IDIOMA[idiomaCliente][0]}, saludo incluido, y pon "idioma": "${idiomaCliente}". ` +
        `IMPORTANT: the customer is writing in ${NOMBRE_IDIOMA[idiomaCliente][1]}. Write the whole "respuesta" in ${NOMBRE_IDIOMA[idiomaCliente][1]} (only resumen_para_asesor stays in Spanish).` : '');
    const cuerpo = { model: aj.modelo, max_tokens: 2000, temperature: 0.3, usage: { include: true }, messages: [{ role: 'system', content: sistema }, ...historial] };
    if (usarWeb) cuerpo.plugins = [{ id: 'web', engine: 'exa', max_results: 2, search_prompt: `Resultados de internet del ${new Date().toISOString().slice(0, 10)} (información general; NO son precios de ${e.nombre}). Úsalos solo como referencia y responde SIEMPRE con el objeto JSON pedido en las instrucciones:` }];
    const t0 = Date.now();
    // Llama a la IA. Si con internet no devuelve texto, se pregunta otra vez sin internet: el cliente siempre recibe respuesta.
    async function pedir(c) {
      const control = new AbortController();
      const reloj = setTimeout(() => control.abort(), 60000);
      try {
        const r = await fetch(central.ayudantes.OPENROUTER + '/chat/completions', {
          method: 'POST', signal: control.signal,
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'X-Title': 'Kaizen IA - asistente de redes' },
          body: JSON.stringify(c)
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) {
          const msg = (d.error && (d.error.message || JSON.stringify(d.error))) || ('código ' + r.status);
          throw error(`La IA respondió con error (${r.status}): ${msg}` + (r.status === 401 ? ' — revisa la clave de OpenRouter.' : r.status === 402 ? ' — sin saldo en OpenRouter.' : ''), 502);
        }
        return d;
      } catch (err) {
        if (err.codigo) throw err;
        throw error(err.name === 'AbortError' ? 'La IA tardó más de 60 segundos.' : 'No se pudo conectar con la IA: ' + err.message, 502);
      } finally { clearTimeout(reloj); }
    }
    // El texto puede venir como cadena o como lista de partes ({ type: 'text', text }).
    const textoDe = m => {
      const c = m && m.content;
      if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : (p && (p.text || (p.type === 'text' && p.content)) || ''))).join('');
      return typeof c === 'string' ? c : '';
    };
    let datos, diagnostico = '', webFallo = false, usoTotal = { entrada: 0, salida: 0, costo: 0, llamadas: 0 };
    // costo: lo que cobró OpenRouter (US$), si lo informa (usage.include). Si no, lo calcula la Simulación con el precio del modelo.
    const sumarUso = d => { if (d && d.usage) { usoTotal.entrada += d.usage.prompt_tokens || 0; usoTotal.salida += d.usage.completion_tokens || 0; usoTotal.costo += Number(d.usage.cost) || 0; usoTotal.llamadas++; } };
    let fueConWeb = Boolean(cuerpo.plugins);
    if (fueConWeb) {
      try { datos = await pedir(cuerpo); sumarUso(datos); }
      catch (err) { datos = null; diagnostico = 'Internet: ' + err.message; }
      const ch = datos && (datos.choices || [])[0];
      if (!datos || !textoDe(ch && ch.message).trim()) {
        if (datos && !diagnostico) diagnostico = `Con internet la IA no devolvió texto (fin: ${(ch && (ch.native_finish_reason || ch.finish_reason)) || 'desconocido'}).`;
        webFallo = true;
        const sinWeb = { ...cuerpo };
        delete sinWeb.plugins;
        sinWeb.messages = [{ role: 'system', content: instruccionesBase({ nombre: aj.nombre, empresa: e.nombre, sede: sedeOk, otras: sedeOk ? otras : '', extra,
          bienvenida: (sedeOk && aj.bienvenidas[sedeOk]) || aj.bienvenidas[''] || '', primera, web: null }) + sistema.slice(sistema.indexOf('\n\nFECHA Y HORA')) }, ...historial];
        datos = await pedir(sinWeb); sumarUso(datos);
        fueConWeb = false;
      }
    } else { datos = await pedir(cuerpo); sumarUso(datos); }
    // Si vino vacía (se quedó sin espacio o pensando), se pide una vez más con más espacio y sin razonamiento largo.
    {
      const c0 = (datos.choices || [])[0] || {};
      if (!textoDe(c0.message).trim()) {
        const otra = { ...cuerpo, max_tokens: 3500, reasoning: { effort: 'low', exclude: true } };
        delete otra.plugins;
        try { const d2 = await pedir(otra); sumarUso(d2); if (textoDe(((d2.choices || [])[0] || {}).message).trim()) { datos = d2; diagnostico = (diagnostico ? diagnostico + ' ' : '') + `La primera respuesta vino vacía (fin: ${c0.native_finish_reason || c0.finish_reason || 'desconocido'}); se pidió otra vez.`; } }
        catch (err) { diagnostico = (diagnostico ? diagnostico + ' ' : '') + 'Reintento: ' + err.message; }
      }
    }
    const ch = (datos.choices || [])[0] || {};
    const msj = ch.message || {};
    const contenido = textoDe(msj);
    const j = leerJSON(contenido);
    if (!contenido.trim() && !diagnostico) diagnostico = `La IA no devolvió texto (fin: ${ch.native_finish_reason || ch.finish_reason || 'desconocido'}).`;
    else if (!j && contenido.trim() && !diagnostico) diagnostico = 'La IA respondió en texto libre (sin el formato JSON): se usa su texto tal cual.';
    const enlaces = [...new Map((msj.annotations || []).filter(a => a.type === 'url_citation' && a.url_citation && a.url_citation.url)
      .map(a => [a.url_citation.url, { url: a.url_citation.url, titulo: a.url_citation.title || '' }])).values()].slice(0, 5);
    const motivo = j && MOTIVOS[j.motivo] ? j.motivo : '';
    // Si no vino en JSON, se limpia lo que la IA haya puesto alrededor (```json, "respuesta": ...).
    // Nunca se muestran al cliente los campos internos (resumen_para_asesor, motivo, pasar_a_asesor, idioma).
    const libre = rescatarRespuesta(contenido);
    // Nunca se le pide al cliente que repita por una falla de la IA: se le avisa con amabilidad y pasa a un asesor.
    const sinRespuesta = !String((j && j.respuesta) || libre || '').trim();
    const avisoFalla = { es: '¡Gracias por escribirnos! 😊 En un momento un asesor te atiende personalmente.', en: 'Thanks for reaching out! 😊 An agent will assist you personally in a moment.', pt: 'Obrigado por escrever! 😊 Em instantes um atendente vai te ajudar pessoalmente.' };
    return {
      respuesta: String((j && j.respuesta) || libre || '').trim() || avisoFalla[idiomaCliente] || avisoFalla.es,
      sin_respuesta: sinRespuesta,
      pasar_a_asesor: Boolean(j && j.pasar_a_asesor) || Boolean(motivo) || sinRespuesta,
      motivo, motivo_texto: MOTIVOS[motivo] || '',
      resumen_para_asesor: String((j && j.resumen_para_asesor) || '').trim(),
      sede: sedeOk || 'Todas',
      fuentes: encontrados.map(x => ({ titulo: x.titulo, fuente: x.fuente, puntaje: x.puntaje })),
      formato_ok: Boolean(j),
      idioma: String((j && j.idioma) || idiomaCliente || '').slice(0, 5).toLowerCase(),
      idioma_cliente: idiomaCliente,
      web: { usada: fueConWeb, intentada: usarWeb, fallo: webFallo, enlaces },
      diagnostico,
      ejemplos: elegidos.length,
      modelo: datos.model || aj.modelo, segundos: Math.round((Date.now() - t0) / 100) / 10,
      tokens: usoTotal.entrada || usoTotal.salida ? usoTotal : null
    };
  }

  // ---------- Entrenamiento: calificaciones y ejemplos ----------
  function textoContexto(mensajes) {
    return (Array.isArray(mensajes) ? mensajes : []).slice(-8).map(m => ({ rol: m.rol === 'asistente' ? 'asistente' : 'cliente', texto: String(m.texto || '').slice(0, 1500) }));
  }
  async function calificar(empresaId, f, autor, origen) {
    const contexto = textoContexto(f.mensajes);
    const cliente = texto(f.cliente || ([...contexto].reverse().find(m => m.rol === 'cliente') || {}).texto, 1500);
    if (!cliente) throw error('Falta el mensaje del cliente.');
    const voto = f.voto === 'bien' ? 'bien' : f.voto === 'mal' ? 'mal' : '';
    const ideal = String(f.ideal || '').trim().slice(0, 3000);
    const estado = f.aprobar ? 'aprobado' : 'nuevo';
    if (estado === 'aprobado' && !ideal) throw error('Escribe la respuesta ideal.');
    const r = (await client.query(`INSERT INTO conocimiento_ejemplos (empresa_id, sede, cliente, contexto, respuesta, ideal, voto, nota, estado, autor, origen, revisado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [empresaId, texto(f.sede, 60), cliente, JSON.stringify(contexto), String(f.respuesta || '').slice(0, 3000), ideal, voto, texto(f.nota, 500), estado, texto(autor, 80), origen, estado === 'aprobado' ? new Date() : null])).rows[0];
    return r.id;
  }

  // ---------- Rutas de la Oficina (sesión del programador; lo revisa oficina.js) ----------
  async function manejarOficina(req, res, url, u, { json, leerCuerpo }) {
    const p = new URL(req.url, 'http://localhost').searchParams;
    if (req.method === 'GET' && url === '/api/oficina/conocimiento') {
      const empresas = (await client.query('SELECT id, nombre, es_demo, conocimiento_sedes, conocimiento_token, conocimiento_ajustes, conocimiento_carpetas FROM empresas ORDER BY es_demo, nombre')).rows;
      const elegida = empresas.find(e => String(e.id) === p.get('empresa')) || empresas.find(e => !e.es_demo) || empresas[0];
      if (!elegida) return json(res, 200, { empresas: [], archivos: [] });
      await revisarOperaciones(elegida.id);
      return json(res, 200, {
        empresas: empresas.map(e => ({ id: e.id, nombre: e.nombre, es_demo: e.es_demo })),
        empresa: { id: elegida.id, nombre: elegida.nombre, sedes: sedesDe(elegida), token: elegida.conocimiento_token, ajustes: ajustesDe(elegida), temas: temasOperaciones(elegida), grupos: gruposDe(elegida),
          tieneClaveIA: Boolean(claveIA && claveIA((await client.query('SELECT * FROM empresas WHERE id = $1', [elegida.id])).rows[0])) },
        archivos: await lista(elegida.id),
        ejemplos: (await client.query(`SELECT id, sede, cliente, contexto, respuesta, ideal, voto, nota, estado, autor, origen, creado, revisado
          FROM conocimiento_ejemplos WHERE empresa_id = $1 AND estado <> 'descartado' ORDER BY (estado = 'nuevo') DESC, creado DESC LIMIT 300`, [elegida.id])).rows,
        votos: (await client.query(`SELECT COUNT(*) FILTER (WHERE voto = 'bien')::int AS bien, COUNT(*) FILTER (WHERE voto = 'mal')::int AS mal
          FROM conocimiento_ejemplos WHERE empresa_id = $1`, [elegida.id])).rows[0],
        panelConectado: await panelConectado(elegida.id)
      });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/subir') {
      const id = await subir(u, await leerCuerpo(req));
      const f = (await client.query('SELECT empresa_id FROM conocimiento_archivos WHERE id = $1', [id])).rows[0];
      olvidar(f.empresa_id);
      return json(res, 200, { ok: true, archivo: (await lista(f.empresa_id)).find(x => x.id === id) });
    }
    if (req.method === 'GET' && url === '/api/oficina/conocimiento/ver') {
      const f = (await client.query('SELECT id, nombre, tipo, sede, estado, documentos, quitado, avisos, carpeta, subcarpeta, grupo FROM conocimiento_archivos WHERE id = $1', [Number(p.get('id'))])).rows[0];
      if (!f) return json(res, 404, { error: 'No encontrado.' });
      return json(res, 200, f);
    }
    if (req.method === 'GET' && url === '/api/oficina/conocimiento/original') {
      const f = (await client.query('SELECT nombre, original FROM conocimiento_archivos WHERE id = $1', [Number(p.get('id'))])).rows[0];
      if (!f || !f.original) return json(res, 404, { error: 'Ese archivo no tiene original guardado.' });
      const tipo = /\.pdf$/i.test(f.nombre) ? 'application/pdf' : /\.docx$/i.test(f.nombre) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      // ?ver=1: el PDF se muestra dentro de la Oficina (visor) en vez de descargarse.
      const enLinea = p.get('ver') === '1' && tipo === 'application/pdf';
      res.writeHead(200, { 'Content-Type': tipo, 'Content-Disposition': `${enLinea ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.nombre)}`, 'X-Content-Type-Options': 'nosniff' });
      return res.end(f.original);
    }
    if (req.method === 'GET' && url === '/api/oficina/conocimiento/tabla') {
      // El Excel tal cual (hojas, filas y celdas) para verlo y editarlo como tabla.
      const f = (await client.query('SELECT nombre, original FROM conocimiento_archivos WHERE id = $1', [Number(p.get('id'))])).rows[0];
      if (!f || !f.original || !/\.xlsx$|\.xlsm$/i.test(f.nombre)) return json(res, 404, { error: 'Ese archivo no es un Excel guardado.' });
      const hojas = leerExcel(f.original).map(h => ({ nombre: h.nombre, filas: h.filas.slice(0, 5000) }));
      return json(res, 200, { hojas });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/editar') {
      // Guarda lo editado como versión nueva (la anterior queda para "volver a esa"). Excel: se escribe un .xlsx nuevo.
      const f = await leerCuerpo(req);
      const a = (await client.query('SELECT * FROM conocimiento_archivos WHERE id = $1', [Number(f.id)])).rows[0];
      if (!a) return json(res, 404, { error: 'No encontrado.' });
      const e = await empresa(a.empresa_id);
      let r, original = a.original;
      if (Array.isArray(f.hojas)) {
        if (!/\.xlsx$|\.xlsm$/i.test(a.nombre)) throw error('Solo los Excel se editan como tabla.');
        original = escribirExcel(f.hojas.map(h => ({ nombre: texto(h.nombre, 31), filas: (Array.isArray(h.filas) ? h.filas : []).map(fila => {
          const o = {};
          for (const [c, celda] of Object.entries(fila || {})) {
            const v = celda && celda.v !== undefined ? celda.v : celda;
            if (v === null || v === undefined || String(v).trim() === '') continue;
            const txt = String(v).trim().slice(0, 4000);
            o[Number(c)] = { v: /^-?\d+(\.\d+)?$/.test(txt) ? Number(txt) : txt, enlace: celda && celda.enlace ? texto(celda.enlace, 500) : null };
          }
          return o;
        }) })));
        if (original.length > MAX_ARCHIVO) throw error('El Excel quedó de más de 15 MB.');
        try { r = convertirExcel(original, a.nombre); } catch (err) { throw error('No se pudo leer lo editado: ' + err.message); }
      } else {
        const lineas = String(f.texto || '').replace(/\r/g, '').split('\n').map(l => l.trimEnd()).filter(l => l.trim()).slice(0, 5000);
        if (!lineas.length) throw error('El texto quedó vacío.');
        const quitado = { columnas: [], lineas: [] };
        const finales = a.carpeta === 'chatbot' ? lineas.filter(l => LINEA_INTERNA.test(l) ? (quitado.lineas.push(l), false) : true) : lineas;
        const titulo = (a.documentos && a.documentos[0] && a.documentos[0].titulo) || nombreBase(a.nombre);
        r = { tipo: a.tipo, documentos: [{ titulo, lineas: finales }], quitado, avisos: a.tipo === 'ficha' && /\.pdf$/i.test(a.nombre) ? ['Texto editado en la Oficina: el PDF original no cambia; el asistente usa este texto.'] : [] };
      }
      await client.query("DELETE FROM conocimiento_archivos WHERE empresa_id = $1 AND LOWER(nombre) = LOWER($2) AND estado = 'borrador'", [a.empresa_id, a.nombre]);
      const nuevo = (await client.query(`INSERT INTO conocimiento_archivos (empresa_id, nombre, tipo, sede, documentos, quitado, avisos, crudo, original, tamano, subido_por, carpeta, subcarpeta, grupo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [a.empresa_id, a.nombre, r.tipo || a.tipo, a.sede, JSON.stringify(r.documentos), JSON.stringify(r.quitado), JSON.stringify(r.avisos || []), original,
        original ? original.length : Buffer.byteLength(f.texto || ''), u.usuario, a.carpeta, a.subcarpeta, a.grupo || ''])).rows[0].id;
      await publicar(u, [nuevo]);
      let operaciones = null;
      if (a.carpeta === 'tarifarios' && Array.isArray(f.hojas)) operaciones = await enviarAOperaciones(a.empresa_id, nuevo);
      olvidar(a.empresa_id);
      await registrar(u, 'conocimiento_editar', 'empresa', e.slug, '', '', a.nombre);
      return json(res, 200, { ok: true, id: nuevo, operaciones });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/sede') {
      const f = await leerCuerpo(req);
      const r = (await client.query('UPDATE conocimiento_archivos SET sede = $1 WHERE id = $2 RETURNING empresa_id', [texto(f.sede, 60), Number(f.id)])).rows[0];
      if (r) { olvidar(r.empresa_id); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/mover') {
      // Cambia un archivo de carpeta (todas sus versiones). Si sale del chatbot, el asistente deja de leerlo al instante.
      const f = await leerCuerpo(req);
      const a = (await client.query('SELECT id, empresa_id, nombre, carpeta, estado FROM conocimiento_archivos WHERE id = $1', [Number(f.id)])).rows[0];
      if (!a) return json(res, 404, { error: 'No encontrado.' });
      const e = await empresa(a.empresa_id);
      const carpeta = CARPETAS.includes(f.carpeta) ? f.carpeta : a.carpeta;
      const subcarpeta = carpeta === 'operaciones' ? (temasOperaciones(e).find(x => x.k === f.subcarpeta) || { k: 'politicas' }).k : '';
      const sede = texto(f.sede || '', 60);
      // Carpeta con nombre (solo Chatbot y Tarifarios). Si se cambia de carpeta y no se indica otra, queda sin carpeta.
      const grupo = carpeta === 'operaciones' ? '' : texto(f.grupo || '', 60);
      if (grupo && !gruposDe(e)[carpeta].includes(grupo)) throw error('Primero crea la carpeta "' + grupo + '".');
      await client.query('UPDATE conocimiento_archivos SET carpeta = $1, subcarpeta = $2, sede = $3, grupo = $4 WHERE empresa_id = $5 AND LOWER(nombre) = LOWER($6)', [carpeta, subcarpeta, sede, grupo, a.empresa_id, a.nombre]);
      if (carpeta !== 'chatbot' && a.estado === 'borrador') await publicar(u, [a.id]);
      let operaciones = null;
      if (carpeta === 'tarifarios' && a.carpeta !== 'tarifarios') {
        const pub = (await client.query("SELECT id FROM conocimiento_archivos WHERE empresa_id = $1 AND LOWER(nombre) = LOWER($2) AND estado = 'publicado'", [a.empresa_id, a.nombre])).rows[0];
        if (pub) operaciones = await enviarAOperaciones(a.empresa_id, pub.id);
      }
      olvidar(a.empresa_id);
      await registrar(u, 'conocimiento_mover', 'empresa', e.slug, a.carpeta, carpeta + (subcarpeta ? '/' + subcarpeta : '') + (sede ? ' · ' + sede : ''), a.nombre);
      return json(res, 200, { ok: true, operaciones });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/a-operaciones') {
      const f = await leerCuerpo(req);
      const a = (await client.query("SELECT id, empresa_id FROM conocimiento_archivos WHERE id = $1 AND carpeta = 'tarifarios'", [Number(f.id)])).rows[0];
      if (!a) return json(res, 404, { error: 'Ese archivo no está en Tarifarios.' });
      const r = await enviarAOperaciones(a.empresa_id, a.id);
      if (!r) return json(res, 400, { error: 'Solo los Excel (.xlsx) se cargan en los precios de Operaciones.' });
      return json(res, 200, { ok: true, operaciones: r });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/grupo') {
      // Carpetas con nombre dentro de Chatbot o Tarifarios (ej. "Traslados", "Tours", "Políticas").
      // Quitar una carpeta no borra archivos: sus archivos quedan sin carpeta.
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      const carpeta = String(f.carpeta || '');
      if (!['chatbot', 'tarifarios'].includes(carpeta)) throw error('Las carpetas con nombre son solo para Chatbot y Tarifarios.');
      const c = { ...(e.conocimiento_carpetas || {}) };
      const grupos = gruposDe(e);
      let lista = grupos[carpeta];
      if (f.quitar) {
        const nombreQuitar = texto(f.quitar, 60);
        lista = lista.filter(x => x !== nombreQuitar);
        await client.query('UPDATE conocimiento_archivos SET grupo = $1 WHERE empresa_id = $2 AND carpeta = $3 AND grupo = $4', ['', e.id, carpeta, nombreQuitar]);
      } else {
        const n = texto(f.nombre, 60);
        if (!n) throw error('Escribe el nombre de la carpeta.');
        if (lista.some(x => x.toLowerCase() === n.toLowerCase())) throw error('Ya existe una carpeta con ese nombre.');
        if (lista.length >= 30) throw error('Máximo 30 carpetas por sección.');
        lista = [...lista, n];
      }
      c.grupos = { ...grupos, [carpeta]: lista };
      await client.query('UPDATE empresas SET conocimiento_carpetas = $1 WHERE id = $2', [JSON.stringify(c), e.id]);
      olvidar(e.id);
      return json(res, 200, { ok: true, grupos: gruposDe({ conocimiento_carpetas: c }) });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/tema') {
      // Temas propios dentro de "Operaciones y políticas" (ej. "Manual del chofer"). Los fijos no se borran.
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      const c = { ...(e.conocimiento_carpetas || {}) };
      let lista = (c.operaciones || []).filter(x => x && x.k);
      if (f.quitar) {
        const usados = (await client.query("SELECT COUNT(*)::int AS n FROM conocimiento_archivos WHERE empresa_id = $1 AND carpeta = 'operaciones' AND subcarpeta = $2", [e.id, String(f.quitar)])).rows[0].n;
        if (usados) throw error('Ese tema todavía tiene archivos: muévelos o bórralos primero.');
        lista = lista.filter(x => x.k !== String(f.quitar));
      } else {
        const n = texto(f.nombre, 60);
        if (!n) throw error('Escribe el nombre del tema.');
        const k = 't_' + sinTildes(n).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30);
        if (temasOperaciones(e).some(x => x.k === k || x.n.toLowerCase() === n.toLowerCase())) throw error('Ya existe un tema con ese nombre.');
        if (lista.length >= 20) throw error('Máximo 20 temas propios.');
        lista.push({ k, n });
      }
      c.operaciones = lista;
      await client.query('UPDATE empresas SET conocimiento_carpetas = $1 WHERE id = $2', [JSON.stringify(c), e.id]);
      return json(res, 200, { ok: true, temas: temasOperaciones({ conocimiento_carpetas: c }) });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/ordenar') {
      // 🪄 Ordena Chatbot y Tarifarios en Punta Cana / Orlando / General leyendo el nombre y el contenido.
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      if (!sedesDe(e).length) throw error('Primero guarda las sedes en Configuración → Ajustes del asistente.');
      const cuenta = await ordenarPorSede(e.id);
      await registrar(u, 'conocimiento_ordenar', 'empresa', e.slug, '', '', JSON.stringify(cuenta));
      return json(res, 200, { ok: true, cuenta });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/auto-sede') {
      // Pone la sede según el nombre de cada archivo a los que están en "Todas las sedes".
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      const sedes = sedesDe(e);
      if (!sedes.length) throw error('Primero guarda las sedes en Ajustes del asistente.');
      const filas = (await client.query("SELECT id, nombre FROM conocimiento_archivos WHERE empresa_id = $1 AND sede = ''", [e.id])).rows;
      const cuenta = {};
      for (const x of filas) {
        const sede = adivinarSede(x.nombre, sedes);
        await client.query('UPDATE conocimiento_archivos SET sede = $1 WHERE id = $2', [sede, x.id]);
        cuenta[sede] = (cuenta[sede] || 0) + 1;
      }
      olvidar(e.id);
      await registrar(u, 'conocimiento_auto_sede', 'empresa', e.slug, '', '', JSON.stringify(cuenta));
      return json(res, 200, { ok: true, cambiados: filas.length, cuenta });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/publicar') {
      const f = await leerCuerpo(req);
      const n = await publicar(u, Array.isArray(f.ids) ? f.ids : [f.id]);
      return json(res, 200, { ok: true, publicados: n });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/quitar') {
      const f = await leerCuerpo(req);
      const r = (await client.query('DELETE FROM conocimiento_archivos WHERE id = $1 RETURNING empresa_id, nombre, estado', [Number(f.id)])).rows[0];
      if (r) {
        olvidar(r.empresa_id);
        const e = await empresa(r.empresa_id);
        await registrar(u, 'conocimiento_quitar', 'empresa', e.slug, r.estado, '', r.nombre);
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/restaurar') {
      const f = await leerCuerpo(req);
      const ant = (await client.query("SELECT id, empresa_id, nombre FROM conocimiento_archivos WHERE id = $1 AND estado = 'anterior'", [Number(f.id)])).rows[0];
      if (!ant) return json(res, 404, { error: 'No hay versión anterior.' });
      await client.query("UPDATE conocimiento_archivos SET estado = 'tmp' WHERE empresa_id = $1 AND LOWER(nombre) = LOWER($2) AND estado = 'publicado'", [ant.empresa_id, ant.nombre]);
      await client.query("UPDATE conocimiento_archivos SET estado = 'publicado' WHERE id = $1", [ant.id]);
      await client.query("UPDATE conocimiento_archivos SET estado = 'anterior' WHERE empresa_id = $1 AND estado = 'tmp'", [ant.empresa_id]);
      olvidar(ant.empresa_id);
      const e = await empresa(ant.empresa_id);
      await registrar(u, 'conocimiento_restaurar', 'empresa', e.slug, '', '', ant.nombre);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/ajustes') {
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      if (f.sedes !== undefined) {
        const sedes = [...new Set(String(f.sedes).split(',').map(s => texto(s, 60)).filter(Boolean))].slice(0, 12);
        await client.query('UPDATE empresas SET conocimiento_sedes = $1 WHERE id = $2', [sedes.join(', '), e.id]);
      }
      if (f.nuevaClave) {
        const clave = 'kc_' + crypto.randomBytes(24).toString('hex');
        await client.query('UPDATE empresas SET conocimiento_token = $1 WHERE id = $2', [clave, e.id]);
        await registrar(u, 'conocimiento_clave', 'empresa', e.slug, '', '', e.conocimiento_token ? 'clave cambiada' : 'clave creada');
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/chat') {
      const f = await leerCuerpo(req);
      return json(res, 200, await responder(f.empresa_id, { sede: texto(f.sede, 60), mensajes: f.mensajes, borradores: Boolean(f.borradores) }));
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/ejemplo') {
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      if (f.id) {
        const accion = f.accion;
        if (accion === 'aprobar' || accion === 'editar') {
          const ideal = String(f.ideal || '').trim().slice(0, 3000);
          if (!ideal) throw error('Escribe la respuesta ideal.');
          await client.query("UPDATE conocimiento_ejemplos SET ideal = $1, cliente = COALESCE(NULLIF($2, ''), cliente), sede = $3, estado = 'aprobado', revisado = NOW() WHERE id = $4 AND empresa_id = $5",
            [ideal, texto(f.cliente, 1500), texto(f.sede, 60), Number(f.id), e.id]);
        } else if (accion === 'descartar') {
          await client.query("UPDATE conocimiento_ejemplos SET estado = 'descartado', revisado = NOW() WHERE id = $1 AND empresa_id = $2", [Number(f.id), e.id]);
        } else if (accion === 'borrar') {
          await client.query('DELETE FROM conocimiento_ejemplos WHERE id = $1 AND empresa_id = $2', [Number(f.id), e.id]);
        } else throw error('Acción no válida.');
        await registrar(u, 'conocimiento_ejemplo_' + accion, 'empresa', e.slug, '', '', String(f.id));
        return json(res, 200, { ok: true });
      }
      const id = await calificar(e.id, { ...f, aprobar: f.aprobar !== false }, u.usuario, 'oficina');
      await registrar(u, 'conocimiento_ejemplo_nuevo', 'empresa', e.slug, '', '', String(id));
      return json(res, 200, { ok: true, id });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/conectar-panel') {
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      const fila = (await client.query('SELECT * FROM empresas WHERE id = $1', [e.id])).rows[0];
      let clave = e.conocimiento_token;
      if (!f.quitar && !clave) {
        clave = 'kc_' + crypto.randomBytes(24).toString('hex');
        await client.query('UPDATE empresas SET conocimiento_token = $1 WHERE id = $2', [clave, e.id]);
      }
      await central.ayudantes.conEmpresa(fila, async db => {
        await db.query(`CREATE TABLE IF NOT EXISTS asistente_conexion (id INTEGER PRIMARY KEY DEFAULT 1, url TEXT NOT NULL, clave TEXT NOT NULL, actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        if (f.quitar) await db.query('DELETE FROM asistente_conexion');
        else await db.query(`INSERT INTO asistente_conexion (id, url, clave) VALUES (1, $1, $2)
          ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, clave = EXCLUDED.clave, actualizado = NOW()`, [`http://127.0.0.1:${config.puerto}`, clave]);
      });
      await registrar(u, f.quitar ? 'conocimiento_panel_quitar' : 'conocimiento_panel_conectar', 'empresa', e.slug, '', '', '');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/instrucciones') {
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      const sedes = {};
      for (const s of sedesDe(e)) { const t = String((f.sedes || {})[s] || '').trim().slice(0, 4000); if (t) sedes[s] = t; }
      const modelo = texto(f.modelo, 100);
      if (modelo && !/^[\w.\-]+\/[\w.:\-]+$/.test(modelo)) throw error('El modelo debe ser como anthropic/claude-haiku-5.5');
      const bienvenidas = {};
      for (const [k, v] of Object.entries(f.bienvenidas || {})) { const t = String(v || '').trim().slice(0, 600); if (t && (k === '' || sedesDe(e).includes(k))) bienvenidas[k] = t; }
      const w = f.web || {};
      const web = { sedes: (Array.isArray(w.sedes) ? w.sedes : []).filter(x => sedesDe(e).includes(x) || x === ''), palabras: texto(w.palabras, 600), sitios: texto(w.sitios, 600) };
      const aj = { nombre: texto(f.nombre, 80), modelo, instrucciones: String(f.instrucciones || '').trim().slice(0, 12000), sedes, bienvenidas, web };
      await client.query('UPDATE empresas SET conocimiento_ajustes = $1 WHERE id = $2', [JSON.stringify(aj), e.id]);
      await registrar(u, 'conocimiento_instrucciones', 'empresa', e.slug, '', '', aj.modelo || MODELO_POR_DEFECTO);
      return json(res, 200, { ok: true });
    }
    if (url.startsWith('/api/oficina/conocimiento/simula')) return simulacion.manejar(req, res, url, u, { json, leerCuerpo });
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/probar') {
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      return json(res, 200, { resultados: await buscar(e.id, texto(f.q, 300), texto(f.sede, 60), f.n || 4, Boolean(f.borradores)) });
    }
    return json(res, 404, { error: 'Ruta no encontrada' });
  }

  // ---------- Rutas del chatbot (sin sesión, con la clave del asistente) ----------
  async function empresaPorClave(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i);
    if (!m || m[1].length < 20) return null;
    const filas = (await client.query("SELECT id, nombre, conocimiento_token FROM empresas WHERE conocimiento_token <> ''")).rows;
    const dada = Buffer.from(m[1]);
    return filas.find(e => { const b = Buffer.from(e.conocimiento_token); return b.length === dada.length && crypto.timingSafeEqual(b, dada); }) || null;
  }
  async function manejarPublico(req, res, url, { json, leerCuerpo }) {
    if (!activo) return json(res, 404, { error: 'Solo existe en el panel central.' });
    const esPost = url === '/api/conocimiento/responder' || url === '/api/conocimiento/calificar';
    const esResponder = url === '/api/conocimiento/responder';
    if (req.method !== (esPost ? 'POST' : 'GET')) return json(res, 405, { error: esPost ? 'Solo POST.' : 'Solo GET.' });
    const e = await empresaPorClave(req);
    if (!e) return json(res, 401, { error: 'Clave del asistente no válida.' });
    if (url === '/api/conocimiento/calificar') {
      // Lo usa el panel de la empresa (gerente, IT...): 👍 / 👎 con sugerencia. Queda "nuevo" hasta que el programador lo apruebe.
      try {
        const f = await leerCuerpo(req);
        const id = await calificar(e.id, { ...f, aprobar: false }, f.autor, 'panel');
        return json(res, 200, { ok: true, id });
      } catch (err) { return json(res, err.codigo || 500, { error: err.message }); }
    }
    if (url === '/api/conocimiento/info') {
      const fila = await empresa(e.id);
      return json(res, 200, { empresa: e.nombre, sedes: sedesDe(fila), nombre: ajustesDe(fila).nombre });
    }
    if (esResponder) {
      // Lo usa n8n: { sede, mensajes: [{ rol: 'cliente'|'asistente', texto }] } -> { respuesta, pasar_a_asesor, motivo, resumen_para_asesor }
      try {
        const f = await leerCuerpo(req);
        return json(res, 200, await responder(e.id, { sede: texto(f.sede, 60), mensajes: f.mensajes }));
      } catch (err) { return json(res, err.codigo || 500, { error: err.message }); }
    }
    const p = new URL(req.url, 'http://localhost').searchParams;
    const sede = texto(p.get('sede'), 60);
    if (url === '/api/conocimiento/buscar') {
      const q = texto(p.get('q'), 300);
      if (!q) return json(res, 400, { error: 'Falta la pregunta (q).' });
      return json(res, 200, { empresa: e.nombre, sede: sede || 'todas', resultados: await buscar(e.id, q, sede, p.get('n')) });
    }
    const ix = await indice(e.id);
    const archivos = ix.archivos.filter(f => !sede || !f.sede || mismaSede(f.sede, sede));
    if (url === '/api/conocimiento/indice') {
      return json(res, 200, {
        empresa: e.nombre, sede: sede || 'todas',
        documentos: archivos.flatMap(f => f.documentos.map(d => ({ titulo: d.titulo, tipo: f.tipo, sede: f.sede || 'Todas', actualizado: f.fecha })))
      });
    }
    if (url === '/api/conocimiento/todo') {
      const textoTodo = archivos.flatMap(f => f.documentos.map(d => `# ${d.titulo}${f.sede ? ` (sede ${f.sede})` : ''}\n${d.lineas.join('\n')}`)).join('\n\n');
      return json(res, 200, { empresa: e.nombre, sede: sede || 'todas', caracteres: textoTodo.length, texto: textoTodo });
    }
    return json(res, 404, { error: 'Ruta no encontrada' });
  }

  const simulacion = crearSimulacion({ client, registrar, central, claveIA, responder, empresa, sedesDe, error });

  return { activo, preparar, manejarOficina, manejarPublico, responder, _probar: { detectarIdioma, ampliarConsulta, hotelesYZonas, hotelesEn, rescatarRespuesta, convertirExcel, paginasPdf, pdfATexto, cabecerasDe, fragmentar, palabras, instruccionesBase, leerJSON } };
};
