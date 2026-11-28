// Reglas de la caja con los ejemplos del dueño (memoria/PLAN-CAJA.md). Se corre con: node --test plataforma/caja.test.js
const test = require('node:test');
const assert = require('node:assert');
const { calcular, revisar } = require('./caja');
const ZENTRALIA = [{ clave: 'dueno', nombre: 'Cristian Mundaray', pct: 60 }, { clave: 'socio', nombre: 'José Betancourt', pct: 40 }];

test('números reales de Zentralia: reparto automático con los adelantos', () => {
  const movs = [
    { tipo: 'entrada', monto: 1890 },
    { tipo: 'gasto_creacion', monto: 515 }, { tipo: 'gasto_mensual', monto: 422 }, { tipo: 'gasto_negocio', monto: 151.20 },
    { tipo: 'retiro', socio: 'socio', monto: 109 }, { tipo: 'retiro', socio: 'socio', monto: 197 }, { tipo: 'retiro', socio: 'dueno', monto: 459 }
  ];
  const e = calcular(movs, ZENTRALIA);
  assert.strictEqual(e.gastos, 1088.20);
  assert.strictEqual(e.utilidad, 801.80);
  assert.deepStrictEqual(e.toca, { dueno: 481.08, socio: 320.72 });
  assert.deepStrictEqual(e.disponible, { dueno: 22.08, socio: 14.72 });
  assert.strictEqual(e.caja, 36.80);
  assert.match(revisar(e, { tipo: 'retiro', socio: 'socio', monto: 555 }), /Solo puede retirar 14.72/);
  assert.strictEqual(revisar(e, { tipo: 'retiro', socio: 'socio', monto: 14.72 }), '');
});

test('regla del dueño: emergencia con la empresa en 0, se devuelve con el próximo cobro', () => {
  const movs = [{ tipo: 'entrada', monto: 2000 }, { tipo: 'gasto_creacion', monto: 1000 }];
  let e = calcular(movs, ZENTRALIA);
  assert.deepStrictEqual(e.toca, { dueno: 600, socio: 400 });
  movs.push({ tipo: 'retiro', socio: 'socio', monto: 400 });
  movs.push({ tipo: 'gasto_mensual', monto: 300 });   // emergencia: la empresa está en 0
  e = calcular(movs, ZENTRALIA);
  assert.strictEqual(e.caja, 300, 'quedan los 300 de Cristian');
  assert.strictEqual(e.puedeRetirar.dueno, 300);
  assert.strictEqual(e.debe.socio, 120, 'José retiró más de su parte después del gasto');
  assert.match(revisar(e, { tipo: 'retiro', socio: 'socio', monto: 1 }), /no puede retirar/);
  movs.push({ tipo: 'entrada', monto: 1000 });   // nuevo pago: primero se devuelve lo prestado y el resto se reparte
  e = calcular(movs, ZENTRALIA);
  assert.deepStrictEqual(e.toca, { dueno: 1020, socio: 680 });
  assert.deepStrictEqual(e.disponible, { dueno: 1020, socio: 280 });
  assert.strictEqual(e.caja, 1300);
});

test('nadie retira más de lo suyo ni más de lo que hay en caja', () => {
  const e = calcular([{ tipo: 'entrada', monto: 1000 }], ZENTRALIA);
  assert.match(revisar(e, { tipo: 'retiro', socio: 'socio', monto: 401 }), /Solo puede retirar 400/);
  assert.strictEqual(revisar(e, { tipo: 'retiro', socio: 'dueno', monto: 600 }), '');
});

test('fondo de la empresa: lo que se deja no se reparte', () => {
  const e = calcular([{ tipo: 'entrada', monto: 1200 }], ZENTRALIA, { reserva: 200 });
  assert.strictEqual(e.utilidad, 1000);
  assert.deepStrictEqual(e.toca, { dueno: 600, socio: 400 });
});

test('varios socios: los % suman 100 y nada se pierde por redondeo', () => {
  const tres = [{ clave: 'dueno', pct: 50 }, { clave: 'socio', pct: 33.33 }, { clave: 's3', pct: 16.67 }];
  const e = calcular([{ tipo: 'entrada', monto: 100.01 }], tres);
  const suma = Math.round(Object.values(e.toca).reduce((t, x) => t + x, 0) * 100) / 100;
  assert.strictEqual(suma, 100.01);
});
