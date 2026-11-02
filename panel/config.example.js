// Copia este archivo como config.js y llena los valores reales.
// config.js NO se sube al repositorio (está en .gitignore).
module.exports = {
  db: {
    host: '127.0.0.1',
    port: 5432,
    database: 'correos',
    user: 'postgres',
    password: 'CLAVE_DE_POSTGRES'
  },
  sesion: {
    minutosInactividad: 30,
    secreto: 'FRASE_LARGA_Y_ALEATORIA'
  },
  puerto: 3001,

  // Flujo de n8n que marca el correo como leído cuando todos sus servicios quedan "Registrada".
  // Debe estar activo (Publish). Si se deja vacío, el panel no marca nada.
  // Alertas de fallos: a quién se le manda un correo cuando algo falla (además de la campanita del panel).
  alertas: {
    correos: ['gerencia@tuempresa.com'],
    saldoMinimo: 3,         // US$: avisa si el saldo de OpenRouter baja de esto
    minutosSinFlujo: 30,    // avisa si n8n no lee correos en estos minutos
    erroresIaPorHora: 5     // avisa si fallan más correos que esto en una hora
  },
  // Opcional: la misma clave de OpenRouter que usa n8n, solo para vigilar el saldo.
  openrouter: {
    apiKey: ''
  },

  n8n: {
    marcarLeido: 'http://localhost:5678/webhook/marcar-leido',
    // Flujo "Correo completo": trae el correo de Microsoft 365 con imágenes y adjuntos.
    correoCompleto: 'http://localhost:5678/webhook/correo-completo',
    // Flujo "Enviar correo": responder y enviar desde estos buzones de Microsoft 365.
    enviarCorreo: 'http://localhost:5678/webhook/enviar-correo',
    buzonesMicrosoft: ['operaciones@somosviajepuntacana.com']
  },

  // Cuentas desde las que el panel responde y envía correos.
  // La clave es la dirección de la cuenta (igual a la columna buzon de la base).
  // "clave" es la contraseña de aplicación de Gmail (16 letras), no la contraseña normal.
  correo: {
    'serviciosintegraleskaizen.ia@gmail.com': {
      host: 'smtp.gmail.com',
      port: 465,
      usuario: 'serviciosintegraleskaizen.ia@gmail.com',
      clave: 'CONTRASEÑA_DE_APLICACION',
      nombre: 'Somos Viajes Punta Cana',
      empresa: 'Republica Dominicana'
    }
  },

  // Las claves de API van en variables de entorno, nunca escritas aquí.
  haiku: {
    apiKey: process.env.HAIKU_API_KEY,
    modelo: 'claude-haiku-5-5',
    habilitado: false,
    modo: 'clasificacion'
  },
  chatwoot: {
    habilitado: false,
    apiUrl: 'http://localhost:3000/api',
    apiKey: process.env.CHATWOOT_API_KEY,
    accountId: 1
  },
  meta: {
    habilitado: false,
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN
  }
};
