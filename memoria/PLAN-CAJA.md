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

## Diseño de la caja (libro de movimientos) · plataforma/caja.js
Tabla `caja_movimientos` (administracion, fecha, tipo, concepto, monto > 0, plan_id, empresa_id, socio, pago_id único, recibo_id, detalle JSONB, usuario).
Tipos: `entrada` (cobro pagado; se crea solo desde oficina_pagos, usa lo recibido), `gasto_creacion`, `gasto_mensual`, `reparto` (detalle: parte de cada socio y deudas cobradas), `retiro` (con recibo de socio), `prestamo` (detalle: presta, debe).
Socios de una administración: `dueno` (Cristian, «Mi parte») y `socio` (socio_nombre, socio_porcentaje de oficina_administraciones).
Cálculos:
- caja = Σ entradas − Σ gastos − Σ retiros.
- parte libre de cada socio = Σ lo que le tocó en repartos (ya con deudas cobradas) − Σ sus retiros − Σ lo que prestó.
- fondo de la empresa (sin repartir) = caja − Σ partes libres de los socios.
- Gasto: si el fondo alcanza, sale del fondo. Si no, el que falta lo presta un socio (con su autorización, hasta su parte libre) y queda la deuda «debe» (por defecto el otro socio).
- Reparto de R (por defecto todo el fondo; se puede dejar parte como fondo): dueño R·(1−p), socio R·p. Antes de entregar, cada deuda se cobra de la parte del que debe y pasa al que prestó; lo que no alcance sigue debiéndose.
- Retiro: hasta su parte libre y hasta la caja; el que debe no retira.
Prueba obligatoria (ejemplo del dueño): entra 1,000 → reparto 1,000 (C 600 / J 400) → J retira 400 → gasto 300 prestado por C (debe J) → entra 750 → gasto mensual 250 (del fondo) → reparto 500 → C 300 + 200 cobrados a J = 500; J 0; J sigue debiendo 100; C libre 800; J libre 0; caja 800.

## Estado (27 nov)
- HECHO y entregado en el paquete 6bbf0cb: paso 1 (recibos que faltan), pasos 4-6 (caja, reparto, retiros con recibo, préstamos, deshacer el último) y la pantalla «💰 Caja» (Zentralia / Kaizen IA). Pruebas: reglas 5/5, API 17/17, recibos 5/5, navegador 6/6.
- Al instalar: los gastos de «Creación de sistema» y los retiros con recibo pasan solos a la caja (una sola vez); los cobros pagados entran solos.
- HECHO después: paso 2 y 3 (planes por cliente con precio de creación, mensualidad y día 1-31 o paquete; «Cobrar el mes» con extras; recibo con una línea por plan y por extra; gastos y cobros cargados a un plan; fichas de planes en la Caja con cobrado / costó / deja). Pruebas: planes 8/8, navegador 5/5.
- FALTA: pausa automática por prórroga (#80), acceso del socio (#81), automatización dentro del panel de Somos Viajes (#76).

## REESTRUCTURA DE ADMINISTRACIÓN (dueño, 27 nov, tras instalar la Caja)
Problemas vistos en el servidor: la Caja copió «Creación de sistema» una sola vez (693.20 hasta el 12 nov); lo anotado después (Claude 15 nov, recarga 300, contador/abogado 55, adelantos José 109 y 197, adelanto Cristian 459) no llegó → Creación suma 1,088.20 y retiros 0. Hay que tener UNA sola fuente: todo lo que se anote en cualquier pestaña suma/resta/reparte a la vez.
Decisiones:
- Sin menú «Caja» aparte: todo dentro de Administración, por empresa (KAIZEN IA / ZENTRALIA).
- Pestañas: **General** (antes «Todo»; cuadritos movibles como están + cuadrito pequeño de Socios: % y retiros) · **Clientes** · **Gastos** (creación, mensuales y del negocio en un lugar) · **Socios** (reparto, retiros con recibo, deudas; sale de «Cobro, gastos y reparto») · **Creación de sistema** · **Resumen del mes**.
- Gastos del negocio y mensuales SÍ se restan antes de repartir, en la empresa a la que pertenecen; los de «plataforma» se dividen con el % de «quién lo paga». Los adelantos de ganancia dejan de ser gasto: son retiros del socio con recibo.
- Monedas: lista editable (US$, S/, RD$, CLP, €…); cobro y recibo en la moneda del cliente; al registrar el pago se anota cuánto llegó en US$; caja y reparto en US$.
- Recibos: descargar PDF, WhatsApp, correo y enlace para ver en línea.
- Ficha del cliente: «Datos y plan» → **Datos de la empresa** (con contacto, teléfono, correo); «Editar» → **Configuración** (clave OpenRouter, n8n, correo de lectura, otros); **Programas** (varios por cliente: setup y mensualidad, se suman); **Estado de cuenta**. Somos Viajes no es «Cerrado»: le falta la mensualidad de 750.
- Creación de sistema: al guardar un abono, recibo automático para compartir.
- **Regla del dueño (27 nov):** una mensualidad o cobro pendiente (ej. 750 de Somos Viajes) NUNCA se suma a lo cobrado, a la caja ni a la utilidad. Solo cuenta cuando está pagado con su voucher. «Por cobrar» se muestra aparte y no entra en ningún total.

## CONSTRUCCIÓN DE LA REESTRUCTURA (aprobada 27 nov) · lista de pasos
- [x] R1 Una sola fuente: la caja se recalcula siempre desde Creación de sistema (gastos y adelantos→retiros con recibo), Gastos del negocio pagados (los de plataforma por % de «quién lo paga») y cobros pagados. Tipo nuevo `gasto_negocio`. Fondo = caja − partes libres (con negativos) para que los adelantos viejos cuadren al repartir.
- [x] R2 Pendiente no suma; marcar pagado exige voucher; todo cobro pagado recibe su recibo solo (también los de Creación de sistema).
- [x] R3 Monedas: lista editable; cobro en moneda del cliente; «llegó en US$» al pagar; caja en US$.
- [ ] R4 Recibos para compartir: PDF, WhatsApp, correo, enlace en línea (token).
- [ ] R5 Administración: pestañas General (antes Todo) + cuadrito Socios · Clientes · Gastos · Socios · Creación de sistema · Resumen; quitar el menú «Caja» aparte, «Cobro, gastos y reparto» y «Gastos del negocio» (queda dentro de Gastos).
- [ ] R6 Ficha del cliente: Datos de la empresa (con contacto, teléfono, correo) · Programas (planes, mensualidad total, paquete, moneda) · Configuración (claves, correo de lectura) · Estado de cuenta; quitar «Cerrado» si tiene mensualidad.
- [ ] R7 Pruebas con los números reales (cobrado 1,890; gastos 1,088.20; adelantos 765; reparto 801.80 → 481.08/320.72; libres 22.08/14.72; caja 36.80) y paquete.
