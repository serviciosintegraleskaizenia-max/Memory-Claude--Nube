// Lector de Excel (.xlsx) sin librerías externas: abre el zip, lee las hojas, textos, enlaces y fechas.
// Devuelve, por hoja, las filas con sus celdas { columna: { v, enlace } } (como openpyxl: una celda
// combinada solo trae el valor en la primera).

const zlib = require('zlib');

function abrirZip(buf) {
  // Fin del directorio central: firma 0x06054b50, buscando desde el final.
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw new Error('El archivo no es un Excel válido (.xlsx).');
  const total = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const archivos = new Map();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const tamComp = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28), largoExtra = buf.readUInt16LE(p + 30), largoNota = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.slice(p + 46, p + 46 + largoNombre).toString('utf8');
    archivos.set(nombre.replace(/^\//, ''), { metodo, tamComp, local });
    p += 46 + largoNombre + largoExtra + largoNota;
  }
  return nombre => {
    const a = archivos.get(nombre);
    if (!a) return null;
    const inicio = a.local + 30 + buf.readUInt16LE(a.local + 26) + buf.readUInt16LE(a.local + 28);
    const datos = buf.slice(inicio, inicio + a.tamComp);
    if (a.metodo === 0) return datos.toString('utf8');
    if (a.metodo === 8) return zlib.inflateRawSync(datos).toString('utf8');
    throw new Error('Compresión no soportada en el Excel.');
  };
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function des(t) {
  return String(t).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTIDADES[e] ?? m;
  }).replace(/_x([0-9A-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}
function attr(etiqueta, nombre) {
  const m = etiqueta.match(new RegExp('(?:^|\\s)' + nombre + '="([^"]*)"'));
  return m ? des(m[1]) : null;
}
// Texto de un <si> o <is>: todos los <t>, sin la guía fonética (<rPh>).
function textoDe(xml) {
  return [...xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => des(m[1])).join('');
}
function columna(ref) {
  let n = 0;
  for (const c of ref.replace(/\d+/g, '')) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}
function relaciones(xml) {
  const r = new Map();
  for (const m of (xml || '').matchAll(/<Relationship\s[^>]*>/g)) r.set(attr(m[0], 'Id'), { destino: attr(m[0], 'Target'), modo: attr(m[0], 'TargetMode') });
  return r;
}
function ruta(base, destino) {
  if (destino.startsWith('/')) return destino.slice(1);
  const partes = base.split('/').slice(0, -1);
  for (const p of destino.split('/')) { if (p === '..') partes.pop(); else if (p !== '.') partes.push(p); }
  return partes.join('/');
}

// Formatos de número que son fechas.
const FECHAS_FIJAS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function esFormatoFecha(codigo) {
  const c = String(codigo).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dy]/i.test(c) || /h.*m|m.*s/i.test(c);
}
function fechaExcel(n, conHora) {
  const d = new Date(Math.round((n - 25569) * 86400000));
  const p = x => String(x).padStart(2, '0');
  const f = `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  if (n < 1) return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return conHora && (d.getUTCHours() || d.getUTCMinutes()) ? `${f} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : f;
}

function leerExcel(buf) {
  const leer = abrirZip(buf);
  const libro = leer('xl/workbook.xml');
  if (!libro) throw new Error('El archivo no es un Excel válido (.xlsx).');
  const relLibro = relaciones(leer('xl/_rels/workbook.xml.rels'));
  const compartidos = [...(leer('xl/sharedStrings.xml') || '').matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(m => m[1] ? textoDe(m[1]) : '');

  // Estilos: qué celdas son fechas.
  const estilos = leer('xl/styles.xml') || '';
  const propios = new Map([...estilos.matchAll(/<numFmt\s[^>]*>/g)].map(m => [Number(attr(m[0], 'numFmtId')), attr(m[0], 'formatCode')]));
  const xfs = ((estilos.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '');
  const estiloFecha = [...xfs.matchAll(/<xf\s[^>]*?(?:\/>|>)/g)].map(m => {
    const id = Number(attr(m[0], 'numFmtId') || 0);
    return FECHAS_FIJAS.has(id) || (propios.has(id) && esFormatoFecha(propios.get(id)));
  });

  const hojas = [];
  for (const m of libro.matchAll(/<sheet\s[^>]*>/g)) {
    const nombre = attr(m[0], 'name');
    const rel = relLibro.get(attr(m[0], 'r:id'));
    if (!rel) continue;
    const archivo = ruta('xl/workbook.xml', rel.destino);
    const xml = leer(archivo);
    if (!xml) continue;
    const relHoja = relaciones(leer(archivo.replace(/([^/]+)$/, '_rels/$1.rels')));
    const enlaces = new Map();
    for (const h of xml.matchAll(/<hyperlink\s[^>]*>/g)) {
      const r = relHoja.get(attr(h[0], 'r:id'));
      if (r && r.destino) enlaces.set(attr(h[0], 'ref').split(':')[0], r.destino);
    }
    const filas = [];
    const datos = (xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/) || [])[1] || '';
    for (const fila of datos.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const celdas = {};
      for (const c of (fila[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], 'r');
        if (!ref || !c[2]) continue;
        const tipo = attr(c[1], 't');
        const v = (c[2].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let valor = null;
        if (tipo === 's') valor = v != null ? compartidos[Number(v)] : null;
        else if (tipo === 'inlineStr') valor = textoDe((c[2].match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
        else if (tipo === 'str') valor = v != null ? des(v) : null;
        else if (tipo === 'b') valor = v === '1' ? 'Sí' : 'No';
        else if (tipo === 'e') valor = null;
        else if (v != null) {
          const n = Number(v);
          valor = estiloFecha[Number(attr(c[1], 's') || 0)] ? fechaExcel(n, true) : n;
        }
        if (valor === null || valor === '') continue;
        celdas[columna(ref)] = { v: valor, enlace: enlaces.get(ref) || null };
      }
      if (Object.keys(celdas).length) filas.push(celdas);
    }
    hojas.push({ nombre, filas });
  }
  return hojas;
}

// ---------- Escribir un Excel sencillo (para guardar lo que se edita en la Oficina) ----------
// hojas: [{ nombre, filas: [{ [columna]: { v, enlace } }] }] — el mismo formato que devuelve leerExcel.
// Se pierden colores y celdas combinadas; se conservan las hojas, los valores y los enlaces.
const TABLA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zip(archivos) {
  const locales = [], centrales = []; let pos = 0;
  for (const [nombre, contenido] of archivos) {
    const datos = Buffer.from(contenido, 'utf8'), comp = zlib.deflateRawSync(datos), n = Buffer.from(nombre, 'utf8'), crc = crc32(datos);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(datos.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(datos.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(pos, 42);
    locales.push(l, n, comp); centrales.push(c, n); pos += 30 + n.length + comp.length;
  }
  const central = Buffer.concat(centrales), fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10); fin.writeUInt32LE(central.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...locales, central, fin]);
}
const xmlEsc = t => String(t).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function letra(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function escribirExcel(hojas) {
  const lista = (hojas || []).filter(h => h && h.nombre).slice(0, 50);
  if (!lista.length) throw new Error('No hay hojas para guardar.');
  const archivos = [];
  const usados = new Set();
  const nombres = lista.map(h => { let n = String(h.nombre).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Hoja'; let k = n, i = 2; while (usados.has(k.toLowerCase())) k = n.slice(0, 28) + ' ' + i++; usados.add(k.toLowerCase()); return k; });
  lista.forEach((h, i) => {
    const enlaces = [];
    const filasXml = (h.filas || []).slice(0, 20000).map((f, r) => {
      const celdas = Object.keys(f || {}).map(Number).filter(c => c > 0 && c <= 16384).sort((a, b) => a - b).map(c => {
        const celda = f[c] || {}, ref = letra(c) + (r + 1), v = celda.v;
        if (v === null || v === undefined || v === '') return '';
        if (celda.enlace && /^(https?:|mailto:)/i.test(celda.enlace)) enlaces.push([ref, celda.enlace]);
        return typeof v === 'number' && Number.isFinite(v) ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${celdas}</row>`;
    }).join('');
    const hl = enlaces.length ? `<hyperlinks>${enlaces.map(([ref], k) => `<hyperlink ref="${ref}" r:id="rIdL${k + 1}"/>`).join('')}</hyperlinks>` : '';
    archivos.push([`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${filasXml}</sheetData>${hl}</worksheet>`]);
    if (enlaces.length) archivos.push([`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${enlaces.map(([, u], k) => `<Relationship Id="rIdL${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(u)}" TargetMode="External"/>`).join('')}</Relationships>`]);
  });
  archivos.unshift(
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${lista.map((h, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${nombres.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${nombres.map((n, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`]);
  return zip(archivos);
}

module.exports = { leerExcel, abrirZip, escribirExcel };
