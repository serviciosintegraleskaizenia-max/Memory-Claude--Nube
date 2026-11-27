// Reglas de la caja con los ejemplos del dueño (memoria/PLAN-CAJA.md). Se corre con: node --test plataforma/caja.test.js
const test = require('node:test');
const assert = require('node:assert');
const { calcular, revisar } = require('./caja');

test('ejemplo del dueño: emergencia prestada por Cristian después de que José retiró todo', () => {
  // Las entradas no se revisan: vienen de cobros pagados.
  const movs = [{ tipo: 'entrada', monto: 1000 }];
  const paso = m => { const err = revisar(calcular(movs, 40), m); assert.strictEqual(err, '', err); movs.push(m); };
  paso({ tipo: 'reparto', monto: 1000 });
  let e = calcular(movs, 40);
  assert.deepStrictEqual(e.libre, { dueno: 600, socio: 400 });
  paso({ tipo: 'retiro', socio: 'socio', monto: 400 });
  // Sin fondo: el gasto de 300 no puede salir si nadie presta.
  e = calcular(movs, 40);
  assert.match(revisar(e, { tipo: 'gasto_mensual', monto: 300 }), /Faltan 300/);
  paso({ tipo: 'gasto_mensual', monto: 300, concepto: 'Emergencia', detalle: { prestamos: [{ presta: 'dueno', debe: 'socio', monto: 300 }] } });
  e = calcular(movs, 40);
  assert.strictEqual(e.caja, 300);
  assert.strictEqual(e.debe.socio, 300);
  assert.strictEqual(e.puedeRetirar.socio, 0);
  movs.push({ tipo: 'entrada', monto: 750 });
  paso({ tipo: 'gasto_mensual', monto: 250, concepto: 'Gastos fijos' });
  e = calcular(movs, 40);
  assert.strictEqual(e.fondo, 500);
  paso({ tipo: 'reparto', monto: 500 });
  e = calcular(movs, 40);
  assert.strictEqual(e.libre.dueno, 800, 'Cristian: 300 del mes 1 + 300 de su parte + 200 cobrados a José');
  assert.strictEqual(e.libre.socio, 0);
  assert.strictEqual(e.debe.socio, 100, 'José sigue debiendo 100');
  assert.strictEqual(e.caja, 800);
  assert.strictEqual(e.fondo, 0);
  assert.match(revisar(e, { tipo: 'retiro', socio: 'socio', monto: 1 }), /deuda de 100/);
  assert.strictEqual(revisar(e, { tipo: 'retiro', socio: 'dueno', monto: 800 }), '');
  assert.match(revisar(e, { tipo: 'retiro', socio: 'dueno', monto: 800.01 }), /Solo puede retirar 800/);
});

test('nadie retira más de su parte ni adelantos del mes siguiente', () => {
  const movs = [{ tipo: 'entrada', monto: 1196.80 }, { tipo: 'reparto', monto: 1196.80 }];
  const e = calcular(movs, 40);
  assert.deepStrictEqual(e.libre, { dueno: 718.08, socio: 478.72 });
  assert.match(revisar(e, { tipo: 'retiro', socio: 'socio', monto: 500 }), /Solo puede retirar 478.72/);
  assert.strictEqual(revisar(e, { tipo: 'retiro', socio: 'socio', monto: 478.72 }), '');
});

test('el retiro de un socio no baja lo que se reparte; el gasto sí', () => {
  const movs = [{ tipo: 'entrada', monto: 1890 }, { tipo: 'gasto_creacion', monto: 693.20 }];
  let e = calcular(movs, 40);
  assert.strictEqual(e.fondo, 1196.80);
  movs.push({ tipo: 'reparto', monto: 1196.80 }, { tipo: 'retiro', socio: 'socio', monto: 478.72 });
  e = calcular(movs, 40);
  assert.strictEqual(e.caja, 718.08, 'en caja queda justo la parte de Cristian');
  assert.strictEqual(e.libre.dueno, 718.08);
  assert.strictEqual(e.fondo, 0);
});

test('se puede dejar parte como fondo de la empresa y las emergencias salen de ahí', () => {
  const movs = [{ tipo: 'entrada', monto: 1200 }, { tipo: 'reparto', monto: 1000 }];
  let e = calcular(movs, 40);
  assert.strictEqual(e.fondo, 200);
  assert.strictEqual(revisar(e, { tipo: 'gasto_mensual', monto: 150 }), '');
  movs.push({ tipo: 'gasto_mensual', monto: 150 });
  e = calcular(movs, 40);
  assert.deepStrictEqual(e.libre, { dueno: 600, socio: 400 }, 'la emergencia del fondo no toca lo repartido');
  assert.strictEqual(e.debe.socio, 0);
  assert.match(revisar(e, { tipo: 'reparto', monto: 100 }), /fondo de la empresa \(50.00\)/);
});

test('un préstamo no puede pasar de lo que el socio tiene libre', () => {
  const movs = [{ tipo: 'entrada', monto: 1000 }, { tipo: 'reparto', monto: 1000 }, { tipo: 'retiro', socio: 'dueno', monto: 500 }];
  const e = calcular(movs, 40);
  assert.match(revisar(e, { tipo: 'gasto_mensual', monto: 300, detalle: { prestamos: [{ presta: 'dueno', debe: 'socio', monto: 300 }] } }), /más de lo que tiene libre \(100.00\)/);
  assert.strictEqual(revisar(e, { tipo: 'gasto_mensual', monto: 300, detalle: { prestamos: [{ presta: 'socio', debe: 'dueno', monto: 300 }] } }), '');
});

test('números reales de Zentralia: adelantos anotados antes del reparto', () => {
  const movs = [
    { tipo: 'entrada', monto: 1890 },
    { tipo: 'gasto_creacion', monto: 978.20 }, { tipo: 'gasto_mensual', monto: 55 }, { tipo: 'gasto_negocio', monto: 55 },
    { tipo: 'retiro', socio: 'socio', monto: 109 }, { tipo: 'retiro', socio: 'socio', monto: 197 }, { tipo: 'retiro', socio: 'dueno', monto: 459 }
  ];
  let e = calcular(movs, 40);
  assert.strictEqual(e.gastos, 1088.20);
  assert.strictEqual(e.caja, 36.80);
  assert.strictEqual(e.fondo, 801.80, 'lo que queda para repartir, aunque ya hubo adelantos');
  movs.push({ tipo: 'reparto', monto: 801.80 });
  e = calcular(movs, 40);
  assert.strictEqual(e.repartido.dueno, 481.08);
  assert.strictEqual(e.repartido.socio, 320.72);
  assert.strictEqual(e.libre.dueno, 22.08);
  assert.strictEqual(e.libre.socio, 14.72);
  assert.strictEqual(e.fondo, 0);
  assert.match(revisar(e, { tipo: 'retiro', socio: 'socio', monto: 555 }), /Solo puede retirar 14.72/);
});
