// Abre una copia cifrada de Google Drive (.zip.cifrado) y la deja como .zip normal.
// Uso:  node restaurar-respaldo.js "G:\Mi unidad\Respaldos Zentralia\zentralia-respaldo-2026-11-10_0300.zip.cifrado"
// Pide la contraseña del respaldo. Si la contraseña es incorrecta o el archivo está dañado, no escribe nada.
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

const archivo = process.argv[2];
if (!archivo || !fs.existsSync(archivo)) { console.log('Uso: node restaurar-respaldo.js <archivo .zip.cifrado>'); process.exit(1); }

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
  const datos = fs.readFileSync(archivo);
  if (datos.slice(0, 4).toString() !== 'ZRB1') { console.log('Ese archivo no es un respaldo cifrado de Zentralia.'); process.exit(1); }
  const sal = datos.slice(4, 20), iv = datos.slice(20, 32), etiqueta = datos.slice(datos.length - 16), cuerpo = datos.slice(32, datos.length - 16);
  const clave = await pedirClave();
  const llave = crypto.scryptSync(clave, sal, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', llave, iv);
  d.setAuthTag(etiqueta);
  let zip;
  try { zip = Buffer.concat([d.update(cuerpo), d.final()]); }
  catch (e) { console.log('Contraseña incorrecta o archivo dañado. No se escribió nada.'); process.exit(1); }
  const salida = archivo.replace(/\.cifrado$/, '');
  fs.writeFileSync(salida, zip);
  console.log('Listo: ' + salida + '  (ábrelo como cualquier .zip)');
})();
