// Cuenta de la empresa: lo que Kaizen IA controla desde la pestaña Empresas del panel central.
//  - Módulos contratados (se encienden y apagan por empresa).
//  - Cuenta pausada (nadie entra, salvo el programador).
//  - Recordatorio de pago al usuario principal (franja arriba + campanita), con los textos del banco de mensajes.
//  - Anuncios escritos a mano para un usuario o para todos.
//  - Accesos con vencimiento (los de la demo duran 48 horas).

const MODULOS = {
  correo: { nombre: 'Lectura de correos con IA', porDefecto: true },
  reparto: { nombre: 'Reparto automático', porDefecto: true },
  control: { nombre: 'Pantalla de Control', porDefecto: true },
  historial: { nombre: 'Historial de correos', porDefecto: true },
  chat: { nombre: 'Chat interno', porDefecto: true },
  redes: { nombre: 'Redes sociales (WhatsApp e Instagram)', porDefecto: false },
  crm: { nombre: 'CRM de redes y campañas (servicio aparte)', porDefecto: false }
};

const TEXTOS_PAGO = {
  antes: 'Hola {usuario}: te recordamos que el pago de {empresa} ({monto}) vence el {fecha}. Faltan {dias} día(s). Gracias por confiar en Kaizen IA.',
  dia: 'Hola {usuario}: hoy {fecha} vence el pago de {empresa} ({monto}). Gracias por confiar en Kaizen IA.',
  vencido: 'Hola {usuario}: el pago de {empresa} ({monto}) venció el {fecha} ({dias} día(s) de atraso). Para evitar la pausa del servicio, comunícate con Kaizen IA.'
};

const ZONA = 'America/Santo_Domingo';
// Fecha de hoy (AAAA-MM-DD) en la hora de la oficina.
function hoyLocal(ahora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ahora);
}
function sumarMeses(periodo, n) {
  const [a, m] = periodo.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function diasEntre(desde, hasta) {
  return Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / 86400000);
}
function fechaBonita(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

// En qué etapa del cobro está la cuenta hoy: null, 'antes', 'dia' o 'vencido'.
// pagado = último mes pagado (AAAA-MM). Cada mes vence el día "dia" (1 a 28).
function etapaPago(pago, pagado, hoy = hoyLocal()) {
  if (!pago || !pago.activo || !pago.dia) return null;
  const dia = Math.min(28, Math.max(1, Number(pago.dia) || 1));
  const antes = Math.max(0, Number(pago.diasAntes ?? 3));
  const mesHoy = hoy.slice(0, 7);
  for (const periodo of [sumarMeses(mesHoy, -1), mesHoy, sumarMeses(mesHoy, 1)]) {
    if (pagado && pagado >= periodo) continue;
    const vence = `${periodo}-${String(dia).padStart(2, '0')}`;
    const faltan = diasEntre(hoy, vence);
    if (faltan < 0) {
      // Un mes viejo sin pagar solo cuenta si la cuenta empezó a cobrarse antes de ese mes.
      if (pago.desde && pago.desde > periodo) continue;
      return { etapa: 'vencido', periodo, vence, dias: -faltan };
    }
    if (faltan === 0) return { etapa: 'dia', periodo, vence, dias: 0 };
    if (faltan <= antes) return { etapa: 'antes', periodo, vence, dias: faltan };
    return null;
  }
  return null;
}

function rellenar(texto, datos) {
  return String(texto || '').replace(/\{(\w+)\}/g, (m, k) => (datos[k] !== undefined ? String(datos[k]) : m));
}

module.exports = function crearCuenta({ client, config, avisar, registrar, SISTEMA }) {
  let guardada = null;
  let leidaEn = 0;

  async function preparar() {
    await client.query(`CREATE TABLE IF NOT EXISTS cuenta (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      estado VARCHAR(20) NOT NULL DEFAULT 'activa',
      motivo TEXT NOT NULL DEFAULT '',
      modulos JSONB NOT NULL DEFAULT '{}'::jsonb,
      pago JSONB NOT NULL DEFAULT '{}'::jsonb,
      pagado VARCHAR(7) NOT NULL DEFAULT '',
      aviso_pago VARCHAR(30) NOT NULL DEFAULT '',
      actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query('INSERT INTO cuenta (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await client.query("ALTER TABLE cuenta ADD COLUMN IF NOT EXISTS demo_dia VARCHAR(10) NOT NULL DEFAULT ''");
    await client.query(`CREATE TABLE IF NOT EXISTS anuncios (
      id SERIAL PRIMARY KEY,
      para VARCHAR(50) NOT NULL,
      titulo TEXT NOT NULL DEFAULT '',
      texto TEXT NOT NULL,
      por VARCHAR(50) NOT NULL DEFAULT '',
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cerrado TIMESTAMPTZ)`);
    // Accesos con vencimiento (demo): pasada la hora, el usuario ya no entra.
    await client.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS vence TIMESTAMPTZ');
    await client.query('ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS nota TEXT');
  }

  async function leer(fresca) {
    if (!fresca && guardada && Date.now() - leidaEn < 15000) return guardada;
    try {
      guardada = (await client.query('SELECT * FROM cuenta WHERE id = 1')).rows[0] || { estado: 'activa', modulos: {}, pago: {}, pagado: '' };
    } catch (e) {
      // Si la tabla no está, el panel sigue como siempre: activo y con todos los módulos.
      return { estado: 'activa', modulos: {}, pago: {}, pagado: '' };
    }
    leidaEn = Date.now();
    return guardada;
  }

  async function modulos() {
    const c = await leer();
    return Object.fromEntries(Object.entries(MODULOS).map(([k, m]) => [k, c.modulos && typeof c.modulos[k] === 'boolean' ? c.modulos[k] : m.porDefecto]));
  }

  async function tiene(modulo) {
    return (await modulos())[modulo] !== false;
  }

  // null si puede entrar; si no, el mensaje que se le muestra.
  async function motivoBloqueo(u) {
    if (u.vence && new Date(u.vence).getTime() < Date.now()) return 'Este acceso de prueba ya venció. Pide uno nuevo a Kaizen IA.';
    if (u.grupo === 'Programador') return null;
    const c = await leer();
    if (c.estado === 'pausada') return c.motivo || 'El servicio está en pausa. Comunícate con Kaizen IA.';
    return null;
  }

  async function usuarioPrincipal(c) {
    if (c.pago && c.pago.usuario) return c.pago.usuario;
    const r = await client.query("SELECT usuario FROM usuarios WHERE activo = TRUE AND grupo <> 'Programador' AND (permisos->>'administrar_usuarios')::boolean IS TRUE ORDER BY id LIMIT 1");
    return r.rows[0] ? r.rows[0].usuario : '';
  }

  async function textoPago(c, e) {
    const principal = await usuarioPrincipal(c);
    const nombre = principal ? ((await client.query('SELECT nombre FROM usuarios WHERE usuario = $1', [principal])).rows[0] || {}).nombre : '';
    const empresa = ((await client.query('SELECT nombre FROM empresa_datos WHERE id = 1')).rows[0] || {}).nombre || '';
    const pago = c.pago || {};
    const monto = pago.monto ? `${pago.moneda || 'US$'} ${pago.monto}` : '';
    const plantilla = (pago.mensajes && pago.mensajes[e.etapa]) || TEXTOS_PAGO[e.etapa];
    return {
      principal,
      texto: rellenar(plantilla, { usuario: nombre || principal, empresa, monto, fecha: fechaBonita(e.vence), dias: e.dias, moneda: pago.moneda || 'US$' })
    };
  }

  // Franjas que ve este usuario arriba del panel.
  async function franjas(u) {
    const lista = [];
    if (config.demo) {
      lista.push({ tipo: 'demo', texto: 'DEMO — Todos los datos son de ejemplo. Los correos no se envían de verdad.' + (u.vence ? ' Tu acceso vence el ' + new Date(u.vence).toLocaleString('es-DO', { timeZone: ZONA, dateStyle: 'short', timeStyle: 'short' }).replace(/\.$/, '') + '.' : '') });
    }
    const c = await leer();
    if (c.estado === 'pausada' && u.grupo === 'Programador') {
      lista.push({ tipo: 'pausa', texto: 'Cuenta en pausa: solo el programador puede entrar.' });
    }
    const e = etapaPago(c.pago, c.pagado);
    if (e) {
      const { principal, texto } = await textoPago(c, e);
      if (principal === u.usuario) lista.push({ tipo: 'pago-' + e.etapa, texto });
    }
    const anuncios = await client.query(
      'SELECT id, titulo, texto FROM anuncios WHERE cerrado IS NULL AND para = $1 ORDER BY id DESC LIMIT 3', [u.usuario]).catch(() => ({ rows: [] }));
    for (const a of anuncios.rows) lista.push({ tipo: 'anuncio', id: a.id, titulo: a.titulo, texto: a.texto });
    return lista;
  }

  // Cada anuncio es de una persona (un anuncio "para todos" se guarda uno por usuario).
  async function cerrarAnuncio(u, id) {
    await client.query('UPDATE anuncios SET cerrado = NOW() WHERE id = $1 AND para = $2 AND cerrado IS NULL', [Number(id), u.usuario]);
  }

  // Cada hora: si cambió la etapa del cobro, aviso en la campanita del usuario principal (una vez por etapa).
  async function revisarPago() {
    const c = await leer(true);
    const e = etapaPago(c.pago, c.pagado);
    if (!e) return;
    const marca = `${e.periodo}:${e.etapa}`;
    if (c.aviso_pago === marca) return;
    const { principal, texto } = await textoPago(c, e);
    if (!principal) return;
    await avisar([principal], texto, null);
    await client.query('UPDATE cuenta SET aviso_pago = $1 WHERE id = 1', [marca]);
    await registrar(SISTEMA, 'recordatorio_pago', 'cuenta', principal, '', marca, texto.slice(0, 300));
  }

  // Los accesos vencidos se desactivan (y con eso se cierran sus sesiones).
  async function desactivarVencidos() {
    const r = await client.query('UPDATE usuarios SET activo = FALSE WHERE activo = TRUE AND vence IS NOT NULL AND vence < NOW() RETURNING usuario');
    for (const x of r.rows) await registrar(SISTEMA, 'acceso_vencido', 'usuario', x.usuario, '', '', 'El acceso temporal venció');
  }

  return { preparar, leer, modulos, tiene, motivoBloqueo, franjas, cerrarAnuncio, revisarPago, desactivarVencidos };
};

module.exports.MODULOS = MODULOS;
module.exports.TEXTOS_PAGO = TEXTOS_PAGO;
module.exports.etapaPago = etapaPago;
module.exports.hoyLocal = hoyLocal;
module.exports.rellenar = rellenar;
