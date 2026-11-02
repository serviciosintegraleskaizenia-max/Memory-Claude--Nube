// Motor de correo: lee los buzones de Microsoft 365, clasifica con IA (texto + capturas) y guarda en el panel.
// Hace lo mismo que el flujo de n8n "Correos - leer y clasificar", pero dentro del programa:
// una mejora aquí llega a todas las agencias de una vez.
//
// Modo sombra (motor.sombra = true): lee y clasifica igual, pero guarda en "motor_sombra" para comparar
// con lo que hace n8n. No toca las reservas ni avisa a nadie.

const ms = require('./microsoft');
const ia = require('./clasificar');

const COLUMNAS = ['categoria', 'remitente', 'asunto', 'estado', 'fecha', 'cuerpo', 'message_id', 'buzon', 'agencia',
  'nombre_cliente', 'telefono', 'adultos', 'ninos', 'infantes', 'error_ia', 'motivo', 'numero_servicio', 'tipo_servicio',
  'actividad', 'aeropuerto', 'fecha_servicio', 'hora_servicio', 'vuelo', 'hotel', 'punto_partida', 'punto_llegada'];
const COMPARAR = ['categoria', 'agencia', 'nombre_cliente', 'adultos', 'ninos', 'aeropuerto', 'fecha_servicio', 'hora_servicio', 'vuelo', 'hotel'];

const MAXIMO_FALLOS = 6;
const esperar = ms_ => new Promise(r => setTimeout(r, ms_));

module.exports = function crearMotor({ client, config, registrar, SISTEMA }) {
  const ajustes = () => Object.assign({
    activo: false, sombra: true, intervaloMinutos: 10, ventanaDias: 2, buzones: [], microsoft: {},
    maximoPorCiclo: 60, pausaMs: 1000, modelo: 'anthropic/claude-haiku-5.5'
  }, config.motor || {});
  const claveIA = () => {
    const a = ajustes();
    return { apiKey: (a.ia && a.ia.apiKey) || (config.openrouter && config.openrouter.apiKey) || '', url: a.ia && a.ia.url, esperaReintento: a.ia && a.ia.esperaReintento };
  };
  let corriendo = false;
  let reloj = null;

  async function preparar() {
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

  async function correosPendientes(a) {
    const desde = new Date(Date.now() - a.ventanaDias * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const leidos = [];
    for (const buzon of a.buzones) {
      const lista = await ms.listarRecientes(a.microsoft, buzon, desde);
      leidos.push(...lista.map(m => ia.desdeGraph(m, buzon)));
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
    )).rows.map(x => ({ id: x.message_id, buzon: x.buzon, from: x.remitente || '', subject: x.asunto || '', date: x.fecha || '', textPlain: x.cuerpo || '', reintento: true }));
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
    if (corriendo || !a.activo) return;
    corriendo = true;
    const cuenta = { leidos: 0, nuevos: 0, con_error: 0, imagenes: 0, en_espera: 0 };
    await client.query("UPDATE motor_estado SET inicio = NOW(), mensaje = 'Leyendo correos…' WHERE id = 1").catch(() => {});
    try {
      if (!a.microsoft.tenantId || !a.microsoft.clientId || !a.microsoft.clientSecret) throw new Error('Faltan los datos de Microsoft 365 en config.js (motor.microsoft).');
      if (!claveIA().apiKey) throw new Error('Falta la clave de OpenRouter en config.js (openrouter.apiKey o motor.ia.apiKey).');
      const { leidos, pendientes } = await correosPendientes(a);
      cuenta.leidos = leidos;
      // Aviso de vida: el panel sabe que la lectura de correos funciona (solo en modo real; en sombra lo sigue dando n8n).
      if (!a.sombra) await client.query('INSERT INTO salud_n8n (id, visto) VALUES (1, NOW()) ON CONFLICT (id) DO UPDATE SET visto = NOW()');
      for (const correo of pendientes.slice(0, a.maximoPorCiclo)) {
        const fallos = (await client.query('SELECT n, visto FROM motor_fallos WHERE message_id = $1', [correo.id])).rows[0];
        // Un correo que falla muchas veces se vuelve a intentar cada 6 horas (no en cada vuelta).
        if (fallos && fallos.n >= MAXIMO_FALLOS && Date.now() - new Date(fallos.visto).getTime() < 6 * 3600000) { cuenta.en_espera++; continue; }
        let imagenes = [];
        // Después de 2 fallos se intenta solo con el texto (igual que en n8n).
        if (!fallos || fallos.n < 2) {
          try {
            imagenes = await ia.elegirImagenes(correo.id, await ms.adjuntos(a.microsoft, correo.buzon, correo.id), vistas);
          } catch (e) { imagenes = []; }
        }
        const respuesta = await ia.llamarIA(claveIA(), ia.pedidoIA(correo, imagenes, a.modelo));
        const filas = ia.filasDesdeRespuesta(correo, respuesta);
        if (filas[0].error_ia) {
          await client.query(`INSERT INTO motor_fallos (message_id, n) VALUES ($1, 1)
            ON CONFLICT (message_id) DO UPDATE SET n = motor_fallos.n + 1, visto = NOW()`, [correo.id]);
        } else if (!filas[0].error_ia) {
          await client.query('DELETE FROM motor_fallos WHERE message_id = $1', [correo.id]);
        }
        await guardar(a, filas, imagenes.length);
        cuenta.nuevos++;
        if (filas[0].error_ia) cuenta.con_error++;
        if (imagenes.length) cuenta.imagenes++;
        if (a.pausaMs) await esperar(a.pausaMs);
      }
      const resto = Math.max(0, pendientes.length - a.maximoPorCiclo);
      await client.query(`UPDATE motor_estado SET fin = NOW(), leidos = $1, nuevos = $2, con_error = $3, imagenes = $4, mensaje = $5 WHERE id = 1`,
        [cuenta.leidos, cuenta.nuevos, cuenta.con_error, cuenta.imagenes,
          (a.sombra ? 'Modo sombra. ' : '') + `Revisados ${cuenta.leidos} correos; ${cuenta.nuevos} analizados${cuenta.con_error ? ` (${cuenta.con_error} con error de la IA)` : ''}${cuenta.en_espera ? `; ${cuenta.en_espera} en espera por fallos repetidos` : ''}${resto ? `; quedan ${resto} para la próxima vuelta` : ''}.`]);
    } catch (e) {
      await client.query('UPDATE motor_estado SET fin = NOW(), mensaje = $1 WHERE id = 1', ['Error: ' + e.message.slice(0, 300)]).catch(() => {});
      await registrar(SISTEMA, 'motor_error', 'sistema', 'motor', '', '', e.message.slice(0, 300)).catch(() => {});
    } finally {
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
    const norm = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
          if (norm(f.datos[campo]) !== norm(f.n8n[campo])) d.diferencias.push({ servicio: f.numero_servicio, campo, n8n: f.n8n[campo] ?? '', motor: f.datos[campo] ?? '' });
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
    return { activo: a.activo, sombra: a.sombra, buzones: a.buzones, intervaloMinutos: a.intervaloMinutos, corriendo, ...e };
  }

  return { preparar, iniciar, ciclo, comparar, estado };
};
