// CRM de redes y campañas (servicio aparte, por cliente).
// Lo ve el Programador siempre, y los demás usuarios solo si la empresa tiene el módulo "crm" contratado
// y el usuario tiene el permiso "ver_crm" que da el Programador.
// Tablas propias en la base de cada empresa. Las conversaciones se traen de Chatwoot con la misma conexión
// que usa Operaciones (dirección, cuenta y token), para que automatización y CRM vayan juntos.

const CANALES = { whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger', tiktok: 'TikTok', web: 'Web / chat', manual: 'Carga manual' };
const ETAPAS_INICIALES = [
  { clave: 'nuevo', nombre: 'Nuevo' }, { clave: 'interesado', nombre: 'Interesado' }, { clave: 'cotizado', nombre: 'Cotizado' },
  { clave: 'cerrado', nombre: 'Cerrado' }, { clave: 'perdido', nombre: 'Perdido' }
];
const DIRECCIONES = ['entrante', 'saliente', 'nota'];
// Tipo de canal en Chatwoot → canal del CRM. Lo que no esté aquí entra como "web".
const CANAL_CHATWOOT = {
  'Channel::Whatsapp': 'whatsapp', 'Channel::FacebookPage': 'messenger', 'Channel::Instagram': 'instagram',
  'Channel::Tiktok': 'tiktok', 'Channel::WebWidget': 'web'
};
const PAGINA_CHATWOOT = 25;   // Chatwoot devuelve 25 conversaciones por página
const PAGINAS_MAX = 8;        // hasta 200 conversaciones por sincronización

module.exports = function crearCrm({ client, cuenta, registrar, chatwoot }) {
  const error = (m, codigo = 400) => Object.assign(new Error(m), { codigo });
  const texto = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const etiquetasDe = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => texto(x, 40)).filter(Boolean).slice(0, 20);
  const claveDe = t => texto(t, 60).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'etapa';

  async function preparar() {
    await client.query(`CREATE TABLE IF NOT EXISTS crm_contactos (
      id SERIAL PRIMARY KEY, canal TEXT NOT NULL, identificador TEXT NOT NULL, nombre TEXT NOT NULL DEFAULT '',
      telefono TEXT NOT NULL DEFAULT '', correo TEXT NOT NULL DEFAULT '', origen TEXT NOT NULL DEFAULT '',
      etiquetas JSONB NOT NULL DEFAULT '[]', etapa TEXT NOT NULL DEFAULT 'nuevo', notas TEXT NOT NULL DEFAULT '',
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (canal, identificador))`);
    await client.query(`CREATE TABLE IF NOT EXISTS crm_mensajes (
      id SERIAL PRIMARY KEY, contacto_id INTEGER NOT NULL REFERENCES crm_contactos(id) ON DELETE CASCADE,
      direccion TEXT NOT NULL, texto TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // ref: número del mensaje en Chatwoot (para no guardarlo dos veces). Las notas a mano no lo llevan.
    await client.query("ALTER TABLE crm_mensajes ADD COLUMN IF NOT EXISTS ref TEXT NOT NULL DEFAULT ''");
    await client.query("CREATE UNIQUE INDEX IF NOT EXISTS crm_mensajes_ref ON crm_mensajes (contacto_id, ref) WHERE ref <> ''");
    await client.query(`CREATE TABLE IF NOT EXISTS crm_etapas (
      clave TEXT PRIMARY KEY, nombre TEXT NOT NULL, orden INTEGER NOT NULL DEFAULT 0, activa BOOLEAN NOT NULL DEFAULT TRUE)`);
    if (!(await client.query('SELECT 1 FROM crm_etapas LIMIT 1')).rowCount) {
      for (const [i, e] of ETAPAS_INICIALES.entries()) {
        await client.query('INSERT INTO crm_etapas (clave, nombre, orden) VALUES ($1, $2, $3)', [e.clave, e.nombre, i + 1]);
      }
    }
    await client.query(`CREATE TABLE IF NOT EXISTS crm_config (clave TEXT PRIMARY KEY, valor JSONB NOT NULL DEFAULT '{}'::jsonb)`);
  }

  // Quién puede entrar: el Programador siempre; los demás, con el servicio contratado y el permiso.
  async function puede(u) {
    if (!u) return false;
    if (u.grupo === 'Programador') return true;
    if (!(await cuenta.tiene('crm'))) return false;
    return Boolean(u.permisos && u.permisos.ver_crm);
  }
  // Cambiar las etapas: el Programador, o quien tenga "Configurar empresa".
  const puedeEditarEtapas = u => Boolean(u && (u.grupo === 'Programador' || (u.permisos && u.permisos.configurar_empresa)));

  // Para el panel: solo dice si se ve el botón del CRM (sin llamar a Chatwoot).
  async function estadoPublico(u) {
    return { puedeVer: await puede(u), servicio: await cuenta.tiene('crm') };
  }

  async function etapas() {
    return (await client.query('SELECT clave, nombre, activa FROM crm_etapas ORDER BY orden, clave')).rows;
  }

  async function estado(u) {
    const cw = chatwoot ? await chatwoot().catch(() => null) : null;
    const sync = (await client.query("SELECT valor FROM crm_config WHERE clave = 'sincronizacion'")).rows[0];
    return {
      puedeVer: true, servicio: await cuenta.tiene('crm'), editarEtapas: puedeEditarEtapas(u),
      chatwoot: Boolean(cw && cw.url && cw.cuenta && cw.token), sincronizado: sync ? sync.valor : null,
      etapas: await etapas(), canales: CANALES
    };
  }

  async function listar(p) {
    const q = texto(p.get('q'), 100).toLowerCase();
    const etapa = texto(p.get('etapa'), 60);
    const filas = (await client.query(`SELECT id, canal, identificador, nombre, telefono, correo, origen, etiquetas, etapa,
        TO_CHAR(actualizado, 'YYYY-MM-DD HH24:MI') AS actualizado FROM crm_contactos
        WHERE ($1 = '' OR etapa = $1)
          AND ($2 = '' OR lower(nombre) LIKE '%' || $2 || '%' OR lower(telefono) LIKE '%' || $2 || '%' OR lower(correo) LIKE '%' || $2 || '%')
        ORDER BY actualizado DESC LIMIT 200`, [etapa, q])).rows;
    const conteos = Object.fromEntries((await client.query('SELECT etapa, COUNT(*)::int AS n FROM crm_contactos GROUP BY etapa')).rows.map(r => [r.etapa, r.n]));
    return { contactos: filas, conteos, total: Object.values(conteos).reduce((s, n) => s + n, 0) };
  }

  async function ver(id) {
    const c = (await client.query('SELECT * FROM crm_contactos WHERE id = $1', [id])).rows[0];
    if (!c) throw error('Ese contacto ya no existe.', 404);
    const mensajes = (await client.query(`SELECT id, direccion, texto, TO_CHAR(creado, 'YYYY-MM-DD HH24:MI') AS creado
      FROM crm_mensajes WHERE contacto_id = $1 ORDER BY creado DESC LIMIT 200`, [id])).rows;
    return { contacto: c, mensajes };
  }

  async function guardar(f, u) {
    const canal = Object.prototype.hasOwnProperty.call(CANALES, f.canal) ? f.canal : 'manual';
    const etapa = texto(f.etapa, 60) || 'nuevo';
    if (!(await client.query('SELECT 1 FROM crm_etapas WHERE clave = $1 AND activa', [etapa])).rowCount) throw error('Esa etapa no existe o está apagada.');
    const nombre = texto(f.nombre, 120);
    const identificador = texto(f.identificador || f.telefono || f.correo || nombre, 120);
    if (!identificador) throw error('Escribe al menos el nombre, teléfono o correo de la persona.');
    const v = [canal, identificador, nombre, texto(f.telefono, 40), texto(f.correo, 120), texto(f.origen, 120),
      JSON.stringify(etiquetasDe(f.etiquetas)), etapa, texto(f.notas, 2000)];
    const id = Number(f.id) || 0;
    if (id) {
      let r;
      try {
        r = await client.query(`UPDATE crm_contactos SET canal=$1, identificador=$2, nombre=$3, telefono=$4, correo=$5,
          origen=$6, etiquetas=$7::jsonb, etapa=$8, notas=$9, actualizado=NOW() WHERE id=$10 RETURNING id`, [...v, id]);
      } catch (e) {
        if (e.code === '23505') throw error('Ya existe otra persona con ese dato en este canal.', 409);
        throw e;
      }
      if (!r.rows[0]) throw error('Ese contacto ya no existe.', 404);
      await registrar(u, 'crm_contactos', 'crm', nombre || identificador, '', '', 'editado');
      return { id };
    }
    const existe = (await client.query('SELECT id FROM crm_contactos WHERE canal = $1 AND identificador = $2', [canal, identificador])).rows[0];
    if (existe) throw error('Ya existe una persona con ese dato en este canal.', 409);
    const r = await client.query(`INSERT INTO crm_contactos (canal, identificador, nombre, telefono, correo, origen, etiquetas, etapa, notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id`, v);
    await registrar(u, 'crm_contactos', 'crm', nombre || identificador, '', '', 'creado');
    return { id: r.rows[0].id };
  }

  async function nota(f, u) {
    const contacto = Number(f.contacto_id) || 0;
    const direccion = DIRECCIONES.includes(f.direccion) ? f.direccion : 'nota';
    const t = texto(f.texto, 2000);
    if (!contacto) throw error('Falta la persona.');
    if (!t) throw error('Escribe el mensaje o la nota.');
    const existe = (await client.query('SELECT 1 FROM crm_contactos WHERE id = $1', [contacto])).rowCount;
    if (!existe) throw error('Ese contacto ya no existe.', 404);
    await client.query('INSERT INTO crm_mensajes (contacto_id, direccion, texto) VALUES ($1, $2, $3)', [contacto, direccion, t]);
    await client.query('UPDATE crm_contactos SET actualizado = NOW() WHERE id = $1', [contacto]);
    await registrar(u, 'crm_mensajes', 'crm', String(contacto), '', '', direccion);
    return { ok: true };
  }

  async function guardarEtapas(f, u) {
    if (!puedeEditarEtapas(u)) throw error('Solo el Programador o quien tenga «Configurar empresa» puede cambiar las etapas.', 403);
    const lista = Array.isArray(f.etapas) ? f.etapas.slice(0, 20) : [];
    if (!lista.length) throw error('Debe quedar al menos una etapa.');
    if (!lista.some(e => e && e.activa !== false && texto(e.nombre, 40))) throw error('Debe quedar al menos una etapa activa.');
    const existentes = (await client.query('SELECT clave FROM crm_etapas')).rows.map(r => r.clave);
    const usadas = new Set();
    for (const [i, e] of lista.entries()) {
      const nombre = texto(e && e.nombre, 40);
      if (!nombre) throw error('Cada etapa necesita un nombre.');
      let clave = texto(e.clave, 60);
      if (!clave || !existentes.includes(clave)) {
        const base = claveDe(nombre); clave = base; let n = 2;
        while (existentes.includes(clave) || usadas.has(clave)) clave = base + '_' + (n++);
      }
      if (usadas.has(clave)) throw error('Hay dos etapas con el mismo nombre.');
      usadas.add(clave);
      await client.query(`INSERT INTO crm_etapas (clave, nombre, orden, activa) VALUES ($1, $2, $3, $4)
        ON CONFLICT (clave) DO UPDATE SET nombre = EXCLUDED.nombre, orden = EXCLUDED.orden, activa = EXCLUDED.activa`,
        [clave, nombre, i + 1, e.activa !== false]);
    }
    // Las etapas quitadas no se borran: hay personas en ellas. Solo se apagan.
    await client.query('UPDATE crm_etapas SET activa = FALSE WHERE NOT (clave = ANY($1::text[]))', [[...usadas]]);
    await registrar(u, 'crm_etapas', 'crm', 'etapas', '', '', 'editadas');
    return { ok: true };
  }

  // Trae de Chatwoot las conversaciones, sus personas y sus mensajes. Repetirla no duplica nada.
  async function sincronizar(u) {
    const cw = chatwoot ? await chatwoot() : null;
    if (!cw || !cw.url || !cw.cuenta || !cw.token) {
      throw error('Chatwoot no está configurado en esta empresa. El Programador lo configura en Operaciones (WhatsApp).');
    }
    const base = String(cw.url).replace(/\/$/, '') + '/api/v1/accounts/' + encodeURIComponent(cw.cuenta);
    const pedir = async ruta => {
      let r;
      try {
        r = await fetch(base + ruta, { headers: { api_access_token: cw.token }, signal: AbortSignal.timeout(15000) });
      } catch (e) {
        throw error(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'Chatwoot no respondió en 15 segundos.' : 'No hay conexión con Chatwoot: ' + e.message, 502);
      }
      if (!r.ok) throw error(`Chatwoot respondió ${r.status}${r.status === 401 ? ' (token no válido)' : ''}.`, 502);
      return r.json();
    };
    let contactosNuevos = 0, mensajesNuevos = 0, conversaciones = 0;
    for (let pagina = 1; pagina <= PAGINAS_MAX; pagina++) {
      const lista = (await pedir(`/conversations?status=all&page=${pagina}`))?.data?.payload || [];
      for (const conv of lista) {
        const sender = conv.meta && conv.meta.sender;
        if (!sender) continue;
        conversaciones++;
        const canal = CANAL_CHATWOOT[(conv.meta && conv.meta.channel) || ''] || 'web';
        const telefono = String(sender.phone_number || '');
        const identificador = canal === 'whatsapp' && telefono ? telefono.replace(/\D/g, '') : (sender.identifier || ('cw-' + sender.id));
        const r = await client.query(`INSERT INTO crm_contactos (canal, identificador, nombre, telefono, correo, origen)
          VALUES ($1, $2, $3, $4, $5, 'Chatwoot')
          ON CONFLICT (canal, identificador) DO UPDATE SET
            nombre = CASE WHEN crm_contactos.nombre = '' THEN EXCLUDED.nombre ELSE crm_contactos.nombre END,
            telefono = CASE WHEN crm_contactos.telefono = '' THEN EXCLUDED.telefono ELSE crm_contactos.telefono END,
            correo = CASE WHEN crm_contactos.correo = '' THEN EXCLUDED.correo ELSE crm_contactos.correo END
          RETURNING id, (xmax = 0) AS nuevo`, [canal, identificador, texto(sender.name, 120), texto(telefono, 40), texto(sender.email, 120)]);
        const contactoId = r.rows[0].id;
        if (r.rows[0].nuevo) contactosNuevos++;
        const mensajes = (await pedir(`/conversations/${conv.id}/messages`))?.payload || [];
        for (const m of mensajes) {
          if (![0, 1].includes(m.message_type) || m.private || !texto(m.content, 2000)) continue;
          const ins = await client.query(`INSERT INTO crm_mensajes (contacto_id, direccion, texto, creado, ref)
            VALUES ($1, $2, $3, TO_TIMESTAMP($4), $5)
            ON CONFLICT (contacto_id, ref) WHERE ref <> '' DO NOTHING`,
            [contactoId, m.message_type === 0 ? 'entrante' : 'saliente', texto(m.content, 2000), Number(m.created_at) || Date.now() / 1000, 'cw-' + m.id]);
          mensajesNuevos += ins.rowCount;
        }
        await client.query(`UPDATE crm_contactos SET actualizado = GREATEST(actualizado,
          (SELECT COALESCE(MAX(creado), actualizado) FROM crm_mensajes WHERE contacto_id = $1)) WHERE id = $1`, [contactoId]);
      }
      if (lista.length < PAGINA_CHATWOOT) break;
    }
    const resumen = { contactos_nuevos: contactosNuevos, mensajes_nuevos: mensajesNuevos, conversaciones, en: new Date().toISOString() };
    await client.query(`INSERT INTO crm_config (clave, valor) VALUES ('sincronizacion', $1)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`, [JSON.stringify(resumen)]);
    await registrar(u, 'crm_contactos', 'crm', 'Chatwoot', '', '', 'sincronizado');
    return resumen;
  }

  async function manejar(req, res, url, u, { json, leerCuerpo }) {
    if (!(await puede(u))) {
      if (u && u.grupo !== 'Programador' && !(await cuenta.tiene('crm'))) {
        return json(res, 403, { error: 'Tu empresa no tiene contratado el servicio CRM. Consulta con Kaizen IA.' });
      }
      return json(res, 403, { error: 'No tienes acceso al CRM. Pide al Programador que te dé el permiso «Ver CRM».' });
    }
    const p = new URL(req.url, 'http://localhost').searchParams;
    try {
      if (req.method === 'GET' && url === '/api/crm/estado') return json(res, 200, await estado(u));
      if (req.method === 'GET' && url === '/api/crm/contactos') return json(res, 200, await listar(p));
      const ficha = url.match(/^\/api\/crm\/contactos\/(\d+)$/);
      if (req.method === 'GET' && ficha) return json(res, 200, await ver(Number(ficha[1])));
      if (req.method === 'POST' && url === '/api/crm/contactos/guardar') return json(res, 200, await guardar(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/mensajes') return json(res, 200, await nota(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/etapas/guardar') return json(res, 200, await guardarEtapas(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/sincronizar') return json(res, 200, await sincronizar(u));
      return json(res, 404, { error: 'No existe esa ruta del CRM.' });
    } catch (e) {
      if (!e.codigo) console.log('CRM:', e.message);
      return json(res, e.codigo || 500, { error: e.codigo ? e.message : 'No se pudo completar la acción del CRM.' });
    }
  }

  return { preparar, puede, estadoPublico, manejar };
};
