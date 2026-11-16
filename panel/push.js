// Avisos del navegador aunque el panel esté cerrado (Web Push con claves VAPID). Solo usa Node: sin librerías nuevas.
// Guarda las claves y las suscripciones de cada usuario en la base; cifra el aviso (aes128gcm, RFC 8291) y lo manda
// al servicio de notificaciones del navegador (Chrome/Edge usan el de Google/Microsoft).
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const desb64u = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

module.exports = function crearPush({ client, contacto = 'https://kaizenia.app' }) {
  let claves = null;

  async function prepararClaves() {
    if (claves) return claves;
    await client.query(`CREATE TABLE IF NOT EXISTS push_claves (id INTEGER PRIMARY KEY, publica TEXT NOT NULL, privada TEXT NOT NULL)`);
    await client.query(`CREATE TABLE IF NOT EXISTS push_suscripciones (
      id SERIAL PRIMARY KEY, usuario VARCHAR(50) NOT NULL, endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL, creado TIMESTAMP NOT NULL DEFAULT NOW())`);
    let fila = (await client.query('SELECT publica, privada FROM push_claves WHERE id = 1')).rows[0];
    if (!fila) {
      const par = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = par.publicKey.export({ format: 'jwk' });
      const publica = Buffer.concat([Buffer.from([4]), desb64u(jwk.x), desb64u(jwk.y)]);
      const privada = par.privateKey.export({ type: 'pkcs8', format: 'pem' });
      await client.query('INSERT INTO push_claves (id, publica, privada) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING', [b64u(publica), privada]);
      fila = (await client.query('SELECT publica, privada FROM push_claves WHERE id = 1')).rows[0];
    }
    claves = { publicaTexto: fila.publica, privada: crypto.createPrivateKey(fila.privada) };
    return claves;
  }

  // Cabecera VAPID (JWT firmado con ES256).
  function jwtVapid(audiencia, k) {
    const cabecera = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const cuerpo = b64u(JSON.stringify({ aud: audiencia, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contacto }));
    const datos = cabecera + '.' + cuerpo;
    const firma = crypto.sign('sha256', Buffer.from(datos), { key: k.privada, dsaEncoding: 'ieee-p1363' });
    return datos + '.' + b64u(firma);
  }

  // Cifrado del aviso (aes128gcm, RFC 8291 y RFC 8188).
  function cifrar(texto, sus) {
    const uaPublica = desb64u(sus.p256dh);
    const auth = desb64u(sus.auth);
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const asPublica = ecdh.getPublicKey();
    const secreto = ecdh.computeSecret(uaPublica);
    const salt = crypto.randomBytes(16);
    const infoClave = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublica, asPublica]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', secreto, auth, infoClave, 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const datos = Buffer.concat([Buffer.from(texto, 'utf8'), Buffer.from([2])]);
    const cifra = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const cifrado = Buffer.concat([cifra.update(datos), cifra.final(), cifra.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096, 0);
    return Buffer.concat([salt, rs, Buffer.from([asPublica.length]), asPublica, cifrado]);
  }

  function enviarA(sus, texto, k) {
    return new Promise(ok => {
      let url;
      try { url = new URL(sus.endpoint); } catch (e) { return ok(0); }
      const cuerpo = cifrar(texto, sus);
      const req = https.request({
        hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'POST',
        headers: {
          TTL: '86400', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
          'Content-Length': cuerpo.length, Authorization: `vapid t=${jwtVapid(url.origin, k)}, k=${k.publicaTexto}`
        }
      }, res => { res.resume(); res.on('end', () => ok(res.statusCode)); });
      req.on('error', () => ok(0));
      req.setTimeout(15000, () => req.destroy());
      req.end(cuerpo);
    });
  }

  return {
    async clavePublica() { return (await prepararClaves()).publicaTexto; },

    async suscribir(usuario, sub) {
      const endpoint = String(sub && sub.endpoint || '');
      const p256dh = String(sub && sub.keys && sub.keys.p256dh || '');
      const auth = String(sub && sub.keys && sub.keys.auth || '');
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !p256dh || !auth) throw new Error('Suscripción no válida.');
      await prepararClaves();
      await client.query(`INSERT INTO push_suscripciones (usuario, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
        ON CONFLICT (endpoint) DO UPDATE SET usuario = EXCLUDED.usuario, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [usuario, endpoint, p256dh, auth]);
    },

    async quitar(usuario, endpoint) {
      await client.query('DELETE FROM push_suscripciones WHERE usuario = $1 AND endpoint = $2', [usuario, String(endpoint || '')]);
    },

    // Manda el aviso a todos los navegadores suscritos de ese usuario. No espera: no frena al panel.
    avisarUsuario(usuario, titulo, cuerpo, ruta = '/') {
      (async () => {
        const subs = (await client.query('SELECT * FROM push_suscripciones WHERE usuario = $1', [usuario])).rows;
        if (!subs.length) return;
        const k = await prepararClaves();
        const texto = JSON.stringify({ titulo: String(titulo || 'Zentralia').slice(0, 80), cuerpo: String(cuerpo || '').slice(0, 220), url: ruta });
        for (const s of subs) {
          const estado = await enviarA(s, texto, k);
          // El navegador ya no tiene esa suscripción (la quitaron o expiró): se borra.
          if (estado === 404 || estado === 410) await client.query('DELETE FROM push_suscripciones WHERE id = $1', [s.id]);
        }
      })().catch(e => console.log('Push:', e.message));
    },

    // Para probar: verifica el cifrado y la firma con una suscripción de prueba.
    _pruebas: { cifrar, jwtVapid, prepararClaves }
  };
};
