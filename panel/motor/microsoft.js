// Microsoft 365 (Graph) con credenciales de aplicación: lo mismo que hacía n8n, pero desde el panel.
const tokens = new Map();

function urls(cfg) {
  return {
    login: (cfg.loginUrl || 'https://login.microsoftonline.com') + '/' + encodeURIComponent(cfg.tenantId) + '/oauth2/v2.0/token',
    graph: cfg.graphUrl || 'https://graph.microsoft.com/v1.0'
  };
}

async function token(cfg) {
  const clave = cfg.tenantId + '|' + cfg.clientId;
  const guardado = tokens.get(clave);
  if (guardado && guardado.vence > Date.now() + 60000) return guardado.valor;
  const r = await fetch(urls(cfg).login, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    throw new Error('Microsoft 365 no dio permiso: ' + (d.error_description || d.error || ('código ' + r.status)).toString().split('\n')[0]);
  }
  tokens.set(clave, { valor: d.access_token, vence: Date.now() + (Number(d.expires_in) || 3600) * 1000 });
  return d.access_token;
}

// Llamada a Graph con reintentos cuando Microsoft pide esperar (429) o falla un momento (5xx).
async function graph(cfg, metodo, ruta, opciones = {}) {
  const url = ruta.startsWith('http') ? ruta : urls(cfg).graph + ruta;
  for (let intento = 1; ; intento++) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), opciones.tiempo || 60000);
    let r;
    try {
      r = await fetch(url, {
        method: metodo, signal: control.signal,
        headers: { Authorization: 'Bearer ' + await token(cfg), 'Content-Type': 'application/json', ...(opciones.cabeceras || {}) },
        body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo)
      });
    } catch (e) {
      clearTimeout(reloj);
      if (intento < 3) { await new Promise(x => setTimeout(x, 2000 * intento)); continue; }
      throw new Error(e.name === 'AbortError' ? 'Microsoft 365 tardó demasiado en responder.' : 'No hay conexión con Microsoft 365: ' + e.message);
    }
    clearTimeout(reloj);
    if ((r.status === 429 || r.status >= 500) && intento < 3) {
      const espera = Math.min(30, Number(r.headers.get('retry-after')) || 2 * intento) * 1000;
      await new Promise(x => setTimeout(x, espera));
      continue;
    }
    if (r.status === 401 && intento < 2) { tokens.clear(); continue; }
    if (r.status === 202 || r.status === 204) return null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Microsoft 365 respondió ' + r.status + ': ' + ((d.error && d.error.message) || ''));
    return d;
  }
}

const SELECT = 'id,subject,from,receivedDateTime,body,isRead';
const TEXTO = { Prefer: 'outlook.body-content-type="text"' };

// Correos de la bandeja de entrada recibidos desde "desde" (ISO), leídos o no. No marca nada como leído.
async function listarRecientes(cfg, buzon, desde, maximo = 500) {
  const filtro = encodeURIComponent('receivedDateTime ge ' + desde);
  let url = `/users/${buzon}/mailFolders/inbox/messages?$filter=${filtro}&$top=100&$select=${SELECT}`;
  const lista = [];
  while (url && lista.length < maximo) {
    const d = await graph(cfg, 'GET', url, { cabeceras: TEXTO });
    lista.push(...((d && d.value) || []));
    url = d && d['@odata.nextLink'];
  }
  return lista.slice(0, maximo);
}

async function adjuntos(cfg, buzon, id) {
  const d = await graph(cfg, 'GET', `/users/${buzon}/messages/${encodeURIComponent(id)}/attachments`);
  return (d && d.value) || [];
}

module.exports = { token, graph, listarRecientes, adjuntos };
