// Conector con Chatwoot (redes sociales): cada mensaje nuevo de un cliente en Facebook, Instagram o WhatsApp
// llega aquí (webhook de Chatwoot). El asistente prepara la respuesta con la base de la sede de esa bandeja y:
//   - modo "nota": la deja como NOTA PRIVADA para el asesor (al cliente no le llega nada),
//   - modo "responder": se la envía al cliente,
//   - modo "apagado": no hace nada.
// Si hay que pasar a un asesor, asigna la conversación al equipo de la sede y le pone la etiqueta "asesor".
// Mide la tasa de acierto: compara cada sugerencia con lo que el asesor envió de verdad.
//
// Cómo se entera: el central le pregunta a Chatwoot cada 5 segundos si hay mensajes nuevos (no hace falta webhook:
// Chatwoot no acepta webhooks hacia direcciones internas). El webhook /api/chatwoot/evento sigue disponible si algún día
// el central tiene una dirección pública.

const crypto = require('crypto');

const MODOS = { apagado: 'Apagado', nota: 'Nota privada para el asesor', responder: 'Responde solo al cliente' };
const ESPERA_MS = 4000;          // se espera a que el cliente termine de escribir ("hola" "hola" "precio?")
const REVISAR_MS = 5000;         // cada cuánto se le pregunta a Chatwoot si hay mensajes nuevos
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
  const respondido = new Map();   // conversación -> último mensaje del cliente que ya se atendió

  async function preparar() {
    if (!activo) return;
    await client.query("ALTER TABLE empresas ADD COLUMN IF NOT EXISTS chatwoot JSONB NOT NULL DEFAULT '{}'");
    await client.query(`CREATE TABLE IF NOT EXISTS redes_sugerencias (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL, bandeja INTEGER NOT NULL, conversacion INTEGER NOT NULL, sede TEXT NOT NULL DEFAULT '',
      modo VARCHAR(10) NOT NULL DEFAULT 'nota', cliente TEXT NOT NULL DEFAULT '', sugerencia TEXT NOT NULL DEFAULT '', idioma VARCHAR(5) NOT NULL DEFAULT '',
      pasar_a_asesor BOOLEAN NOT NULL DEFAULT FALSE, motivo VARCHAR(20) NOT NULL DEFAULT '', enviada TEXT, parecido NUMERIC(4,3),
      resultado VARCHAR(14) NOT NULL DEFAULT 'pendiente', error TEXT NOT NULL DEFAULT '', creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), respondido TIMESTAMPTZ)`);
    await client.query('CREATE INDEX IF NOT EXISTS redes_sugerencias_conv ON redes_sugerencias (empresa_id, conversacion, resultado)');
    // Hasta qué mensaje se revisó cada conversación (para no contestar dos veces ni contestar historial viejo).
    await client.query(`CREATE TABLE IF NOT EXISTS redes_visto (
      empresa_id INTEGER NOT NULL, conversacion INTEGER NOT NULL, ultimo_id BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (empresa_id, conversacion))`);
    // La clave del aviso se cambia una vez (la anterior pudo quedar a la vista en un registro de error).
    for (const e of (await client.query("SELECT id, chatwoot FROM empresas WHERE chatwoot->>'clave' IS NOT NULL AND COALESCE(chatwoot->>'clave2', '') = ''")).rows) {
      await client.query('UPDATE empresas SET chatwoot = $1 WHERE id = $2', [JSON.stringify({ ...e.chatwoot, clave: crypto.randomBytes(20).toString('hex'), clave2: '1' }), e.id]);
    }
    setInterval(revisarTodo, REVISAR_MS).unref();
    setTimeout(revisarTodo, 3000).unref();
  }

  // ---------- Revisión periódica de Chatwoot (cada 5 s) ----------
  const ultimaRevision = new Map();   // empresa -> { cuando, error }
  let revisando = false;
  async function revisarTodo() {
    if (revisando) return;
    revisando = true;
    try {
      const filas = (await client.query("SELECT id, nombre, slug, chatwoot, conocimiento_sedes FROM empresas WHERE chatwoot->>'token' IS NOT NULL AND (chatwoot->>'cuenta')::int > 0")).rows;
      for (const e of filas) {
        const aj = ajustes(e);
        const activas = Object.entries(aj.bandejas).filter(([, b]) => b.modo && b.modo !== 'apagado').map(([id]) => Number(id));
        if (!activas.length) { ultimaRevision.delete(e.id); continue; }
        try {
          await revisarEmpresa(e, aj, activas);
          ultimaRevision.set(e.id, { cuando: Date.now(), error: '' });
        } catch (err) {
          ultimaRevision.set(e.id, { cuando: Date.now(), error: err.message });
        }
      }
    } catch (err) { /* la base no responde: se intenta en la próxima vuelta */ }
    finally { revisando = false; }
  }
  async function revisarEmpresa(e, aj, activas) {
    const d = await cw(aj, 'GET', '/conversations?status=all&assignee_type=all&page=1');
    const convs = lista(d).filter(c => activas.includes(Number(c.inbox_id)));
    if (!convs.length) return;
    const vistos = new Map((await client.query('SELECT conversacion, ultimo_id FROM redes_visto WHERE empresa_id = $1 AND conversacion = ANY($2)',
      [e.id, convs.map(c => Number(c.id))])).rows.map(r => [Number(r.conversacion), Number(r.ultimo_id)]));
    for (const c of convs) {
      const conv = Number(c.id);
      const ultimoLista = Number((c.last_non_activity_message && c.last_non_activity_message.id) || (Array.isArray(c.messages) && c.messages.length && c.messages[c.messages.length - 1].id) || 0);
      const visto = vistos.get(conv);
      if (visto === undefined) {
        // Conversación vista por primera vez: si su último mensaje es del cliente y es reciente (menos de 2 min), se atiende;
        // si no, solo se marca (no se contesta historial viejo).
        const reciente = Number(c.last_activity_at || c.timestamp || 0) * 1000 > Date.now() - 120000;
        await client.query('INSERT INTO redes_visto (empresa_id, conversacion, ultimo_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [e.id, conv, reciente ? 0 : ultimoLista]);
        if (!reciente) continue;
      } else if (ultimoLista && ultimoLista <= visto) continue;
      const msgs = lista(await cw(aj, 'GET', `/conversations/${conv}/messages`)).sort((a, b) => a.id - b.id);
      const desde = vistos.get(conv) || 0;
      let max = desde, hayCliente = false, maxCliente = 0;
      for (const m of msgs) {
        if (Number(m.id) <= desde) continue;
        max = Math.max(max, Number(m.id));
        if (m.private || !String(m.content || '').trim()) continue;
        const entrante = m.message_type === 0 || m.message_type === 'incoming';
        const saliente = m.message_type === 1 || m.message_type === 'outgoing';
        if (entrante) { hayCliente = true; maxCliente = Math.max(maxCliente, Number(m.id)); }
        else if (saliente && !propios.has(String(m.id))) {
          const quien = m.sender && String(m.sender.type || '').toLowerCase();
          if (!quien || quien === 'user' || quien === 'agent') await medir(e.id, conv, m.content);
        }
      }
      if (max > desde) await client.query('INSERT INTO redes_visto (empresa_id, conversacion, ultimo_id) VALUES ($1,$2,$3) ON CONFLICT (empresa_id, conversacion) DO UPDATE SET ultimo_id = GREATEST(redes_visto.ultimo_id, EXCLUDED.ultimo_id)', [e.id, conv, max]);
      // Mensaje nuevo del cliente: se espera a que termine de escribir y se atiende una sola vez.
      const k = e.id + ':' + conv;
      if (hayCliente && maxCliente > (respondido.get(k) || 0)) {
        clearTimeout(esperas.get(k));
        esperas.set(k, setTimeout(() => { esperas.delete(k); atender(e.id, Number(c.inbox_id), conv); }, ESPERA_MS));
      }
    }
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

  async function historial(aj, conv, k) {
    const d = await cw(aj, 'GET', `/conversations/${conv}/messages`);
    const todos = lista(d);
    if (k) {
      const maxCliente = Math.max(0, ...todos.filter(m => !m.private && (m.message_type === 0 || m.message_type === 'incoming')).map(m => Number(m.id) || 0));
      respondido.set(k, Math.max(respondido.get(k) || 0, maxCliente));
    }
    return todos
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
      const mensajes = await historial(aj, conv, e.id + ':' + conv);
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
      bandejas: aj.bandejas, equipos: aj.equipos, porSede, ultimas, modos: MODOS,
      revision: ultimaRevision.has(e.id) ? { haceSeg: Math.round((Date.now() - ultimaRevision.get(e.id).cuando) / 1000), error: ultimaRevision.get(e.id).error } : null
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

  return { activo, preparar, manejarPublico, manejarOficina, revisarTodo, _probar: { parecido, resultadoDe } };
};
