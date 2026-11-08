// Conector con Chatwoot (redes sociales): cada mensaje nuevo de un cliente en Facebook, Instagram o WhatsApp
// llega aquí (webhook de Chatwoot). El asistente prepara la respuesta con la base de la sede de esa bandeja y:
//   - modo "nota": la deja como NOTA PRIVADA para el asesor (al cliente no le llega nada),
//   - modo "responder": se la envía al cliente,
//   - modo "apagado": no hace nada.
// Si hay que pasar a un asesor, asigna la conversación al equipo de la sede y le pone la etiqueta "asesor".
// Mide la tasa de acierto: compara cada sugerencia con lo que el asesor envió de verdad.
//
// Chatwoot -> Ajustes -> Integraciones -> Webhooks -> URL: http://host.docker.internal:PUERTO/api/chatwoot/evento?clave=...  (evento: Mensaje creado)

const crypto = require('crypto');

const MODOS = { apagado: 'Apagado', nota: 'Nota privada para el asesor', responder: 'Responde solo al cliente' };
const ESPERA_MS = 4000;          // se espera a que el cliente termine de escribir ("hola" "hola" "precio?")
const ETIQUETA_ASESOR = 'asesor';

function normal(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ$ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Parecido entre dos textos (0 a 1), por distancia de edición.
function parecido(a, b) {
  a = normal(a).slice(0, 1500); b = normal(b).slice(0, 1500);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
const resultadoDe = p => p >= 0.95 ? 'igual' : p >= 0.6 ? 'editada' : 'distinta';
const IDIOMAS = { es: 'español', pt: 'portugués', en: 'inglés', fr: 'francés', it: 'italiano', de: 'alemán' };

module.exports = function crearRedes({ client, registrar, central, conocimiento }) {
  const activo = central.activo;
  const esperas = new Map();      // conversación -> temporizador (espera a que el cliente termine)
  const vistos = new Set();       // mensajes ya procesados (Chatwoot puede repetir el aviso)
  const propios = new Set();      // mensajes que mandó el asistente (para no contarlos como del asesor)

  async function preparar() {
    if (!activo) return;
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS chatwoot JSONB NOT NULL DEFAULT '{}'");
    await client.query(`CREATE TABLE IF NOT EXISTS redes_sugerencias (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL, bandeja INTEGER NOT NULL, conversacion INTEGER NOT NULL, sede TEXT NOT NULL DEFAULT '',
      modo VARCHAR(10) NOT NULL DEFAULT 'nota', cliente TEXT NOT NULL DEFAULT '', sugerencia TEXT NOT NULL DEFAULT '', idioma VARCHAR(5) NOT NULL DEFAULT '',
      pasar_a_asesor BOOLEAN NOT NULL DEFAULT FALSE, motivo VARCHAR(20) NOT NULL DEFAULT '', enviada TEXT, parecido NUMERIC(4,3),
      resultado VARCHAR(14) NOT NULL DEFAULT 'pendiente', error TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), respondido TIMESTAMPTZ)`);
    await client.query('CREATE INDEX IF NOT EXISTS redes_sugerencias_conv ON redes_sugerencias (empresa_id, conversacion, resultado)');
  }

  const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);
  const error = (msg, codigo = 400) => Object.assign(new Error(msg), { codigo });
  async function empresa(id) {
    const e = (await client.query('SELECT id, nombre, slug, chatwoot, conocimiento_sedes FROM empresas WHERE id = $1', [Number(id)])).rows[0];
    if (!e) throw error('Empresa no encontrada.', 404);
    return e;
  }
  const ajustes = e => {
    const c = e.chatwoot || {};
    return { url: c.url || 'http://localhost:3000', publico: c.publico || 'https://redes.kaizenia.app', cuenta: Number(c.cuenta) || 0, token: c.token || '',
      clave: c.clave || '', bandejas: c.bandejas || {}, equipos: c.equipos || {} };
  };

  // ---------- API de Chatwoot ----------
  async function cw(aj, metodo, ruta, cuerpo) {
    if (!aj.token || !aj.cuenta) throw error('Falta el token o el número de cuenta de Chatwoot.');
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 15000);
    try {
      const r = await fetch(aj.url.replace(/\/$/, '') + `/api/v1/accounts/${aj.cuenta}` + ruta, {
        method: metodo, signal: control.signal,
        headers: { api_access_token: aj.token, 'Content-Type': 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw error(`Chatwoot respondió ${r.status}${r.status === 401 ? ' (token no válido)' : r.status === 404 ? ' (cuenta o conversación no encontrada)' : ''}: ${d.message || d.error || ''}`.trim(), 502);
      return d;
    } catch (err) {
      if (err.codigo) throw err;
      throw error(err.name === 'AbortError' ? 'Chatwoot no respondió en 15 s.' : `No hay conexión con Chatwoot (${aj.url}): ${err.message}`, 502);
    } finally { clearTimeout(reloj); }
  }
  const lista = d => Array.isArray(d) ? d : Array.isArray(d.payload) ? d.payload : Array.isArray(d.data) ? d.data : (d.data && Array.isArray(d.data.payload) ? d.data.payload : []);

  async function historial(aj, conv) {
    const d = await cw(aj, 'GET', `/conversations/${conv}/messages`);
    return lista(d)
      .filter(m => !m.private && (m.message_type === 0 || m.message_type === 1 || m.message_type === 'incoming' || m.message_type === 'outgoing') && String(m.content || '').trim())
      .sort((a, b) => (a.created_at || 0) - (b.created_at || 0) || a.id - b.id)
      .map(m => ({ rol: (m.message_type === 0 || m.message_type === 'incoming') ? 'cliente' : 'asistente', texto: String(m.content) }))
      .slice(-12);
  }

  async function etiquetar(aj, conv, nuevas) {
    try {
      for (const t of nuevas) await cw(aj, 'POST', '/labels', { title: t, color: t === ETIQUETA_ASESOR ? '#F59E0B' : '#6366F1', show_on_sidebar: true }).catch(() => {});
      const d = await cw(aj, 'GET', `/conversations/${conv}/labels`).catch(() => ({}));
      const ya = lista(d).map(String);
      await cw(aj, 'POST', `/conversations/${conv}/labels`, { labels: [...new Set([...ya, ...nuevas])] });
    } catch (err) { /* sin etiqueta no se pierde nada */ }
  }

  // ---------- Atender un mensaje del cliente ----------
  async function atender(empresaId, bandeja, conv) {
    const e = await empresa(empresaId);
    const aj = ajustes(e);
    const b = aj.bandejas[String(bandeja)];
    if (!b || !b.modo || b.modo === 'apagado') return;
    const sede = b.sede || '';
    let fila;
    try {
      const mensajes = await historial(aj, conv);
      if (!mensajes.length || mensajes[mensajes.length - 1].rol !== 'cliente') return;
      // La sugerencia anterior que nadie respondió queda "sin respuesta".
      await client.query("UPDATE redes_sugerencias SET resultado = 'sin_respuesta' WHERE empresa_id = $1 AND conversacion = $2 AND resultado = 'pendiente'", [e.id, conv]);
      const r = await conocimiento.responder(e.id, { sede, mensajes });
      const ultimoCliente = mensajes.filter(m => m.rol === 'cliente').slice(-1)[0].texto;
      fila = (await client.query(`INSERT INTO redes_sugerencias (empresa_id, bandeja, conversacion, sede, modo, cliente, sugerencia, idioma, pasar_a_asesor, motivo)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [e.id, bandeja, conv, sede, b.modo, ultimoCliente.slice(0, 2000), r.respuesta, r.idioma || '', r.pasar_a_asesor, r.motivo || ''])).rows[0];
      if (b.modo === 'responder') {
        const m = await cw(aj, 'POST', `/conversations/${conv}/messages`, { content: r.respuesta, message_type: 'outgoing', private: false });
        if (m && m.id) propios.add(String(m.id));
        await client.query("UPDATE redes_sugerencias SET resultado = 'automatica', enviada = sugerencia, parecido = 1, respondido = NOW() WHERE id = $1", [fila.id]);
        if (r.pasar_a_asesor) {
          const nota = `🤖 El asistente pasó la conversación a un asesor${r.motivo_texto ? ` (${r.motivo_texto})` : ''}.${r.resumen_para_asesor ? `\n\n📝 ${r.resumen_para_asesor}` : ''}`;
          const n = await cw(aj, 'POST', `/conversations/${conv}/messages`, { content: nota, message_type: 'outgoing', private: true });
          if (n && n.id) propios.add(String(n.id));
        }
      } else {
        const partes = [`🤖 Sugerencia del asistente${r.idioma && r.idioma !== 'es' ? ` (en ${IDIOMAS[r.idioma] || r.idioma})` : ''} — revísala, cópiala y envíala:`, '', r.respuesta];
        if (r.pasar_a_asesor) partes.push('', `👤 Pasar a un asesor de ${sede || 'la oficina'}${r.motivo_texto ? ` · ${r.motivo_texto}` : ''}`, r.resumen_para_asesor ? `📝 ${r.resumen_para_asesor}` : '');
        const n = await cw(aj, 'POST', `/conversations/${conv}/messages`, { content: partes.filter(x => x !== undefined).join('\n').trim(), message_type: 'outgoing', private: true });
        if (n && n.id) propios.add(String(n.id));
      }
      if (r.pasar_a_asesor) {
        const equipo = aj.equipos[sede];
        if (equipo) await cw(aj, 'POST', `/conversations/${conv}/assignments`, { team_id: Number(equipo) }).catch(() => {});
        await etiquetar(aj, conv, [ETIQUETA_ASESOR, ...(r.motivo ? [r.motivo.replace(/_/g, '-')] : [])]);
      }
    } catch (err) {
      if (fila) await client.query("UPDATE redes_sugerencias SET error = $1 WHERE id = $2", [String(err.message).slice(0, 500), fila.id]);
      else await client.query(`INSERT INTO redes_sugerencias (empresa_id, bandeja, conversacion, sede, modo, resultado, error) VALUES ($1,$2,$3,$4,$5,'error',$6)`,
        [e.id, bandeja, conv, sede, b.modo, String(err.message).slice(0, 500)]).catch(() => {});
      console.log('Redes: no se pudo atender la conversación', conv, '-', err.message);
    }
  }

  // El asesor respondió: se compara con la última sugerencia pendiente.
  async function medir(empresaId, conv, contenido) {
    const s = (await client.query("SELECT id, sugerencia FROM redes_sugerencias WHERE empresa_id = $1 AND conversacion = $2 AND resultado = 'pendiente' ORDER BY id DESC LIMIT 1", [empresaId, conv])).rows[0];
    if (!s) return;
    const p = parecido(s.sugerencia, contenido);
    await client.query('UPDATE redes_sugerencias SET enviada = $1, parecido = $2, resultado = $3, respondido = NOW() WHERE id = $4',
      [String(contenido).slice(0, 3000), Math.round(p * 1000) / 1000, resultadoDe(p), s.id]);
  }

  // ---------- Aviso de Chatwoot (sin sesión, con la clave de la URL) ----------
  async function empresaPorClave(clave, cuenta) {
    if (!clave || clave.length < 20) return null;
    const filas = (await client.query("SELECT id, chatwoot FROM empresas WHERE chatwoot->>'clave' IS NOT NULL")).rows;
    const dada = Buffer.from(clave);
    return filas.find(e => {
      const c = Buffer.from(String(e.chatwoot.clave || ''));
      return c.length === dada.length && crypto.timingSafeEqual(c, dada) && (!cuenta || Number(e.chatwoot.cuenta) === Number(cuenta));
    }) || null;
  }
  async function manejarPublico(req, res, url, { json, leerCuerpo }) {
    if (!activo) return json(res, 404, { error: 'Solo existe en el panel central.' });
    if (url !== '/api/chatwoot/evento') return json(res, 404, { error: 'Ruta no encontrada' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Solo POST.' });
    const clave = new URL(req.url, 'http://localhost').searchParams.get('clave') || '';
    let ev;
    try { ev = await leerCuerpo(req); } catch (err) { return json(res, 400, { error: 'Cuerpo no válido' }); }
    const e = await empresaPorClave(clave, ev.account && ev.account.id);
    if (!e) return json(res, 401, { error: 'Clave no válida.' });
    json(res, 200, { ok: true });   // se contesta enseguida; el trabajo sigue aparte
    try {
      if (ev.event !== 'message_created') return;
      const id = String(ev.id || '');
      if (id) { if (vistos.has(id)) return; vistos.add(id); if (vistos.size > 5000) vistos.clear(); }
      const conv = Number((ev.conversation && (ev.conversation.display_id ?? ev.conversation.id)) || 0);
      const bandeja = Number((ev.conversation && ev.conversation.inbox_id) || (ev.inbox && ev.inbox.id) || 0);
      if (!conv || !bandeja) return;
      const tipo = ev.message_type;
      const entrante = tipo === 'incoming' || tipo === 0;
      const saliente = tipo === 'outgoing' || tipo === 1;
      if (ev.private) return;
      if (entrante) {
        const k = e.id + ':' + conv;
        clearTimeout(esperas.get(k));
        esperas.set(k, setTimeout(() => { esperas.delete(k); atender(e.id, bandeja, conv); }, ESPERA_MS));
      } else if (saliente && String(ev.content || '').trim() && !propios.has(id)) {
        const quien = ev.sender && String(ev.sender.type || '').toLowerCase();
        if (!quien || quien === 'user' || quien === 'agent') await medir(e.id, conv, ev.content);
      }
    } catch (err) { console.log('Redes: aviso de Chatwoot con error -', err.message); }
  }

  // ---------- Oficina ----------
  async function estado(e) {
    const aj = ajustes(e);
    const stats = (await client.query(`SELECT sede, resultado, COUNT(*)::int AS n FROM redes_sugerencias
      WHERE empresa_id = $1 AND creado > NOW() - INTERVAL '30 days' GROUP BY 1, 2`, [e.id])).rows;
    const porSede = {};
    for (const s of stats) {
      const x = porSede[s.sede || 'Sin sede'] = porSede[s.sede || 'Sin sede'] || { total: 0 };
      x[s.resultado] = s.n; x.total += s.n;
    }
    for (const x of Object.values(porSede)) {
      const medidas = (x.igual || 0) + (x.editada || 0) + (x.distinta || 0);
      x.acierto = medidas ? Math.round((x.igual || 0) / medidas * 100) : null;
      x.medidas = medidas;
    }
    const ultimas = (await client.query(`SELECT id, bandeja, conversacion, sede, modo, cliente, sugerencia, enviada, parecido, resultado, pasar_a_asesor, motivo, error, creado
      FROM redes_sugerencias WHERE empresa_id = $1 ORDER BY id DESC LIMIT 25`, [e.id])).rows;
    return {
      url: aj.url, publico: aj.publico, cuenta: aj.cuenta || '', tieneToken: Boolean(aj.token), clave: aj.clave,
      bandejas: aj.bandejas, equipos: aj.equipos, porSede, ultimas, modos: MODOS
    };
  }

  async function manejarOficina(req, res, url, u, { json, leerCuerpo }) {
    const p = new URL(req.url, 'http://localhost').searchParams;
    if (req.method === 'GET' && url === '/api/oficina/redes') {
      const e = await empresa(p.get('empresa'));
      return json(res, 200, await estado(e));
    }
    if (req.method === 'POST' && url === '/api/oficina/redes/guardar') {
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      const actual = e.chatwoot || {};
      const nuevo = { ...actual };
      if (f.url !== undefined) {
        const v = texto(f.url, 200).replace(/\/$/, '');
        if (v && !/^https?:\/\/[^\s]+$/.test(v)) throw error('La dirección de Chatwoot debe empezar con http:// o https://');
        nuevo.url = v || 'http://localhost:3000';
      }
      if (f.publico !== undefined) nuevo.publico = texto(f.publico, 200).replace(/\/$/, '') || 'https://redes.kaizenia.app';
      if (f.cuenta !== undefined) nuevo.cuenta = Number(f.cuenta) || 0;
      if (f.token) nuevo.token = texto(f.token, 200);
      if (!nuevo.clave) nuevo.clave = crypto.randomBytes(20).toString('hex');
      if (f.bandejas && typeof f.bandejas === 'object') {
        const sedes = String(e.conocimiento_sedes || '').split(',').map(s => s.trim()).filter(Boolean);
        nuevo.bandejas = {};
        for (const [id, b] of Object.entries(f.bandejas)) {
          if (!/^\d+$/.test(id)) continue;
          nuevo.bandejas[id] = { nombre: texto(b.nombre, 80), sede: sedes.includes(b.sede) ? b.sede : '', modo: MODOS[b.modo] ? b.modo : 'apagado' };
        }
      }
      if (f.equipos && typeof f.equipos === 'object') {
        nuevo.equipos = {};
        for (const [sede, id] of Object.entries(f.equipos)) if (Number(id)) nuevo.equipos[texto(sede, 60)] = Number(id);
      }
      await client.query('UPDATE empresas SET chatwoot = $1 WHERE id = $2', [JSON.stringify(nuevo), e.id]);
      await registrar(u, 'redes_ajustes', 'empresa', e.slug, '', '', f.token ? 'token nuevo' : (f.bandejas ? 'bandejas' : 'ajustes'));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/oficina/redes/probar') {
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      const aj = ajustes(e);
      const bandejas = lista(await cw(aj, 'GET', '/inboxes')).map(b => ({ id: b.id, nombre: b.name, canal: String(b.channel_type || '').replace('Channel::', '') }));
      const equipos = lista(await cw(aj, 'GET', '/teams').catch(() => [])).map(t => ({ id: t.id, nombre: t.name }));
      return json(res, 200, { ok: true, bandejas, equipos });
    }
    if (req.method === 'POST' && url === '/api/oficina/redes/equipo') {
      // Crea en Chatwoot el equipo de una sede (ej. "Punta Cana") y lo deja elegido.
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      const aj = ajustes(e);
      const nombre = texto(f.sede, 60);
      if (!nombre) throw error('Falta la sede.');
      const t = await cw(aj, 'POST', '/teams', { name: nombre, description: `Asesores de ${nombre}`, allow_auto_assign: true });
      const nuevo = { ...(e.chatwoot || {}), equipos: { ...(ajustes(e).equipos), [nombre]: t.id } };
      await client.query('UPDATE empresas SET chatwoot = $1 WHERE id = $2', [JSON.stringify(nuevo), e.id]);
      return json(res, 200, { ok: true, equipo: { id: t.id, nombre: t.name } });
    }
    return json(res, 404, { error: 'Ruta no encontrada' });
  }

  return { activo, preparar, manejarPublico, manejarOficina, _probar: { parecido, resultadoDe } };
};
