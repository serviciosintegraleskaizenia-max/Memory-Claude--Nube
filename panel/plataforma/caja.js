// Caja de cada administración (Kaizen IA / Zentralia): un libro de movimientos con las reglas del dueño.
//  - Entradas: cada cobro pagado (se toma solo de Clientes y cobros, por lo que realmente llegó).
//  - Gastos: «creación del sistema» o «gasto mensual», cargados a un plan o a General. Nunca se mezclan.
//  - Reparto: de lo que queda (el fondo de la empresa) se decide cuánto se reparte; lo repartido es de cada socio (regla de oro).
//  - Retiros: hasta su parte libre y hasta lo que hay en caja; cada uno con su recibo (también los del dueño).
//  - Préstamos: si el fondo no alcanza para un gasto, un socio presta de su parte (con su autorización) y otro le queda debiendo.
//    En el próximo reparto, primero se cobra la deuda de la parte del que debe; lo que no alcance se sigue debiendo.
// Reglas completas: memoria/MEMORIA-PROYECTO.md y memoria/PLAN-CAJA.md.

const TIPOS = {
  entrada: 'Entrada', gasto_creacion: 'Creación del sistema', gasto_mensual: 'Gasto mensual', gasto_negocio: 'Gasto del negocio',
  reparto: 'Reparto', retiro: 'Retiro de socio'
};
const SOCIOS = ['dueno', 'socio'];
const r2 = n => Math.round((Number(n) || 0) * 100) / 100 || 0;

// ---------- Cálculo puro (sin base de datos; se prueba en caja.test.js) ----------
// movs: [{ tipo, monto, socio, detalle }] en orden. pct: porcentaje del socio (0 a 100).
function calcular(movs, pct) {
  const e = {
    entradas: 0, creacion: 0, mensuales: 0, negocio: 0, retiros: { dueno: 0, socio: 0 }, repartido: { dueno: 0, socio: 0 },
    libre: { dueno: 0, socio: 0 }, caja: 0, deudas: [], prestado: { dueno: 0, socio: 0 }
  };
  for (const m of movs) {
    const monto = r2(m.monto);
    const d = m.detalle || {};
    if (m.tipo === 'entrada') { e.entradas = r2(e.entradas + monto); e.caja = r2(e.caja + monto); }
    else if (String(m.tipo).startsWith('gasto_')) {
      if (m.tipo === 'gasto_creacion') e.creacion = r2(e.creacion + monto);
      else if (m.tipo === 'gasto_negocio') e.negocio = r2(e.negocio + monto);
      else e.mensuales = r2(e.mensuales + monto);
      e.caja = r2(e.caja - monto);
      for (const p of d.prestamos || []) {
        const pm = r2(p.monto);
        if (!(pm > 0) || !SOCIOS.includes(p.presta)) continue;
        e.libre[p.presta] = r2(e.libre[p.presta] - pm);
        e.prestado[p.presta] = r2(e.prestado[p.presta] + pm);
        e.deudas.push({ presta: p.presta, debe: p.debe, saldo: pm, concepto: m.concepto || '' });
      }
    } else if (m.tipo === 'reparto') {
      const parte = { socio: r2(monto * pct / 100) };
      parte.dueno = r2(monto - parte.socio);
      e.repartido.dueno = r2(e.repartido.dueno + parte.dueno);
      e.repartido.socio = r2(e.repartido.socio + parte.socio);
      // Primero se cobran las deudas de la parte del que debe.
      for (const deuda of e.deudas) {
        if (!(deuda.saldo > 0) || !SOCIOS.includes(deuda.debe)) continue;
        const paga = r2(Math.min(deuda.saldo, parte[deuda.debe]));
        parte[deuda.debe] = r2(parte[deuda.debe] - paga);
        parte[deuda.presta] = r2(parte[deuda.presta] + paga);
        deuda.saldo = r2(deuda.saldo - paga);
      }
      e.libre.dueno = r2(e.libre.dueno + parte.dueno);
      e.libre.socio = r2(e.libre.socio + parte.socio);
    } else if (m.tipo === 'retiro' && SOCIOS.includes(m.socio)) {
      e.retiros[m.socio] = r2(e.retiros[m.socio] + monto);
      e.libre[m.socio] = r2(e.libre[m.socio] - monto);
      e.caja = r2(e.caja - monto);
    }
  }
  e.deudas = e.deudas.filter(x => x.saldo > 0);
  e.debe = { dueno: r2(e.deudas.filter(x => x.debe === 'dueno').reduce((t, x) => t + x.saldo, 0)), socio: r2(e.deudas.filter(x => x.debe === 'socio').reduce((t, x) => t + x.saldo, 0)) };
  e.gastos = r2(e.creacion + e.mensuales + e.negocio);
  e.fondo = r2(e.caja - e.libre.dueno - e.libre.socio);
  e.puedeRetirar = {
    dueno: e.debe.dueno > 0 ? 0 : r2(Math.max(0, Math.min(e.libre.dueno, e.caja))),
    socio: e.debe.socio > 0 ? 0 : r2(Math.max(0, Math.min(e.libre.socio, e.caja)))
  };
  return e;
}

// Revisa un movimiento nuevo contra el estado actual. Devuelve el texto del error o ''.
function revisar(e, m) {
  const monto = r2(m.monto);
  if (!(monto > 0)) return 'El monto debe ser mayor que 0.';
  if (String(m.tipo).startsWith('gasto_')) {
    const prestamos = (m.detalle && m.detalle.prestamos) || [];
    const prestado = r2(prestamos.reduce((t, p) => t + r2(p.monto), 0));
    for (const p of prestamos) {
      if (!SOCIOS.includes(p.presta) || !SOCIOS.includes(p.debe) || p.presta === p.debe) return 'Indica quién presta y quién le queda debiendo.';
      if (r2(p.monto) > r2(e.libre[p.presta])) return `No puede prestar más de lo que tiene libre (${r2(e.libre[p.presta]).toFixed(2)}).`;
    }
    const fondo = Math.max(0, e.fondo);
    if (r2(fondo + prestado) < monto) return `El fondo de la empresa tiene ${fondo.toFixed(2)}. Faltan ${r2(monto - fondo - prestado).toFixed(2)}: elige qué socio lo presta de su parte.`;
    if (monto > r2(e.caja)) return `En caja solo hay ${r2(e.caja).toFixed(2)}.`;
    return '';
  }
  if (m.tipo === 'reparto') {
    if (monto > r2(e.fondo)) return `Solo se puede repartir lo que hay en el fondo de la empresa (${r2(Math.max(0, e.fondo)).toFixed(2)}).`;
    return '';
  }
  if (m.tipo === 'retiro') {
    if (!SOCIOS.includes(m.socio)) return 'Elige quién retira.';
    if (e.debe[m.socio] > 0) return `Tiene una deuda de ${e.debe[m.socio].toFixed(2)} con su socio: no puede retirar hasta cubrirla.`;
    if (monto > e.puedeRetirar[m.socio]) return `Solo puede retirar ${e.puedeRetirar[m.socio].toFixed(2)} (su parte libre y lo que hay en caja).`;
    return '';
  }
  return 'Tipo de movimiento no válido.';
}

module.exports = { calcular, revisar, TIPOS, SOCIOS };
