#!/usr/bin/env node
// Respaldo de Zentralia EN EL SERVIDOR (Linux). Lo corre systemd cada noche a las 2:00 a. m.
// y también cuando se pulsa "Respaldar ahora" en la Oficina (la Oficina deja el archivo "pedir-respaldo").
//
// Junta en un solo archivo CIFRADO (formato ZRB1, el mismo de restaurar-respaldo.js):
//   bases-de-datos.sql.gz   todas las bases (Somos Viajes, Oficina, demo y Chatwoot)
//   chatwoot-archivos.tgz   archivos subidos a Chatwoot
//   n8n.tgz                 n8n completo (flujos, credenciales y su llave)
//   paneles.tgz             los paneles con sus ajustes (sin node_modules ni caché)
//   sistema.tgz             servicios del servidor (paneles, túnel, respaldo)
// Guarda las últimas copias en el servidor; la PC baja la más nueva a las 3:00 a. m. (USB, C:, D: y Drive).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const BASE = process.env.RESPALDO_BASE || '/srv/zentralia/respaldos';
const ARCHIVO_CLAVE = process.env.RESPALDO_CLAVE_ARCHIVO || '/root/.zentralia-respaldo.clave';
const APPS = process.env.RESPALDO_APPS || '/srv/zentralia/apps';
const DATOS = process.env.RESPALDO_DATOS || '/srv/zentralia/datos';
const PG = process.env.RESPALDO_CONTENEDOR || 'chatwoot-postgres-1';
const GUARDAR = Math.max(1, Number(process.env.RESPALDO_GUARDAR) || 3);
const SIMULAR = process.env.RESPALDO_SIMULAR === '1'; // pruebas: sin Docker
const ESTADO = path.join(BASE, 'ultimo-respaldo.json');
const CANDADO = path.join(BASE, 'respaldo-en-curso.json');
const PEDIDO = path.join(BASE, 'pedir-respaldo');
const PATRON = /^zentralia-respaldo-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.tar\.cifrado$/;

const registro = [];
const problemas = [];
const log = t => { const l = `[${new Date().toLocaleTimeString('es-DO', { hour12: false })}] ${t}`; registro.push(l); console.log(l); };
const mal = t => { problemas.push(t); log('ERROR  ' + t); };

function correr(cmd, args, opciones = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opciones });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} terminó con código ${r.status}: ${(r.stderr || '').trim().slice(-300)}`);
  return (r.stdout || '').trim();
}
const bash = linea => correr('bash', ['-o', 'pipefail', '-c', linea]);
const mb = n => (n / 1048576).toFixed(1) + ' MB';

// Cifrado: "ZRB1" | sal (16) | iv (12) | datos (AES-256-GCM) | etiqueta (16). Llave: scrypt(contraseña, sal).
function llaveDe(clave, sal) { return crypto.scryptSync(clave, sal, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }); }
function empaquetarCifrado(carpeta, destino, clave) {
  return new Promise((ok, falla) => {
    const sal = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', llaveDe(clave, sal), iv);
    const salida = fs.createWriteStream(destino, { mode: 0o600 });
    salida.write(Buffer.concat([Buffer.from('ZRB1'), sal, iv]));
    const tar = spawn('tar', ['-cf', '-', '-C', carpeta, '.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errTar = '';
    tar.stderr.on('data', d => { errTar += d; });
    tar.on('error', falla); c.on('error', falla); salida.on('error', falla);
    tar.on('close', codigo => { if (codigo !== 0) falla(new Error('tar terminó con código ' + codigo + ': ' + errTar.slice(-300))); });
    tar.stdout.pipe(c).pipe(salida, { end: false });
    c.on('end', () => salida.end(c.getAuthTag()));
    salida.on('finish', ok);
  });
}
function sha256(archivo) {
  return new Promise((ok, falla) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(archivo).on('error', falla).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex')));
  });
}

function limpiar() {
  const copias = fs.readdirSync(BASE).filter(n => PATRON.test(n)).sort().reverse();
  let borradas = 0;
  for (const n of copias.slice(GUARDAR)) { try { fs.unlinkSync(path.join(BASE, n)); borradas++; } catch (e) {} }
  return { guardadas: Math.min(copias.length, GUARDAR), borradas };
}

(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  const manual = fs.existsSync(PEDIDO) || process.argv.includes('--manual');
  try { fs.unlinkSync(PEDIDO); } catch (e) {}
  const automatico = !manual;
  if (fs.existsSync(CANDADO)) {
    try {
      const viejo = JSON.parse(fs.readFileSync(CANDADO, 'utf8'));
      if (Date.now() - Date.parse(viejo.inicio) < 2 * 3600 * 1000) { console.log('Ya hay un respaldo en curso desde ' + viejo.inicio); return; }
    } catch (e) {}
  }
  const inicio = new Date();
  fs.writeFileSync(CANDADO, JSON.stringify({ inicio: inicio.toISOString(), pid: process.pid }), { mode: 0o640 });
  const p2 = n => String(n).padStart(2, '0');
  const nombre = `zentralia-respaldo-${inicio.getFullYear()}-${p2(inicio.getMonth() + 1)}-${p2(inicio.getDate())}_${p2(inicio.getHours())}${p2(inicio.getMinutes())}.tar.cifrado`;
  const trabajo = fs.mkdtempSync(path.join(BASE, '.trabajo-'));
  fs.chmodSync(trabajo, 0o700);
  const destinos = [];
  let tamano = 0, archivos = 0, huella = '';
  let n8nPausado = false;
  try {
    log(`Respaldo ${automatico ? 'automático' : 'manual'} del servidor · ${nombre}`);
    let clave = '';
    try { clave = fs.readFileSync(ARCHIVO_CLAVE, 'utf8').replace(/\r?\n$/, ''); } catch (e) {}
    if (clave.length < 8) throw new Error('falta la contraseña del respaldo (' + ARCHIVO_CLAVE + '): corre instalar-respaldo.sh');

    // 1. Bases de datos (todas, con usuarios y contraseñas de Postgres)
    if (SIMULAR) fs.writeFileSync(path.join(trabajo, 'bases-de-datos.sql.gz'), crypto.randomBytes(50000));
    else {
      try {
        const bases = correr('docker', ['exec', PG, 'psql', '-U', 'postgres', '-Atc', 'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY 1']).split(/\n/);
        bash(`docker exec ${PG} pg_dumpall -U postgres --clean --if-exists | gzip > '${trabajo}/bases-de-datos.sql.gz'`);
        log(`OK  bases de datos (${bases.filter(b => b !== 'postgres').join(', ')}) · ${mb(fs.statSync(path.join(trabajo, 'bases-de-datos.sql.gz')).size)}`);
        for (const b of ['correos', 'kaizen_central']) if (!bases.includes(b)) mal(`No aparece la base '${b}'`);
      } catch (e) { mal('Bases de datos: ' + e.message); }
    }

    // 2. Archivos de Chatwoot
    if (!SIMULAR) {
      try {
        correr('docker', ['run', '--rm', '-v', 'chatwoot_storage_data:/d:ro', '-v', `${trabajo}:/m`, 'alpine', 'tar', 'czf', '/m/chatwoot-archivos.tgz', '-C', '/d', '.']);
        log('OK  archivos de Chatwoot · ' + mb(fs.statSync(path.join(trabajo, 'chatwoot-archivos.tgz')).size));
      } catch (e) { mal('Archivos de Chatwoot: ' + e.message); }
    }

    // 3. n8n: se pausa 2-3 segundos mientras se copia su base (así la copia queda exacta) y sigue trabajando.
    if (fs.existsSync(path.join(DATOS, 'n8n'))) {
      const copia = path.join(trabajo, 'n8n-copia');
      try {
        if (!SIMULAR) { correr('docker', ['pause', 'n8n']); n8nPausado = true; }
        fs.mkdirSync(copia);
        correr('cp', ['-a', path.join(DATOS, 'n8n'), copia]);
        if (fs.existsSync(path.join(DATOS, 'n8n.env'))) correr('cp', ['-a', path.join(DATOS, 'n8n.env'), copia]);
      } catch (e) { mal('n8n (copia): ' + e.message); }
      finally { if (n8nPausado) { try { correr('docker', ['unpause', 'n8n']); n8nPausado = false; } catch (e) { mal('No pude reanudar n8n: ' + e.message); } } }
      try {
        correr('tar', ['czf', path.join(trabajo, 'n8n.tgz'), '-C', copia, '.']);
        fs.rmSync(copia, { recursive: true, force: true });
        log('OK  n8n · ' + mb(fs.statSync(path.join(trabajo, 'n8n.tgz')).size));
      } catch (e) { mal('n8n: ' + e.message); }
    } else mal('No encontré n8n en ' + DATOS);

    // 4. Paneles y Chatwoot (ajustes), sin librerías ni caché
    try {
      const carpetas = ['panel-correos', 'kaizen-pruebas', 'chatwoot'].filter(c => fs.existsSync(path.join(APPS, c)));
      correr('tar', ['czf', path.join(trabajo, 'paneles.tgz'), '--exclude=node_modules', '--exclude=cache-correos', '--exclude=auditoria-correos',
        '--exclude=*.log', '-C', APPS, ...carpetas]);
      log(`OK  paneles (${carpetas.join(', ')}) · ${mb(fs.statSync(path.join(trabajo, 'paneles.tgz')).size)}`);
    } catch (e) { mal('Paneles: ' + e.message); }

    // 5. Servicios del servidor (para rearmarlo igual en otro servidor)
    try {
      const sistema = ['/etc/systemd/system', '/etc/ssh/sshd_config.d', '/etc/apt/apt.conf.d/20auto-upgrades'].filter(f => fs.existsSync(f));
      const lista = [];
      for (const s of sistema) {
        if (fs.statSync(s).isDirectory()) for (const n of fs.readdirSync(s)) { if (/^(zentralia|cloudflared|00-zentralia)/.test(n)) lista.push(path.join(s, n)); }
        else lista.push(s);
      }
      if (lista.length) correr('tar', ['czf', path.join(trabajo, 'sistema.tgz'), '--ignore-failed-read', ...lista]);
      log('OK  servicios del servidor (' + lista.length + ' archivos)');
    } catch (e) { mal('Servicios del servidor: ' + e.message); }

    fs.writeFileSync(path.join(trabajo, 'LEEME.txt'), [
      `RESPALDO ZENTRALIA (servidor) - ${inicio.toLocaleString('es-DO')}`, '',
      'Este archivo se abre con:  node restaurar-respaldo.js "zentralia-respaldo-....tar.cifrado"  y la contraseña del respaldo.',
      'Queda un .tar: se abre con 7-Zip, o en PowerShell:  tar -xf "archivo.tar" -C "carpeta"', '',
      'bases-de-datos.sql.gz   TODAS las bases. En un servidor nuevo con Postgres (pgvector/pgvector:pg16) encendido:',
      `   gunzip -c bases-de-datos.sql.gz | docker exec -i ${PG} psql -U postgres -d postgres`,
      'chatwoot-archivos.tgz   va dentro del volumen chatwoot_storage_data (tar xzf ... -C /app/storage)',
      'n8n.tgz                 carpeta de n8n: va en /srv/zentralia/datos (dueño 1000:1000)',
      'paneles.tgz             panel-correos, kaizen-pruebas y chatwoot (con config.js y .env: tienen contraseñas)',
      'sistema.tgz             servicios zentralia-*, túnel (cloudflared) y entrada segura', '',
      'NUNCA uses "docker compose down -v": borra las bases de datos.'].join('\n'));

    // 6. Un solo archivo, cifrado
    const final = path.join(BASE, nombre);
    archivos = fs.readdirSync(trabajo).length;
    await empaquetarCifrado(trabajo, final + '.parcial', clave);
    fs.renameSync(final + '.parcial', final);
    fs.chmodSync(final, 0o600);
    tamano = fs.statSync(final).size;
    huella = await sha256(final);
    const lim = limpiar();
    destinos.push({ lugar: 'Servidor', ruta: final, ok: true, cifrado: true, copias: lim.guardadas, borradas: lim.borradas, error: '' });
    log(`OK  copia cifrada en el servidor: ${nombre} (${mb(tamano)})${lim.borradas ? ` · borradas ${lim.borradas} copias viejas` : ''}`);
  } catch (e) {
    mal('El respaldo se detuvo: ' + e.message);
    destinos.push({ lugar: 'Servidor', ruta: '', ok: false, cifrado: true, error: e.message });
  } finally {
    if (n8nPausado) { try { correr('docker', ['unpause', 'n8n']); } catch (e) {} }
    try { fs.rmSync(trabajo, { recursive: true, force: true }); } catch (e) {}
    for (const n of fs.readdirSync(BASE)) if (n.endsWith('.parcial')) { try { fs.unlinkSync(path.join(BASE, n)); } catch (e) {} }
    const fin = new Date();
    const estado = { inicio: inicio.toISOString(), fin: fin.toISOString(), segundos: Math.round((fin - inicio) / 1000), automatico,
      servidor: true, archivo: destinos[0] && destinos[0].ok ? nombre : '', sha256: huella,
      ok: destinos.length > 0 && destinos.every(d => d.ok) && !problemas.length, algunoOk: destinos.some(d => d.ok),
      tamano, archivos, destinos, problemas, registro: registro.slice(-80) };
    fs.writeFileSync(ESTADO + '.tmp', JSON.stringify(estado, null, 2), { mode: 0o640 });
    fs.renameSync(ESTADO + '.tmp', ESTADO);
    fs.appendFileSync(path.join(BASE, 'respaldos.log'), registro.join('\n') + '\n\n');
    try { fs.unlinkSync(CANDADO); } catch (e) {}
    console.log(estado.ok ? 'TODO BIEN: respaldo del servidor listo.' : estado.algunoOk ? 'Respaldo hecho, con avisos (ver arriba).' : 'EL RESPALDO FALLÓ.');
    process.exitCode = estado.algunoOk ? 0 : 1;
  }
})();
