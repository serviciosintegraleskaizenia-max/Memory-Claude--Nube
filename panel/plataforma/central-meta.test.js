// Pruebas de las plantillas en Meta (Video 2): crear, sincronizar y guardar el ID de la cuenta.
// Meta se simula sustituyendo fetch; la base de datos es una lista en memoria.
// Ejecutar: node --test plataforma/central-meta.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crearCentral = require('./central.js');

const TOKEN = 'EAAtoken_de_prueba_0123456789abcdef';
const PROG = { id: 1, grupo: 'Programador', nombre: 'Prueba', usuario: 'prueba' };
const OTRO = { id: 2, grupo: 'Gerente', nombre: 'Otro', usuario: 'otro', permisos: {} };

function bdFalsa(plantillas) {
  const config = new Map();
  const bd = {
    config, plantillas,
    async query(sql, p = []) {
      if (/^SELECT valor FROM automatizacion_config WHERE clave = \$1/.test(sql)) {
        return { rows: config.has(p[0]) ? [{ valor: config.get(p[0]) }] : [] };
      }
      if (/^INSERT INTO automatizacion_config \(clave, valor\) VALUES \(\$1, \$2\)/.test(sql)) { config.set(p[0], p[1]); return { rows: [] }; }
      if (/^INSERT INTO automatizacion_config \(clave, valor\) VALUES \('waba_id_whatsapp', \$1\)/.test(sql)) { config.set('waba_id_whatsapp', p[0]); return { rows: [] }; }
      if (/^SELECT clave FROM automatizacion_config WHERE clave LIKE 'token_wa_%'/.test(sql)) {
        return { rows: [...config.keys()].filter(k => k.startsWith('token_wa_')).sort().slice(0, 1).map(clave => ({ clave })) };
      }
      if (/^SELECT id, nombre, categoria, cuerpo, meta_id FROM plantillas_wa WHERE id = \$1/.test(sql)) {
        return { rows: plantillas.filter(x => x.id === p[0]).map(({ id, nombre, categoria, cuerpo, meta_id }) => ({ id, nombre, categoria, cuerpo, meta_id })) };
      }
      if (/^UPDATE plantillas_wa SET meta_id = \$2, meta_estado = \$3, meta_motivo = ''/.test(sql)) {
        const x = plantillas.find(y => y.id === p[0]); Object.assign(x, { meta_id: p[1], meta_estado: p[2], meta_motivo: '' }); return { rows: [] };
      }
      if (/^UPDATE plantillas_wa SET meta_id = \$2, meta_estado = \$3, meta_motivo = \$4/.test(sql)) {
        const x = plantillas.find(y => y.id === p[0]); Object.assign(x, { meta_id: p[1], meta_estado: p[2], meta_motivo: p[3] }); return { rows: [] };
      }
      if (/^SELECT id, nombre FROM plantillas_wa/.test(sql)) return { rows: plantillas.map(({ id, nombre }) => ({ id, nombre })) };
      if (/^SELECT id, nombre, categoria, cuerpo, estado, motivo, meta_id/.test(sql)) return { rows: plantillas };
      if (/^SELECT COUNT|^SELECT 1/.test(sql)) return { rows: [] };
      return { rows: [] };
    }
  };
  return bd;
}

function montar(plantillas, { waba = '123456789012345', conToken = true } = {}) {
  const bd = bdFalsa(plantillas);
  const registros = [];
  const central = crearCentral({
    client: bd,
    config: { central: { activo: true }, sesion: { secreto: 'secreto-de-prueba' } },
    registrar: async (...a) => registros.push(a),
    CARPETA: require('os').tmpdir()
  });
  if (waba) bd.config.set('waba_id_whatsapp', waba);
  return { central, bd, registros };
}

async function llamar(central, metodo, ruta, cuerpo, u = PROG) {
  const res = {};
  await central.manejar({ method: metodo, url: ruta, headers: {} }, res, ruta.split('?')[0], u, {
    json: (r, code, obj) => { r.code = code; r.body = obj; },
    leerCuerpo: async () => cuerpo || {},
    permisos: {}
  });
  return res;
}

// Meta simulado: registra cada llamada y responde según la ruta.
function metaFalso(respuestas) {
  const llamadas = [];
  global.fetch = async (url, opciones = {}) => {
    llamadas.push({ url: String(url), metodo: opciones.method || 'GET', cabeceras: opciones.headers || {}, cuerpo: opciones.body ? JSON.parse(opciones.body) : null });
    const r = respuestas.shift();
    if (!r) throw new Error('Meta simulado sin respuesta preparada');
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return llamadas;
}

test.afterEach(() => { delete global.fetch; });

// ---------- piezas puras ----------
test('variablesDe cuenta la variable más alta', () => {
  const { central } = montar([]);
  const { variablesDe } = central._probar;
  assert.equal(variablesDe('Hola {{1}}, tu pedido {{2}} sale hoy'), 2);
  assert.equal(variablesDe('Sin variables'), 0);
  assert.equal(variablesDe(''), 0);
});

test('payloadPlantillaMeta: categoría, idioma y ejemplos para las variables', () => {
  const { central } = montar([]);
  const { payloadPlantillaMeta } = central._probar;
  const p = payloadPlantillaMeta({ nombre: 'confirmacion_pedido', categoria: 'utilidad', cuerpo: 'Pedido {{1}} listo, paga {{2}}' }, 'es_PE');
  assert.equal(p.name, 'confirmacion_pedido');
  assert.equal(p.language, 'es_PE');
  assert.equal(p.category, 'UTILITY');
  assert.equal(p.components[0].type, 'BODY');
  assert.deepEqual(p.components[0].example.body_text, [['ejemplo1', 'ejemplo2']]);
  const sinVariables = payloadPlantillaMeta({ nombre: 'gracias', categoria: 'marketing', cuerpo: 'Gracias por escribirnos' });
  assert.equal(sinVariables.category, 'MARKETING');
  assert.equal(sinVariables.components[0].example, undefined);
});

// ---------- guardar el ID de la cuenta y el token ----------
test('guardar el ID de la cuenta: solo números, y se muestra en la configuración', async () => {
  const { central, bd } = montar([], { waba: null });
  assert.equal((await llamar(central, 'POST', '/api/central/whatsapp/waba/guardar', { waba_id: 'abc' })).code, 400);
  const ok = await llamar(central, 'POST', '/api/central/whatsapp/waba/guardar', { waba_id: '123 456 789 012 345' });
  assert.equal(ok.code, 200);
  assert.equal(bd.config.get('waba_id_whatsapp'), '123456789012345');
  const cfg = await llamar(central, 'GET', '/api/central/whatsapp/config');
  assert.equal(cfg.body.waba_id, '123456789012345');
});

test('solo el Programador puede usar Empresas, también para Meta', async () => {
  const { central } = montar([{ id: 1, nombre: 'confirmacion_pedido', categoria: 'utilidad', cuerpo: 'Hola', estado: 'borrador', motivo: '' }]);
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/crear', { id: 1 }, OTRO);
  assert.equal(r.code, 403);
});

// ---------- crear la plantilla en Meta ----------
test('crear: sin ID de la cuenta, avisa qué falta y no llama a Meta', async () => {
  const plantillas = [{ id: 1, nombre: 'confirmacion_pedido', categoria: 'utilidad', cuerpo: 'Pedido {{1}} listo', estado: 'borrador', motivo: '' }];
  const { central } = montar(plantillas, { waba: null });
  const llamadas = metaFalso([]);
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/crear', { id: 1 });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /ID de la cuenta de WhatsApp Business/);
  assert.equal(llamadas.length, 0);
});

test('crear: sin token guardado, avisa y no llama a Meta', async () => {
  const plantillas = [{ id: 1, nombre: 'confirmacion_pedido', categoria: 'utilidad', cuerpo: 'Pedido {{1}} listo', estado: 'borrador', motivo: '' }];
  const { central } = montar(plantillas);
  const llamadas = metaFalso([]);
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/crear', { id: 1 });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /token/);
  assert.equal(llamadas.length, 0);
});

test('crear: envía la plantilla con el token cifrado guardado y registra el estado de Meta', async () => {
  const plantillas = [{ id: 1, nombre: 'confirmacion_pedido', categoria: 'utilidad', cuerpo: 'Pedido {{1}} listo', estado: 'borrador', motivo: '', meta_id: '', meta_estado: '', meta_motivo: '' }];
  const { central, bd } = montar(plantillas);
  await llamar(central, 'POST', '/api/central/whatsapp/token/guardar', { numero_id: '51945607167', token: TOKEN });
  assert.notEqual(bd.config.get('token_wa_51945607167'), TOKEN, 'el token no debe guardarse en claro');
  const llamadas = metaFalso([{ status: 200, body: { id: 'tpl-777', status: 'PENDING', category: 'UTILITY' } }]);
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/crear', { id: 1 });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.estado, 'PENDING');
  assert.equal(llamadas.length, 1);
  assert.match(llamadas[0].url, /graph\.facebook\.com\/v21\.0\/123456789012345\/message_templates$/);
  assert.equal(llamadas[0].metodo, 'POST');
  assert.equal(llamadas[0].cabeceras.Authorization, 'Bearer ' + TOKEN);
  assert.equal(llamadas[0].cuerpo.name, 'confirmacion_pedido');
  assert.equal(llamadas[0].cuerpo.category, 'UTILITY');
  assert.equal(llamadas[0].cuerpo.language, 'es_PE');
  assert.deepEqual(llamadas[0].cuerpo.components[0].example.body_text, [['ejemplo1']]);
  assert.equal(plantillas[0].meta_id, 'tpl-777');
  assert.equal(plantillas[0].meta_estado, 'PENDING');
});

test('crear: si la plantilla no pasa las reglas locales, no sale a Meta', async () => {
  const plantillas = [{ id: 1, nombre: 'Mal Nombre', categoria: 'utilidad', cuerpo: 'Mira http://x.co', estado: 'borrador', motivo: '' }];
  const { central } = montar(plantillas);
  await llamar(central, 'POST', '/api/central/whatsapp/token/guardar', { numero_id: '51945607167', token: TOKEN });
  const llamadas = metaFalso([]);
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/crear', { id: 1 });
  assert.equal(r.code, 400);
  assert.match(r.body.error, /Corrige la plantilla/);
  assert.equal(llamadas.length, 0);
});

test('crear: si Meta rechaza, muestra su mensaje y no marca nada como enviada', async () => {
  const plantillas = [{ id: 1, nombre: 'confirmacion_pedido', categoria: 'utilidad', cuerpo: 'Pedido {{1}} listo', estado: 'borrador', motivo: '', meta_id: '', meta_estado: '', meta_motivo: '' }];
  const { central } = montar(plantillas);
  await llamar(central, 'POST', '/api/central/whatsapp/token/guardar', { numero_id: '51945607167', token: TOKEN });
  metaFalso([{ status: 400, body: { error: { message: 'Invalid parameter', error_user_msg: 'Ya existe una plantilla con ese nombre.' } } }]);
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/crear', { id: 1 });
  assert.equal(r.code, 502);
  assert.match(r.body.error, /Ya existe una plantilla con ese nombre/);
  assert.equal(plantillas[0].meta_estado, '');
});

// ---------- sincronizar el estado ----------
test('sincronizar: recorre todas las páginas y guarda el estado de cada plantilla', async () => {
  const plantillas = [
    { id: 1, nombre: 'confirmacion_pedido', meta_estado: '', meta_motivo: '', meta_id: '' },
    { id: 2, nombre: 'retomar_conversacion', meta_estado: '', meta_motivo: '', meta_id: '' },
    { id: 3, nombre: 'solo_local', meta_estado: '', meta_motivo: '', meta_id: '' }
  ];
  const { central, bd } = montar(plantillas);
  await llamar(central, 'POST', '/api/central/whatsapp/token/guardar', { numero_id: '51945607167', token: TOKEN });
  const llamadas = metaFalso([
    { status: 200, body: { data: [{ id: 'a1', name: 'confirmacion_pedido', status: 'APPROVED' }], paging: { next: 'https://graph.facebook.com/v21.0/123/message_templates?after=abc' } } },
    { status: 200, body: { data: [{ id: 'b2', name: 'retomar_conversacion', status: 'REJECTED', rejected_reason: 'NONE' }], paging: {} } }
  ]);
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/sincronizar', {});
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(llamadas.length, 2, 'debe pedir la segunda página');
  assert.equal(llamadas[1].url, 'https://graph.facebook.com/v21.0/123/message_templates?after=abc');
  assert.equal(llamadas[1].cabeceras.Authorization, 'Bearer ' + TOKEN, 'cada página lleva el token');
  assert.equal(r.body.actualizadas, 2);
  assert.deepEqual(r.body.sin_en_meta, ['solo_local']);
  assert.equal(plantillas[0].meta_estado, 'APPROVED');
  assert.equal(plantillas[1].meta_estado, 'REJECTED');
  assert.equal(plantillas[1].meta_motivo, '', 'NONE de Meta significa sin motivo');
});

test('sincronizar: sin ID de la cuenta no llama a Meta', async () => {
  const { central } = montar([], { waba: null });
  const llamadas = metaFalso([]);
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/sincronizar', {});
  assert.equal(r.code, 400);
  assert.equal(llamadas.length, 0);
});

test('sin conexión con Meta, el error es claro y no se rompe', async () => {
  const plantillas = [{ id: 1, nombre: 'confirmacion_pedido', categoria: 'utilidad', cuerpo: 'Hola', estado: 'borrador', motivo: '', meta_id: '', meta_estado: '', meta_motivo: '' }];
  const { central } = montar(plantillas);
  await llamar(central, 'POST', '/api/central/whatsapp/token/guardar', { numero_id: '51945607167', token: TOKEN });
  global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND graph.facebook.com'); };
  const r = await llamar(central, 'POST', '/api/central/whatsapp/plantillas/meta/crear', { id: 1 });
  assert.equal(r.code, 502);
  assert.match(r.body.error, /No hay conexión con Meta/);
});
