// Motor de correo: lee los buzones de Microsoft 365, clasifica con IA (texto + capturas) y guarda en el panel.
// Hace lo mismo que el flujo de n8n "Correos - leer y clasificar", pero dentro del programa:
// una mejora aquí llega a todas las agencias de una vez.
//
// Modo sombra (motor.sombra = true): lee y clasifica igual, pero guarda en "motor_sombra" para comparar
// con lo que hace n8n. No toca las reservas ni avisa a nadie.

const ms = require('./microsoft');
const ia = require('./clasificar');
const imap = require('./imap');
const fact = require('./facturas');

const COLUMNAS = ['categoria', 'remitente', 'asunto', 'estado', 'fecha', 'cuerpo', 'message_id', 'buzon', 'agencia',
  'nombre_cliente', 'telefono', 'adultos', 'ninos', 'infantes', 'error_ia', 'motivo', 'numero_servicio', 'tipo_servicio',
  'actividad', 'aeropuerto', 'fecha_servicio', 'hora_servicio', 'vuelo', 'hotel', 'punto_partida', 'punto_llegada'];
const COMPARAR = ['categoria', 'agencia', 'nombre_cliente', 'adultos', 'ninos', 'aeropuerto', 'fecha_servicio', 'hora_servicio', 'vuelo', 'hotel'];

const MAXIMO_FALLOS = 6;
const esperar = ms_ => new Promise(r => setTimeout(r, ms_));

module.exports = function crearMotor({ client, config, registrar, SISTEMA, habilitado = async () => true, leerClave = null, leerCuentaImap = null }) {
  const ajustes = () => Object.assign({
    activo: false, sombra: true, intervaloMinutos: 10, ventanaDias: 2, buzones: [], microsoft: {},
    maximoPorCiclo: 60, pausaMs: 1000, modelo: 'anthropic/claude-haiku-5.5'
  }, config.motor || {});
  // Buzones a leer. Formato nuevo: cuentas [{ proveedor: 'microsoft' | 'imap', buzon, microsoft | imap }].
  // Formato de Somos Viajes (buzones + microsoft) sigue sirviendo igual.
  const cuentasDe = a => (Array.isArray(a.cuentas) && a.cuentas.length
    ? a.cuentas
    : (a.buzones || []).map(buzon => ({ proveedor: 'microsoft', buzon, microsoft: a.microsoft || {} })));
  function faltaDato(c) {
    if (c.proveedor === 'imap') {
      const i = c.imap || {};
      return !i.host || !i.usuario || !i.clave ? `Faltan los datos IMAP de ${c.buzon} (servidor, usuario o contraseña).` : '';
    }
    const m = c.microsoft || {};
    return !m.tenantId || !m.clientId || !m.clientSecret ? `Faltan los datos de Microsoft 365 de ${c.buzon} en config.js.` : '';
  }
  const claveIA = () => {
    const a = ajustes();
    return { apiKey: (a.ia && a.ia.apiKey) || claveBase || (config.openrouter && config.openrouter.apiKey) || '', url: a.ia && a.ia.url, esperaReintento: a.ia && a.ia.esperaReintento };
  };
  // La clave de OpenRouter que se guardó en Oficina (se lee al empezar cada vuelta).
  let claveBase = '';
  async function cargarClaveBase() { claveBase = (leerClave ? await leerClave().catch(() => '') : '') || ''; }
  let corriendo = false;
  let reloj = null;

  async function preparar() {
    await fact.preparar(client);
    await client.query(`CREATE TABLE IF NOT EXISTS motor_estado (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      inicio TIMESTAMPTZ, fin TIMESTAMPTZ, leidos INTEGER NOT NULL DEFAULT 0, nuevos INTEGER NOT NULL DEFAULT 0,
      con_error INTEGER NOT NULL DEFAULT 0, imagenes INTEGER NOT NULL DEFAULT 0, mensaje TEXT NOT NULL DEFAULT '')`);
    await client.query(`CREATE TABLE IF NOT EXISTS motor_sombra (
      message_id TEXT NOT NULL, numero_servicio INTEGER NOT NULL, datos JSONB NOT NULL, imagenes INTEGER NOT NULL DEFAULT 0,
      error_ia BOOLEAN NOT NULL DEFAULT FALSE, motivo TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, numero_servicio))`);
    await client.query(`CREATE TABLE IF NOT EXISTS motor_imagenes (
      huella TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, correos TEXT[] NOT NULL DEFAULT '{}', visto TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS motor_fallos (
      message_id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0, visto TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query('ALTER TABLE motor_estado ADD COLUMN IF NOT EXISTS corte_correo TIMESTAMPTZ');
    await client.query('INSERT INTO motor_estado (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  }

  // En cuántos correos distintos apareció una imagen (para no mandar a la IA logos y banners repetidos).
  async function vistas(huella, id) {
    const fila = (await client.query('SELECT n, correos FROM motor_imagenes WHERE huella = $1', [huella])).rows[0];
    if (fila && fila.correos.includes(id)) {
      await client.query('UPDATE motor_imagenes SET visto = NOW() WHERE huella = $1', [huella]);
      return fila.n;
    }
    const r = await client.query(
      `INSERT INTO motor_imagenes (huella, n, correos) VALUES ($1, 1, ARRAY[$2])
       ON CONFLICT (huella) DO UPDATE SET n = motor_imagenes.n + 1,
         correos = (motor_imagenes.correos || $2)[GREATEST(1, array_length(motor_imagenes.correos, 1) - 3):], visto = NOW()
       RETURNING n`, [huella, id]);
    return r.rows[0].n;
  }

  // Buzones de la configuración + la cuenta que se guardó en Oficina (Yahoo u otro IMAP), si hay.
  async function cuentasTodas(a) {
    const base = cuentasDe(a);
    const extra = leerCuentaImap ? await leerCuentaImap().catch(() => null) : null;
    if (extra && extra.buzon && extra.imap && !base.some(c => c.buzon === extra.buzon)) base.push(extra);
    return base;
  }
  // Corte del reinicio del correo: los correos recibidos antes de esa fecha no se leen.
  let corteActual = null;
  async function leerCorte() {
    const f = (await client.query('SELECT corte_correo FROM motor_estado WHERE id = 1')).rows[0];
    return f && f.corte_correo ? new Date(f.corte_correo) : null;
  }
  async function correosPendientes(a, abiertas, cuentas) {
    let desdeFecha = new Date(Date.now() - a.ventanaDias * 86400000);
    if (corteActual && corteActual > desdeFecha) desdeFecha = corteActual;
    const desde = desdeFecha.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const leidos = [];
    for (const cuenta of cuentas) {
      if (cuenta.proveedor === 'imap') {
        const sesion = await imap.abrir(cuenta.imap);
        abiertas.push(sesion);
        const lista = await sesion.listar(desde);
        leidos.push(...lista.map(m => ({ id: m.id, buzon: cuenta.buzon, cuenta, uid: m.uid, sesion })));
      } else {
        const lista = await ms.listarRecientes(cuenta.microsoft, cuenta.buzon, desde);
        leidos.push(...lista.map(m => { const correo = ia.desdeGraph(m, cuenta.buzon); return { id: correo.id, buzon: cuenta.buzon, cuenta, correo }; }));
      }
    }
    // Los que fallaron antes (igual que el nodo "Reintentar fallidos"); en modo sombra no se tocan.
    const reintentos = a.sombra ? [] : (await client.query(
      `(SELECT DISTINCT ON (message_id) message_id, buzon, remitente, asunto, fecha, cuerpo FROM clasificacion
         WHERE error_ia = TRUE AND estado <> 'historico' AND COALESCE(message_id, '') <> '' AND COALESCE(motivo, '') NOT LIKE 'No se pudo leer%'
         ORDER BY message_id, id DESC LIMIT 30)
       UNION ALL
       (SELECT DISTINCT ON (message_id) message_id, buzon, remitente, asunto, fecha, cuerpo FROM clasificacion
         WHERE error_ia = TRUE AND estado = 'historico' AND COALESCE(message_id, '') <> '' AND COALESCE(motivo, '') NOT LIKE 'No se pudo leer%'
         ORDER BY message_id, id DESC LIMIT 25)`
    )).rows.map(x => ({
      id: x.message_id, buzon: x.buzon, cuenta: cuentas.find(c => c.buzon === x.buzon) || null, reintento: true,
      correo: { id: x.message_id, buzon: x.buzon, from: x.remitente || '', subject: x.asunto || '', date: x.fecha || '', textPlain: x.cuerpo || '', reintento: true }
    }));
    const vistosIds = new Set();
    const todos = [...leidos, ...reintentos].filter(c => c.id && !vistosIds.has(c.id) && vistosIds.add(c.id));
    if (!todos.length) return { leidos: leidos.length, pendientes: [] };
    const ids = todos.map(c => c.id);
    const hechos = new Set((a.sombra
      ? await client.query('SELECT DISTINCT message_id FROM motor_sombra WHERE message_id = ANY($1::text[]) AND error_ia = FALSE', [ids])
      : await client.query('SELECT DISTINCT message_id FROM clasificacion WHERE message_id = ANY($1::text[]) AND error_ia IS NOT TRUE', [ids])
    ).rows.map(x => x.message_id));
    return { leidos: leidos.length, pendientes: todos.filter(c => !hechos.has(c.id)) };
  }

  // Texto y adjuntos del correo. Microsoft: el texto ya vino en la lista, se piden los adjuntos.
  // IMAP: se baja el correo completo (texto y adjuntos juntos). Reintentos de IMAP: solo el texto guardado.
  async function contenido(item, conImagenes) {
    if (item.uid && item.sesion) {
      const r = await item.sesion.completo(item.uid, item.buzon);
      r.correo.id = item.id;
      return { correo: r.correo, adjuntos: conImagenes ? r.adjuntos : [] };
    }
    let adjuntos = [];
    if (conImagenes && item.cuenta && item.cuenta.proveedor !== 'imap') {
      adjuntos = await ms.adjuntos(item.cuenta.microsoft, item.buzon, item.id).catch(() => []);
    }
    return { correo: item.correo, adjuntos };
  }

  // Factura de pago: se lee con la IA y la propuesta queda lista para revisar en el panel de facturas.
  async function leerSiEsFactura(a, filas, correo) {
    if (a.sombra || !filas || !filas[0] || filas[0].categoria !== 'FACTURA' || filas[0].error_ia) return;
    const r = await client.query('SELECT id FROM clasificacion WHERE message_id = $1 ORDER BY id DESC LIMIT 1', [correo.id]);
    if (!r.rows[0]) return;
    await fact.leerFactura({ client, ia, claveIA: claveIA(), modelo: a.modelo, clasificacionId: r.rows[0].id, correo })
      .catch(e => console.log('Facturas:', e.message));
  }

  async function guardar(a, filas, imagenes) {
    if (a.sombra) {
      await client.query('DELETE FROM motor_sombra WHERE message_id = $1', [filas[0].message_id]);
      for (const f of filas) {
        await client.query('INSERT INTO motor_sombra (message_id, numero_servicio, datos, imagenes, error_ia, motivo) VALUES ($1, $2, $3, $4, $5, $6)',
          [f.message_id, f.numero_servicio, f, imagenes, f.error_ia, f.motivo]);
      }
      return;
    }
    // Una sola instrucción: el disparador de la base de datos reemplaza las filas viejas con error de ese correo.
    const valores = [];
    const marcas = filas.map((f, i) => '(' + COLUMNAS.map((c, j) => { valores.push(f[c]); return '$' + (i * COLUMNAS.length + j + 1); }).join(', ') + ')');
    await client.query(`INSERT INTO clasificacion (${COLUMNAS.join(', ')}) VALUES ${marcas.join(', ')}`, valores);
  }

  async function ciclo() {
    const a = ajustes();
    if (corriendo || !a.activo || !(await habilitado().catch(() => false))) return;
    corriendo = true;
    const cuenta = { leidos: 0, nuevos: 0, con_error: 0, imagenes: 0, en_espera: 0 };
    const abiertas = []; // conexiones IMAP de esta vuelta
    await client.query("UPDATE motor_estado SET inicio = NOW(), mensaje = 'Leyendo correos…' WHERE id = 1").catch(() => {});
    try {
      await cargarClaveBase();
      const cuentas = await cuentasTodas(a);
      if (!cuentas.length) throw new Error('No hay buzones para leer (motor.cuentas en config.js).');
      for (const c of cuentas) { const falta = faltaDato(c); if (falta) throw new Error(falta); }
      if (!claveIA().apiKey) throw new Error('Falta la clave de OpenRouter en config.js (openrouter.apiKey o motor.ia.apiKey).');
      corteActual = await leerCorte();
      const { leidos, pendientes } = await correosPendientes(a, abiertas, cuentas);
      cuenta.leidos = leidos;
      // Aviso de vida: el panel sabe que la lectura de correos funciona (solo en modo real; en sombra lo sigue dando n8n).
      if (!a.sombra) await client.query('INSERT INTO salud_n8n (id, visto) VALUES (1, NOW()) ON CONFLICT (id) DO UPDATE SET visto = NOW()');
      for (const item of pendientes.slice(0, a.maximoPorCiclo)) {
        if (corteActual && item.correo && item.correo.date && new Date(item.correo.date) < corteActual) continue;
        const fallos = (await client.query('SELECT n, visto FROM motor_fallos WHERE message_id = $1', [item.id])).rows[0];
        // Un correo que falla muchas veces se vuelve a intentar cada 6 horas (no en cada vuelta).
        if (fallos && fallos.n >= MAXIMO_FALLOS && Date.now() - new Date(fallos.visto).getTime() < 6 * 3600000) { cuenta.en_espera++; continue; }
        // Después de 2 fallos se intenta solo con el texto (igual que en n8n).
        const conImagenes = !fallos || fallos.n < 2;
        let leido;
        try {
          leido = await contenido(item, conImagenes);
        } catch (e) {
          // No se pudo bajar el correo: se intenta en la próxima vuelta (y si sigue fallando, cada 6 horas).
          cuenta.con_error++;
          await client.query(`INSERT INTO motor_fallos (message_id, n) VALUES ($1, 1)
            ON CONFLICT (message_id) DO UPDATE SET n = motor_fallos.n + 1, visto = NOW()`, [item.id]);
          continue;
        }
        const correo = leido.correo;
        if (corteActual && correo.date && new Date(correo.date) < corteActual) continue;
        let imagenes = [];
        try { imagenes = await ia.elegirImagenes(correo.id, leido.adjuntos, vistas); } catch (e) { imagenes = []; }
        const respuesta = await ia.clasificarConReintento(claveIA(), correo, imagenes, a.modelo, a.perfil);
        const filas = ia.filasDesdeRespuesta(correo, respuesta);
        if (filas[0].error_ia) {
          await client.query(`INSERT INTO motor_fallos (message_id, n) VALUES ($1, 1)
            ON CONFLICT (message_id) DO UPDATE SET n = motor_fallos.n + 1, visto = NOW()`, [correo.id]);
        } else if (!filas[0].error_ia) {
          await client.query('DELETE FROM motor_fallos WHERE message_id = $1', [correo.id]);
        }
        await guardar(a, filas, imagenes.length);
        await leerSiEsFactura(a, filas, correo);
        cuenta.nuevos++;
        if (filas[0].error_ia) cuenta.con_error++;
        if (imagenes.length) cuenta.imagenes++;
        if (a.pausaMs) await esperar(a.pausaMs);
      }
      const resto = Math.max(0, pendientes.length - a.maximoPorCiclo);
      await client.query(`UPDATE motor_estado SET fin = NOW(), leidos = $1, nuevos = $2, con_error = $3, imagenes = $4, mensaje = $5 WHERE id = 1`,
        [cuenta.leidos, cuenta.nuevos, cuenta.con_error, cuenta.imagenes,
          (a.sombra ? 'Modo sombra. ' : '') + `Revisados ${cuenta.leidos} correos; ${cuenta.nuevos} nuevos analizados${cuenta.con_error ? ` (${cuenta.con_error} con error)` : ''}${cuenta.en_espera ? `; ${cuenta.en_espera} en espera por fallos repetidos` : ''}${resto ? `; quedan ${resto} para la próxima vuelta` : ''}.`]);
    } catch (e) {
      await client.query('UPDATE motor_estado SET fin = NOW(), mensaje = $1 WHERE id = 1', ['Error: ' + e.message.slice(0, 300)]).catch(() => {});
      await registrar(SISTEMA, 'motor_error', 'sistema', 'motor', '', '', e.message.slice(0, 300)).catch(() => {});
    } finally {
      for (const s of abiertas) await s.cerrar().catch(() => {});
      corriendo = false;
    }
  }

  function iniciar() {
    const a = ajustes();
    if (!a.activo || reloj) return;
    setTimeout(ciclo, 30 * 1000);
    reloj = setInterval(ciclo, Math.max(2, a.intervaloMinutos) * 60 * 1000);
  }

  // Comparación del modo sombra: lo que sacó el motor contra lo que guardó n8n en el panel.
  async function comparar() {
    const filas = (await client.query(
      `SELECT s.message_id, s.numero_servicio, s.datos, s.imagenes, s.error_ia, s.motivo, s.creado, row_to_json(c) AS n8n
       FROM motor_sombra s
       LEFT JOIN clasificacion c ON c.message_id = s.message_id AND c.numero_servicio = s.numero_servicio AND c.error_ia IS NOT TRUE
       ORDER BY s.creado DESC LIMIT 400`
    )).rows;
    const porCorreo = new Map();
    for (const f of filas) {
      const d = porCorreo.get(f.message_id) || { message_id: f.message_id, asunto: f.datos.asunto, creado: f.creado, imagenes: f.imagenes, servicios: 0, sinN8n: false, errorIA: f.error_ia, motivo: f.motivo, diferencias: [] };
      d.servicios++;
      if (!f.n8n) d.sinN8n = true;
      else {
        for (const campo of COMPARAR) {
          if (ia.normalizarComparacion(campo, f.datos[campo]) !== ia.normalizarComparacion(campo, f.n8n[campo])) d.diferencias.push({ servicio: f.numero_servicio, campo, n8n: f.n8n[campo] ?? '', motor: f.datos[campo] ?? '' });
        }
      }
      porCorreo.set(f.message_id, d);
    }
    const correos = Array.from(porCorreo.values());
    const comparables = correos.filter(c => !c.sinN8n && !c.errorIA);
    const categoriaIgual = comparables.filter(c => !c.diferencias.some(x => x.campo === 'categoria')).length;
    return {
      total: correos.length, comparables: comparables.length,
      iguales: comparables.filter(c => !c.diferencias.length).length,
      categoriaIgual, conErrorIA: correos.filter(c => c.errorIA).length,
      correos: correos.slice(0, 100)
    };
  }

  async function estado() {
    const a = ajustes();
    const e = (await client.query('SELECT * FROM motor_estado WHERE id = 1')).rows[0] || {};
    return { activo: a.activo, sombra: a.sombra, buzones: cuentasDe(a).map(c => c.buzon), intervaloMinutos: a.intervaloMinutos, corriendo, ...e, recuperacion };
  }

  // Recuperación: vuelve a leer un rango de fechas de los buzones y pone esos correos en la bandeja, analizados por la IA.
  // Sirve para correos que se borraron de la base (caché). Siempre guarda en real, aunque el motor esté en modo sombra.
  let recuperacion = null;
  async function recuperar(desdeISO, hastaISO) {
    if (recuperacion && recuperacion.estado === 'corriendo') throw new Error('Ya se está recuperando un rango. Espera a que termine.');
    if (corriendo) throw new Error('El motor está leyendo correos. Vuelve a intentar en un minuto.');
    const a = ajustes();
    const cuentas = await cuentasTodas(a);
    if (!cuentas.length) throw new Error('No hay buzones configurados para leer.');
    for (const c of cuentas) { const falta = faltaDato(c); if (falta) throw new Error(falta); }
    await cargarClaveBase();
    if (!claveIA().apiKey) throw new Error('Falta la clave de OpenRouter (en Oficina → Clientes y cobros → Editar, o en config.js).');
    const desde = new Date(desdeISO), hasta = new Date(hastaISO);
    if (isNaN(desde) || isNaN(hasta) || hasta <= desde) throw new Error('El rango de fechas no es válido.');
    recuperacion = { estado: 'corriendo', desde: desde.toISOString(), hasta: hasta.toISOString(), inicio: new Date().toISOString(), fin: null,
      leidos: 0, total: 0, nuevos: 0, restaurados: 0, yaEstaban: 0, con_error: 0, mensaje: 'Buscando correos en los buzones…' };
    corriendo = true;
    (async () => {
      const abiertas = [];
      try {
        const lista = [];
        for (const cuenta of cuentas) {
          if (cuenta.proveedor === 'imap') {
            const sesion = await imap.abrir(cuenta.imap);
            abiertas.push(sesion);
            for (const m of await sesion.listar(desde.toISOString(), 2000)) {
              const f = new Date(m.fecha);
              if (f >= desde && f < hasta) lista.push({ id: m.id, buzon: cuenta.buzon, cuenta, uid: m.uid, sesion });
            }
          } else {
            for (const m of await ms.listarRecientes(cuenta.microsoft, cuenta.buzon, desde.toISOString(), 2000)) {
              const f = new Date(m.receivedDateTime);
              if (f >= desde && f < hasta) { const correo = ia.desdeGraph(m, cuenta.buzon); lista.push({ id: correo.id, buzon: cuenta.buzon, cuenta, correo }); }
            }
          }
        }
        const unicos = [...new Map(lista.filter(x => x.id).map(x => [x.id, x])).values()];
        recuperacion.leidos = unicos.length;
        const ids = unicos.map(x => x.id);
        // 1) Lo que ya está en la bandeja (no en Histórico): no se toca.
        const bandeja = new Set((await client.query("SELECT DISTINCT message_id FROM clasificacion WHERE message_id = ANY($1::text[]) AND estado <> 'historico'", [ids])).rows.map(r => r.message_id));
        // 2) Lo que está en Histórico con estado real guardado: vuelve a ese estado.
        const volvieron = new Set((await client.query(`UPDATE clasificacion SET estado = estado_antes, estado_antes = NULL
          WHERE estado = 'historico' AND estado_antes IS NOT NULL AND estado_antes <> 'historico'
            AND message_id = ANY($1::text[]) AND NOT (message_id = ANY($2::text[]))
          RETURNING message_id`, [ids, [...bandeja]])).rows.map(r => r.message_id));
        // 3) Lo demás se analiza de nuevo. Quedan marcados como histórico para que no vuelvan allí.
        const pendientes = unicos.filter(x => !bandeja.has(x.id) && !volvieron.has(x.id));
        recuperacion.yaEstaban = bandeja.size;
        recuperacion.restaurados = volvieron.size;
        recuperacion.total = pendientes.length;
        await client.query('DELETE FROM correo_historico WHERE message_id = ANY($1::text[])', [[...volvieron, ...pendientes.map(p => p.id)]]);
        let n = 0;
        for (const item of pendientes) {
          n++;
          recuperacion.mensaje = `Analizando ${n} de ${pendientes.length}…`;
          try {
            const leido = await contenido(item, true);
            const correo = leido.correo;
            let imagenes = [];
            try { imagenes = await ia.elegirImagenes(correo.id, leido.adjuntos, vistas); } catch (e) { imagenes = []; }
            const respuesta = await ia.clasificarConReintento(claveIA(), correo, imagenes, a.modelo, a.perfil);
            const filas = ia.filasDesdeRespuesta(correo, respuesta);
            // La fila de Histórico (sin análisis) se quita justo antes de guardar el resultado: si la IA falla, el correo sigue ahí.
            await client.query("DELETE FROM clasificacion WHERE message_id = $1 AND estado = 'historico' AND estado_antes IS NULL", [correo.id]);
            await guardar({ ...a, sombra: false }, filas, imagenes.length);
            await leerSiEsFactura({ ...a, sombra: false }, filas, correo);
            if (filas[0].error_ia) recuperacion.con_error++; else recuperacion.nuevos++;
          } catch (e) {
            recuperacion.con_error++;
          }
          if (a.pausaMs) await esperar(a.pausaMs);
        }
        recuperacion.estado = 'listo';
        recuperacion.mensaje = `Listo: ${recuperacion.nuevos} correos analizados a la bandeja; ${recuperacion.restaurados} vueltos de Histórico; ${recuperacion.yaEstaban} ya estaban en la bandeja${recuperacion.con_error ? `; ${recuperacion.con_error} con error` : ''}.`;
      } catch (e) {
        recuperacion.estado = 'error';
        recuperacion.mensaje = 'Error: ' + e.message.slice(0, 300);
      } finally {
        for (const s of abiertas) await s.cerrar().catch(() => {});
        corriendo = false;
        recuperacion.fin = new Date().toISOString();
      }
    })();
    return recuperacion;
  }

  // Lee con la IA las facturas ya clasificadas que todavía no tienen propuesta (o cuya lectura falló).
  async function leerFacturasPendientes(limite = 20) {
    await cargarClaveBase();
    const filas = (await client.query(`SELECT c.id, c.message_id, c.remitente, c.asunto, c.cuerpo, c.fecha FROM clasificacion c
      WHERE c.categoria = 'FACTURA' AND NOT COALESCE(c.error_ia, FALSE) AND COALESCE(c.message_id, '') <> ''
        AND NOT EXISTS (SELECT 1 FROM facturas_pago f WHERE f.clasificacion_id = c.id AND f.estado IN ('pendiente', 'registrada', 'rechazada'))
      ORDER BY c.id DESC LIMIT $1`, [limite])).rows;
    const modelo = ajustes().modelo;
    let leidas = 0;
    for (const x of filas) {
      const correo = { id: x.message_id, from: x.remitente || '', subject: x.asunto || '', date: x.fecha || '', textPlain: x.cuerpo || '' };
      const r = await fact.leerFactura({ client, ia, claveIA: claveIA(), modelo, clasificacionId: x.id, correo }).catch(() => ({ ok: false }));
      if (r.ok) leidas++;
    }
    return { encontradas: filas.length, leidas };
  }

  // Lee una factura concreta (botón «Leer con IA ahora» en el correo). Devuelve la propuesta o el error.
  async function leerUnaFactura(clasificacionId) {
    if (!claveIA().apiKey) throw new Error('Falta la clave de OpenRouter (en Oficina → Clientes y cobros → Editar, o en config.js).');
    const x = (await client.query(`SELECT id, message_id, remitente, asunto, cuerpo, fecha, categoria FROM clasificacion WHERE id = $1`, [Number(clasificacionId) || 0])).rows[0];
    if (!x) return { ok: false, error: 'Ese correo ya no existe.' };
    if (x.categoria !== 'FACTURA') return { ok: false, error: 'Ese correo no está clasificado como factura.' };
    if (!x.message_id) return { ok: false, error: 'Este correo no tiene identificador; no se puede leer.' };
    const correo = { id: x.message_id, from: x.remitente || '', subject: x.asunto || '', date: x.fecha || '', textPlain: x.cuerpo || '' };
    return fact.leerFactura({ client, ia, claveIA: claveIA(), modelo: ajustes().modelo, clasificacionId: x.id, correo });
  }

  return { preparar, iniciar, ciclo, comparar, estado, recuperar, leerFacturasPendientes, leerUnaFactura };
};
