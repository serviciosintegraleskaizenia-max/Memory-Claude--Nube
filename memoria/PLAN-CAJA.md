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
- [x] R4 Recibos para compartir: PDF, WhatsApp, correo, enlace en línea (token).
- [x] R5 Administración: pestañas General (antes Todo) + cuadrito Socios · Clientes · Gastos · Socios · Creación de sistema · Resumen; quitar el menú «Caja» aparte, «Cobro, gastos y reparto» y «Gastos del negocio» (queda dentro de Gastos).
- [x] R6 Ficha del cliente: Datos de la empresa (con contacto, teléfono, correo) · Programas (planes, mensualidad total, paquete, moneda) · Configuración (claves, correo de lectura) · Estado de cuenta; quitar «Cerrado» si tiene mensualidad.
- [x] R7 Pruebas con los números reales (cobrado 1,890; gastos 1,088.20; adelantos 765; reparto 801.80 → 481.08/320.72; libres 22.08/14.72; caja 36.80) y paquete.

## CORRECCIONES TRAS INSTALAR (dueño, 27 nov) · decisiones y pasos
Decisiones:
- **Reparto automático, sin botón «Repartir».** Utilidad = cobrado − gastos (− fondo reservado si el dueño lo pone). A cada socio le toca su % de la utilidad; disponible = le toca − retirado; puede retirar = mín(disponible, caja). Si un socio retiró de más (disponible negativo) queda debiendo y no retira.
- **Regla del préstamo (versión final del dueño):** entran 2,000, gastos 1,000, se reparte 600/400; José retira 400; emergencia 300 con la empresa en 0 → Cristian presta 300 de sus 600; cuando entra un pago nuevo, primero se le devuelve lo prestado, luego los gastos y lo que sobra se reparte 60/40. (Es idéntico al cálculo automático acumulado: con un pago de 1,000 → Cristian 1,020 total, José 680.)
- **Gastos fijos mensuales** (Claude el 13, servidor, contador): se anotan una vez como fijos; cada mes se confirma el pago con su **monto real editable** (ej. servidor 23 el primer mes y 45 después). Solo cuenta lo confirmado.
- **Editar gastos directo en Gastos** (fecha, monto, nombre, borrar); si vino de Creación de sistema se cambia también allá.
- **Varios socios con su %** (suman 100): editar nombres y porcentajes, agregar y quitar.
Pasos:
Estado 27 nov: C1–C8 hechos y probados (caja 22/22, fuentes 13/13, planes 8/8, recibos 6/6, enlace 6/6, unitarias 28/28, pantalla 25/25). C6: falta el resto del mensaje cortado del dueño («Por…»).
- [x] C1 Reparto automático y varios socios (tabla oficina_socios; claves dueno/socio para los dos primeros). Rutas reparto/prestamo quitadas; /caja/socios (nombres, %, agregar/quitar, fondo caja_reserva).
- [x] C2 Gastos: debajo del total, «Retiros de ganancias de socios» (cada socio y total) y «Queda en caja»; mensuales y del negocio con flechita por mes (octubre, noviembre…) sin agrandar el cuadro.
- [x] C3 Editar / borrar gastos en Gastos; «Hacer fijo mensual»; confirmar pago del fijo con monto real. (/caja/editar, /caja/fijo; oficina_gastos.caja_tipo y desde; oficina_gastos_pagados.monto)
- [x] C4 Retiros con método, referencia y voucher (también completar los adelantos ya hechos) y que salgan en el recibo. (banco, lugar, comprobante en oficina_recibos; «Completar datos» en Socios)
- [x] C5 Creación de sistema → resumen para el socio: retención 8 % (151.20), llegó a la cuenta 1,738.80; «Gastos de cada mes» con los reales. (la retención sale de los descuentos del cobro; si también es gasto con el mismo monto, no se cuenta dos veces)
- [x] C6 Resumen del mes: calendario con cobros de mensualidad y depósitos de cada programa (el mensaje del dueño se cortó: falta el resto).
- [x] C7 Estados de cuenta: por mes y completo (financiero de todo: entradas, gastos por grupo, retiros, lo que queda), imprimibles.
- [x] C8b Arreglo: «🖨️ PDF» de Estados de cuenta no hacía nada (chocaba con imprimirEstado de la ficha del cliente). Renombrado a imprimirEstadoCuenta / data-imprimir-ec; la ventana imprime sola.
- [x] C8 Recibos (pedido del dueño con captura del R-C 0001): dirección del cliente más corta (no ocupar tanto espacio); en vez de «Setup · abono», el nombre del software/programa; en «Datos del pago» poner método, banco, desde dónde se pagó y número de referencia; **sección para editar recibos** (de clientes y de socios) para corregirlos y mejorarlos.

## PEDIDOS DEL 27–28 NOV (dueño) · decisiones y pasos
Maquetas mostradas al dueño: recibo del cliente (verde, enmarcado, RC-0001, condiciones de pago, estado de la cuenta, sello PAGADO y cuadro «Datos para pagar») y comprobante del socio (RS-0001, «NO ES RECIBO DE CLIENTE», lo que le toca y le queda, firmas). El dueño pidió el comprobante del socio en **azul marino** (lo dictó como «submarino»; confirmar).
Decisiones (respuestas del dueño):
- **Numeración separada:** clientes RC-0001… y socios RS-0001…; **renumerar los existentes** por fecha (hoy: 1 = cliente, 2-3-4 = retiros de José, 5 = depósito de cliente). Los enlaces compartidos se rehacen.
- **Datos bancarios del pie del recibo del cliente** (banco, cuenta en dólares, CCI y titular): el dueño los dio en el chat; se escriben en Administración y se guardan en la base, **nunca en el repositorio**. Confirmar con el dueño cómo se escribe su nombre como titular.
- **Condiciones de pago:** se arman del programa de cada cliente (mensualidad, día de cobro) + un texto que el dueño escribe una vez (prórroga, pago por adelantado).
- **Aviso de pago** (mensualidad por adelantado): Oficina lo prepara solo unos días antes del día de cobro; el dueño lo revisa y lo envía (WhatsApp / correo). Numeración AP-0001.
- **Proformas** a interesados: logo y datos, programa(s), precio de creación, mensualidad, validez. Numeración PF-0001.
- Recibos, avisos y proformas: **dentro de Administración**.
- **José Betancourt (socio):** usuario de Oficina que ve **solo Zentralia** en todas las secciones (Inicio, Estado de cada negocio, Administración, Calendario, Chat, Enlaces, APIs, Apps, Integraciones, Base del asistente, Aprobaciones, Redes, Respaldos). Empresas y demo: **solo crear demos de ventas**. **Sin Herramientas**. En Zentralia puede hacer todo. Nada de Kaizen IA en ningún lado (filtrado en el servidor).
- **Calendario como CRM interno:** editar, recordatorios, asignar a una persona, marcar quién pagó o no ese día, citas con clientes.
Pasos:
- [x] D1 Recibos nuevos: numeración RC/RS + renumerar (migración `recibos_series` al arrancar; índice único por administración+tipo+número); diseño del cliente (verde, enmarcado) y del socio (azul marino); datos para pagar y condiciones en Administración → Recibos → «⚙️ Datos para pagar y condiciones» (`oficina_administraciones.recibo_banco` y `recibo_condiciones`).
- [x] D6 Contraseñas de cualquier empresa (pedido por PEX): Empresas → «🔑 Contraseñas» en cada empresa; elige gerente/usuario del panel de reservas o la cuenta principal del panel del cliente; pide la contraseña del Programador. Rutas `/api/central/empresas/:id/accesos` y `/clave`.
Respuestas del 28 nov: proforma con programas + precios (creación, mensualidad, qué incluye, validez 15 días, forma de pago, cuenta; PF-0001; se convierte en cliente con un clic). Aviso de pago 5 días antes, aparece en Inicio y Administración como «Avisos por enviar». Usuario «jose» lo creo yo con clave temporal (debe cambiarla). Calendario: cita con cliente (hora, lugar/enlace, asignado), recordatorio/tarea (responsable, hecho, avisa en Inicio), cobro del día (pagó / no pagó, marcar pagado con voucher), seguimiento de proforma (se crea solo al enviarla).
- [ ] D2 Avisos de pago (AP) automáticos antes del día de cobro, para revisar y enviar.
- [ ] D3 Proformas (PF) para interesados.
- [ ] D4 Usuario socio solo-Zentralia en toda Oficina.
- [ ] D5 Calendario CRM.
