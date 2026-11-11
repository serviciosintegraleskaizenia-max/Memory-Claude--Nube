// Abre una copia cifrada de Zentralia (.zip.cifrado o .tar.cifrado) y la deja como .zip o .tar normal.
// Uso:  node restaurar-respaldo.js "C:\Respaldos Zentralia\zentralia-respaldo-2026-11-12_0200.tar.cifrado"
// Pide la contraseña del respaldo. Si la contraseña es incorrecta o el archivo está dañado, no deja nada a medias.
// Funciona en Windows y en el servidor. Lee por partes: sirve para copias grandes.
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

const archivo = process.argv[2];
if (!archivo || !fs.existsSync(archivo)) { console.log('Uso: node restaurar-respaldo.js <archivo .zip.cifrado o .tar.cifrado>'); process.exit(1); }

function pedirClave() {
  if (process.env.RESPALDO_CLAVE) return Promise.resolve(process.env.RESPALDO_CLAVE);
  return new Promise(ok => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = s => { if (!rl.stdoutMuted || s.includes('Contraseña')) process.stdout.write(s); };
    rl.question('Contraseña del respaldo: ', c => { rl.close(); process.stdout.write('\n'); ok(c); });
  });
}

(async () => {
  const tamano = fs.statSync(archivo).size;
  const fd = fs.openSync(archivo, 'r');
  const cabeza = Buffer.alloc(32), etiqueta = Buffer.alloc(16);
  fs.readSync(fd, cabeza, 0, 32, 0);
  fs.readSync(fd, etiqueta, 0, 16, tamano - 16);
  fs.closeSync(fd);
  if (tamano < 48 || cabeza.slice(0, 4).toString() !== 'ZRB1') { console.log('Ese archivo no es un respaldo cifrado de Zentralia.'); process.exit(1); }
  const sal = cabeza.slice(4, 20), iv = cabeza.slice(20, 32);
  const clave = await pedirClave();
  const llave = crypto.scryptSync(clave, sal, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', llave, iv);
  d.setAuthTag(etiqueta);
  const salida = archivo.replace(/\.cifrado$/, '');
  const parcial = salida + '.parcial';
  try {
    await new Promise((ok, falla) => {
      const entrada = fs.createReadStream(archivo, { start: 32, end: tamano - 17 });
      const escribir = fs.createWriteStream(parcial);
      entrada.on('error', falla); d.on('error', falla); escribir.on('error', falla);
      escribir.on('finish', ok);
      entrada.pipe(d).pipe(escribir);
    });
  } catch (e) {
    try { fs.unlinkSync(parcial); } catch (x) {}
    console.log('Contraseña incorrecta o archivo dañado. No se escribió nada.');
    process.exit(1);
  }
  fs.renameSync(parcial, salida);
  console.log('Listo: ' + salida);
  if (/\.tar$/i.test(salida)) console.log('Ábrelo con 7-Zip, o en PowerShell:  mkdir restaurado; tar -xf "' + salida + '" -C restaurado');
  else console.log('Ábrelo como cualquier .zip');
})();
