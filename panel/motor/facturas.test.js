// Pruebas de la lectura de facturas (sin IA real: se usan respuestas de ejemplo).
// Ejecutar: node --test motor/facturas.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { promptFactura, parseFactura, validarFactura } = require('./facturas.js');

const buena = {
  es_factura: true, agencia: 'Viator', monto: '1,250.50', moneda: 'usd', referencia: 'TRF-88421',
  reservas: ['14872', '1893', '14872', 'abc'], paquete: 'Orlando', tipo_reserva: 'Paquete',
  sede: 'Orlando', fecha_pago: '2026-11-20', notas: 'Pago parcial', confianza: 'alta'
};

test('el prompt pide JSON con las claves exactas y trae el correo', () => {
  const p = promptFactura({ subject: 'Pago factura', from: 'viator@x.com', textPlain: 'Pagamos US$ 500 por las reservas 14872 y 1893' });
  for (const clave of ['es_factura', 'agencia', 'monto', 'moneda', 'referencia', 'reservas', 'paquete', 'tipo_reserva', 'sede', 'fecha_pago', 'confianza']) {
    assert.ok(p.includes(`"${clave}"`), 'falta la clave ' + clave);
  }
  assert.ok(p.includes('Pagamos US$ 500'));
  assert.ok(p.includes('SOLO con un objeto JSON'));
});

test('lee la respuesta aunque venga con ``` y texto alrededor', () => {
  const r = parseFactura('Aquí están los datos:\n```json\n' + JSON.stringify(buena) + '\n```\nListo.');
  assert.equal(r.agencia, 'Viator');
  assert.equal(r.monto, 1250.5);
  assert.equal(r.moneda, 'USD');
  assert.equal(r.sede, 'Orlando');
  assert.equal(r.fecha_pago, '2026-11-20');
});

test('quita reservas repetidas y las que no son números', () => {
  const r = parseFactura(JSON.stringify(buena));
  assert.deepEqual(r.reservas, ['14872', '1893']);
});

test('respuesta sin JSON o JSON roto: devuelve error, no datos', () => {
  assert.ok(parseFactura('no sé leer ese correo').error);
  assert.ok(parseFactura('{"agencia": "Viator", ').error);
});

test('valores raros se corrigen o se vacían', () => {
  const r = parseFactura(JSON.stringify({ ...buena, monto: 'gratis', moneda: 'XYZ', sede: 'Santo Domingo', fecha_pago: '20/11/2026', confianza: 'muy alta' }));
  assert.equal(r.monto, 0);
  assert.equal(r.moneda, 'XYZ');
  assert.equal(r.sede, '');
  assert.equal(r.fecha_pago, '');
  assert.equal(r.confianza, 'baja');
});

test('una factura completa se puede proponer para registrar', () => {
  const v = validarFactura(parseFactura(JSON.stringify(buena)));
  assert.deepEqual(v.problemas, []);
  assert.equal(v.listaParaRegistrar, true);
});

test('sin reserva no se propone: hay que elegirla a mano', () => {
  const v = validarFactura(parseFactura(JSON.stringify({ ...buena, reservas: [] })));
  assert.equal(v.listaParaRegistrar, false);
  assert.ok(v.problemas.some(p => /elegir la reserva a mano/.test(p)));
});

test('sin monto o sin agencia no se propone', () => {
  assert.equal(validarFactura(parseFactura(JSON.stringify({ ...buena, monto: 0 }))).listaParaRegistrar, false);
  assert.equal(validarFactura(parseFactura(JSON.stringify({ ...buena, agencia: '' }))).listaParaRegistrar, false);
});

test('un correo que no es factura se marca así', () => {
  const v = validarFactura(parseFactura(JSON.stringify({ ...buena, es_factura: false })));
  assert.equal(v.listaParaRegistrar, false);
  assert.ok(v.problemas.some(p => /no la reconoce/.test(p)));
});

test('confianza baja avisa, pero no bloquea si los datos están', () => {
  const v = validarFactura(parseFactura(JSON.stringify({ ...buena, confianza: 'baja' })));
  assert.ok(v.problemas.some(p => /poca seguridad/.test(p)));
  assert.equal(v.listaParaRegistrar, true);
});

// ---------- Rutas nuevas: ver la factura de un correo y leerla con la IA ----------
const { manejarFacturas } = require('./facturas.js');
function fakeRes() { return { code: 0, body: null }; }
function jsonFalso(res, code, obj) { res.code = code; res.body = obj; }
function cliente(filas) {
  return { async query(sql, params) {
    for (const [trozo, respuesta] of filas) if (sql.includes(trozo)) return { rows: typeof respuesta === 'function' ? respuesta(params) : respuesta, rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
}
const usuario = { usuario: 'ana', grupo: 'Programador' };
const todo = () => true;

test('ver la factura de un correo: sin leer todavía', async () => {
  const res = fakeRes();
  const client = cliente([['FROM clasificacion WHERE id', [{ id: 7, categoria: 'FACTURA' }]], ['FROM facturas_pago WHERE clasificacion_id', []]]);
  await manejarFacturas({ method: 'GET', url: '/api/facturas/por-correo?clasificacion_id=7' }, res, '/api/facturas/por-correo', usuario,
    { json: jsonFalso, leerCuerpo: null, puede: todo, client, operaciones: null, motor: null });
  assert.equal(res.code, 200);
  assert.equal(res.body.categoria, 'FACTURA');
  assert.equal(res.body.factura, null);
});

test('ver la factura de un correo: devuelve la propuesta guardada', async () => {
  const res = fakeRes();
  const fila = { id: 3, estado: 'pendiente', lista: true, problemas: [], datos: { agencia: 'Viator', monto: 500, moneda: 'USD', reservas: ['14872'] } };
  const client = cliente([['FROM clasificacion WHERE id', [{ id: 7, categoria: 'FACTURA' }]], ['FROM facturas_pago WHERE clasificacion_id', [fila]]]);
  await manejarFacturas({ method: 'GET', url: '/api/facturas/por-correo?clasificacion_id=7' }, res, '/api/facturas/por-correo', usuario,
    { json: jsonFalso, leerCuerpo: null, puede: todo, client, operaciones: null, motor: null });
  assert.equal(res.body.factura.datos.agencia, 'Viator');
});

test('leer con IA: si la IA falla, muestra el motivo y no inventa datos', async () => {
  const res = fakeRes();
  const motor = { leerUnaFactura: async () => ({ ok: false }) };
  const client = cliente([['SELECT estado FROM facturas_pago', []], ['SELECT error FROM facturas_pago', [{ error: 'La IA no pudo leer la factura: sin respuesta' }]]]);
  await manejarFacturas({ method: 'POST', url: '/api/facturas/leer' }, res, '/api/facturas/leer', usuario,
    { json: jsonFalso, leerCuerpo: async () => ({ clasificacion_id: 7 }), puede: todo, client, operaciones: null, motor });
  assert.equal(res.code, 422);
  assert.match(res.body.error, /sin respuesta/);
});

test('leer con IA: si todo sale bien, responde con la propuesta', async () => {
  const res = fakeRes();
  const motor = { leerUnaFactura: async () => ({ ok: true, lista: true, problemas: [] }) };
  const client = cliente([]);
  await manejarFacturas({ method: 'POST', url: '/api/facturas/leer' }, res, '/api/facturas/leer', usuario,
    { json: jsonFalso, leerCuerpo: async () => ({ clasificacion_id: 7 }), puede: todo, client, operaciones: null, motor });
  assert.equal(res.code, 200);
  assert.equal(res.body.lista, true);
});

test('una factura ya registrada no se vuelve a leer', async () => {
  const res = fakeRes();
  let llamado = false;
  const motor = { leerUnaFactura: async () => { llamado = true; return { ok: true }; } };
  const client = cliente([['SELECT estado FROM facturas_pago', [{ estado: 'registrada' }]]]);
  await manejarFacturas({ method: 'POST', url: '/api/facturas/leer' }, res, '/api/facturas/leer', usuario,
    { json: jsonFalso, leerCuerpo: async () => ({ clasificacion_id: 7 }), puede: todo, client, operaciones: null, motor });
  assert.equal(res.code, 400);
  assert.equal(llamado, false);
});
