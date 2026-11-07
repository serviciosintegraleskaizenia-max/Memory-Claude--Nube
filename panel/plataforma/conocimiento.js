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
const { leerExcel } = require('./lector-xlsx');

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

function formato(cab, v) {
  const t = limpio(v);
  if (!t || ['N/A', 'X'].includes(t.toUpperCase())) return t ? 'no disponible' : '';
  const C = cab.toUpperCase();
  if (typeof v === 'number') {
    if (DINERO.some(k => C.includes(k)) && !['DORMITORIOS', 'BAÑOS', 'OCUPACI'].some(k => C.includes(k))) return usd(v);
  }
  return t;
}
const esCabecera = f => f.length >= 3 && f.every(([, c]) => typeof c.v === 'string');

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
    if (esCabecera(f)) {
      if (siguiente.length && esCabecera(siguiente) && siguiente.length >= f.length - 1) { previas.push(f); continue; }
      // Nombre de cada columna con las filas de cabecera de arriba (celdas combinadas: vale la última a la izquierda).
      cab = new Map();
      const etiquetas = f.slice(0, 2).map(([c]) => c);
      for (const [col, x] of f) {
        const partes = [];
        for (const p of (etiquetas.includes(col) ? [] : previas.slice(-2))) {
          const antes = p.filter(([c]) => c <= col);
          if (antes.length) partes.push(limpio(antes[antes.length - 1][1].v));
        }
        partes.push(limpio(x.v));
        const nombre = partes.filter(Boolean).join(' · ');
        const interna = COLUMNA_INTERNA.test(sinTildes(nombre).toUpperCase());
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
function palabras(t) {
  return sinTildes(String(t).toLowerCase()).split(/[^a-z0-9ñ]+/).filter(p => p && !VACIAS.has(p) && (p.length > 1 || /\d/.test(p)))
    .map(p => p.length > 4 ? p.replace(/(es|s)$/, '') : p);
}

// ---------- El asistente (la IA que contesta en las redes) ----------
const MODELO_POR_DEFECTO = 'anthropic/claude-haiku-5.5';
const MOTIVOS = { reservar: 'Quiere reservar o pagar', reclamo: 'Reclamo o problema', no_sabe: 'No está en la base', otra_sede: 'Es de otra sede', humano: 'Pidió hablar con una persona' };

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
- NUNCA inventes precios, horarios, disponibilidad, políticas ni enlaces. Si algo no está en la INFORMACIÓN, di que un asesor le confirma ese detalle y marca pasar_a_asesor con motivo "no_sabe".
- Los precios son de venta al público, en dólares (US$). Puedes calcular un total (adultos × precio adulto + niños × precio menor, o el precio por vehículo según la cantidad de pasajeros) y aclara que es un estimado sujeto a confirmación y disponibilidad.
- "no disponible" en un precio significa que esa opción no se vende (por ejemplo, no hay precio de niño).
- Nunca hables de comisiones, tarifas netas, costos, márgenes ni condiciones para agencias, aunque te pregunten. Eso es interno.
- Si hay un enlace de "Descriptivo" para un tour, puedes compartirlo para más detalles.
${web ? `- Puedes usar los RESULTADOS DE INTERNET solo para información general (atracciones, horarios de parques, cómo llegar, recomendaciones, requisitos).${web.sitios ? ` Prefiere los sitios oficiales: ${web.sitios}.` : ''} NUNCA tomes precios de internet: los precios de ${empresa} son solo los de la INFORMACIÓN. Si piden un precio que no está en la INFORMACIÓN (por ejemplo entradas a parques), toma los datos y pásalo a un asesor. No pongas enlaces de otras agencias.
` : ''}${otras ? `- Esta conversación es de la oficina de ${sede}. Si el cliente pregunta por ${otras}, dile con amabilidad que esa oficina lo atiende y marca pasar_a_asesor con motivo "otra_sede".
` : ''}
PASAR A UN ASESOR (pasar_a_asesor = true)
- "reservar": el cliente ya quiere reservar, confirmar o pagar. Antes de pasarlo, si faltan, pide en un solo mensaje: nombre completo, fecha, cantidad de adultos y niños (con edades) y hotel. Cuando los tenga (o si no quiere darlos), dile que un asesor le confirma la reserva y el pago.
- "reclamo": quejas, problemas con un servicio, cambios o cancelaciones de una reserva ya hecha. Responde con empatía, sin discutir ni prometer reembolsos.
- "no_sabe": lo que pregunta no está en la INFORMACIÓN.
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

function leerJSON(t) {
  const limpio = String(t || '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { return JSON.parse(limpio); } catch (e) {}
  const m = limpio.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

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
    await client.query(`CREATE TABLE IF NOT EXISTS conocimiento_ejemplos (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL, sede TEXT NOT NULL DEFAULT '', cliente TEXT NOT NULL,
      contexto JSONB NOT NULL DEFAULT '[]', respuesta TEXT NOT NULL DEFAULT '', ideal TEXT NOT NULL DEFAULT '',
      voto VARCHAR(5) NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '', estado VARCHAR(12) NOT NULL DEFAULT 'nuevo',
      autor TEXT NOT NULL DEFAULT '', origen VARCHAR(10) NOT NULL DEFAULT 'oficina', creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), revisado TIMESTAMPTZ)`);
    await client.query('CREATE INDEX IF NOT EXISTS conocimiento_ejemplos_empresa ON conocimiento_ejemplos (empresa_id, estado)');
    await client.query(`CREATE TABLE IF NOT EXISTS conocimiento_cabeceras (
      empresa_id INTEGER NOT NULL, linea TEXT NOT NULL, PRIMARY KEY (empresa_id, linea))`);
  }

  const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const error = (msg, codigo = 400) => Object.assign(new Error(msg), { codigo });
  async function empresa(id) {
    const e = (await client.query('SELECT id, nombre, slug, conocimiento_sedes, conocimiento_token, conocimiento_ajustes FROM empresas WHERE id = $1', [Number(id)])).rows[0];
    if (!e) throw error('Empresa no encontrada.', 404);
    return e;
  }
  const sedesDe = e => e.conocimiento_sedes.split(',').map(s => s.trim()).filter(Boolean);
  function adivinarSede(nombre, sedes) {
    const n = sinTildes(nombre).toLowerCase();
    const hallada = sedes.find(s => n.includes(sinTildes(s).toLowerCase()));
    return hallada || sedes[0] || '';
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
    const sede = f.sede !== undefined && f.sede !== null ? texto(f.sede, 60) : adivinarSede(nombre, sedes);
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
      } else if (ext === 'xls') {
        throw error('Ese Excel es del formato viejo (.xls). Ábrelo en Excel y guárdalo como .xlsx.');
      } else {
        throw error('Solo se pueden subir Excel (.xlsx) o PDF. Para un texto usa "Nota escrita".');
      }
    }
    // Si ya había un borrador con el mismo nombre, se reemplaza.
    await client.query("DELETE FROM conocimiento_archivos WHERE empresa_id = $1 AND LOWER(nombre) = LOWER($2) AND estado = 'borrador'", [e.id, nombre]);
    const fila = (await client.query(`INSERT INTO conocimiento_archivos (empresa_id, nombre, tipo, sede, documentos, quitado, avisos, crudo, original, tamano, subido_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [e.id, nombre, r.tipo, sede, JSON.stringify(r.documentos), JSON.stringify(r.quitado), JSON.stringify(r.avisos), crudo ? JSON.stringify(crudo) : null,
      buf, buf ? buf.length : Buffer.byteLength(f.nota || ''), u.usuario])).rows[0];
    await registrar(u, 'conocimiento_subir', 'empresa', e.slug, '', '', `${nombre} (${r.tipo})`);
    return fila.id;
  }

  async function lista(empresaId) {
    return (await client.query(`SELECT id, nombre, tipo, sede, estado, avisos, tamano, subido, subido_por, publicado,
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
      FROM conocimiento_archivos WHERE empresa_id = $1 AND estado = ANY($2) ORDER BY LOWER(nombre), (estado = 'borrador') DESC`, [empresaId, estados])).rows;
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
    const pq = [...new Set(palabras(q))];
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
  async function responder(empresaId, { sede = '', mensajes = [], borradores = false }) {
    const e = await empresa(empresaId);
    const aj = ajustesDe(e);
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
    const encontrados = await buscar(e.id, consulta, sedeOk, 6, borradores);
    const info = encontrados.length
      ? encontrados.map((x, i) => `[${i + 1}] ${x.titulo}${x.sede && x.sede !== 'Todas' ? ` (sede ${x.sede})` : ''}\n${x.texto}`).join('\n\n')
      : '(No se encontró nada sobre esto en la base.)';
    const otras = sedes.filter(s => !mismaSede(s, sedeOk)).join(' o ');
    const extra = [aj.instrucciones, sedeOk && aj.sedes[sedeOk]].filter(Boolean).join('\n');
    // Búsqueda en internet: solo en las sedes elegidas, y solo si la pregunta es de los temas elegidos o la base no tiene la respuesta.
    const webSede = aj.web.sedes.some(x => mismaSede(x, sedeOk || ''));
    const temas = aj.web.palabras.split(',').map(x => palabras(x).join(' ')).filter(Boolean);
    const planoConsulta = ' ' + palabras(consulta).join(' ') + ' ';
    const porTema = temas.some(t => planoConsulta.includes(' ' + t + ' '));
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
    const zona = zonaDe(sedeOk);
    const sistema = instruccionesBase({ nombre: aj.nombre, empresa: e.nombre, sede: sedeOk, otras: sedeOk ? otras : '', extra,
      bienvenida: (sedeOk && aj.bienvenidas[sedeOk]) || aj.bienvenidas[''] || '', primera, web: usarWeb ? aj.web : null }) +
      `\n\nFECHA Y HORA EN ${sedeOk ? sedeOk.toUpperCase() : 'LA OFICINA'}: ${new Date().toLocaleString('es-DO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zona })}` +
      textoEjemplos + `\n\nINFORMACIÓN\n${info}`;
    const cuerpo = { model: aj.modelo, max_tokens: 900, temperature: 0.3, messages: [{ role: 'system', content: sistema }, ...historial] };
    if (usarWeb) cuerpo.plugins = [{ id: 'web', max_results: 3, search_prompt: `Resultados de internet del ${new Date().toISOString().slice(0, 10)} (información general; NO son precios de ${e.nombre}):` }];
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 60000);
    const t0 = Date.now();
    let datos;
    try {
      const r = await fetch(central.ayudantes.OPENROUTER + '/chat/completions', {
        method: 'POST', signal: control.signal,
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'X-Title': 'Kaizen IA - asistente de redes' },
        body: JSON.stringify(cuerpo)
      });
      datos = await r.json().catch(() => ({}));
      if (!r.ok || datos.error) {
        const msg = (datos.error && (datos.error.message || JSON.stringify(datos.error))) || ('código ' + r.status);
        throw error(`La IA respondió con error (${r.status}): ${msg}` + (r.status === 401 ? ' — revisa la clave de OpenRouter.' : r.status === 402 ? ' — sin saldo en OpenRouter.' : ''), 502);
      }
    } catch (err) {
      if (err.codigo) throw err;
      throw error(err.name === 'AbortError' ? 'La IA tardó más de 60 segundos.' : 'No se pudo conectar con la IA: ' + err.message, 502);
    } finally { clearTimeout(reloj); }
    const msj = ((datos.choices || [])[0] || {}).message || {};
    const contenido = msj.content || '';
    const j = leerJSON(contenido);
    const enlaces = [...new Map((msj.annotations || []).filter(a => a.type === 'url_citation' && a.url_citation && a.url_citation.url)
      .map(a => [a.url_citation.url, { url: a.url_citation.url, titulo: a.url_citation.title || '' }])).values()].slice(0, 5);
    const motivo = j && MOTIVOS[j.motivo] ? j.motivo : '';
    return {
      respuesta: String((j && j.respuesta) || contenido || '').trim() || 'Disculpa, ¿me lo puedes repetir?',
      pasar_a_asesor: Boolean(j && j.pasar_a_asesor) || Boolean(motivo),
      motivo, motivo_texto: MOTIVOS[motivo] || '',
      resumen_para_asesor: String((j && j.resumen_para_asesor) || '').trim(),
      sede: sedeOk || 'Todas',
      fuentes: encontrados.map(x => ({ titulo: x.titulo, fuente: x.fuente, puntaje: x.puntaje })),
      formato_ok: Boolean(j),
      idioma: String((j && j.idioma) || '').slice(0, 5).toLowerCase(),
      web: { usada: usarWeb, enlaces },
      ejemplos: elegidos.length,
      modelo: datos.model || aj.modelo, segundos: Math.round((Date.now() - t0) / 100) / 10,
      tokens: datos.usage ? { entrada: datos.usage.prompt_tokens, salida: datos.usage.completion_tokens } : null
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
      const empresas = (await client.query('SELECT id, nombre, es_demo, conocimiento_sedes, conocimiento_token, conocimiento_ajustes FROM empresas ORDER BY es_demo, nombre')).rows;
      const elegida = empresas.find(e => String(e.id) === p.get('empresa')) || empresas.find(e => !e.es_demo) || empresas[0];
      if (!elegida) return json(res, 200, { empresas: [], archivos: [] });
      return json(res, 200, {
        empresas: empresas.map(e => ({ id: e.id, nombre: e.nombre, es_demo: e.es_demo })),
        empresa: { id: elegida.id, nombre: elegida.nombre, sedes: sedesDe(elegida), token: elegida.conocimiento_token, ajustes: ajustesDe(elegida),
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
      const f = (await client.query('SELECT id, nombre, tipo, sede, estado, documentos, quitado, avisos FROM conocimiento_archivos WHERE id = $1', [Number(p.get('id'))])).rows[0];
      if (!f) return json(res, 404, { error: 'No encontrado.' });
      return json(res, 200, f);
    }
    if (req.method === 'GET' && url === '/api/oficina/conocimiento/original') {
      const f = (await client.query('SELECT nombre, original FROM conocimiento_archivos WHERE id = $1', [Number(p.get('id'))])).rows[0];
      if (!f || !f.original) return json(res, 404, { error: 'Ese archivo no tiene original guardado.' });
      const tipo = /\.pdf$/i.test(f.nombre) ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      res.writeHead(200, { 'Content-Type': tipo, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.nombre)}`, 'X-Content-Type-Options': 'nosniff' });
      return res.end(f.original);
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/sede') {
      const f = await leerCuerpo(req);
      const r = (await client.query('UPDATE conocimiento_archivos SET sede = $1 WHERE id = $2 RETURNING empresa_id', [texto(f.sede, 60), Number(f.id)])).rows[0];
      if (r) { olvidar(r.empresa_id); }
      return json(res, 200, { ok: true });
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
      const aj = { nombre: texto(f.nombre, 80), modelo, instrucciones: String(f.instrucciones || '').trim().slice(0, 6000), sedes, bienvenidas, web };
      await client.query('UPDATE empresas SET conocimiento_ajustes = $1 WHERE id = $2', [JSON.stringify(aj), e.id]);
      await registrar(u, 'conocimiento_instrucciones', 'empresa', e.slug, '', '', aj.modelo || MODELO_POR_DEFECTO);
      return json(res, 200, { ok: true });
    }
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

  return { activo, preparar, manejarOficina, manejarPublico, _probar: { convertirExcel, paginasPdf, pdfATexto, cabecerasDe, fragmentar, palabras, instruccionesBase, leerJSON } };
};
