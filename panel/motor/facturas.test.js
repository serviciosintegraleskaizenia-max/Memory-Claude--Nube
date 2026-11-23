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
