// Lectura de facturas de pago que llegan por correo (categoría FACTURA).
// La IA propone los datos; nada se registra en Operaciones hasta que una persona lo confirme.
//
// Piezas (sin base de datos, para poder probarlas):
//   promptFactura(correo)      -> texto que se le manda a la IA
//   parseFactura(respuesta)    -> datos ordenados, o { error } si la respuesta no sirve
//   validarFactura(datos)      -> lista de cosas que faltan o se ven mal

const MONEDAS = ['USD', 'DOP', 'EUR', 'CAD', 'MXN'];
const SEDES = ['Punta Cana', 'Orlando'];

function promptFactura(correo) {
  const asunto = String(correo.subject || '').slice(0, 300);
  const remitente = String(correo.from || '').slice(0, 200);
  const texto = String(correo.textPlain || '').replace(/\s+/g, ' ').slice(0, 9000);
  return `Este correo es una factura o comprobante de pago de una agencia de viajes a Somos Viaje (Punta Cana u Orlando).
Saca los datos y responde SOLO con un objeto JSON, sin texto antes ni después, con estas claves exactas:
{
  "es_factura": true o false,
  "agencia": nombre de la agencia que paga (texto),
  "monto": número con el total que paga (sin símbolo),
  "moneda": "USD", "DOP", "EUR", "CAD" o "MXN",
  "referencia": número de factura, comprobante o transferencia (texto),
  "reservas": lista de números de reserva o proforma que se pagan (solo números, puede estar vacía),
  "paquete": nombre del paquete o servicio principal (ej. "Orlando", "Saona", "Traslado"), o "",
  "tipo_reserva": "Paquete", "Tour", "Traslado", "Hotel" u "Otro",
  "sede": "Punta Cana" u "Orlando", o "" si no se sabe,
  "fecha_pago": "AAAA-MM-DD" o "",
  "notas": algo importante que no cupo arriba (texto corto),
  "confianza": "alta", "media" o "baja"
}
Importante: si el correo lo envía PayPal, un banco o una pasarela, NO es la agencia. La agencia es quien paga: búscala en el saludo ("Hello, ..."), en "pagó por", en la factura o en el nombre de la empresa del cliente. El método de pago (PayPal, transferencia, etc.) va en "referencia" y en "notas".
Si un dato no aparece en el correo, pon "" o [] o 0. No inventes números de reserva ni montos.

Asunto: ${asunto}
De: ${remitente}
Correo:
${texto}`;
}

// La IA a veces responde con ```json ... ``` o con texto alrededor. Sacamos el objeto y lo validamos.
function parseFactura(respuesta) {
  const texto = String(respuesta || '').trim();
  const ini = texto.indexOf('{'), fin = texto.lastIndexOf('}');
  if (ini < 0 || fin <= ini) return { error: 'La IA no devolvió un objeto de datos.' };
  let d;
  try { d = JSON.parse(texto.slice(ini, fin + 1)); }
  catch (e) { return { error: 'La respuesta de la IA no es JSON válido.' }; }
  // Acepta "1,250.50" (miles con coma), "1.250,50" (miles con punto) y "250,50" (decimal con coma).
  const num = v => {
    let t = String(v ?? '').replace(/[^\d.,-]/g, '');
    if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (t.includes(',')) t = t.replace(',', '.');
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const txt = (v, max) => String(v ?? '').trim().slice(0, max);
  const fecha = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const reservas = (Array.isArray(d.reservas) ? d.reservas : String(d.reservas || '').split(/[,;\s]+/))
    .map(x => String(x).replace(/\D/g, '')).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 30);
  const moneda = txt(d.moneda, 5).toUpperCase();
  const sede = SEDES.includes(txt(d.sede, 30)) ? txt(d.sede, 30) : '';
  const confianza = ['alta', 'media', 'baja'].includes(txt(d.confianza, 10)) ? txt(d.confianza, 10) : 'baja';
  return {
    es_factura: d.es_factura === true,
    agencia: txt(d.agencia, 120),
    monto: num(d.monto),
    moneda: MONEDAS.includes(moneda) ? moneda : (moneda || ''),
    referencia: txt(d.referencia, 80),
    reservas,
    paquete: txt(d.paquete, 120),
    tipo_reserva: txt(d.tipo_reserva, 30) || 'Otro',
    sede,
    fecha_pago: fecha(d.fecha_pago),
    notas: txt(d.notas, 300),
    confianza
  };
}

// Lo que falta o se ve raro. Una factura con problemas graves no se propone para registrar.
function validarFactura(f) {
  const problemas = [];
  const bloqueos = [];
  if (!f.es_factura) { bloqueos.push('no es factura'); problemas.push('La IA no la reconoce como factura de pago.'); }
  if (!f.agencia) { bloqueos.push('sin agencia'); problemas.push('No se encontró la agencia que paga.'); }
  if (!(f.monto > 0)) { bloqueos.push('sin monto'); problemas.push('No se encontró el monto.'); }
  if (!f.moneda) problemas.push('No se encontró la moneda.');
  else if (!MONEDAS.includes(f.moneda)) problemas.push(`Moneda no reconocida: ${f.moneda}.`);
  if (!f.reservas.length) problemas.push('No aparece ningún número de reserva o proforma: hay que elegir la reserva a mano.');
  if (f.confianza === 'baja') problemas.push('La IA tiene poca seguridad: revísala con calma.');
  return { problemas, listaParaRegistrar: bloqueos.length === 0 && f.reservas.length > 0 };
}

// ---------- Lo que se guarda y la lectura con la IA ----------
const METODOS_PAGO = ['PayPal', 'Transferencia', 'Efectivo', 'Tarjeta', 'Cheque', 'Otro'];

async function preparar(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS facturas_pago (
    id SERIAL PRIMARY KEY, clasificacion_id INTEGER UNIQUE, message_id TEXT NOT NULL DEFAULT '',
    datos JSONB NOT NULL DEFAULT '{}', problemas JSONB NOT NULL DEFAULT '[]', lista BOOLEAN NOT NULL DEFAULT FALSE,
    resumen_correo TEXT NOT NULL DEFAULT '', estado TEXT NOT NULL DEFAULT 'pendiente', error TEXT NOT NULL DEFAULT '',
    creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), revisado_por TEXT NOT NULL DEFAULT '', revisado_en TIMESTAMPTZ,
    metodo_pago TEXT NOT NULL DEFAULT '', op_pago_id INTEGER)`);
}

async function guardarPropuesta(client, { clasificacionId, messageId, datos, problemas, lista, resumen, error }) {
  await client.query(`INSERT INTO facturas_pago (clasificacion_id, message_id, datos, problemas, lista, resumen_correo, estado, error)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (clasificacion_id) DO UPDATE SET datos = EXCLUDED.datos, problemas = EXCLUDED.problemas, lista = EXCLUDED.lista,
      resumen_correo = EXCLUDED.resumen_correo, error = EXCLUDED.error,
      estado = CASE WHEN facturas_pago.estado = 'registrada' THEN 'registrada' ELSE EXCLUDED.estado END`,
    [clasificacionId, messageId || '', JSON.stringify(datos || {}), JSON.stringify(problemas || []), !!lista, String(resumen || '').slice(0, 3000), error ? 'error' : 'pendiente', error || '']);
}

// Lee una factura con la IA y guarda la propuesta. Si la IA falla, guarda el error para reintentar.
async function leerFactura({ client, ia, claveIA, modelo, clasificacionId, correo }) {
  const resumen = String(correo.textPlain || '').replace(/\s+/g, ' ').slice(0, 3000);
  let respuesta;
  try {
    respuesta = await ia.llamarIA(claveIA, { model: modelo, max_tokens: 1500, messages: [{ role: 'user', content: promptFactura(correo) }] });
  } catch (e) {
    respuesta = { error: { message: e.message } };
  }
  if (!respuesta || respuesta.error) {
    const e = respuesta && respuesta.error;
    const detalle = typeof e === 'string' ? e : ((e && e.message) || 'sin respuesta de la IA');
    await guardarPropuesta(client, { clasificacionId, messageId: correo.id, resumen, error: 'La IA no pudo leer la factura: ' + detalle.slice(0, 250) });
    return { ok: false };
  }
  const texto = (respuesta.choices && respuesta.choices[0] && respuesta.choices[0].message && respuesta.choices[0].message.content) || '';
  const datos = parseFactura(texto);
  if (datos.error) {
    await guardarPropuesta(client, { clasificacionId, messageId: correo.id, resumen, error: datos.error });
    return { ok: false };
  }
  const v = validarFactura(datos);
  await guardarPropuesta(client, { clasificacionId, messageId: correo.id, datos, problemas: v.problemas, lista: v.listaParaRegistrar, resumen });
  return { ok: true, datos, ...v };
}

// ---------- Rutas de la pantalla de facturas (/api/facturas) ----------
// Confirmar registra el pago en Operaciones igual que un pago manual (con su recibo).
async function llamarOperaciones(operaciones, u, puede, ruta, cuerpo) {
  const res = { writeHead(code) { this.code = code; }, setHeader() {}, end(b) { this.body = b; } };
  let salida = null;
  await operaciones.manejar({ method: 'POST', url: ruta, headers: {} }, res, ruta, u, {
    json: (r, code, obj) => { salida = { code, obj }; }, leerCuerpo: async () => cuerpo, puede
  });
  return salida || { code: 500, obj: { error: 'Operaciones no respondió.' } };
}

async function manejarFacturas(req, res, url, u, { json, leerCuerpo, puede, client, operaciones, motor }) {
  if (!u) return json(res, 401, { error: 'Entra al panel para ver las facturas.' });
  const puedeVer = u.grupo === 'Programador' || puede('ver_pagos');
  if (!puedeVer) return json(res, 403, { error: 'Necesitas el permiso «Ver pagos» para ver las facturas.' });
  const p = new URL(req.url, 'http://localhost').searchParams;
  const txt = (v, max) => String(v ?? '').trim().slice(0, max);

  if (req.method === 'GET' && url === '/api/facturas') {
    const estado = ['pendiente', 'registrada', 'rechazada', 'error'].includes(p.get('estado')) ? p.get('estado') : 'pendiente';
    const filas = (await client.query(`SELECT f.id, f.estado, f.lista, f.problemas, f.datos, f.error, f.creado, f.metodo_pago, f.op_pago_id,
        c.remitente, c.asunto, c.fecha, c.id AS clasificacion_id
      FROM facturas_pago f JOIN clasificacion c ON c.id = f.clasificacion_id WHERE f.estado = $1 ORDER BY f.creado DESC LIMIT 200`, [estado])).rows;
    const agencias = (await client.query('SELECT nombre FROM op_agencias ORDER BY nombre')).rows.map(x => x.nombre);
    const contar = (await client.query('SELECT estado, COUNT(*)::int AS n FROM facturas_pago GROUP BY estado')).rows;
    return json(res, 200, { facturas: filas, agencias, metodos: METODOS_PAGO, monedas: MONEDAS, sedes: SEDES, conteo: Object.fromEntries(contar.map(x => [x.estado, x.n])) });
  }

  if (req.method === 'GET' && url === '/api/facturas/detalle') {
    const f = (await client.query(`SELECT f.*, c.remitente, c.asunto, c.fecha FROM facturas_pago f JOIN clasificacion c ON c.id = f.clasificacion_id WHERE f.id = $1`, [Number(p.get('id')) || 0])).rows[0];
    if (!f) return json(res, 404, { error: 'Esa factura ya no existe.' });
    return json(res, 200, f);
  }

  if (req.method === 'POST' && url === '/api/facturas/leer-pendientes') {
    if (!motor) return json(res, 500, { error: 'El motor de correo no está disponible.' });
    const r = await motor.leerFacturasPendientes(20);
    return json(res, 200, { ok: true, ...r });
  }

  if (req.method === 'POST' && url === '/api/facturas/rechazar') {
    const f = await leerCuerpo(req);
    const motivo = txt(f.motivo, 300);
    if (!motivo) return json(res, 400, { error: 'Escribe por qué la rechazas.' });
    const r = await client.query(`UPDATE facturas_pago SET estado = 'rechazada', error = $2, revisado_por = $3, revisado_en = NOW()
      WHERE id = $1 AND estado <> 'registrada' RETURNING id`, [Number(f.id) || 0, motivo, u.usuario]);
    if (!r.rowCount) return json(res, 400, { error: 'Esa factura ya se registró o no existe.' });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url === '/api/facturas/confirmar') {
    const f = await leerCuerpo(req);
    const agencia = txt(f.agencia, 120);
    const monto = Math.round(Number(f.monto || 0) * 100) / 100;
    const metodo = txt(f.metodo_pago, 40);
    const pagos = (Array.isArray(f.pagos) ? f.pagos : []).map(x => ({ reserva: String(Number(x.reserva) || 0), monto: Math.round(Number(x.monto || 0) * 100) / 100 }));
    if (!metodo || !METODOS_PAGO.includes(metodo)) return json(res, 400, { error: 'Elige de dónde pagó: ' + METODOS_PAGO.join(', ') + '.' });
    if (!agencia) return json(res, 400, { error: 'Escribe la agencia que paga.' });
    if (!(monto > 0)) return json(res, 400, { error: 'El monto tiene que ser mayor que cero.' });
    if (!pagos.length) return json(res, 400, { error: 'Pon cada reserva que se paga y cuánto va a cada una.' });
    const suma = Math.round(pagos.reduce((a, x) => a + x.monto, 0) * 100) / 100;
    if (Math.abs(suma - monto) > 0.009) return json(res, 400, { error: `Lo que repartes (US$ ${suma.toFixed(2)}) no cuadra con el monto de la factura (US$ ${monto.toFixed(2)}).` });
    const factura = (await client.query(`SELECT * FROM facturas_pago WHERE id = $1`, [Number(f.id) || 0])).rows[0];
    if (!factura) return json(res, 404, { error: 'Esa factura ya no existe.' });
    if (factura.estado === 'registrada') return json(res, 400, { error: 'Esta factura ya está registrada.' });

    // Agencia: si no existe, se crea solo si la persona lo marcó.
    const existe = (await client.query('SELECT 1 FROM op_agencias WHERE lower(nombre) = lower($1)', [agencia])).rowCount;
    if (!existe) {
      if (!f.crear_agencia) return json(res, 400, { error: `La agencia «${agencia}» no existe. Marca «crear agencia» para crearla.` });
      await client.query(`INSERT INTO op_agencias (nombre) VALUES ($1)`, [agencia]);
    }
    const nota = [txt(f.paquete, 120) && 'Paquete: ' + txt(f.paquete, 120), txt(f.tipo_reserva, 30) && 'Tipo: ' + txt(f.tipo_reserva, 30), txt(f.sede, 30) && 'Sede: ' + txt(f.sede, 30), txt(f.moneda, 5) && 'Moneda: ' + txt(f.moneda, 5), txt(f.notas, 200)].filter(Boolean).join(' · ');
    const pago = await llamarOperaciones(operaciones, u, puede, '/api/op/cobros/pago', {
      agencia, pagos, metodo, referencia: txt(f.referencia, 80), fecha: /^\d{4}-\d{2}-\d{2}$/.test(String(f.fecha_pago || '')) ? f.fecha_pago : '', nota: nota.slice(0, 200)
    });
    if (pago.code !== 200) return json(res, pago.code || 400, { error: pago.obj.error || 'Operaciones no pudo registrar el pago.' });
    await client.query(`UPDATE facturas_pago SET estado = 'registrada', metodo_pago = $2, op_pago_id = $3, datos = $4, revisado_por = $5, revisado_en = NOW(), error = '' WHERE id = $1`,
      [factura.id, metodo, pago.obj.id, JSON.stringify({ ...(factura.datos || {}), agencia, monto, moneda: txt(f.moneda, 5), referencia: txt(f.referencia, 80), paquete: txt(f.paquete, 120), tipo_reserva: txt(f.tipo_reserva, 30), sede: txt(f.sede, 30), reservas: pagos.map(x => x.reserva), fecha_pago: f.fecha_pago || '', notas: txt(f.notas, 300), metodo_pago: metodo }), u.usuario]);
    return json(res, 200, { ok: true, recibo: pago.obj.numero, id: pago.obj.id });
  }

  return json(res, 404, { error: 'No existe esa ruta de facturas.' });
}

module.exports = { promptFactura, parseFactura, validarFactura, preparar, guardarPropuesta, leerFactura, manejarFacturas, METODOS_PAGO, MONEDAS, SEDES };
