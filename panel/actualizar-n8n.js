// Cambia el código de los nodos del flujo de n8n "Correos - leer y clasificar" usando la API de n8n,
// sin abrir n8n. Antes de tocar nada guarda una copia del flujo. Lo llama actualizar-todo.ps1.
//
//   node actualizar-n8n.js <carpeta con NODO-*.js>      -> cambia los nodos y publica
//   node actualizar-n8n.js --restaurar <copia.json>     -> deja el flujo como estaba en esa copia
//
// Variables: N8N_API_KEY (obligatoria), N8N_URL (por defecto http://localhost:5678), RESPALDOS (carpeta de copias).

const fs = require('fs');
const path = require('path');

const BASE = String(process.env.N8N_URL || 'http://localhost:5678').replace(/\/+$/, '');
const CLAVE = String(process.env.N8N_API_KEY || '').trim();
const RESPALDOS = path.resolve(process.env.RESPALDOS || 'respaldos-n8n');
const FLUJO = /leer y clasificar/i;
const NODOS = [
  { nombre: 'Limpiar texto', archivo: 'NODO-Limpiar-texto-COMPLETO.js', marca: 'Cancelaciones, esperas y cambios' },
  { nombre: 'Code in JavaScript', archivo: 'NODO-Code-in-JavaScript-COMPLETO.js', marca: 'numero_servicio' }
];
// Ajustes que acepta la API pública al guardar un flujo (los demás los rechaza).
const AJUSTES = ['saveExecutionProgress', 'saveManualExecutions', 'saveDataErrorExecution', 'saveDataSuccessExecution',
  'executionTimeout', 'errorWorkflow', 'timezone', 'executionOrder', 'callerPolicy', 'callerIds', 'timeSavedPerExecution'];

const fallar = (m, codigo = 1) => { console.error('\nERROR: ' + m); process.exit(codigo); };

async function api(metodo, ruta, cuerpo) {
  let r;
  try {
    r = await fetch(BASE + '/api/v1' + ruta, {
      method: metodo,
      headers: { 'X-N8N-API-KEY': CLAVE, Accept: 'application/json', ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined
    });
  } catch (e) { fallar(`No pude conectar con n8n en ${BASE}. ¿Está abierto? (${e.message})`); }
  const texto = await r.text();
  let d; try { d = JSON.parse(texto); } catch (e) { d = { message: texto.slice(0, 300) }; }
  if (r.status === 401 || r.status === 403) fallar('n8n no aceptó la clave de API. Crea una nueva en n8n (Settings → n8n API) y vuelve a ejecutar.', 2);
  return { ok: r.ok, status: r.status, d };
}

async function buscarFlujo() {
  const todos = [];
  let cursor = '';
  do {
    const r = await api('GET', '/workflows?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    if (!r.ok) fallar('n8n respondió ' + r.status + ' al pedir los flujos: ' + (r.d.message || ''));
    todos.push(...(r.d.data || []));
    cursor = r.d.nextCursor || '';
  } while (cursor);
  const candidatos = todos.filter(w => FLUJO.test(w.name || '') && !w.isArchived);
  if (!candidatos.length) fallar('No encontré el flujo "Correos - leer y clasificar". Flujos que hay: ' + todos.map(w => w.name).join(' | '));
  const activos = candidatos.filter(w => w.active);
  if (activos.length > 1 || (!activos.length && candidatos.length > 1)) fallar('Hay varios flujos con ese nombre: ' + candidatos.map(w => `${w.name} (${w.id})`).join(', '));
  const elegido = activos[0] || candidatos[0];
  const r = await api('GET', '/workflows/' + elegido.id);
  if (!r.ok) fallar('No pude leer el flujo: ' + (r.d.message || r.status));
  return r.d;
}

async function guardar(wf, nodos) {
  const ajustes = {};
  for (const k of AJUSTES) if (wf.settings && wf.settings[k] !== undefined) ajustes[k] = wf.settings[k];
  const cuerpo = { name: wf.name, nodes: nodos, connections: wf.connections, settings: ajustes };
  if (wf.staticData) cuerpo.staticData = wf.staticData;
  let r = await api('PUT', '/workflows/' + wf.id, cuerpo);
  if (!r.ok && /settings/i.test(r.d.message || '')) {
    cuerpo.settings = wf.settings && wf.settings.executionOrder ? { executionOrder: wf.settings.executionOrder } : {};
    r = await api('PUT', '/workflows/' + wf.id, cuerpo);
  }
  if (!r.ok) fallar('n8n no guardó el flujo (' + r.status + '): ' + (r.d.message || '') + '\nNo se cambió nada.');
}

async function publicar(wf) {
  // En n8n, "activar" desde la API publica la versión guardada. Si ya estaba activo, se vuelve a publicar.
  let r = await api('POST', `/workflows/${wf.id}/activate`);
  if (!r.ok && wf.active) {
    await api('POST', `/workflows/${wf.id}/deactivate`);
    r = await api('POST', `/workflows/${wf.id}/activate`);
  }
  if (!r.ok) fallar('El código quedó guardado pero n8n no lo publicó (' + r.status + '): ' + (r.d.message || '') + '\nAbre el flujo en n8n y pulsa Publish.');
}

function codigoPublicado(wf, nombre) {
  const v = wf.activeVersion && Array.isArray(wf.activeVersion.nodes) ? wf.activeVersion.nodes : wf.nodes;
  const n = (v || []).find(x => x.name === nombre);
  return n && n.parameters ? String(n.parameters.jsCode || '') : '';
}

(async () => {
  if (!CLAVE) fallar('Falta la clave de API de n8n (N8N_API_KEY).');
  const args = process.argv.slice(2);
  const wf = await buscarFlujo();
  console.log(`Flujo: "${wf.name}" (id ${wf.id}) · ${wf.active ? 'activo' : 'NO activo'}`);

  fs.mkdirSync(RESPALDOS, { recursive: true });
  const sello = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const copia = path.join(RESPALDOS, `flujo-antes-${sello}.json`);
  fs.writeFileSync(copia, JSON.stringify(wf, null, 2));
  console.log('Copia de seguridad: ' + copia);

  let nodos;
  if (args[0] === '--restaurar') {
    if (!args[1] || !fs.existsSync(args[1])) fallar('Indica la copia a restaurar: node actualizar-n8n.js --restaurar <archivo.json>');
    const viejo = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (String(viejo.id) !== String(wf.id)) fallar('Esa copia es de otro flujo.');
    nodos = viejo.nodes;
    console.log('Restaurando los nodos de ' + path.basename(args[1]));
  } else {
    const carpeta = path.resolve(args[0] || '.');
    nodos = JSON.parse(JSON.stringify(wf.nodes));
    for (const n of NODOS) {
      const archivo = path.join(carpeta, n.archivo);
      if (!fs.existsSync(archivo)) fallar('No encuentro ' + archivo);
      const nuevo = fs.readFileSync(archivo, 'utf8').replace(/^﻿/, '');
      if (!nuevo.includes(n.marca)) fallar(`${n.archivo} no es la versión esperada.`);
      const nodo = nodos.find(x => x.name === n.nombre);
      if (!nodo) fallar(`El flujo no tiene un nodo llamado "${n.nombre}". Nodos: ${nodos.map(x => x.name).join(' | ')}`);
      if (!nodo.parameters || typeof nodo.parameters.jsCode !== 'string') fallar(`El nodo "${n.nombre}" no es un nodo de código.`);
      const igual = nodo.parameters.jsCode === nuevo;
      nodo.parameters.jsCode = nuevo;
      console.log(`  ${igual ? '=' : '✔'} ${n.nombre}${igual ? ' (ya tenía esta versión)' : ': código nuevo'}`);
    }
  }

  await guardar(wf, nodos);
  console.log('Guardado.');
  await publicar(wf);

  const final = (await api('GET', '/workflows/' + wf.id)).d;
  if (args[0] !== '--restaurar') {
    const malos = NODOS.filter(n => !codigoPublicado(final, n.nombre).includes(n.marca)).map(n => n.nombre);
    if (malos.length) fallar('Se guardó, pero la versión publicada no tiene el código nuevo en: ' + malos.join(', ') + '. Abre el flujo en n8n y pulsa Publish.');
  }
  console.log(`Publicado · flujo ${final.active ? 'ACTIVO' : 'NO activo'}`);
  if (!final.active) fallar('El flujo quedó apagado. Ábrelo en n8n y pulsa Publish.');
  console.log('\nn8n listo. Si algo saliera mal:  node actualizar-n8n.js --restaurar "' + copia + '"');
})().catch(e => fallar(e.message));
