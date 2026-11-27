# Plan de construcción · Caja única de Oficina (aprobado por el dueño el 27 nov 2026)

Reglas completas: ver MEMORIA-PROYECTO.md → «DINERO EN OFICINA · DECISIONES DEL DUEÑO» y «REGLAS DE REPARTO DEFINITIVAS».
Maquetas aprobadas: maqueta-caja.png (detalle) y maqueta-caja-compacta.png (diseño final: todo en una pantalla, cada cuadro se abre en grande).

## Lo que ya existe en el código (no duplicar)
- `panel/plataforma/oficina.js`
  - `oficina_pagos` (cobros por empresa; mensualidades automáticas `auto_mes`; comprobante; descuentos; `recibo_id`).
  - `oficina_recibos` (numerados por administración; tipo `cliente` y `socio`).
  - `oficina_gastos` (con `administracion` y `pagadores`).
  - `oficina_administraciones` (kaizen / centralia; socio y porcentaje).
  - Rutas: `/api/oficina/cobro/plan`, `/cobro/pagar` (genera recibo), `/cobro/pagar-varios` (genera recibos), `/pagado` (NO genera recibo: así quedó el cobro de US$ 1,890), `/recibo/:id`, `/socio/disponible`, `/recibo/socio` (retiro solo del socio, por mes, permite negativo → contra las reglas).
- `panel/plataforma/proyectos.js` («Creación de sistema»): `oficina_proyectos` (cobro, socios y %), `oficina_proyecto_gastos` (gastos de creación; categoría `adelanto` = adelanto de ganancia), `oficina_proyecto_mensuales`, `oficina_recargas_ia`. Sin recibos.
- UI: `panel/oficina.html` (secciones Clientes, Gastos, Creación).

## Pasos (cada uno se prueba, se guarda y se sube)
1. **Recibos que faltan:** «Marcar pagado» también genera el recibo al cliente; botón «Generar recibo» para los cobros pagados sin recibo (ej. Setup 1,890 de Somos Viajes).
2. **Planes por cliente:** tabla `oficina_planes` (empresa, nombre, precio de creación, mensualidad, moneda, día de cobro, en paquete). Mensualidades por plan o un solo cobro en paquete con líneas; recibo con una línea por plan y por extra (ej. tokens). `oficina_pagos.lineas JSONB` y `plan_id`.
3. **Gastos por tipo y por plan:** cada gasto es «creación del sistema» o «gasto mensual», cargado a un plan o a General. Migrar los gastos de creación de proyectos.js a la caja sin perder nada.
4. **Caja por administración:** entró / gastos (creación y mensuales) / retiros / en caja; fondo de la empresa; reparto (cuánto se reparte y cuánto queda como fondo); saldo de cada socio (le toca, retiró, disponible). Lo repartido es del socio (regla de oro).
5. **Retiros:** del dueño y del socio, con recibo; tope = su parte y lo que hay en caja (no negativo, no adelantos del mes siguiente).
6. **Préstamos:** sin fondo, Oficina pregunta quién presta y cuánto; tabla `oficina_prestamos`; lo devuelve de su parte el socio que ya había retirado; mientras deba, no retira (en rojo).
7. **Pantalla compacta** (maqueta compacta) y prueba con los ejemplos de la memoria (1,000 / 300 / 750-250 = 500 → Cristian 500, José debe 100).
8. Paquete propio con su comando.
