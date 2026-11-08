// Exporta correos del panel para una auditoría: lo que leyó la IA (campos), el texto, el correo completo y sus imágenes.
// Uso (en la carpeta del panel, p. ej. C:\panel-correos):
//   node exportar-auditoria.js 1284 1292 1205        -> esos números de reserva (#)
//   node exportar-auditoria.js --ultimos 15           -> las 15 reservas/modificaciones más recientes
// Crea la carpeta "auditoria-correos" (una subcarpeta por correo). Tiene datos de clientes: no la subas a internet.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const config = require(process.env.PANEL_CONFIG ? path.resolve(process.env.PANEL_CONFIG) : './config');

const MAX_ADJUNTO = 8 * 1024 * 1024;
const SALIDA = path.resolve('auditoria-correos');
const seguro = t => String(t || '').replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 80) || 'archivo';

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
  const db = new Client(config.db);
  await db.connect();
  let filas;
  if (args[0] === '--ultimos') {
    const n = Math.min(Math.max(Number(args[1]) || 15, 1), 60);
    filas = (await db.query(`SELECT * FROM clasificacion WHERE categoria IN ('RESERVA', 'MODIFICACION') AND estado <> 'historico'
      ORDER BY id DESC LIMIT $1`, [n])).rows;
  } else {
    const ids = args.map(Number).filter(Boolean);
    if (!ids.length) { console.log('Uso: node exportar-auditoria.js 1284 1292 ...   o   node exportar-auditoria.js --ultimos 15'); process.exit(1); }
    filas = (await db.query('SELECT * FROM clasificacion WHERE id = ANY($1) ORDER BY id', [ids])).rows;
  }
  fs.rmSync(SALIDA, { recursive: true, force: true });
  fs.mkdirSync(SALIDA, { recursive: true });
  const resumen = [];
  for (const f of filas) {
    const carpeta = path.join(SALIDA, String(f.id));
    fs.mkdirSync(carpeta, { recursive: true });
    const { cuerpo, ...campos } = f;
    fs.writeFileSync(path.join(carpeta, 'lo-que-leyo-la-ia.json'), JSON.stringify(campos, null, 2));
    fs.writeFileSync(path.join(carpeta, 'texto-del-correo.txt'), String(cuerpo || ''));
    let imagenes = 0, error = '';
    try {
      const c = await correoCompleto(f);
      fs.writeFileSync(path.join(carpeta, 'correo.html'), String(c.html || ''));
      for (const [i, a] of (c.adjuntos || []).entries()) {
        if (!a || !a.datos) continue;
        const buf = Buffer.from(a.datos, 'base64');
        if (buf.length > MAX_ADJUNTO) continue;
        if (!/^image\/|pdf/i.test(String(a.tipo || '')) && !/\.(png|jpe?g|gif|webp|pdf)$/i.test(String(a.nombre || ''))) continue;
        fs.writeFileSync(path.join(carpeta, `adjunto-${i + 1}-${seguro(a.nombre)}`), buf);
        imagenes++;
      }
    } catch (e) { error = e.message; }
    resumen.push({ id: f.id, asunto: f.asunto, buzon: f.buzon, imagenes, error });
    console.log(`#${f.id}  ${String(f.asunto || '').slice(0, 60)}  ->  ${imagenes} imagen(es)${error ? '  (sin correo completo: ' + error + ')' : ''}`);
  }
  fs.writeFileSync(path.join(SALIDA, 'resumen.json'), JSON.stringify(resumen, null, 2));
  await db.end();
  console.log(`\nListo: ${filas.length} correo(s) en ${SALIDA}`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
