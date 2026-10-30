# Flujo n8n: Correo de Prueba

Lee los correos no leídos de Gmail, descarta los ya guardados, los clasifica con
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

## Nunca subir a este repositorio

Contraseñas, secretos de Azure / Microsoft 365, contraseñas de aplicación de Gmail
ni el archivo `config.js` del panel con claves.
