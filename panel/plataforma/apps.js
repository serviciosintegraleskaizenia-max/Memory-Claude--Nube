// Apps de Oficina: aplicaciones instalables (PWA) para celular que se crean, se prueban con un link privado
// y un código por probador, y se publican desde la Oficina. Tablas propias en la base del central.
//
// Una app es un acceso instalable a una pantalla que ya existe en el panel (la app del chofer o la de asesores),
// con su icono, sus accesos directos y su estado (prueba o publicada).

const crypto = require('crypto');

// Pantallas que una app puede abrir. Cada una define el alcance de la app instalada.
const INICIOS = { '/chofer': 'App del chofer', '/asesor': 'App de asesores' };
const COOKIE = 'appprueba_';
const DIAS_PRUEBA_DEFECTO = 30;

module.exports = function crearApps({ client, registrar }) {
  const error = (m, codigo = 400) => Object.assign(new Error(m), { codigo });
  const texto = (v, max = 300) => String(v ?? '').trim().slice(0, max);
  const color = c => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : '#0c1a2e');
  const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const hoyISO = () => new Date().toISOString().slice(0, 10);

  const slugDe = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
  const letraDe = nombre => (String(nombre || '').trim().charAt(0) || 'A').toUpperCase();

  // Accesos directos: rutas que empiezan igual que la pantalla de inicio (así quedan dentro del alcance de la app).
  function accesosLimpios(lista, inicio) {
    const filas = Array.isArray(lista) ? lista : [];
    if (filas.length > 6) throw error('Máximo 6 accesos directos por app.');
    return filas.filter(a => a && (a.nombre || a.ruta)).map(a => {
      const nombre = texto(a.nombre, 40), ruta = texto(a.ruta, 200);
      if (!nombre) throw error('Cada acceso directo necesita un nombre.');
      if (!ruta.startsWith(inicio) || ruta.includes('..') || !/^[\w\/\-.?=&%]+$/.test(ruta)) throw error(`El acceso «${nombre}» debe ser una ruta de ${inicio}.`);
      return { nombre, ruta };
    });
  }

  async function preparar() {
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_apps (
      id SERIAL PRIMARY KEY, nombre TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, empresa_id INTEGER NOT NULL DEFAULT 0,
      descripcion TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#0c1a2e', letra TEXT NOT NULL DEFAULT 'A',
      inicio TEXT NOT NULL, accesos JSONB NOT NULL DEFAULT '[]', estado TEXT NOT NULL DEFAULT 'prueba',
      version TEXT NOT NULL DEFAULT '1.0.0', publicada_en TIMESTAMPTZ, creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query(`CREATE TABLE IF NOT EXISTS oficina_app_probadores (
      id SERIAL PRIMARY KEY, app_id INTEGER NOT NULL REFERENCES oficina_apps(id) ON DELETE CASCADE, nombre TEXT NOT NULL,
      codigo_hash TEXT NOT NULL UNIQUE, codigo_fin TEXT NOT NULL, vence DATE NOT NULL, activo BOOLEAN NOT NULL DEFAULT TRUE,
      creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), ultimo_uso TIMESTAMPTZ)`);
  }

  // ---------- Oficina (solo Programador) ----------
  async function listar() {
    const apps = (await client.query(`SELECT id, nombre, slug, empresa_id, descripcion, color, letra, inicio, accesos, estado, version,
      to_char(publicada_en, 'YYYY-MM-DD') AS publicada_en FROM oficina_apps ORDER BY nombre`)).rows;
    const probs = (await client.query(`SELECT id, app_id, nombre, codigo_fin, to_char(vence, 'YYYY-MM-DD') AS vence, activo,
      to_char(ultimo_uso, 'YYYY-MM-DD HH24:MI') AS ultimo_uso FROM oficina_app_probadores ORDER BY creado DESC`)).rows;
    const hoy = hoyISO();
    return apps.map(a => ({ ...a, probadores: probs.filter(p => p.app_id === a.id).map(p => ({ ...p, vigente: p.activo && p.vence >= hoy })) }));
  }

  async function guardar(f, u) {
    const nombre = texto(f.nombre, 60);
    if (!nombre) throw error('Ponle un nombre a la app.');
    const inicio = String(f.inicio || '');
    if (!INICIOS[inicio]) throw error('Elige la pantalla que abre la app.');
    const accesos = accesosLimpios(f.accesos, inicio);
    const datos = [texto(f.descripcion, 300), color(f.color), texto(f.letra, 2).toUpperCase() || letraDe(nombre), inicio,
      JSON.stringify(accesos), Number(f.empresa_id) || 0, texto(f.version, 20) || '1.0.0'];
    const id = Number(f.id) || 0;
    if (id) {
      const r = await client.query(`UPDATE oficina_apps SET nombre=$2, descripcion=$3, color=$4, letra=$5, inicio=$6, accesos=$7::jsonb,
        empresa_id=$8, version=$9, actualizado=NOW() WHERE id=$1 RETURNING id, slug`, [id, nombre, ...datos]);
      if (!r.rows[0]) throw error('Esa app ya no existe.', 404);
      await registrar(u, 'oficina_apps', 'apps', nombre, '', '', 'editada');
      return { id, slug: r.rows[0].slug };
    }
    // Slug único: si ya existe, se añade un número.
    const base = slugDe(nombre);
    let slug = base, n = 2;
    while ((await client.query('SELECT 1 FROM oficina_apps WHERE slug = $1', [slug])).rows[0]) slug = `${base}-${n++}`;
    const r = await client.query(`INSERT INTO oficina_apps (nombre, slug, descripcion, color, letra, inicio, accesos, empresa_id, version)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) RETURNING id`, [nombre, slug, ...datos]);
    await registrar(u, 'oficina_apps', 'apps', nombre, '', '', 'creada en prueba');
    return { id: r.rows[0].id, slug };
  }

  async function cambiarEstado(id, publicar, u) {
    const r = await client.query(`UPDATE oficina_apps SET estado = $2, publicada_en = CASE WHEN $2 = 'publicada' THEN NOW() ELSE publicada_en END,
      actualizado = NOW() WHERE id = $1 RETURNING nombre`, [id, publicar ? 'publicada' : 'prueba']);
    if (!r.rows[0]) throw error('Esa app ya no existe.', 404);
    await registrar(u, 'oficina_apps', 'apps', r.rows[0].nombre, '', '', publicar ? 'publicada' : 'vuelta a prueba');
    return { ok: true };
  }

  // Código para un probador: se muestra una sola vez. En la base solo queda su huella.
  async function crearProbador(f, u) {
    const app = (await client.query('SELECT id, nombre, slug FROM oficina_apps WHERE id = $1', [Number(f.app_id) || 0])).rows[0];
    if (!app) throw error('Esa app ya no existe.', 404);
    const nombre = texto(f.nombre, 60);
    if (!nombre) throw error('Pon el nombre de la persona que probará.');
    const dias = Math.min(Math.max(Number(f.dias) || DIAS_PRUEBA_DEFECTO, 1), 365);
    const codigo = crypto.randomBytes(9).toString('base64url');
    const vence = new Date(Date.now() + dias * 86400000).toISOString().slice(0, 10);
    await client.query(`INSERT INTO oficina_app_probadores (app_id, nombre, codigo_hash, codigo_fin, vence) VALUES ($1, $2, $3, $4, $5)`,
      [app.id, nombre, hash(codigo), codigo.slice(-4), vence]);
    await registrar(u, 'oficina_apps', 'apps', app.nombre, '', '', `probador ${nombre} (vence ${vence})`);
    return { codigo, enlace: `/app/${app.slug}/?c=${codigo}`, vence };
  }

  async function revocarProbador(id, u) {
    const r = await client.query('UPDATE oficina_app_probadores SET activo = FALSE WHERE id = $1 RETURNING nombre', [Number(id) || 0]);
    if (!r.rows[0]) throw error('Ese probador ya no existe.', 404);
    await registrar(u, 'oficina_apps', 'apps', r.rows[0].nombre, '', '', 'acceso de prueba quitado');
    return { ok: true };
  }

  async function manejarOficina(req, res, url, u, { json, leerCuerpo }) {
    const ruta = url.replace(/^\/api\/oficina\/apps/, '');
    if (req.method === 'GET' && ruta === '') return json(res, 200, { apps: await listar(), inicios: INICIOS });
    if (req.method !== 'POST') return json(res, 404, { error: 'No existe.' });
    const f = await leerCuerpo(req);
    try {
      if (ruta === '/guardar') return json(res, 200, await guardar(f, u));
      if (ruta === '/publicar') return json(res, 200, await cambiarEstado(Number(f.id) || 0, Boolean(f.publicar), u));
      if (ruta === '/borrar') {
        const r = await client.query('DELETE FROM oficina_apps WHERE id = $1 RETURNING nombre', [Number(f.id) || 0]);
        if (r.rows[0]) await registrar(u, 'oficina_apps', 'apps', r.rows[0].nombre, '', '', 'borrada');
        return json(res, 200, { ok: true });
      }
      if (ruta === '/probador') return json(res, 200, await crearProbador(f, u));
      if (ruta === '/probador/revocar') return json(res, 200, await revocarProbador(f.id, u));
      return json(res, 404, { error: 'No existe.' });
    } catch (e) {
      return json(res, e.codigo || 500, { error: e.codigo ? e.message : 'No se pudo guardar.' });
    }
  }

  // ---------- Público: instalación y pruebas (sin sesión del panel) ----------
  // Una app en prueba solo se abre con un código de probador vigente (cookie por app, con su vencimiento).
  async function appPorSlug(slug) {
    return (await client.query('SELECT * FROM oficina_apps WHERE slug = $1', [slug])).rows[0] || null;
  }
  async function probadorVigente(app, req) {
    const cookies = String(req.headers.cookie || '');
    const m = cookies.match(new RegExp('(?:^|;\\s*)' + COOKIE + app.slug + '=([0-9a-f]{64})'));
    if (!m) return null;
    const p = (await client.query(`SELECT id, to_char(vence, 'YYYY-MM-DD') AS vence FROM oficina_app_probadores
      WHERE app_id = $1 AND codigo_hash = $2 AND activo AND vence >= CURRENT_DATE`, [app.id, m[1]])).rows[0];
    if (p) await client.query('UPDATE oficina_app_probadores SET ultimo_uso = NOW() WHERE id = $1', [p.id]);
    return p || null;
  }
  async function puedeVerla(app, req) { return app.estado === 'publicada' || Boolean(await probadorVigente(app, req)); }

  function icono(app) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${color(app.color)}"/>`
      + `<text x="256" y="350" font-size="300" font-family="Arial, sans-serif" font-weight="700" text-anchor="middle" fill="#ffffff">${esc(app.letra || 'A')}</text></svg>`;
  }
  function manifiesto(app) {
    const icon = `/app/${app.slug}/icono.svg`;
    const accesos = Array.isArray(app.accesos) ? app.accesos : [];
    return {
      name: app.nombre, short_name: app.nombre.slice(0, 12), description: app.descripcion || app.nombre,
      start_url: app.inicio, scope: app.inicio, display: 'standalone', orientation: 'portrait',
      background_color: color(app.color), theme_color: color(app.color), lang: 'es',
      icons: [{ src: icon, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      shortcuts: accesos.map(a => ({ name: a.nombre, url: a.ruta, icons: [{ src: icon, sizes: 'any', type: 'image/svg+xml' }] }))
    };
  }
  function paginaEntrada(app, aviso) {
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(app.nombre)} · prueba</title><style>body{font-family:system-ui,sans-serif;background:#0c1a2e;color:#fff;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{width:100%;max-width:360px;text-align:center}input{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:0;font-size:16px;margin:12px 0}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#fff;color:#0c1a2e;font-weight:700;font-size:16px}.aviso{color:#fbbf24;min-height:20px}</style></head>
<body><main><img src="/app/${esc(app.slug)}/icono.svg" width="96" height="96" alt="">
<h1 style="font-size:22px">${esc(app.nombre)}</h1><p>App en prueba. Pon el código que te dio Kaizen IA.</p>
<form method="get" action="/app/${esc(app.slug)}/"><input name="c" autocomplete="off" placeholder="Código de prueba" required><button>Entrar</button></form>
<p class="aviso">${esc(aviso || '')}</p></main></body></html>`;
  }
  function paginaInstalar(app) {
    const accesos = (Array.isArray(app.accesos) ? app.accesos : []).map(a => `<li><a href="${esc(a.ruta)}" style="color:#fff">${esc(a.nombre)}</a></li>`).join('');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(app.nombre)}</title><link rel="manifest" href="/app/${esc(app.slug)}/manifest.webmanifest"><link rel="icon" href="/app/${esc(app.slug)}/icono.svg">
<meta name="theme-color" content="${color(app.color)}"><style>body{font-family:system-ui,sans-serif;background:${color(app.color)};color:#fff;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{width:100%;max-width:380px;text-align:center}a.boton{display:block;padding:14px;border-radius:12px;background:#fff;color:${color(app.color)};font-weight:700;text-decoration:none;margin:12px 0}
ol{text-align:left;line-height:1.6}.p{opacity:.85}</style></head>
<body><main><img src="/app/${esc(app.slug)}/icono.svg" width="96" height="96" alt="">
<h1 style="font-size:22px">${esc(app.nombre)}</h1><p class="p">${esc(app.descripcion || '')}</p>
<a class="boton" href="${esc(app.inicio)}">Abrir la app</a>
<h2 style="font-size:17px">Instalarla en el celular</h2>
<ol><li><b>Android (Chrome):</b> menú ⋮ → «Instalar aplicación».</li><li><b>iPhone (Safari):</b> botón Compartir → «Agregar a pantalla de inicio».</li></ol>
${accesos ? `<h2 style="font-size:17px">Accesos directos</h2><ul style="text-align:left">${accesos}</ul>` : ''}
<p class="p" style="font-size:12px">Versión ${esc(app.version)}${app.estado === 'prueba' ? ' · en prueba' : ''}</p></main>
<script>if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/${esc(app.slug)}/sw.js', { scope: '${esc(app.inicio)}' }).catch(() => {});</script></body></html>`;
  }
  // Service worker mínimo: lo pide el navegador para poder instalar la app. No guarda nada: siempre va a la red.
  const SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });`;

  function enviar(res, codigo, tipo, cuerpo, extra = {}) {
    res.writeHead(codigo, { 'Content-Type': tipo, 'Cache-Control': 'no-store', ...extra });
    res.end(cuerpo);
  }

  async function manejarPublico(req, res, url, { json, leerCuerpo }) {
    const m = url.match(/^\/app\/([a-z0-9-]+)\/?(manifest\.webmanifest|sw\.js|icono\.svg)?$/);
    if (!m) return json(res, 404, { error: 'No existe.' });
    const app = await appPorSlug(m[1]);
    if (!app) return enviar(res, 404, 'text/plain; charset=utf-8', 'No existe esta app.');
    const q = new URL(req.url, 'http://localhost').searchParams;
    const recurso = m[2];

    // Código en el link del probador: se valida, se guarda una cookie para esta app y se limpia el enlace.
    if (!recurso && q.get('c') !== null) {
      const codigo = String(q.get('c') || '').trim();
      const p = codigo ? (await client.query(`SELECT id FROM oficina_app_probadores WHERE app_id = $1 AND codigo_hash = $2 AND activo AND vence >= CURRENT_DATE`,
        [app.id, hash(codigo)])).rows[0] : null;
      if (!p && app.estado !== 'publicada') return enviar(res, 403, 'text/html; charset=utf-8', paginaEntrada(app, 'Ese código no sirve o ya venció.'));
      if (p) {
        const vence = (await client.query('SELECT vence FROM oficina_app_probadores WHERE id = $1', [p.id])).rows[0].vence;
        const hasta = new Date(vence).toUTCString();
        return enviar(res, 302, 'text/plain; charset=utf-8', 'Entrando…', { Location: `/app/${app.slug}/`,
          'Set-Cookie': `${COOKIE}${app.slug}=${hash(codigo)}; HttpOnly; Path=/app/${app.slug}; SameSite=Lax; Expires=${hasta}` });
      }
    }

    if (!(await puedeVerla(app, req))) {
      if (recurso) return json(res, 403, { error: 'Esta app está en prueba. Pide tu código de acceso.' });
      return enviar(res, 403, 'text/html; charset=utf-8', paginaEntrada(app));
    }
    if (recurso === 'manifest.webmanifest') return enviar(res, 200, 'application/manifest+json; charset=utf-8', JSON.stringify(manifiesto(app)));
    if (recurso === 'sw.js') return enviar(res, 200, 'text/javascript; charset=utf-8', SW, { 'Service-Worker-Allowed': app.inicio });
    if (recurso === 'icono.svg') return enviar(res, 200, 'image/svg+xml', icono(app));
    return enviar(res, 200, 'text/html; charset=utf-8', paginaInstalar(app));
  }

  return { preparar, listar, manejarOficina, manejarPublico, INICIOS };
};
