// CRM de redes y campañas (servicio aparte, por cliente).
// Lo ve el Programador siempre, y los demás usuarios solo si la empresa tiene el módulo "crm" contratado
// y el usuario tiene el permiso "ver_crm" que da el Programador.
// Tablas propias en la base de cada empresa.

const CANALES = ['whatsapp', 'instagram', 'messenger', 'tiktok', 'web', 'manual'];
const ETAPAS = ['nuevo', 'interesado', 'cotizado', 'cerrado', 'perdido'];
const DIRECCIONES = ['entrante', 'saliente', 'nota'];

module.exports = function crearCrm({ client, cuenta, registrar }) {
  const error = (m, codigo = 400) => Object.assign(new Error(m), { codigo });
  const texto = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const etiquetasDe = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => texto(x, 40)).filter(Boolean).slice(0, 20);

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
  }

  // Quién puede entrar: el Programador siempre; los demás, con el servicio contratado y el permiso.
  async function puede(u) {
    if (!u) return false;
    if (u.grupo === 'Programador') return true;
    if (!(await cuenta.tiene('crm'))) return false;
    return Boolean(u.permisos && u.permisos.ver_crm);
  }

  async function listar(p) {
    const q = texto(p.get('q'), 100).toLowerCase();
    const etapa = texto(p.get('etapa'), 20);
    const filas = (await client.query(`SELECT id, canal, identificador, nombre, telefono, correo, origen, etiquetas, etapa,
        TO_CHAR(creado, 'YYYY-MM-DD HH24:MI') AS creado FROM crm_contactos
        WHERE ($1 = '' OR etapa = $1)
          AND ($2 = '' OR lower(nombre) LIKE '%' || $2 || '%' OR lower(telefono) LIKE '%' || $2 || '%' OR lower(correo) LIKE '%' || $2 || '%')
        ORDER BY actualizado DESC LIMIT 200`, [etapa, q])).rows;
    return { contactos: filas, etapas: ETAPAS, canales: CANALES };
  }

  async function ver(id) {
    const c = (await client.query('SELECT * FROM crm_contactos WHERE id = $1', [id])).rows[0];
    if (!c) throw error('Ese contacto ya no existe.', 404);
    const mensajes = (await client.query(`SELECT id, direccion, texto, TO_CHAR(creado, 'YYYY-MM-DD HH24:MI') AS creado
      FROM crm_mensajes WHERE contacto_id = $1 ORDER BY creado DESC LIMIT 200`, [id])).rows;
    return { contacto: c, mensajes };
  }

  async function guardar(f, u) {
    const canal = CANALES.includes(f.canal) ? f.canal : 'manual';
    const etapa = ETAPAS.includes(f.etapa) ? f.etapa : 'nuevo';
    const nombre = texto(f.nombre, 120);
    const identificador = texto(f.identificador || f.telefono || f.correo || nombre, 120);
    if (!identificador) throw error('Escribe al menos el nombre, teléfono o correo de la persona.');
    const v = [canal, identificador, nombre, texto(f.telefono, 40), texto(f.correo, 120), texto(f.origen, 120),
      JSON.stringify(etiquetasDe(f.etiquetas)), etapa, texto(f.notas, 2000)];
    const id = Number(f.id) || 0;
    if (id) {
      const r = await client.query(`UPDATE crm_contactos SET canal=$1, identificador=$2, nombre=$3, telefono=$4, correo=$5,
        origen=$6, etiquetas=$7::jsonb, etapa=$8, notas=$9, actualizado=NOW() WHERE id=$10 RETURNING id`, [...v, id]);
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

  async function manejar(req, res, url, u, { json, leerCuerpo }) {
    if (!(await puede(u))) {
      if (u && u.grupo !== 'Programador' && !(await cuenta.tiene('crm'))) {
        return json(res, 403, { error: 'Tu empresa no tiene contratado el servicio CRM. Consulta con Kaizen IA.' });
      }
      return json(res, 403, { error: 'No tienes acceso al CRM. Pide al Programador que te dé el permiso «Ver CRM».' });
    }
    const p = new URL(req.url, 'http://localhost').searchParams;
    try {
      if (req.method === 'GET' && url === '/api/crm/contactos') return json(res, 200, await listar(p));
      const ficha = url.match(/^\/api\/crm\/contactos\/(\d+)$/);
      if (req.method === 'GET' && ficha) return json(res, 200, await ver(Number(ficha[1])));
      if (req.method === 'POST' && url === '/api/crm/contactos/guardar') return json(res, 200, await guardar(await leerCuerpo(req), u));
      if (req.method === 'POST' && url === '/api/crm/mensajes') return json(res, 200, await nota(await leerCuerpo(req), u));
      return json(res, 404, { error: 'No existe esa ruta del CRM.' });
    } catch (e) {
      return json(res, e.codigo || 500, { error: e.codigo ? e.message : 'No se pudo completar la acción del CRM.' });
    }
  }

  return { preparar, puede, manejar };
};
