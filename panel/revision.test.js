// Pruebas de las reglas de revisión: actividad, interhotel, crucero, IN/OUT y nombre del pasajero.
// Ejecutar: node --test panel/revision.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { revisarReservas } = require('./revision.js');

const base = { categoria: 'RESERVA', estado: 'pendiente de transcribir', error_ia: false, asunto: 'Re: reserva', fecha_servicio: '2026-12-02',
  hotel: 'Hotel Riu Bambu', adultos: 2, ninos: 0, infantes: 0, nombre_cliente: 'Ana Perez', telefono: '', vuelo: '', hora_servicio: '',
  aeropuerto: '', motivo: '', punto_partida: '', punto_llegada: '' };
const revisar = filas => revisarReservas(filas, { isoDe: f => f.fecha_servicio, claveDe: f => f.message_id, hoy: '2026-11-26' });
const textos = (filas) => (revisar(filas).get(filas[0].id) || { puntos: [] }).puntos.map(p => p.texto);

test('actividad sola: no pide vuelo, aeropuerto, hora ni telefono', () => {
  assert.deepEqual(textos([{ ...base, id: 1, message_id: 'A', tipo_servicio: 'ACTIVIDAD', actividad: 'Velero con tortugas', aeropuerto: 'N/A', vuelo: 'N/A' }]), []);
});
test('IN sin vuelo: debe pedir el vuelo', () => {
  assert.deepEqual(textos([{ ...base, id: 2, message_id: 'B', tipo_servicio: 'IN', aeropuerto: 'PUJ', hora_servicio: '14:00' }]), ['Falta el número de vuelo.']);
});
test('crucero: el puerto es el aeropuerto y no pide vuelo', () => {
  assert.deepEqual(textos([{ ...base, id: 3, message_id: 'C', tipo_servicio: 'IN', aeropuerto: 'Puerto de Puerto Plata', vuelo: 'N/A' }]), []);
});
test('interhotel: no pide vuelo', () => {
  assert.deepEqual(textos([{ ...base, id: 4, message_id: 'D', tipo_servicio: 'INTERHOTEL' }]), []);
});
test('sin nombre del pasajero: debe pedirlo', () => {
  assert.deepEqual(textos([{ ...base, id: 5, message_id: 'E', tipo_servicio: 'ACTIVIDAD', actividad: 'Isla Saona', nombre_cliente: '', aeropuerto: 'N/A', vuelo: 'N/A' }]), ['Falta el nombre del pasajero.']);
});
