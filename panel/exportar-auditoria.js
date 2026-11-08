// Exporta correos del panel para una auditoría: lo que leyó la IA (todos los servicios), el texto, el correo completo y sus imágenes.
// Uso (en la carpeta del panel, p. ej. C:\panel-correos):
//   node exportar-auditoria.js 1284 1292 1205        -> esas reservas (#), con todos los servicios de cada correo
//   node exportar-auditoria.js --ultimos 15           -> los 15 correos de reserva/modificación más recientes
// Crea la carpeta "auditoria-correos" (una subcarpeta por correo) y BORRA la anterior. Tiene datos de clientes: no la subas a internet.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const config = require(process.env.PANEL_CONFIG ? path.resolve(process.env.PANEL_CONFIG) : './config');

const MAX_ADJUNTO = 8 * 1024 * 1024;
const SALIDA = path.resolve('auditoria-correos');
const CATEGORIAS = ['RESERVA', 'MODIFICACION'];
const seguro = t => String(t || '').replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 80) || 'archivo';
const clave = f => (f.message_id ? 'm:' + f.message_id : 'id:' + f.id);

async function correoCompleto(fila) {
  const destino = config.n8n && config.n8n.correoCompleto;
  if (!destino) throw new Error('Falta n8n.correoCompleto en config.js');
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), 60000);
  try {
    const r = await fetch(destino, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: control.signal,
      body: JSON.stringify({ accion: 'correo', message_id: fila.message_id, buzon: fila.buzon, incluir_adjuntos: true })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok !== true) throw new Error(d.error || ('n8n respondió ' + r.status));
    return d;
  } finally { clearTimeout(reloj); }
}

(async () => {
  const args = process.argv.slice(2);
  let ids = [];
  const db = new Client(config.db);
  await db.connect();
  if (args[0] === '--ultimos') {
    const n = Math.min(Math.max(Number(args[1]) || 15, 1), 60);
    ids = (await db.query(`SELECT MAX(id) AS id FROM clasificacion WHERE categoria = ANY($2) AND estado <> 'historico'
      GROUP BY COALESCE(NULLIF(message_id, ''), 'id:' || id) ORDER BY MAX(id) DESC LIMIT $1`, [n, CATEGORIAS])).rows.map(x => x.id);
  } else {
    ids = args.map(Number).filter(Boolean);
    if (!ids.length) { console.log('Uso: node exportar-auditoria.js 1284 1292 ...   o   node exportar-auditoria.js --ultimos 15'); process.exit(1); }
  }
  // Cada número trae también los demás servicios del mismo correo (IN, OUT, actividades...).
  const filas = (await db.query(`SELECT * FROM clasificacion WHERE id = ANY($1)
      OR (COALESCE(message_id, '') <> '' AND categoria = ANY($2)
          AND message_id IN (SELECT message_id FROM clasificacion WHERE id = ANY($1)))
    ORDER BY id`, [ids, CATEGORIAS])).rows;
  const grupos = new Map();
  for (const f of filas) {
    if (!grupos.has(clave(f))) grupos.set(clave(f), []);
    grupos.get(clave(f)).push(f);
  }
  fs.rmSync(SALIDA, { recursive: true, force: true });
  fs.mkdirSync(SALIDA, { recursive: true });
  const resumen = [];
  for (const servicios of grupos.values()) {
    servicios.sort((a, b) => (a.numero_servicio || 0) - (b.numero_servicio || 0) || a.id - b.id);
    const f = servicios[0];
    const nombre = servicios.map(s => s.id).join('-');
    const carpeta = path.join(SALIDA, nombre);
    fs.mkdirSync(carpeta, { recursive: true });
    fs.writeFileSync(path.join(carpeta, 'lo-que-leyo-la-ia.json'),
      JSON.stringify({ servicios: servicios.map(({ cuerpo, ...campos }) => campos) }, null, 2));
    fs.writeFileSync(path.join(carpeta, 'texto-del-correo.txt'), String(f.cuerpo || ''));
    let imagenes = 0, error = '';
    try {
      const c = await correoCompleto(f);
      fs.writeFileSync(path.join(carpeta, 'correo.html'), String(c.html || ''));
      const vistas = new Set();
      for (const [i, a] of (c.adjuntos || []).entries()) {
        if (!a || !a.datos) continue;
        const buf = Buffer.from(a.datos, 'base64');
        if (buf.length > MAX_ADJUNTO) continue;
        if (!/^image\/|pdf/i.test(String(a.tipo || '')) && !/\.(png|jpe?g|gif|webp|pdf)$/i.test(String(a.nombre || ''))) continue;
        const huella = crypto.createHash('sha1').update(buf).digest('hex');
        if (vistas.has(huella)) continue; // la misma firma o logo repetido en la cadena
        vistas.add(huella);
        fs.writeFileSync(path.join(carpeta, `adjunto-${i + 1}-${seguro(a.nombre)}`), buf);
        imagenes++;
      }
    } catch (e) { error = e.message; }
    resumen.push({ ids: servicios.map(s => s.id), asunto: f.asunto, buzon: f.buzon, servicios: servicios.length, imagenes, error });
    console.log(`#${nombre}  ${String(f.asunto || '').slice(0, 55)}  ->  ${servicios.length} servicio(s), ${imagenes} imagen(es)${error ? '  (sin correo completo: ' + error + ')' : ''}`);
  }
  fs.writeFileSync(path.join(SALIDA, 'resumen.json'), JSON.stringify(resumen, null, 2));
  await db.end();
  console.log(`\nListo: ${grupos.size} correo(s) en ${SALIDA}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
