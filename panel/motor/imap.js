// Gmail, Google Workspace y correo de dominio propio (Zoho, Hostinger, GoDaddy, cPanel...) por IMAP.
// Microsoft 365 va por microsoft.js (Microsoft ya no deja entrar por IMAP con contraseña).
//
// Gmail: hace falta la verificación en 2 pasos y una "contraseña de aplicación" (16 letras).
// Servidor IMAP: imap.gmail.com, puerto 993. Para responder: smtp.gmail.com, puerto 465.

const { htmlATexto, decodificar } = require('./clasificar');

let ImapFlow = null;
let simpleParser = null;
function cargar() {
  if (ImapFlow) return;
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
  } catch (e) {
    throw new Error('Falta instalar la lectura de Gmail/IMAP. En la carpeta del panel corre: npm install imapflow@2.2.7 mailparser@3.9.37');
  }
}

// Una conexión por vuelta del motor: se listan los correos y se leen completos solo los nuevos.
async function abrir(cfg) {
  cargar();
  const puerto = Number(cfg.puerto) || 993;
  const c = new ImapFlow({
    host: cfg.host, port: puerto, secure: puerto === 993,
    auth: { user: cfg.usuario, pass: cfg.clave },
    logger: false, socketTimeout: 90000, connectionTimeout: 30000
  });
  c.on('error', () => {}); // los errores se manejan en cada llamada
  try {
    await c.connect();
  } catch (e) {
    if (e.authenticationFailed || /auth/i.test(e.message || '')) {
      throw new Error('El correo rechazó el usuario o la contraseña. En Gmail hay que usar una contraseña de aplicación.');
    }
    throw new Error('No se pudo conectar al correo (' + cfg.host + '): ' + (e.message || e.code));
  }
  const lock = await c.getMailboxLock('INBOX');

  // Correos de la bandeja de entrada desde "desde" (ISO), leídos o no. No marca nada como leído.
  async function listar(desde, maximo = 500) {
    const limite = new Date(desde);
    const uids = await c.search({ since: limite }, { uid: true });
    const ultimos = (uids || []).slice(-maximo);
    const lista = [];
    if (!ultimos.length) return lista;
    for await (const m of c.fetch(ultimos, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
      const fecha = m.internalDate ? new Date(m.internalDate) : null;
      // IMAP filtra por día; aquí se ajusta a la hora exacta.
      if (fecha && fecha < limite) continue;
      lista.push({ uid: m.uid, id: (m.envelope && m.envelope.messageId) || ('uid:' + m.uid), fecha: fecha ? fecha.toISOString() : '' });
    }
    return lista;
  }

  // El correo completo: texto y adjuntos con la misma forma que Microsoft (contentBytes en base64).
  async function completo(uid, buzon) {
    const m = await c.fetchOne(String(uid), { source: true, internalDate: true, envelope: true }, { uid: true });
    if (!m || !m.source) throw new Error('El correo ya no está en la bandeja.');
    const p = await simpleParser(m.source, { skipImageLinks: true });
    const id = p.messageId || (m.envelope && m.envelope.messageId) || ('uid:' + uid);
    return {
      correo: {
        id, buzon,
        from: decodificar((p.from && p.from.text) || ''),
        subject: decodificar(p.subject || ''),
        date: (p.date || (m.internalDate ? new Date(m.internalDate) : new Date())).toISOString(),
        textPlain: decodificar(p.text || htmlATexto(p.html || ''))
      },
      adjuntos: (p.attachments || []).map(a => ({
        name: a.filename || '', contentType: a.contentType || '', isInline: a.contentDisposition === 'inline',
        contentBytes: a.content ? a.content.toString('base64') : ''
      }))
    };
  }

  async function cerrar() {
    try { lock.release(); } catch (e) {}
    await c.logout().catch(() => {});
  }

  return { listar, completo, cerrar };
}

module.exports = { abrir };
