// Pruebas de las reglas del CRM que no tocan la base de datos.
// Ejecutar: node --test plataforma/crm.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crearCrm = require('./crm.js');

const { _probar: P } = crearCrm({
  client: { query: async () => ({ rows: [], rowCount: 0 }) },
  cuenta: { tiene: async () => true },
  registrar: async () => {}
});
const H = 3600e3;
const AHORA = Date.UTC(2026, 10, 23, 12, 0, 0);

test('prioridadDe: solo cuando la persona escribió después de nuestra última respuesta', () => {
  assert.equal(P.prioridadDe({ ultimo_entrante: null, ultimo_saliente: null }, AHORA), null);
  // Respondimos después de su último mensaje: ya no le toca a nadie.
  assert.equal(P.prioridadDe({ ultimo_entrante: new Date(AHORA - 5 * H), ultimo_saliente: new Date(AHORA - 1 * H) }, AHORA), null);
  // Escribió hace una hora: todavía no es prioridad.
  assert.equal(P.prioridadDe({ ultimo_entrante: new Date(AHORA - 1 * H), ultimo_saliente: null }, AHORA), null);
});

test('prioridadDe: niveles y texto de la antigüedad', () => {
  const tres = P.prioridadDe({ ultimo_entrante: new Date(AHORA - 3 * H), ultimo_saliente: null }, AHORA);
  assert.deepEqual([tres.motivo, tres.detalle, tres.nivel], ['Sin responder', '3 h', 'verde']);
  const diez = P.prioridadDe({ ultimo_entrante: new Date(AHORA - 10 * H), ultimo_saliente: null }, AHORA);
  assert.equal(diez.nivel, 'ambar');
  const dos = P.prioridadDe({ ultimo_entrante: new Date(AHORA - 50 * H), ultimo_saliente: null }, AHORA);
  assert.deepEqual([dos.detalle, dos.nivel], ['2 d', 'rojo']);
});

test('estadoAutoDe: te toca a ti tiene prioridad sobre la visita', () => {
  const esperando = { ultimo_entrante: new Date(AHORA - 4 * H), ultimo_saliente: null };
  assert.equal(P.estadoAutoDe(esperando, 1, AHORA), 'te_toca');
  assert.equal(P.estadoAutoDe({ ultimo_entrante: null, ultimo_saliente: null }, 1, AHORA), 'con_visita');
  assert.equal(P.estadoAutoDe({ ultimo_entrante: null, ultimo_saliente: null }, 0, AHORA), 'con_asistente');
});

test('etiquetasConAccion: lo llevo yo, devolver y publicidad', () => {
  assert.deepEqual(P.etiquetasConAccion(['cotizacion'], 'lo_llevo_yo'), ['cotizacion', 'lo llevo yo']);
  assert.deepEqual(P.etiquetasConAccion(['lo llevo yo', 'hotel'], 'devolver_asistente'), ['hotel']);
  assert.deepEqual(P.etiquetasConAccion(['publicidad'], 'es_publicidad'), ['publicidad']);
  assert.equal(P.etiquetasConAccion([], 'borrar_todo'), null);
  assert.equal(P.etiquetasConAccion(null, 'lo_llevo_yo').length, 1);
});

test('etiquetasConAccion: nunca pasa de 20 etiquetas', () => {
  const muchas = Array.from({ length: 20 }, (_, i) => 'e' + i);
  assert.equal(P.etiquetasConAccion(muchas, 'lo_llevo_yo').length, 20);
});

test('revisarPermitidos: normaliza, quita repetidos y acepta el formato con signos', () => {
  const r = P.revisarPermitidos(['+1 (809) 555-1234', '18095551234', ' +51 977 000 000 ']);
  assert.deepEqual(r, { numeros: ['18095551234', '51977000000'] });
});

test('revisarPermitidos: rechaza listas vacías, inválidas o de más de diez', () => {
  assert.ok(P.revisarPermitidos('+18095551234').error);
  assert.ok(P.revisarPermitidos([]).error);
  const mal = P.revisarPermitidos(['+18095551234', 'abc']);
  assert.equal(mal.indice, 1);
  assert.match(mal.error, /no es válido/);
  const muchos = Array.from({ length: 11 }, (_, i) => '+1809555' + String(1000 + i));
  assert.equal(P.revisarPermitidos(muchos).error, 'Como mucho 10 números.');
  assert.equal(P.MAX_PERMITIDOS, 10);
});

test('ACCIONES tiene exactamente las tres acciones de la ficha', () => {
  assert.deepEqual(Object.keys(P.ACCIONES).sort(), ['devolver_asistente', 'es_publicidad', 'lo_llevo_yo']);
});
