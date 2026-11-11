// Respaldo de Zentralia: bases de datos, n8n y los paneles en un solo .zip, copiado a 4 lugares:
//   1. USB (la primera memoria USB conectada)   2. C:\Respaldos Zentralia   3. D:\Respaldos Zentralia
//   4. Google Drive (carpeta "Mi unidad\Respaldos Zentralia"), CIFRADO con tu contraseña (AES-256-GCM)
// Guarda las 7 últimas copias diarias y una por semana de las 4 semanas anteriores; lo más viejo se borra solo.
//
//   node respaldo-zentralia.js               -> respaldo ahora (lo usa el botón de la Oficina)
//   node respaldo-zentralia.js --automatico  -> lo usa la tarea de Windows de las 3:00 a. m.
//
// La contraseña de Drive la guarda configurar-respaldo.ps1, cifrada con tu usuario de Windows.
// El estado del último respaldo queda en C:\Respaldos Zentralia\ultimo-respaldo.json (lo lee la Oficina).
//
// MODO SERVIDOR (cuando Zentralia ya corre en el servidor): si existe C:\Respaldos Zentralia\servidor.json,
// este programa NO arma la copia: baja la copia cifrada que el servidor hizo a las 2:00 a. m. (con una llave que
// solo sirve para eso), comprueba su huella y la guarda en los mismos 4 lugares. Luego avisa al servidor (Oficina).

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const WIN = process.platform === 'win32';
const BASE = process.env.RESPALDO_BASE || 'C:\\Respaldos Zentralia';
const CONTENEDOR = process.env.RESPALDO_CONTENEDOR || 'chatwoot-postgres-1';
const CARPETAS = (process.env.RESPALDO_CARPETAS || 'C:\\panel-correos;C:\\kaizen-pruebas').split(';').filter(Boolean);
const SIMULAR = process.env.RESPALDO_SIMULAR === '1'; // pruebas: sin Docker ni n8n
const CARPETA_DESTINO = 'Respaldos Zentralia';
const ARCHIVO_CLAVE = path.join(BASE, 'clave-respaldo.dat');
const ESTADO = path.join(BASE, 'ultimo-respaldo.json');
const CANDADO = path.join(BASE, 'respaldo-en-curso.json');
const automatico = process.argv.includes('--automatico');
const SERVIDOR = (() => { try { const c = JSON.parse(fs.readFileSync(path.join(BASE, 'servidor.json'), 'utf8')); return c && c.host && c.llave ? c : null; } catch (e) { return null; } })();

fs.mkdirSync(BASE, { recursive: true });
const registro = [];
const log = (t) => { const l = `[${new Date().toLocaleTimeString('es-DO')}] ${t}`; registro.push(l); console.log(l); };
const problemas = [];
const mal = (t) => { problemas.push(t); log('ERROR  ' + t); };

function correr(cmd, args, opciones = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: WIN && /^(n8n|npm)$/.test(cmd), maxBuffer: 64 * 1024 * 1024, ...opciones });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} terminó con código ${r.status}: ${(r.stderr || '').trim().slice(0, 300)}`);
  return (r.stdout || '').trim();
}

// ---------- ZIP (sin librerías: deflate de Node + directorio central) ----------
const TABLA_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function fechaDos(d) {
  return { hora: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), dia: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function archivosDe(carpeta, base = carpeta) {
  const lista = [];
  for (const e of fs.readdirSync(carpeta, { withFileTypes: true })) {
    const ruta = path.join(carpeta, e.name);
    if (e.isDirectory()) lista.push(...archivosDe(ruta, base));
    else if (e.isFile()) lista.push({ ruta, nombre: path.relative(base, ruta).split(path.sep).join('/') });
  }
  return lista;
}
function crearZip(carpeta, destino) {
  const fd = fs.openSync(destino, 'w');
  const central = [];
  let pos = 0;
  const escribir = (b) => { fs.writeSync(fd, b); pos += b.length; };
  for (const a of archivosDe(carpeta)) {
    const datos = fs.readFileSync(a.ruta);
    const comprimido = zlib.deflateRawSync(datos, { level: 6 });
    const usar = comprimido.length < datos.length;
    const cuerpo = usar ? comprimido : datos;
    if (pos > 0xfffffff0 || datos.length > 0xfffffff0) throw new Error('El respaldo pasa de 4 GB: hace falta ZIP64.');
    const nombre = Buffer.from(a.nombre, 'utf8');
    const crc = crc32(datos);
    const { hora, dia } = fechaDos(fs.statSync(a.ruta).mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(usar ? 8 : 0, 8);
    local.writeUInt16LE(hora, 10); local.writeUInt16LE(dia, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(cuerpo.length, 18);
    local.writeUInt32LE(datos.length, 22); local.writeUInt16LE(nombre.length, 26); local.writeUInt16LE(0, 28);
    const inicio = pos;
    escribir(local); escribir(nombre); escribir(cuerpo);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(usar ? 8 : 0, 10);
    c.writeUInt16LE(hora, 12); c.writeUInt16LE(dia, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(cuerpo.length, 20); c.writeUInt32LE(datos.length, 24);
    c.writeUInt16LE(nombre.length, 28); c.writeUInt32LE(inicio, 42);
    central.push(Buffer.concat([c, nombre]));
  }
  const inicioCentral = pos;
  for (const c of central) escribir(c);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(central.length, 8); fin.writeUInt16LE(central.length, 10);
  fin.writeUInt32LE(pos - inicioCentral, 12); fin.writeUInt32LE(inicioCentral, 16);
  escribir(fin);
  fs.closeSync(fd);
  return central.length;
}

// ---------- Cifrado para Google Drive ----------
// Formato: "ZRB1" | sal (16) | iv (12) | datos cifrados (AES-256-GCM) | etiqueta (16). Llave: scrypt(contraseña, sal).
function llaveDe(clave, sal) { return crypto.scryptSync(clave, sal, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }); }
async function cifrar(origen, destino, clave) {
  const sal = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', llaveDe(clave, sal), iv);
  const salida = fs.createWriteStream(destino);
  salida.write(Buffer.concat([Buffer.from('ZRB1'), sal, iv]));
  await new Promise((ok, falla) => {
    const entrada = fs.createReadStream(origen);
    entrada.on('error', falla); c.on('error', falla); salida.on('error', falla);
    entrada.pipe(c).pipe(salida, { end: false });
    c.on('end', () => { salida.end(c.getAuthTag()); });
    salida.on('finish', ok);
  });
}

function leerClave() {
  if (process.env.RESPALDO_CLAVE) return process.env.RESPALDO_CLAVE; // solo para pruebas
  if (!fs.existsSync(ARCHIVO_CLAVE) || !WIN) return '';
  // La contraseña está cifrada con el usuario de Windows (DPAPI): solo este usuario, en este PC, la puede leer.
  const ps = `$s = Get-Content -LiteralPath '${ARCHIVO_CLAVE.replace(/'/g, "''")}' | ConvertTo-SecureString; ` +
    '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';
  try { return correr('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]); } catch (e) { mal('No pude leer la contraseña del respaldo: ' + e.message); return ''; }
}

// ---------- Lugares donde se guarda ----------
function discos() {
  if (process.env.RESPALDO_DESTINOS) return []; // pruebas: los lugares vienen en RESPALDO_DESTINOS
  if (!WIN) return [];
  try {
    const salida = correr('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, DriveType, FreeSpace, VolumeName | ConvertTo-Json -Compress']);
    const d = JSON.parse(salida || '[]');
    return (Array.isArray(d) ? d : [d]).map(x => ({ letra: x.DeviceID, tipo: x.DriveType, libre: Number(x.FreeSpace) || 0, nombre: x.VolumeName || '' }));
  } catch (e) { mal('No pude ver los discos: ' + e.message); return []; }
}
function carpetaDrive(lista) {
  if (process.env.RESPALDO_DRIVE !== undefined) return process.env.RESPALDO_DRIVE || null; // pruebas
  const candidatos = [];
  for (const d of lista) for (const sub of ['Mi unidad', 'My Drive']) candidatos.push(path.join(d.letra + '\\', sub));
  for (const sub of ['Google Drive\\Mi unidad', 'Google Drive\\My Drive', 'Google Drive', 'Mi unidad', 'My Drive']) candidatos.push(path.join(os.homedir(), sub));
  return candidatos.find(c => { try { return fs.statSync(c).isDirectory(); } catch (e) { return false; } }) || null;
}

// ---------- Limpieza: 7 copias diarias + 1 por semana de las 4 semanas anteriores ----------
function semana(d) { const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const dia = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dia); const ini = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return t.getUTCFullYear() + '-' + Math.ceil(((t - ini) / 86400000 + 1) / 7); }
function limpiar(carpeta) {
  const re = /^zentralia-respaldo-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.(zip|tar)(\.cifrado)?$/;
  const copias = fs.readdirSync(carpeta).map(n => { const m = n.match(re); return m && { n, f: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) }; })
    .filter(Boolean).sort((a, b) => b.f - a.f);
  const guardar = new Set(), dias = new Set(), semanas = new Set();
  for (const c of copias) {
    const dia = c.f.toDateString();
    if (dias.size < 7 && !dias.has(dia)) { dias.add(dia); guardar.add(c.n); continue; }
    if (dias.has(dia)) continue;
    const s = semana(c.f);
    if (semanas.size < 4 && !semanas.has(s) && ![...dias].some(x => semana(new Date(x)) === s)) { semanas.add(s); guardar.add(c.n); }
  }
  let borradas = 0;
  for (const c of copias) if (!guardar.has(c.n)) { try { fs.unlinkSync(path.join(carpeta, c.n)); borradas++; } catch (e) {} }
  return { guardadas: guardar.size, borradas };
}

// ---------- Modo servidor: bajar la copia cifrada que hizo el servidor ----------
function ssh(orden, opciones = {}) {
  const args = ['-i', SERVIDOR.llave, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', '-o', 'ServerAliveInterval=30',
    `${SERVIDOR.usuario || 'root'}@${SERVIDOR.host}`, orden];
  return spawnSync('ssh', args, { maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...opciones });
}
const textoDe = r => String((r.stderr || '') + (r.error ? ' ' + r.error.message : '')).trim().slice(0, 300);
function huellaDe(archivo) {
  return new Promise((ok, falla) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(archivo).on('error', falla).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex')));
  });
}
async function bajarDelServidor(destinos) {
  const r = ssh('ultimo', { encoding: 'utf8', timeout: 180000 });
  if (r.error || r.status !== 0) throw new Error('No pude hablar con el servidor: ' + textoDe(r));
  const [nombre, tam, huella] = String(r.stdout || '').trim().split(/\s+/);
  if (!/^zentralia-respaldo-\d{4}-\d{2}-\d{2}_\d{4}\.tar\.cifrado$/.test(nombre || '') || !/^[0-9a-f]{64}$/.test(huella || '')) throw new Error('Respuesta rara del servidor: ' + String(r.stdout).slice(0, 120));
  const tamano = Number(tam);
  const m = nombre.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/);
  const hecha = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  log(`Copia más nueva del servidor: ${nombre} (${(tamano / 1048576).toFixed(1)} MB)`);
  if (Date.now() - hecha.getTime() > 30 * 3600 * 1000) mal(`El servidor no ha hecho respaldo desde ${hecha.toLocaleString('es-DO')}: revisa la Oficina → Respaldos`);

  // Si ya está en C: (completa y con la misma huella) no se vuelve a bajar.
  const enC = path.join(BASE, nombre);
  let origen = null;
  if (fs.existsSync(enC) && fs.statSync(enC).size === tamano && await huellaDe(enC) === huella) { origen = enC; log('OK  ya estaba bajada en C:'); }
  else {
    origen = path.join(os.tmpdir(), nombre + '.bajando');
    const fd = fs.openSync(origen, 'w');
    const t0 = Date.now();
    const b = ssh('bajar ' + nombre, { stdio: ['ignore', fd, 'pipe'], timeout: 4 * 3600 * 1000 });
    fs.closeSync(fd);
    if (b.error || b.status !== 0) { try { fs.unlinkSync(origen); } catch (e) {} throw new Error('No se pudo bajar la copia: ' + textoDe(b)); }
    if (fs.statSync(origen).size !== tamano) { fs.unlinkSync(origen); throw new Error('La copia llegó incompleta (se corta el internet)'); }
    if (await huellaDe(origen) !== huella) { fs.unlinkSync(origen); throw new Error('La copia llegó dañada (la huella no coincide)'); }
    log(`OK  bajada y comprobada en ${Math.round((Date.now() - t0) / 1000)} s`);
  }

  const lista = discos();
  const usb = lista.find(d => d.tipo === 2 && d.libre > tamano * 1.2);
  const lugares = [
    { lugar: 'USB', carpeta: usb ? path.join(usb.letra + '\\', CARPETA_DESTINO) : null, falta: lista.some(d => d.tipo === 2) ? 'la memoria USB no tiene espacio' : 'no hay memoria USB conectada' },
    { lugar: 'Disco C:', carpeta: lista.some(d => d.letra === 'C:') ? BASE : null, falta: 'no hay disco C:' },
    { lugar: 'Disco D:', carpeta: lista.some(d => d.letra === 'D:' && d.tipo === 3) ? path.join('D:\\', CARPETA_DESTINO) : null, falta: 'no hay disco D:' },
    { lugar: 'Google Drive', carpeta: (() => { const g = carpetaDrive(lista); return g ? path.join(g, CARPETA_DESTINO) : null; })(), falta: 'no encontré la carpeta de Google Drive (¿está abierto Google Drive para escritorio?)' }
  ];
  if (process.env.RESPALDO_DESTINOS) JSON.parse(process.env.RESPALDO_DESTINOS).forEach((c, i) => { if (lugares[i]) lugares[i].carpeta = c; });
  for (const l of lugares) {
    const d = { lugar: l.lugar, ruta: l.carpeta, ok: false, cifrado: true, error: '' };
    destinos.push(d);
    if (!l.carpeta) { d.error = l.falta; mal(`${l.lugar}: ${l.falta}`); continue; }
    try {
      fs.mkdirSync(l.carpeta, { recursive: true });
      const final = path.join(l.carpeta, nombre);
      if (path.resolve(final).toLowerCase() !== path.resolve(origen).toLowerCase()) {
        fs.copyFileSync(origen, final + '.parcial');
        if (fs.statSync(final + '.parcial').size !== tamano) throw new Error('la copia quedó incompleta');
        fs.renameSync(final + '.parcial', final); // Drive no sube un archivo a medias
      }
      const lim = limpiar(l.carpeta);
      Object.assign(d, { ruta: final, ok: true, copias: lim.guardadas, borradas: lim.borradas });
      log(`OK  ${l.lugar}: ${final}${lim.borradas ? ` (borradas ${lim.borradas} copias viejas)` : ''}`);
    } catch (e) { d.error = e.message; mal(`${l.lugar}: ${e.message}`); }
  }
  if (origen !== enC && fs.existsSync(origen)) { try { fs.unlinkSync(origen); } catch (e) {} }
  // Avisar al servidor dónde quedó (lo muestra la Oficina)
  const aviso = { fecha: new Date().toISOString(), archivo: nombre, ok: destinos.every(d => d.ok), destinos: destinos.map(d => ({ lugar: d.lugar, ok: d.ok, ruta: d.ruta, copias: d.copias, error: d.error })) };
  const a = ssh('recibido', { input: JSON.stringify(aviso), encoding: 'utf8', timeout: 60000 });
  if (a.error || a.status !== 0) log('(no pude avisarle al servidor: ' + textoDe(a) + ')');
  return { nombre, tamano };
}

// ---------- El respaldo ----------
(async () => {
  if (fs.existsSync(CANDADO)) {
    const viejo = JSON.parse(fs.readFileSync(CANDADO, 'utf8'));
    if (Date.now() - Date.parse(viejo.inicio) < 2 * 3600 * 1000) { console.log('Ya hay un respaldo en curso desde ' + viejo.inicio); process.exit(0); }
  }
  const inicio = new Date();
  fs.writeFileSync(CANDADO, JSON.stringify({ inicio: inicio.toISOString(), pid: process.pid }));
  const p2 = n => String(n).padStart(2, '0');
  const nombre = `zentralia-respaldo-${inicio.getFullYear()}-${p2(inicio.getMonth() + 1)}-${p2(inicio.getDate())}_${p2(inicio.getHours())}${p2(inicio.getMinutes())}.zip`;
  const temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'zentralia-respaldo-'));
  const destinos = [];
  let tamano = 0, archivos = 0;
  try {
    if (SERVIDOR) {
      log(`Respaldo ${automatico ? 'automático' : 'manual'} · bajando la copia del servidor ${SERVIDOR.host}`);
      const r = await bajarDelServidor(destinos);
      tamano = r.tamano; archivos = 1;
      return;
    }
    log(`Respaldo ${automatico ? 'automático' : 'manual'} · ${nombre}`);
    // 1. Bases de datos
    const carpetaBases = path.join(temporal, 'bases-de-datos');
    fs.mkdirSync(carpetaBases);
    if (SIMULAR) fs.writeFileSync(path.join(carpetaBases, 'correos.backup'), crypto.randomBytes(20000));
    else {
      try {
        const bases = correr('docker', ['exec', CONTENEDOR, 'psql', '-U', 'postgres', '-Atc',
          "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname"]).split(/\r?\n/).map(s => s.trim()).filter(s => /^[A-Za-z0-9_]+$/.test(s));
        for (const b of bases) {
          try {
            correr('docker', ['exec', CONTENEDOR, 'pg_dump', '-U', 'postgres', '-d', b, '-Fc', '-f', `/tmp/${b}.backup`]);
            correr('docker', ['cp', `${CONTENEDOR}:/tmp/${b}.backup`, path.join(carpetaBases, `${b}.backup`)]);
            try { correr('docker', ['exec', CONTENEDOR, 'rm', '-f', `/tmp/${b}.backup`]); } catch (e) {}
            log(`OK  base ${b} (${Math.round(fs.statSync(path.join(carpetaBases, `${b}.backup`)).size / 1024)} KB)`);
          } catch (e) { mal(`Base ${b}: ${e.message}`); }
        }
        if (!bases.includes('correos')) mal("No aparece la base 'correos' de Somos Viajes");
      } catch (e) { mal('Bases de datos: ' + e.message + ' ¿Está Docker Desktop abierto?'); }
    }
    // 2. n8n (flujos, credenciales cifradas y su llave)
    if (!SIMULAR) {
      for (const [que, archivo] of [['workflow', 'flujos.json'], ['credentials', 'credenciales.json']]) {
        // En Windows n8n es un .cmd (se corre con shell): la ruta va entre comillas por si tiene espacios.
        try { correr('n8n', [`export:${que}`, '--all', WIN ? `--output="${path.join(temporal, archivo)}"` : `--output=${path.join(temporal, archivo)}`]); log('OK  n8n ' + archivo); }
        catch (e) { mal(`n8n ${archivo}: ${e.message}`); }
      }
      const llave = path.join(os.homedir(), '.n8n', 'config');
      if (fs.existsSync(llave)) fs.copyFileSync(llave, path.join(temporal, 'n8n-config')); else mal('No encontré la llave de n8n (' + llave + ')');
    }
    // 3. Carpetas de los paneles (sin node_modules ni la caché de correos)
    for (const c of CARPETAS) {
      if (!fs.existsSync(c)) { log(`(no existe ${c}; se omite)`); continue; }
      fs.cpSync(c, path.join(temporal, path.basename(c)), { recursive: true, filter: src => !/[\\/](node_modules|cache-correos|auditoria-correos)([\\/]|$)/.test(src) });
      log('OK  carpeta ' + c);
    }
    fs.writeFileSync(path.join(temporal, 'LEEME.txt'), [
      `RESPALDO ZENTRALIA - ${inicio.toLocaleString('es-DO')}`, '',
      'bases-de-datos\\   una copia por base (pg_dump). Restaurar una base, por ejemplo "correos":',
      `   docker cp .\\bases-de-datos\\correos.backup ${CONTENEDOR}:/tmp/correos.backup`,
      `   docker exec ${CONTENEDOR} pg_restore -U postgres -d correos --clean --if-exists /tmp/correos.backup`,
      'flujos.json, credenciales.json, n8n-config   n8n (las credenciales van cifradas; n8n-config es su llave)',
      '   n8n import:workflow --input=.\\flujos.json   y   n8n import:credentials --input=.\\credenciales.json',
      'panel-correos\\, kaizen-pruebas\\   los paneles (incluyen config.js con contraseñas)', '',
      'La copia de Google Drive termina en .zip.cifrado: se abre con  node restaurar-respaldo.js <archivo>  y tu contraseña.',
      'NUNCA uses "docker compose down -v": borra las bases de datos.'].join('\r\n'));
    // 4. El zip
    const zip = path.join(temporal, '..', nombre);
    archivos = crearZip(temporal, zip);
    tamano = fs.statSync(zip).size;
    log(`OK  zip con ${archivos} archivos (${(tamano / 1048576).toFixed(1)} MB)`);

    // 5. Copiar a los 4 lugares
    const lista = discos();
    const usb = lista.find(d => d.tipo === 2 && d.libre > tamano * 1.2);
    const lugares = [
      { lugar: 'USB', carpeta: usb ? path.join(usb.letra + '\\', CARPETA_DESTINO) : null, falta: lista.some(d => d.tipo === 2) ? 'la memoria USB no tiene espacio' : 'no hay memoria USB conectada' },
      { lugar: 'Disco C:', carpeta: lista.some(d => d.letra === 'C:') ? path.join('C:\\', CARPETA_DESTINO) : null, falta: 'no hay disco C:' },
      { lugar: 'Disco D:', carpeta: lista.some(d => d.letra === 'D:' && d.tipo === 3) ? path.join('D:\\', CARPETA_DESTINO) : null, falta: 'no hay disco D:' },
      { lugar: 'Google Drive', carpeta: (() => { const g = carpetaDrive(lista); return g ? path.join(g, CARPETA_DESTINO) : null; })(), falta: 'no encontré la carpeta de Google Drive (¿está abierto Google Drive para escritorio?)', cifrado: true }
    ];
    if (process.env.RESPALDO_DESTINOS) JSON.parse(process.env.RESPALDO_DESTINOS).forEach((c, i) => { if (lugares[i]) lugares[i].carpeta = c; });
    let clave = null;
    for (const l of lugares) {
      const r = { lugar: l.lugar, ruta: l.carpeta, ok: false, cifrado: Boolean(l.cifrado), error: '' };
      destinos.push(r);
      if (!l.carpeta) { r.error = l.falta; mal(`${l.lugar}: ${l.falta}`); continue; }
      try {
        fs.mkdirSync(l.carpeta, { recursive: true });
        if (l.cifrado) {
          if (clave === null) clave = leerClave();
          if (!clave) throw new Error('falta la contraseña del respaldo: ejecuta configurar-respaldo.ps1');
          const final = path.join(l.carpeta, nombre + '.cifrado');
          await cifrar(zip, final + '.parcial', clave);
          fs.renameSync(final + '.parcial', final); // Drive no sube un archivo a medias
          r.ruta = final;
        } else {
          const final = path.join(l.carpeta, nombre);
          fs.copyFileSync(zip, final + '.parcial');
          if (fs.statSync(final + '.parcial').size !== tamano) throw new Error('la copia quedó incompleta');
          fs.renameSync(final + '.parcial', final);
          r.ruta = final;
        }
        const lim = limpiar(l.carpeta);
        r.ok = true; r.copias = lim.guardadas; r.borradas = lim.borradas;
        log(`OK  ${l.lugar}: ${r.ruta}${lim.borradas ? ` (borradas ${lim.borradas} copias viejas)` : ''}`);
      } catch (e) { r.error = e.message; mal(`${l.lugar}: ${e.message}`); }
    }
    fs.unlinkSync(zip);
  } catch (e) {
    mal('El respaldo se detuvo: ' + e.message);
  } finally {
    try { fs.rmSync(temporal, { recursive: true, force: true }); } catch (e) {}
    const fin = new Date();
    const estado = { inicio: inicio.toISOString(), fin: fin.toISOString(), segundos: Math.round((fin - inicio) / 1000), automatico,
      ok: destinos.length > 0 && destinos.every(d => d.ok) && !problemas.length, algunoOk: destinos.some(d => d.ok),
      tamano, archivos, destinos, problemas, registro: registro.slice(-80) };
    fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 2));
    fs.appendFileSync(path.join(BASE, 'respaldos.log'), registro.join('\r\n') + '\r\n\r\n');
    try { fs.unlinkSync(CANDADO); } catch (e) {}
    log(estado.ok ? 'TODO BIEN: respaldo en los 4 lugares.' : estado.algunoOk ? 'Respaldo hecho, pero con avisos (ver arriba).' : 'EL RESPALDO FALLÓ.');
    process.exitCode = estado.algunoOk ? 0 : 1;
  }
})();
