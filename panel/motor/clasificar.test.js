// Pruebas de la clasificación del motor (sin IA real: se usan respuestas de ejemplo).
// Ejecutar: node --test motor/clasificar.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('./clasificar.js');

const correo = { id: 'm1', from: 'agencia@x.com', subject: 'Re: confirmacion trf pax: Sebastian Lopez x 3 - Nov', date: '2026-11-13T10:00:00Z', textPlain: 'Pax 3', buzon: 'operaciones@x.com' };
const respuesta = json => ({ choices: [{ message: { content: JSON.stringify(json) } }] });

test('paxDeAsunto saca la cantidad del asunto', () => {
  assert.equal(c.paxDeAsunto('Re: confirmacion trf pax: Sebastian Lopez x 3 - Nov'), 3);
  assert.equal(c.paxDeAsunto('PAX MEDINA JUAN X 09'), 9);
  assert.equal(c.paxDeAsunto('Reserva sin cantidad'), 0);
});

test('pasajeros en 0: se toman de los servicios', () => {
  const r = respuesta({ categoria: 'RESERVA', agencia: 'Vacaciones', clientes: ['Sebastian Lopez'], pax: { adultos: 0, ninos: 0, infantes: 0 },
    servicios: [{ tipo_servicio: 'IN', pax: { adultos: 2, ninos: 0, infantes: 0 }, fecha_servicio: '2026-11-21' }] });
  const filas = c.filasDesdeRespuesta(correo, r);
  assert.equal(filas[0].adultos, 2);
});

test('pasajeros en 0 y servicios sin pax: se toman del asunto', () => {
  const r = respuesta({ categoria: 'RESERVA', agencia: 'Vacaciones', clientes: ['Sebastian Lopez'], pax: { adultos: 0 }, servicios: [{ tipo_servicio: 'IN', fecha_servicio: '2026-11-21' }] });
  const filas = c.filasDesdeRespuesta(correo, r);
  assert.equal(filas[0].adultos, 3);
});

test('si la IA sí da pasajeros, se respetan', () => {
  const r = respuesta({ categoria: 'RESERVA', pax: { adultos: 3, ninos: 1, infantes: 0 }, servicios: [{ tipo_servicio: 'IN' }] });
  const filas = c.filasDesdeRespuesta(correo, r);
  assert.equal(filas[0].adultos, 3);
  assert.equal(filas[0].ninos, 1);
});

test('esNoEntendido reconoce la respuesta que no entendió el correo', () => {
  assert.equal(c.esNoEntendido(respuesta({ categoria: 'NO_ENTENDIDO' })), true);
  assert.equal(c.esNoEntendido(respuesta({ categoria: 'MODIFICACION' })), false);
  assert.equal(c.esNoEntendido({ error: { message: 'x' } }), false);
});

test('normalizarComparacion: vuelo sin ceros a la izquierda y el resto sin tildes ni signos', () => {
  assert.equal(c.normalizarComparacion('vuelo', 'AV 0129'), c.normalizarComparacion('vuelo', 'AV 129'));
  assert.notEqual(c.normalizarComparacion('vuelo', 'CM 463'), c.normalizarComparacion('vuelo', 'CM 128'));
  assert.equal(c.normalizarComparacion('hotel', 'Hotel Club Punta Cana'), c.normalizarComparacion('hotel', 'hotel club punta cana'));
  assert.equal(c.normalizarComparacion('nombre_cliente', 'Sebastián López'), c.normalizarComparacion('nombre_cliente', 'Sebastian Lopez'));
});
