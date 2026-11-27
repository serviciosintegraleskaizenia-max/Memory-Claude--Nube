// Puente de Oficina con el panel del cliente (panel-cliente/servidor.js), por dentro del servidor.
// La clave interna se lee del archivo que creó el instalador del panel; nunca va en el repositorio ni al navegador.
// Ajustes opcionales en config.js: panelCliente: { url: 'http://127.0.0.1:3110', archivoClave: '/srv/zentralia/datos/panel-cliente.env' }
const fs = require('fs');

function crearPuente(config = {}) {
  const ajustes = config.panelCliente || {};
  const base = String(ajustes.url || 'http://127.0.0.1:3110').replace(/\/+$/, '');
  const archivoClave = ajustes.archivoClave || '/srv/zentralia/datos/panel-cliente.env';

  // Se vuelve a leer en cada llamada: si se reinstala el panel y cambia la clave, Oficina la toma sin reiniciarse.
  function clave() {
    if (process.env.PANEL_CLIENTE_INTERNO) return process.env.PANEL_CLIENTE_INTERNO;
    let contenido = '';
    try { contenido = fs.readFileSync(archivoClave, 'utf8'); }
    catch (e) { throw Object.assign(new Error('No encuentro la clave del panel del cliente. ¿Está instalado el panel del cliente en este servidor?'), { codigo: 503 }); }
    const m = contenido.match(/^PANEL_CLIENTE_INTERNO=(.+)$/m);
    if (!m || !m[1].trim()) throw Object.assign(new Error('El archivo del panel del cliente no trae la clave interna. Reinstala el panel del cliente.'), { codigo: 503 });
    return m[1].trim();
  }

  async function pedir(metodo, ruta, cuerpo, { binario = false } = {}) {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 10000);
    let r;
    try {
      r = await fetch(base + ruta, {
        method: metodo, signal: control.signal,
        headers: { 'x-clave-interna': clave(), ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined
      });
    } catch (e) {
      if (e.codigo) throw e;
      throw Object.assign(new Error('El panel del cliente no responde. Revisa que el servicio zentralia-panel-cliente esté encendido.'), { codigo: 503 });
    } finally { clearTimeout(reloj); }
    if (binario && r.ok) {
      return { tipo: r.headers.get('content-type') || 'application/octet-stream', disposicion: r.headers.get('content-disposition') || '', datos: Buffer.from(await r.arrayBuffer()) };
    }
    let datos = {};
    try { datos = await r.json(); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error(datos.error || 'El panel del cliente respondió con un error.'), { codigo: r.status === 403 ? 502 : r.status });
    return datos;
  }
  const q = usuario => '?usuario=' + encodeURIComponent(usuario);

  return {
    cuentas: () => pedir('GET', '/api/interno/cuentas'),
    estado: usuario => pedir('GET', '/api/interno/estado' + q(usuario)),
    crearCuenta: (usuario, claveCliente, nombre) => pedir('POST', '/api/interno/cuenta', { usuario, clave: claveCliente, nombre }),
    configurar: datos => pedir('POST', '/api/interno/configurar', datos),
    plantillas: usuario => pedir('GET', '/api/interno/plantillas' + q(usuario)),
    decidirPlantilla: (usuario, id, aprobar, motivo) => pedir('POST', '/api/interno/plantillas/decidir', { usuario, id, aprobar, motivo }),
    recibos: usuario => pedir('GET', '/api/interno/recibos' + q(usuario)),
    crearRecibo: datos => pedir('POST', '/api/interno/recibo', datos),
    reciboPagado: (usuario, id) => pedir('POST', '/api/interno/recibo/pagado', { usuario, id }),
    anuncio: (usuario, titulo, textoAnuncio) => pedir('POST', '/api/interno/anuncio', { usuario, titulo, texto: textoAnuncio }),
    mensajes: usuario => pedir('GET', '/api/interno/mensajes' + q(usuario)),
    responder: (usuario, textoMensaje) => pedir('POST', '/api/interno/mensaje', { usuario, texto: textoMensaje }),
    archivo: (usuario, id) => pedir('GET', '/api/interno/archivo' + q(usuario) + '&id=' + encodeURIComponent(id), null, { binario: true }),
    avisos: () => pedir('GET', '/api/interno/avisos'),
    avisosLeidos: ids => pedir('POST', '/api/interno/avisos/leidos', { ids }),
    presenciaTodos: () => pedir('POST', '/api/interno/presencia-todos', {})
  };
}

module.exports = { crearPuente };
