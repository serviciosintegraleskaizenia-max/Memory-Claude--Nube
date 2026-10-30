# Flujo n8n: Correo de Prueba

Lee los correos de la bandeja de entrada de las últimas 48 horas (leídos o no, sin
marcarlos), descarta los ya guardados, los clasifica con
Nemotron (OpenRouter) y guarda el resultado en la tabla `clasificacion` de Postgres.

```
Gmail → Traducir correo → Execute a SQL query → If (nuevo) → Limpiar texto
      → Nvidia/Nemotron-3.5 → Code in JavaScript → Insert rows in a table
```

## Importar

En n8n: **⋯ → Import from File** y elegir `correo-de-prueba.json`. Las credenciales
(Gmail, Postgres, OpenRouter) se reasignan en cada nodo; el archivo no guarda claves.

## Reglas para no romperlo

- **Gmail** con *Simplify* apagado: con Simplify encendido solo llega el resumen
  (`snippet`, unos 200 caracteres y con `&quot;`), no el cuerpo del correo.
- **Execute a SQL query** devuelve `message_id` además de `id`: así **Limpiar texto**
  encuentra el correo correcto aunque el **If** haya quitado alguno.
- **Code in JavaScript** toma los datos del correo de `Limpiar texto` (misma posición
  que la respuesta de la IA), nunca con `.item`.
- **Nvidia/Nemotron-3.5** manda un correo cada 4 s (*Options → Batching*) para no
  recibir el error 429 del modelo gratuito.

## Marcar como leído al registrar (`marcar-leido.json`)

El correo solo pasa a "leído" en la bandeja cuando la reserva se marca como
**Registrada** en el panel. El panel llama al webhook:

```
POST http://localhost:5678/webhook/marcar-leido
{ "message_id": "<message_id de la fila>", "buzon": "<buzon de la fila>" }
```

- Buzón `@gmail.com` → nodo Gmail *Mark as Read*.
- Otro buzón (Microsoft 365 de Somos Viajes) → `PATCH` a Microsoft Graph con
  `isRead: true`. Necesita la credencial *Microsoft Outlook OAuth2* con permiso
  **Mail.ReadWrite** (solo lectura no basta para marcar).

El flujo debe estar **activo** (Publish) para que la URL `/webhook/` responda.

## Nunca subir a este repositorio

Contraseñas, secretos de Azure / Microsoft 365, contraseñas de aplicación de Gmail
ni el archivo `config.js` del panel con claves.
