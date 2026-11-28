// Caja de cada administración (Kaizen IA / Zentralia): un libro de movimientos con las reglas del dueño.
//  - Entradas: cada cobro pagado con voucher (lo que llegó).
//  - Gastos: «creación del sistema», «gasto mensual» o «gasto del negocio». Nunca se mezclan.
//  - Reparto AUTOMÁTICO: utilidad = cobrado − gastos (− el fondo que el dueño quiera dejar en la empresa).
//    A cada socio le toca su % de la utilidad; lo que retiró se le descuenta; puede retirar lo suyo hasta lo que haya en caja.
//  - Si un gasto llega cuando la empresa está en 0, sale de la parte que aún no retiró un socio (le «presta» a la empresa);
//    con el próximo cobro se le devuelve primero y lo que sobra se reparte. El cálculo acumulado hace eso solo:
//    ej. entran 2,000, gastos 1,000 → 600/400; José retira 400; emergencia 300 → Cristian 420 (puede retirar 300, lo que hay),
//    José debe 120; entra 1,000 → Cristian 1,020, José 280. Quien retiró de más queda debiendo y no retira hasta cubrirlo.
// Reglas completas: memoria/MEMORIA-PROYECTO.md y memoria/PLAN-CAJA.md.

const TIPOS = {
  entrada: 'Entrada', gasto_creacion: 'Creación del sistema', gasto_mensual: 'Gasto mensual', gasto_negocio: 'Gasto del negocio',
  retiro: 'Retiro de socio'
};
const r2 = n => Math.round((Number(n) || 0) * 100) / 100 || 0;
// Socios: [{ clave, nombre, pct }] (los % suman 100). Por compatibilidad, un número es el % del socio (el dueño tiene el resto).
function sociosDe(s) {
  if (Array.isArray(s) && s.length) return s.map(x => ({ clave: String(x.clave), nombre: x.nombre || '', pct: Number(x.pct) || 0 }));
  const p = Number(s) || 0;
  return p > 0 ? [{ clave: 'dueno', nombre: '', pct: 100 - p }, { clave: 'socio', nombre: '', pct: p }] : [{ clave: 'dueno', nombre: '', pct: 100 }];
}

// ---------- Cálculo puro (sin base de datos; se prueba en caja.test.js) ----------
function calcular(movs, sociosEntrada, opc = {}) {
  const socios = sociosDe(sociosEntrada);
  const cero = () => Object.fromEntries(socios.map(x => [x.clave, 0]));
  const e = { socios, entradas: 0, creacion: 0, mensuales: 0, negocio: 0, retiros: cero(), caja: 0 };
  for (const m of movs) {
    const monto = r2(m.monto);
    if (m.tipo === 'entrada') { e.entradas = r2(e.entradas + monto); e.caja = r2(e.caja + monto); }
    else if (String(m.tipo).startsWith('gasto_')) {
      if (m.tipo === 'gasto_creacion') e.creacion = r2(e.creacion + monto);
      else if (m.tipo === 'gasto_negocio') e.negocio = r2(e.negocio + monto);
      else e.mensuales = r2(e.mensuales + monto);
      e.caja = r2(e.caja - monto);
    } else if (m.tipo === 'retiro') {
      if (!(m.socio in e.retiros)) e.retiros[m.socio] = 0;   // socio que ya no está: se sigue viendo lo que retiró
      e.retiros[m.socio] = r2(e.retiros[m.socio] + monto);
      e.caja = r2(e.caja - monto);
    }
    // «reparto» y «prestamo» de la versión anterior ya no hacen falta: el reparto es automático.
  }
  e.gastos = r2(e.creacion + e.mensuales + e.negocio);
  e.reserva = r2(Math.max(0, Number(opc.reserva) || 0));
  e.utilidad = r2(e.entradas - e.gastos - e.reserva);
  e.toca = {}; e.disponible = {}; e.debe = {}; e.puedeRetirar = {};
  let repartido = 0;
  socios.forEach((s, i) => {
    const t = i === socios.length - 1 ? r2(e.utilidad - repartido) : r2(e.utilidad * s.pct / 100);
    repartido = r2(repartido + t);
    e.toca[s.clave] = t;
  });
  const cajaLibre = r2(e.caja - e.reserva);
  for (const s of socios) {
    const d = r2(e.toca[s.clave] - (e.retiros[s.clave] || 0));
    e.disponible[s.clave] = d;
    e.debe[s.clave] = d < 0 ? r2(-d) : 0;
    e.puedeRetirar[s.clave] = d <= 0 ? 0 : r2(Math.max(0, Math.min(d, cajaLibre)));
  }
  // Lo que un socio tiene pero no puede sacar todavía porque la caja no alcanza (lo cubrió prestando a la empresa).
  e.porCobrar = Object.fromEntries(socios.map(s => [s.clave, r2(Math.max(0, e.disponible[s.clave]) - e.puedeRetirar[s.clave])]));
  return e;
}

// Revisa un movimiento nuevo contra el estado actual. Devuelve el texto del error o ''.
function revisar(e, m) {
  const monto = r2(m.monto);
  if (!(monto > 0)) return 'El monto debe ser mayor que 0.';
  if (String(m.tipo).startsWith('gasto_')) return '';
  if (m.tipo === 'retiro') {
    if (!(m.socio in e.toca)) return 'Elige quién retira.';
    if (e.debe[m.socio] > 0) return `Retiró ${e.debe[m.socio].toFixed(2)} más de lo que le toca: no puede retirar hasta que se cubra con los próximos cobros.`;
    if (monto > e.puedeRetirar[m.socio]) return `Solo puede retirar ${e.puedeRetirar[m.socio].toFixed(2)} (su parte y lo que hay en caja).`;
    return '';
  }
  return 'Tipo de movimiento no válido.';
}

module.exports = { calcular, revisar, sociosDe, TIPOS };
