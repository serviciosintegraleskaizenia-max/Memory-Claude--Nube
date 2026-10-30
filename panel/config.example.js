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
