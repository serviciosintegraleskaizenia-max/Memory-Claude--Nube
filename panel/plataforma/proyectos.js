// Oficina → Gastos → "Creación del sistema": lo que costó crear cada sistema, el cobro al cliente,
// la comisión del banco, el reparto entre socios y los gastos mensuales de ahí en adelante.
// Tablas propias: no toca oficina_gastos ni los totales del Inicio.
const fs = require('fs');
const path = require('path');

const CATEGORIAS = { ia: 'IA y tokens', programacion: 'Programación', automatizacion: 'Automatización', chat: 'Chat y redes', servidor: 'Servidor', dominio: 'Dominio', adelanto: 'Adelanto de ganancia', otro: 'Otro' };
const FRECUENCIAS = { mensual: 'Cada mes', anual: 'Cada año', variable: 'Variable (estimado al mes)' };
// Datos iniciales opcionales (los del cuaderno). Viven solo en el servidor, nunca en el repositorio.
const SEMILLA = path.join(__dirname, '..', 'datos-iniciales', 'creacion-sistema.json');

module.exports = function crearProyectos({ client }) {
  const texto = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const monto = v => { const n = Math.round(Number(String(v ?? '').replace(',', '.')) * 100) / 100; return Number.isFinite(n) && n >= 0 ? n : 0; };
  const fecha = v => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const error = (m, codigo = 400) => Object.assign(new Error(m), { codigo });

  async function preparar() {
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_proyectos (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, cliente TEXT NOT NULL DEFAULT '', cobrado NUMERIC(12,2) NOT NULL DEFAULT 0,
      fecha_cobro DATE, comision_pct NUMERIC(6,2) NOT NULL DEFAULT 0, comision_nota TEXT NOT NULL DEFAULT '',
      socios JSONB NOT NULL DEFAULT '[]', nota TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_proyecto_gastos (
      id SERIAL PRIMARY KEY, proyecto_id INTEGER NOT NULL REFERENCES oficina_proyectos(id) ON DELETE CASCADE, fecha DATE,
      concepto TEXT NOT NULL, categoria VARCHAR(20) NOT NULL DEFAULT 'otro', monto NUMERIC(12,2) NOT NULL DEFAULT 0,
      pagado_por TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '')`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_proyecto_mensuales (
      id SERIAL PRIMARY KEY, proyecto_id INTEGER NOT NULL REFERENCES oficina_proyectos(id) ON DELETE CASCADE,
      concepto TEXT NOT NULL, categoria VARCHAR(20) NOT NULL DEFAULT 'otro', monto NUMERIC(12,2) NOT NULL DEFAULT 0,
      frecuencia VARCHAR(10) NOT NULL DEFAULT 'mensual', desde DATE, nota TEXT NOT NULL DEFAULT '', activo BOOLEAN NOT NULL DEFAULT TRUE,
      orden INTEGER NOT NULL DEFAULT 0)`);
    // Recargas de OpenRouter por cliente: solo para ver saldo y cuánto le dura (no se suman a los gastos del mes).
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_recargas_ia (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL, fecha DATE NOT NULL, monto NUMERIC(12,2) NOT NULL DEFAULT 0,
      nota TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // Para quién es cada gasto: null = todos los socios; número = índice del socio en la lista de socios.
    await client.query('ALTER TABLE oficina_proyecto_gastos ADD COLUMN IF NOT EXISTS para_socio INTEGER');
    // A qué administración pertenece cada sistema. Los que ya existían son de Somos Viajes (Zentralia App).
    await client.query("ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS administracion VARCHAR(20) NOT NULL DEFAULT 'centralia'");
    // Cliente, precio del programa, fechas de inicio y entrega, mensualidad y extras (API, software).
    await client.query('ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS empresa_id INTEGER');
    await client.query('ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS precio_total NUMERIC(12,2) NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS fecha_inicio DATE');
    await client.query('ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS fecha_entrega DATE');
    await client.query('ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS cuota_mensual NUMERIC(12,2) NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS dia_cobro INTEGER NOT NULL DEFAULT 5');
    await client.query("ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS extras JSONB NOT NULL DEFAULT '[]'::jsonb");
    // Tipo de programa (Operaciones, Panel de correos, CRM, Automatización, Meta, otro) y horas de trabajo.
    await client.query("ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT ''");
    await client.query('ALTER TABLE oficina_proyectos ADD COLUMN IF NOT EXISTS horas NUMERIC(10,2) NOT NULL DEFAULT 0');
    // Notas viejas de n8n y Chatwoot: quedan como gasto que se paga cada mes.
    await client.query("UPDATE oficina_proyecto_mensuales SET nota = 'Se paga cada mes.' WHERE nota LIKE 'Ya no hace falta:%'");
    await client.query("UPDATE oficina_proyecto_mensuales SET concepto = 'n8n Pro' WHERE concepto = 'n8n Pro (en la nube)'");
    await client.query("UPDATE oficina_proyecto_mensuales SET concepto = 'Chatwoot (chatbot)' WHERE concepto = 'Chatwoot (en la nube)'");
    await importarSemilla();
  }

  // Si existe datos-iniciales/creacion-sistema.json y todavía no hay proyectos, lo carga una vez y lo renombra.
  async function importarSemilla() {
    if (!fs.existsSync(SEMILLA)) return;
    if ((await client.query('SELECT 1 FROM oficina_proyectos LIMIT 1')).rowCount) return;
    try {
      const d = JSON.parse(fs.readFileSync(SEMILLA, 'utf8'));
      for (const p of Array.isArray(d.proyectos) ? d.proyectos : []) {
        const id = await guardarProyecto(p);
        for (const g of p.gastos || []) await guardarGasto({ ...g, proyecto_id: id });
        let i = 0;
        for (const m of p.mensuales || []) await guardarMensual({ ...m, proyecto_id: id, orden: i++ });
      }
      // Recargas de OpenRouter: el cliente se busca por su nombre o slug.
      for (const r of Array.isArray(d.recargas) ? d.recargas : []) {
        const e = (await client.query('SELECT id FROM empresas WHERE slug = $1 OR lower(nombre) LIKE lower($2) ORDER BY id LIMIT 1', [String(r.cliente || ''), '%' + String(r.cliente || '') + '%'])).rows[0];
        if (e) await guardarRecarga({ ...r, empresa_id: e.id });
      }
      fs.renameSync(SEMILLA, SEMILLA + '.importado');
      console.log('Oficina: gastos de creación del sistema importados.');
    } catch (e) { console.error('Oficina: no se pudo importar creacion-sistema.json:', e.message); }
  }

  async function guardarProyecto(f) {
    const socios = (Array.isArray(f.socios) ? f.socios : []).map(s => ({ nombre: texto(s.nombre, 60), pct: monto(s.pct) })).filter(s => s.nombre).slice(0, 6);
    const suma = socios.reduce((a, s) => a + s.pct, 0);
    if (socios.length && Math.abs(suma - 100) > 0.01) throw error(`Los porcentajes de los socios suman ${suma} %: deben sumar 100 %.`);
    const adm = ['kaizen', 'centralia'].includes(f.administracion) ? f.administracion : 'centralia';
    const nombre = texto(f.nombre, 120);
    if (!nombre) throw error('Escribe el nombre del programa (ej.: Panel de reservas · Somos Viajes).');
    const empresaId = Number(f.empresa_id) || null;
    let cliente = texto(f.cliente, 120);
    if (empresaId) {
      const e = (await client.query('SELECT nombre FROM empresas WHERE id = $1', [empresaId])).rows[0];
      if (!e) throw error('Ese cliente no existe. Créalo en Empresas y vuelve aquí.');
      cliente = e.nombre;
    }
    const precio = monto(f.precio_total);
    const abono = Math.min(precio, monto(f.abono_monto));
    const abonoFecha = fecha(f.abono_fecha), saldoFecha = fecha(f.saldo_fecha);
    const metodo = texto(f.metodo, 60);
    const extras = (Array.isArray(f.extras) ? f.extras : []).map(x => ({ nombre: texto(x.nombre, 80), monto: monto(x.monto) })).filter(x => x.nombre && x.monto > 0).slice(0, 10);
    const cuota = monto(f.cuota_mensual);
    const dia = Math.min(28, Math.max(1, Number(f.dia_cobro) || 5));
    const tipo = f.tipo_sistema === undefined ? null : texto(f.tipo_sistema, 60), horas = f.horas === undefined ? null : Math.max(0, monto(f.horas));
    const v = [nombre, cliente, empresaId, precio, fecha(f.fecha_inicio), fecha(f.fecha_entrega), cuota, dia, JSON.stringify(extras), JSON.stringify(socios), texto(f.nota, 1000), metodo, adm, tipo, horas];
    let id = Number(f.id) || 0;
    if (id) await client.query('UPDATE oficina_proyectos SET nombre=$1, cliente=$2, empresa_id=$3, precio_total=$4, fecha_inicio=$5, fecha_entrega=$6, cuota_mensual=$7, dia_cobro=$8, extras=$9, socios=$10, nota=$11, comision_nota=$12, administracion=$13, tipo=COALESCE($14, tipo), horas=COALESCE($15, horas) WHERE id=$16', [...v, id]);
    else id = (await client.query('INSERT INTO oficina_proyectos (nombre, cliente, empresa_id, precio_total, fecha_inicio, fecha_entrega, cuota_mensual, dia_cobro, extras, socios, nota, comision_nota, administracion, tipo, horas) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id', v)).rows[0].id;
    // El cobro del setup se crea una sola vez: el abono (si ya lo recibiste) y el saldo que falta.
    const hoyF = new Date().toLocaleDateString('sv-SE');
    if (precio > 0 && empresaId && !(await client.query('SELECT 1 FROM oficina_pagos WHERE proyecto_id = $1 LIMIT 1', [id])).rowCount) {
      if (abono > 0) await client.query('INSERT INTO oficina_pagos (empresa_id, proyecto_id, concepto, monto, moneda, vence, pagado_el, forma, nota) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [empresaId, id, 'Setup · abono', abono, 'US$', abonoFecha || hoyF, abonoFecha || hoyF, metodo, '']);
      if (precio - abono > 0) await client.query('INSERT INTO oficina_pagos (empresa_id, proyecto_id, concepto, monto, moneda, vence, nota) VALUES ($1,$2,$3,$4,$5,$6,$7)', [empresaId, id, 'Setup · saldo al entregar', Math.round((precio - abono) * 100) / 100, 'US$', saldoFecha || hoyF, '']);
    }
    return id;
  }
  async function guardarGasto(f) {
    const proy = (await client.query('SELECT socios FROM oficina_proyectos WHERE id = $1', [Number(f.proyecto_id) || 0])).rows[0];
    const socios = proy && Array.isArray(proy.socios) ? proy.socios : [];
    const cat = CATEGORIAS[f.categoria] ? f.categoria : 'otro';
    // Para quién: null = todos (se reparte entre los socios); número = índice del socio (solo se descuenta de su parte).
    const para = f.para_socio === '' || f.para_socio === null || f.para_socio === undefined ? null : Number(f.para_socio);
    if (para !== null && (!Number.isInteger(para) || para < 0 || para >= socios.length)) throw error('Esa persona no está en el reparto de este sistema.');
    if (cat === 'adelanto' && para === null) throw error('Un adelanto de ganancia es de una persona: elige para quién es.');
    const v = [Number(f.proyecto_id), fecha(f.fecha), texto(f.concepto, 160), cat, monto(f.monto), texto(f.pagado_por, 60), texto(f.nota, 300), para];
    if (!v[0]) throw error('Falta el sistema.');
    if (!v[2]) throw error('Escribe qué se pagó (ej.: Claude Pro).');
    if (Number(f.id)) await client.query('UPDATE oficina_proyecto_gastos SET proyecto_id=$1, fecha=$2, concepto=$3, categoria=$4, monto=$5, pagado_por=$6, nota=$7, para_socio=$8 WHERE id=$9', [...v, Number(f.id)]);
    else await client.query('INSERT INTO oficina_proyecto_gastos (proyecto_id, fecha, concepto, categoria, monto, pagado_por, nota, para_socio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', v);
  }
  async function guardarMensual(f) {
    const v = [Number(f.proyecto_id), texto(f.concepto, 160), CATEGORIAS[f.categoria] ? f.categoria : 'otro', monto(f.monto), FRECUENCIAS[f.frecuencia] ? f.frecuencia : 'mensual', fecha(f.desde), texto(f.nota, 300), f.activo !== false, Number(f.orden) || 0];
    if (!v[0]) throw error('Falta el sistema.');
    if (!v[1]) throw error('Escribe el nombre del gasto (ej.: Servidor Hostinger).');
    if (Number(f.id)) await client.query('UPDATE oficina_proyecto_mensuales SET proyecto_id=$1, concepto=$2, categoria=$3, monto=$4, frecuencia=$5, desde=$6, nota=$7, activo=$8, orden=$9 WHERE id=$10', [...v, Number(f.id)]);
    else await client.query('INSERT INTO oficina_proyecto_mensuales (proyecto_id, concepto, categoria, monto, frecuencia, desde, nota, activo, orden) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', v);
  }

  async function guardarRecarga(f) {
    const v = [Number(f.empresa_id), fecha(f.fecha), monto(f.monto), texto(f.nota, 200)];
    if (!v[0]) throw error('Elige el cliente.');
    if (!v[1]) throw error('Elige la fecha de la recarga.');
    if (!v[2]) throw error('Escribe cuánto se recargó.');
    if (Number(f.id)) await client.query('UPDATE oficina_recargas_ia SET empresa_id=$1, fecha=$2, monto=$3, nota=$4 WHERE id=$5', [...v, Number(f.id)]);
    else await client.query('INSERT INTO oficina_recargas_ia (empresa_id, fecha, monto, nota) VALUES ($1,$2,$3,$4)', v);
  }

  async function listar() {
    const [p, g, m, rc, pg] = await Promise.all([
      client.query("SELECT p.*, TO_CHAR(p.fecha_cobro, 'YYYY-MM-DD') AS fecha_cobro, TO_CHAR(p.fecha_inicio, 'YYYY-MM-DD') AS fecha_inicio, TO_CHAR(p.fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega FROM oficina_proyectos p ORDER BY p.id"),
      client.query("SELECT g.*, TO_CHAR(g.fecha, 'YYYY-MM-DD') AS fecha FROM oficina_proyecto_gastos g ORDER BY g.fecha NULLS FIRST, g.id"),
      client.query("SELECT m.*, TO_CHAR(m.desde, 'YYYY-MM-DD') AS desde FROM oficina_proyecto_mensuales m ORDER BY m.orden, m.id"),
      client.query("SELECT r.*, TO_CHAR(r.fecha, 'YYYY-MM-DD') AS fecha FROM oficina_recargas_ia r ORDER BY r.fecha DESC, r.id DESC"),
      client.query("SELECT q.id, q.proyecto_id, q.concepto, q.monto, q.moneda, q.forma, q.referencia, q.comprobante_nombre, q.recibo_id, q.nota, TO_CHAR(q.vence, 'YYYY-MM-DD') AS vence, TO_CHAR(q.pagado_el, 'YYYY-MM-DD') AS pagado_el FROM oficina_pagos q WHERE q.proyecto_id IS NOT NULL ORDER BY q.vence, q.id")]);
    const n = x => Number(x) || 0;
    return {
      categorias: CATEGORIAS, frecuencias: FRECUENCIAS,
      proyectos: p.rows.map(x => {
        const pagos = pg.rows.filter(y => y.proyecto_id === x.id).map(y => ({ ...y, monto: n(y.monto) }));
        // Lo cobrado es lo que se registró en Cobros del sistema. Los sistemas viejos sin cobros conservan su monto.
        const cobrado = pagos.length ? Math.round(pagos.filter(y => y.pagado_el).reduce((t, y) => t + y.monto, 0) * 100) / 100 : n(x.cobrado);
        return { ...x, cobrado, comision_pct: n(x.comision_pct), precio_total: n(x.precio_total), cuota_mensual: n(x.cuota_mensual),
          dia_cobro: Number(x.dia_cobro) || 5, extras: Array.isArray(x.extras) ? x.extras : [], pagos,
          gastos: g.rows.filter(y => y.proyecto_id === x.id).map(y => ({ ...y, monto: n(y.monto) })),
          mensuales: m.rows.filter(y => y.proyecto_id === x.id).map(y => ({ ...y, monto: n(y.monto) })) };
      }),
      recargas: rc.rows.map(y => ({ ...y, monto: n(y.monto) }))
    };
  }

  async function manejar(req, res, url, u, { json, leerCuerpo, registrar }) {
    if (req.method === 'GET' && url === '/api/oficina/proyectos') return json(res, 200, await listar());
    const r = url.match(/^\/api\/oficina\/proyectos\/(guardar|borrar)$/);
    if (r && req.method === 'POST') {
      const f = await leerCuerpo(req);
      const tabla = { proyecto: 'oficina_proyectos', gasto: 'oficina_proyecto_gastos', mensual: 'oficina_proyecto_mensuales', recarga: 'oficina_recargas_ia' }[f.tipo];
      if (!tabla) throw error('Tipo no válido.');
      if (r[1] === 'borrar') await client.query(`DELETE FROM ${tabla} WHERE id = $1`, [Number(f.id)]);
      else if (f.tipo === 'proyecto') await guardarProyecto(f);
      else if (f.tipo === 'gasto') await guardarGasto(f);
      else if (f.tipo === 'recarga') await guardarRecarga(f);
      else await guardarMensual(f);
      await registrar(u, 'oficina_' + r[1], 'creacion_' + f.tipo, f.id || 'nuevo', '', '', texto(f.concepto || f.nombre, 120));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/oficina/proyectos/mensualidad') {
      const f = await leerCuerpo(req);
      const pr = (await client.query('SELECT p.*, TO_CHAR(p.fecha_entrega, \'YYYY-MM-DD\') AS fecha_entrega FROM oficina_proyectos p WHERE p.id = $1', [Number(f.proyecto_id) || 0])).rows[0];
      if (!pr) throw error('Sistema no encontrado.', 404);
      const mes = /^\d{4}-\d{2}$/.test(f.mes || '') ? f.mes : new Date().toLocaleDateString('sv-SE').slice(0, 7);
      const concepto = `Mensualidad ${mes} · ${pr.nombre}`;
      if ((await client.query('SELECT 1 FROM oficina_pagos WHERE proyecto_id = $1 AND concepto = $2', [pr.id, concepto])).rowCount) throw error('Esa mensualidad ya está registrada.');
      const extras = (Array.isArray(pr.extras) ? pr.extras : []).reduce((t, x) => t + (Number(x.monto) || 0), 0);
      const total = Math.round((Number(pr.cuota_mensual) + extras) * 100) / 100;
      if (!(total > 0)) throw error('El sistema no tiene cuota mensual. Ponla en Editar.');
      const dia = Math.min(28, Math.max(1, Number(pr.dia_cobro) || 5));
      const vence = `${mes}-${String(dia).padStart(2, '0')}`;
      await client.query('INSERT INTO oficina_pagos (empresa_id, proyecto_id, concepto, monto, moneda, vence, nota) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [pr.empresa_id || null, pr.id, concepto, total, 'US$', vence, 'Cuota mensual por adelantado, con extras (API o software)']);
      await registrar(u, 'mensualidad_creada', 'proyecto', pr.id, '', mes, concepto);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Ruta no encontrada' });
  }

  return { preparar, manejar };
};
