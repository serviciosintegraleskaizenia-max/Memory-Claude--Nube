// Arregla tildes dañadas que mandan algunos sistemas (BÃ¡varo -> Bávaro).
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

function textoPlano(parte) {
  if (!parte) return '';
  if (parte.mimeType === 'text/plain' && parte.body && parte.body.data) {
    return Buffer.from(parte.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  }
  for (const p of (parte.parts || [])) {
    const t = textoPlano(p);
    if (t) return t;
  }
  return '';
}

function htmlATexto(html) {
  return String(html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

// Microsoft 365 llega como una lista en "value". Cada nodo de lectura es de un buzón:
// el buzón se toma del nodo que leyó el correo y, si no, de la dirección que devuelve Microsoft.
const BUZON_GMAIL = 'serviciosintegraleskaizen.ia@gmail.com';
const BUZON_MICROSOFT = 'operaciones@somosviajepuntacana.com';
const NODOS_MICROSOFT = {
  'Microsoft 365: leer correos': 'operaciones@somosviajepuntacana.com',
  'Microsoft 365: leer bookings': 'bookings@somosviaje.online'
};
const buzonPorId = new Map();
for (const [nodo, buzon] of Object.entries(NODOS_MICROSOFT)) {
  try {
    for (const item of $(nodo).all()) for (const m of (item.json.value || [])) buzonPorId.set(m.id, buzon);
  } catch (e) { /* ese nodo no corrió o no existe */ }
}
function buzonDeRespuesta(json) {
  const m = String(json['@odata.context'] || '').match(/users\('([^']+)'\)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : BUZON_MICROSOFT;
}
const entradas = $('Juntar correos').all().flatMap(item => Array.isArray(item.json.value)
  ? item.json.value.map(m => ({ json: m, buzon: buzonPorId.get(m.id) || buzonDeRespuesta(item.json) }))
  : [{ json: item.json, buzon: BUZON_GMAIL }]);

const leidos = entradas.filter(item => item.json.id).map(item => {
  const j = item.json;
  if (j.receivedDateTime) {
    const de = (j.from && j.from.emailAddress) || {};
    const cuerpo = (j.body && j.body.content) || '';
    return {
      json: {
        metadata: { 'message-id': j.id },
        buzon: item.buzon,
        from: decodificar(de.name ? `${de.name} <${de.address}>` : (de.address || '')),
        subject: decodificar(j.subject || ''),
        date: j.receivedDateTime,
        textPlain: decodificar(j.body && j.body.contentType === 'html' ? htmlATexto(cuerpo) : cuerpo)
      }
    };
  }
  const cabeceras = (j.payload && j.payload.headers) || [];
  const leer = (nombre) => {
    const h = cabeceras.find(x => x.name && x.name.toLowerCase() === nombre.toLowerCase());
    if (h) return h.value;
    const directo = j[nombre] || j[nombre.toLowerCase()];
    if (directo && typeof directo === 'object') return directo.text || '';
    return directo || '';
  };
  const fecha = leer('Date') || (j.internalDate ? new Date(Number(j.internalDate)).toISOString() : '');
  const texto = j.text || textoPlano(j.payload) || htmlATexto(j.html) || j.snippet || '';
  return {
    json: {
      metadata: { 'message-id': j.id },
      buzon: item.buzon,
      from: decodificar(leer('From')),
      subject: decodificar(leer('Subject')),
      date: fecha,
      textPlain: decodificar(texto)
    }
  };
});

// Correos que fallaron antes (vienen del nodo "Reintentar fallidos"), aunque ya no estén en las fechas que se leen.
const reintentos = $input.all().map(x => x.json).filter(j => j.reintento && j.message_id).map(j => ({
  json: {
    metadata: { 'message-id': j.message_id },
    buzon: j.buzon || BUZON_GMAIL,
    from: j.remitente || '',
    subject: j.asunto || '',
    date: j.fecha || '',
    textPlain: j.cuerpo || ''
  }
}));

// Si un correo llega por los dos caminos, se usa una sola vez (el recién leído tiene el texto más completo).
const vistos = new Set();
return [...leidos, ...reintentos].filter(x => {
  const id = x.json.metadata['message-id'];
  if (vistos.has(id)) return false;
  vistos.add(id);
  return true;
});