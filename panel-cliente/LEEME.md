# Panel del cliente

Un panel por cliente, en su propio servidor y con su propia base de datos.
No comparte sesiones ni código con Oficina.

## Archivos
- `index.html`: la página que ve el cliente.
- `servidor.js`: el servidor (API y página). Puerto por defecto: 3110.
- `esquema.sql`: las tablas. Se crean solas al arrancar.
- `crear-cliente.js`: herramienta del dueño para crear, suspender y activar cuentas.
- `package.json`: dependencia `pg` (PostgreSQL).

## Probar en tu computadora
1. Instala PostgreSQL y crea una base vacía llamada `panel_cliente`.
2. Instala Node.js (versión 18 o mayor) y, en esta carpeta, ejecuta: `npm install`
3. Crea una cuenta de prueba:
   `node crear-cliente.js crear --usuario pexsolutions --clave "clave-de-8-o-mas" --nombre "PEX Solution"`
4. Arranca el servidor con la base:
   - PowerShell: `$env:PANEL_CLIENTE_DB="postgres://postgres:TU_CLAVE@localhost/panel_cliente"; node servidor.js`
5. Abre en el navegador: http://127.0.0.1:3110

## Órdenes del dueño
- `node crear-cliente.js listar`
- `node crear-cliente.js suspender --usuario pexsolutions --motivo "Pago pendiente"`
- `node crear-cliente.js activar --usuario pexsolutions`
- `node crear-cliente.js clave --usuario pexsolutions --clave "nueva-clave"`

Suspender una cuenta cierra su sesión y, al entrar, le muestra el motivo.

## Variables
- `PANEL_CLIENTE_DB`: dirección de la base de PostgreSQL.
- `PANEL_CLIENTE_PUERTO`: puerto (3110 por defecto).
- `PANEL_CLIENTE_INTERNO`: clave que usará Oficina para escribir al chat y marcar presencia. Sin ella, esos endpoints no responden.
- `PANEL_CLIENTE_SEGURO=1`: la cookie solo viaja por HTTPS (activarlo en el servidor).

## Lo que todavía no está conectado
- Conversaciones de Chatwoot, correo y WhatsApp/Facebook/Instagram: se conectan en la siguiente etapa, cuando Meta y los canales estén listos.
- El chat con Kaizen ya guarda mensajes. Oficina todavía no los lee ni responde desde aquí.
