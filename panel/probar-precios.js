// Prueba de precios del asistente: le hace preguntas reales y compara los precios que da con los de los Excel.
// Uso (en la carpeta de la Oficina, C:\kaizen-pruebas):
//   node probar-precios.js casos-precios.json
// Cada caso: { "sede", "pregunta", "esperado": [[n, n], [n]] (basta con que se cumpla UNA de las opciones),
//              "prohibido": [n] (precios netos o de otra zona que no debe dar), "asesor": false (si no debe pasar a un asesor) }
// Escribe probar-precios-resultado.txt. Tiene precios del cliente: no lo subas a internet.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const archivoCasos = process.argv[2] || 'casos-precios.json';
const config = require(process.env.PANEL_CONFIG ? path.resolve(process.env.PANEL_CONFIG)
  : fs.existsSync('./config-central.js') ? path.resolve('./config-central.js') : path.resolve('./config.js'));

function numeros(texto) {
  const t = String(texto || '').replace(/(\d),(\d{3})\b/g, '$1$2');
  return [...t.matchAll(/\d+(?:[.,]\d{1,2})?/g)].map(m => Number(m[0].replace(',', '.')));
}

(async () => {
  const casos = JSON.parse(fs.readFileSync(archivoCasos, 'utf8'));
  const db = new Client(config.db);
  await db.connect();
  const filtro = process.env.EMPRESA || 'somos';
  const e = (await db.query("SELECT id, nombre, conocimiento_token FROM empresas WHERE nombre ILIKE $1 AND COALESCE(conocimiento_token, '') <> '' ORDER BY id LIMIT 1", ['%' + filtro + '%'])).rows[0];
  await db.end();
  if (!e) { console.error(`No encontré una empresa con "${filtro}" que tenga la base del asistente publicada.`); process.exit(1); }
  const url = `http://localhost:${config.puerto || 3090}/api/conocimiento/responder`;
  console.log(`Empresa: ${e.nombre} · ${casos.length} preguntas\n`);
  const lineas = [];
  let bien = 0;
  for (const [i, c] of casos.entries()) {
    let d = {}, error = '';
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { Authorization: 'Bearer ' + e.conocimiento_token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sede: c.sede, mensajes: [{ rol: 'cliente', texto: c.pregunta }] })
      });
      d = await r.json().catch(() => ({}));
      if (!r.ok) error = d.error || ('código ' + r.status);
    } catch (err) { error = err.message; }
    const dados = numeros(d.respuesta);
    const cumple = !c.esperado || !c.esperado.length || c.esperado.some(op => op.every(n => dados.includes(n)));
    const malos = (c.prohibido || []).filter(n => dados.includes(n));
    const asesorOk = c.asesor === undefined || Boolean(d.pasar_a_asesor) === c.asesor;
    const ok = !error && cumple && !malos.length && asesorOk;
    if (ok) bien++;
    const detalle = error ? 'ERROR: ' + error
      : [!cumple ? `esperaba ${c.esperado.map(op => op.join(' y ')).join(' o ')}` : '', malos.length ? `dio ${malos.join(', ')} (no debía)` : '',
        !asesorOk ? (d.pasar_a_asesor ? 'lo pasó a un asesor (no debía)' : 'no lo pasó a un asesor') : ''].filter(Boolean).join(' · ');
    const linea = `${ok ? '✔' : '✘'} ${i + 1}. [${c.sede}] ${c.pregunta}\n     ${detalle || 'bien'}\n     Respuesta: ${String(d.respuesta || '').replace(/\s+/g, ' ').slice(0, 400)}` +
      (d.pasar_a_asesor ? `\n     → Pasa a asesor: ${d.motivo_texto || d.motivo || ''}` : '') + (d.diagnostico ? `\n     (diagnóstico: ${d.diagnostico})` : '');
    console.log(linea + '\n');
    lineas.push(linea);
  }
  const resumen = `RESULTADO: ${bien} de ${casos.length} bien`;
  console.log(resumen);
  fs.writeFileSync('probar-precios-resultado.txt', `Prueba de precios · ${e.nombre} · ${new Date().toLocaleString('es-DO')}\n\n${lineas.join('\n\n')}\n\n${resumen}\n`);
  console.log('Guardado en probar-precios-resultado.txt');
})().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
