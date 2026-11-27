# MEMORIA DEL PROYECTO · Zentralia · Kaizen Consulting IA

Documento vivo. Se actualiza en cada avance. **No contiene contraseñas, tokens ni claves secretas.** Esas viven solo en Oficina (cifradas) o en el administrador de Meta.

## Cómo usar esta memoria
- En una conversación nueva, pedir: "lee memoria/MEMORIA-PROYECTO.md antes de hacer nada".
- Las decisiones y pendientes de abajo son la fuente de verdad. Si algo de la conversación contradice este archivo, se pregunta antes de actuar.

## Preferencias de trabajo del dueño (Christian)
- Habla español. No escribe ni lee inglés: los textos para Meta van en inglés, con traducción al español al lado.
- Quiere guía **paso a paso, sin saltar pasos**, con la ubicación exacta de cada botón. Si algo no coincide con su pantalla, pide captura.
- Quiere preguntas en formato **checklist** (opciones para elegir), antes de tareas complejas.
- Quiere **documentos en Word (.docx)**, no .md.
- No quiere respuestas largas ni rodeos. Pide que no se invente nada: si no sabemos algo, decirlo.
- Quiere que todo lo que se haga quede guardado en el repositorio.

## Empresas y decisiones
- **Kaizen Consulting IA** (negocio del dueño, RUC del titular). Es la primera empresa que se conecta; sirve de prueba y de guía para las demás.
- **Somos Viajes** (cliente, agencia de viajes): ya usa Chatwoot con sedes Punta Cana y Orlando. Tiene varios números, páginas e Instagram.
- **PEX Solution** y **Premios Carrasco** (persona): pendientes. Premios Carrasco tiene su verificación de Meta aparte.
- **Modelo para todas las empresas:** un solo servidor con Chatwoot y n8n. Cada empresa tiene su bandeja en Chatwoot y sus canales conectados desde Oficina → Redes sociales. El flujo de n8n responde (primero en modo nota privada). Oficina sirve para vincular redes y ver los mensajes.
- **Decisión:** Kaizen primero, probado y documentado; después se replica con las demás empresas. Lo de automatizar la creación (cuenta en Chatwoot, flujo en n8n, DNS) se puede hacer por API; lo de Meta (usuario del sistema, token, revisión de la app) es manual.
- **Decisión pendiente:** el número real de Kaizen (+51 989 480 556) se usa para la prueba. La ficha de Kaizen en Oficina se llama "Kaizen Consulting IA".

## Meta (app "Zentralia WB", negocio "Kaizen Consulting")
- ID del negocio (portafolio): 1407345434652908.
- Verificación de la empresa: **VERIFICADA** (20 nov 2026).
- Administrador alternativo: añadido.
- Autenticación en dos pasos: Christian Guerra (Facebook) activada. La cuenta de Instagram @kaizenconsultor.ia (Christian Jose Mundaray Guerra) no se confirmó. El contador del Centro de seguridad sigue en 0 de 2 (pendiente).
- Configuración básica de la app: política de privacidad, términos, eliminación de datos, dominio kaizenia.app, correo soporte@kaizenia.app, icono Zentralia, categoría "Empresa y páginas". Todo cargado en la app.
- **Revisión de la aplicación (27 nov, captura de Meta):** EN CURSO. Enviados 3 permisos: whatsapp_business_messaging, business_management y whatsapp_business_management. Meta muestra "Revisión en curso" y dice que la mayoría se revisa en un plazo de hasta 20 días. public_profile no aparece en la lista de envío.
- **Pruebas (Tests):** whatsapp_business_messaging COMPLETADA. whatsapp_business_management COMPLETADA. business_management: llamada hecha (me/businesses) con respuesta, puede tardar 24 h en reflejarse. public_profile: llamada hecha (me?fields=id,name) con respuesta.
- **Lo que NO está hecho:** cuenta fija de prueba para el revisor y publicación de la app. Los videos de demostración los envió el dueño según él mismo; confirmar en Meta que están adjuntos. Los mensajes reales de clientes no llegan mientras la app no esté publicada (aviso de Meta).
- **BRECHA DE PERMISOS (27 nov):** la revisión en curso cubre solo WhatsApp y business_management. NO se han solicitado los permisos de Facebook Messenger (pages_messaging y relacionados) ni de Instagram (instagram_manage_messages y relacionados). Sin esa solicitud, la automatización de Facebook e Instagram no se puede activar para clientes reales, aunque el dueño administre las redes. Pendiente: decidir si se agregan a la revisión actual o se envía una solicitud nueva, con su video de demostración y su instrucción de uso. Confirmar la forma exacta en la documentación de Meta antes de enviar.
- **Consecuencia para PEX y Kaizen:** la IA atiende WhatsApp real solo después de la aprobación de Meta (hasta 20 días) y de la verificación de cada empresa. Hasta entonces, panel, prompt y pruebas en nota privada con el número de prueba.
- Textos para la revisión: memoria/documentos/textos-permisos-meta.md y Guia-revision-Meta-Zentralia-WB.docx.
- **Decisión pendiente:** el revisor de Meta vería datos reales de clientes si entra a Somos Viajes. Recomendado: empresa demo con datos ficticios. El dueño no respondió; no crear la cuenta del revisor hasta decidirlo.
- Certificaciones para la web: "Certificado personal por Meta" y "Certificado en Workana" son las que indicó el dueño; falta confirmar el nombre exacto de cada certificado y tener el documento.

## Identificadores de WhatsApp (Kaizen)
- Número real: +51 989 480 556 · ID del número de teléfono: 1436733079519865 · estado en Meta: Conectado, verificado, calidad alta.
- Cuenta WhatsApp Business (WABA): 1126190176716418.
- Número de prueba de Meta (no usar para clientes): +1 555-138-1526 · ID 1376670675538773.
- Instagram: ID 17841443950091905 · usuario kaizenconsultor.ia.
- Facebook (página Kaizen Consulting): ID 1263788503473729.
- Cuenta publicitaria: 1131629452789823 (verificada por el dueño).
- Detalle en memoria/documentos/identificadores-whatsapp-kaizen.txt.

## Oficina (Zentralia)
- Empresas y demo → Clientes de automatización → Kaizen Consulting IA: datos de WhatsApp, Instagram, Facebook y Meta guardados. Estado: WhatsApp listo, Instagram listo, Facebook listo, Meta 3 de 5 (las dos casillas que faltan son correctas: socio y permisos no aprobados).
- Oficina → Conexión con WhatsApp (Meta): clave secreta de la app guardada; token del sistema guardado; WABA guardado. El dueño dice que la clave y el token ya están guardados; la prueba de Meta fue exitosa, lo que indica que la clave es correcta.
- **Webhook de Meta:** URL de devolución de llamada `https://oficina.kaizenia.app/api/whatsapp/webhook`. Prueba "test" del campo messages: EXITOSA (Meta confirmó).
- Mensajes entrantes: el webhook los guarda en la tabla `whatsapp_entrantes`. Se agregó la sección "5 · Mensajes de WhatsApp que llegan a este número" en la ficha del cliente (commit 2ceca50, rama claude/wonderful-keller-4c8hoe). Pendiente: decidir si se quita cuando Kaizen pase a Chatwoot.
- Oficina → Redes sociales: solo muestra empresas (Somos Viajes Punta Cana/Orlando y demo). Kaizen no aparece ahí todavía. Se borró por error una conexión de la página Kaizen Consulting en Messenger de Somos Viajes Punta Cana (ya corregido por el dueño).

## Servidor, dominios y n8n
- Chatwoot: **funciona** en el servidor. Dominio público: **pendiente de confirmar**.
- n8n: **funciona** en el servidor. URL: **pendiente de confirmar**.
- Dominio base: **kaizenia.app**, administrado en Cloudflare (dash.cloudflare.com, cuenta del dueño).
- **Publicación por TÚNEL de Cloudflare (no por registros A):** túnel `pc-kaizen` (ID 6e898640-d115-4a96-a11b-9ddd56495e89), réplica `srv2149086`, IP de origen 2.25.172.8. Rutas publicadas: somosviajes, oficina, demo, redes, automatizacion y servidor (.kaizenia.app).
- Para crear un subdominio nuevo: Cloudflare → Zero Trust / Conexión de red → Tunnels → pc-kaizen → pestaña Rutas → Agregar ruta (aplicación publicada). Cloudflare crea el DNS solo. **NO crear registros A hacia 2.25.172.8.**
- Subdominios previstos: kaizenconsulting-ia, pex-solution, premios-carrasco (todos en kaizenia.app). Pendiente: crear sus rutas en el túnel, copiando el 'servicio' (URL local) de una ruta existente.
- **IP pública del servidor: 2.25.172.8** (confirmada por el dueño con `ssh -G zentralia` en PowerShell).
- Flujo de n8n de Kaizen: memoria copiada en n8n/kaizen-consulting-automatizacion-redes.json, **inactivo**. Pendiente: dominio y número de cuenta de Chatwoot, y crear credenciales en n8n (no en el archivo).
- Plantilla general del flujo: n8n/automatizacion-redes.json.

## Sitio web kaizenia.app
- Carpeta web-kaizenia/: index (portada), servicios (Kaizen, Zentralia, Somos Viajes), politica-privacidad, terminos, eliminacion-datos, logos.
- Estado: **publicado** por el dueño en kaizenia.app (confirmado por el dueño). No se pudo verificar desde aquí.
- Pendientes del sitio: confirmar certificaciones, confirmar la descripción de Somos Viajes, confirmar que el formulario abre correo (no hay servidor de envío).

## Guías y documentos
- memoria/documentos/Guia-conexion-redes-por-empresa.docx: pasos para conectar redes de una empresa, con lo automatizable y lo manual.
- memoria/documentos/Guia-revision-Meta-Zentralia-WB.docx: estado de la revisión de Meta, pasos y textos en inglés con traducción.
- memoria/documentos/textos-permisos-meta.md: mismos textos en Markdown (de respaldo).

## LISTA CONSOLIDADA (27 nov)
- Todos los pendientes juntos, con prioridad: PEX Solution primero (entrega de hoy), luego Kaizen, panel de correo y Oficina. Documento: memoria/documentos/PENDIENTES-consolidados-27-nov.docx.
- Pendiente de confirmar: el cliente se escribió "PEX Solution" aquí y "Pet Solution" en el pedido. Asumido que es el mismo.
- Decisiones abiertas del 27 nov: dónde vive la página de entrenamiento de PEX (Oficina o subdominio propio), qué se entrega hoy, nombre del cliente, respuestas públicas de Kaizen.

## DECISIÓN 27 nov · PANEL COMPLETO DEL CLIENTE (PEX)
- Construir ya el panel del cliente en su subdominio (pex-solution.kaizenia.app): entrenamiento de la IA (instrucciones), redes (estado por canal), CRM, chat y botón de apagar/encender la IA.
- Automatización que funciona HOY sin Meta: chat del sitio web (canal Website de Chatwoot con el mismo flujo de n8n) y respuesta de correo. Nada de eso depende de la revisión de Meta.
- WhatsApp, Facebook, Instagram y respuestas a comentarios de publicaciones/estados: dependen de la aprobación de Meta. La verificación de la empresa del cliente NO basta: también hace falta la aprobación de la app. Comentarios e Instagram/Facebook requieren permisos que hoy no están solicitados.
- Mensaje exacto al cliente: el chat del sitio y el correo funcionan desde hoy; WhatsApp, Facebook, Instagram y comentarios se activan cuando Meta apruebe la app y su empresa esté verificada. No decir "funciona cuando verifique".
- Interruptor de la IA: se aplica en el servidor (el flujo consulta el estado antes de responder), no solo en la pantalla.
- Lo que necesita el dueño: ruta pex-solution en el túnel de Cloudflare; acceso a Chatwoot para crear el canal Website (credencial por formulario seguro, nunca en el chat); plataforma del sitio de PEX para instalar el cuadro de chat.

## PENDIENTE IMPORTANTE · OFICINA CONTROLA TODO EL CLIENTE (27 nov, para después del panel de PEX)
- **Orden del dueño:** primero se termina el panel de PEX (construido y probado en la computadora del dueño, luego subido al servidor). Después se completa Oficina, porque le faltan muchas cosas que hay que tener listas.
- **Al crear una empresa en Oficina** se genera automáticamente su subdominio (por ejemplo, `nombre.kaizenia.app`), sin pasos manuales en Cloudflare.
- **Acceso completo para el asistente (Claude):** debe poder crear esa ruta, configurarla y revisarla desde Oficina. Para hacerlo necesita una credencial de Cloudflare guardada en el entorno, nunca en el repositorio ni en el chat.
- **Notificaciones desde Oficina al cliente:** avisos de cobro, de actualizaciones, de pago de la API, de pago de la IA y de conexión de redes sociales. Todo se gestiona desde Oficina.
- **Control total:** Oficina debe ver y administrar el subdominio, las redes, la IA y los avisos de cada cliente, de forma exacta.
- **Estado:** pendiente. No se empieza hasta terminar el panel de PEX.

## PANEL DEL CLIENTE · PRIMERA VERSIÓN LISTA (27 nov) Y SEGUNDA ETAPA
- Primera versión visual con datos de ejemplo: panel-cliente/index.html (commit ecd1abd). Se abre en el navegador con doble clic. Todavía no está conectada al servidor ni a Chatwoot, n8n u Oficina.
- Incluye: inicio con resumen y canales, redes (estado real por canal), conversaciones de canales, chat con Kaizen (con presencia), CRM (buscar, guardar, etiquetas, notas), entrenar la IA (prompt, prueba con interruptor, archivos, historial), pagos y recibos mensuales (sin consumo), correo solo lectura, ajustes (logo, banner, nombre, contraseña, ayuda).
- **Segunda etapa (pendiente, en orden):**
  1. Conectar el chat con Kaizen a Oficina en tiempo real, y la presencia de Kaizen.
  2. Conectar Conversaciones con Chatwoot (canal de la página web primero).
  3. Conectar el CRM a la base de clientes.
  4. Conectar Entrenar la IA a la configuración real del asistente (instrucciones, archivos y prueba).
  5. Pagos y recibos: generados desde Oficina, con descarga.
  6. Correo solo lectura conectado (Google puede pedir su propia revisión).
  7. Paso a humano, horario de atención y mensaje fuera de horario.
  8. Respuestas rápidas y exportar el CRM a Excel.
  9. Reportes sencillos: conversaciones, tiempo de respuesta y preguntas frecuentes.
  10. Resumen de inicio con datos reales y notificaciones por correo.
  11. Seguridad de la cuenta: sesiones abiertas y verificación en dos pasos.
  12. Ayuda dentro del panel con capturas.
  13. Cuenta publicitaria de Meta (requiere permiso de anuncios, no solicitado).
- Decisiones abiertas: cómo se cobra al cliente (solo se muestran recibos por ahora); si el cliente puede editar el prompt sin aprobación (decisión 26 nov: sí, con historial y prueba).
- Lo que el cliente no ve nunca: n8n, claves, consumo de la IA (eso se queda en Oficina), otros clientes.

## CORRECCIÓN DE ESTADO · PEX EN OFICINA (27 nov, capturas del dueño)
- Ya existe la empresa **PEX SOLUTIONS** en Oficina (estado Activa, En línea, 1 usuario). Su correo de lectura está configurado (IMAP, achaconintpx@gmail.com) pero **falta la clave**.
- Ya existe el perfil de **cliente de automatización** PEX Solutions, con WhatsApp, Instagram, Facebook y TikTok pendientes, Meta 0 de 5 y CRM apagado.
- **Dos nombres de subdominio distintos:** la empresa dice pex-solutions.kaizenia.app y el cliente de automatización dice pexsolutions.kaizenia.app. Hay que dejar uno solo antes de crear la ruta del túnel.
- Oficina ya tiene: indicador En línea, cobro y recordatorio de pago (hoy apagado), Pausar servicio y Apagar. Son la base para suspender el servicio si no paga.
- **Modelo de acceso decidido por el dueño (27 nov):** el cliente NO entra a Oficina. Tiene un usuario y contraseña creados por el dueño, válidos solo para su panel. Sin pago, se suspende la cuenta. El dueño ve si está en línea, le escribe y le envía recibos desde Oficina.

## DECISIÓN DE SUBDOMINIO · PEX (27 nov)
- Subdominio elegido por el dueño: **pexsolutions.kaizenia.app** (sin guion). Es el nombre a usar en el túnel, en Oficina y en el panel del cliente.
- Pendiente: corregir en Oficina la URL de la empresa PEX SOLUTIONS (hoy dice pex-solutions.kaizenia.app) para que coincida.
- Pendiente: no crear la ruta en el túnel hasta que el panel del cliente corra en su propio puerto. Apuntarla al puerto de Oficina (3090) expondría Oficina al cliente.

## DECISIONES DEL DUEÑO · OFICINA COMO PANEL DE CONTROL (27 nov)
- **El dueño es dueño del sistema.** Los clientes solo reciben acceso. El dueño crea sus usuarios, claves y permisos, les cobra cada mes y puede apagar su servicio si no pagan.
- **Un solo tipo de cliente en Oficina.** Hoy "Nueva empresa" (panel de correo) y "Automatización" (redes) son cosas separadas y no se hablan: eso se elimina. Un cliente nuevo tiene todos los programas que el dueño vaya creando (correo, reservas y operaciones, automatización de redes, CRM, panel del cliente...) como módulos que se encienden o apagan. Orden acordado: primero se conecta PEX, después se unifica Oficina.
- **Dominio de PEX:** https://pexsolutions.kaizenia.app (ruta ya creada por el dueño). La empresa vieja de PEX (pex-solutions) fue eliminada de Oficina.
- **Puente Oficina → panel del cliente:** el dueño configura en Oficina conexiones de redes, configuración de IA y clave de OpenRouter, plantillas, cobros y recibos con mensaje propio, anuncios, módulos, pausa y suspensión. El panel del cliente lo recibe por dentro del servidor con la clave interna (archivo /srv/zentralia/datos/panel-cliente.env, nunca en el repositorio).
- **Entrenamiento de la IA:** el dueño pone la base en Oficina; el cliente puede ajustarla desde su panel, con historial. La base de Oficina no la borra el cliente.
- **Lo que hace el cliente en su panel:** usa su CRM, chatea con Kaizen (puede mandar documentos) y ve sus recibos, plantillas y redes. Puede crear plantillas, pero quedan "por aprobar" hasta que el dueño las apruebe; al crearlas, el dueño recibe un aviso en Oficina.
- **Chat:** los mensajes y documentos del cliente llegan a Oficina; el dueño responde desde Oficina.

## PUENTE OFICINA → PANEL DEL CLIENTE · ESTADO (27 nov)
- **Hecho del lado del panel (panel-cliente/servidor.js e index.html):** API interna /api/interno/* protegida con la clave interna. Oficina puede: crear la cuenta y su clave, encender o apagar secciones (el panel las oculta y además las bloquea en el servidor), pausar o suspender con motivo, mandar las redes, poner la base de la IA y la clave de OpenRouter (se guarda cifrada y nunca llega al navegador), cargar plantillas, aprobar o rechazar con motivo las que crea el cliente, enviar recibos con mensaje propio y enlace de pago (solo https), marcarlos pagados, mandar anuncios, leer el chat y descargar documentos, responder y ver si el cliente está en línea. Los avisos para Oficina (plantillas nuevas, mensajes y documentos) quedan en /api/interno/avisos.
- **Probado:** 40 pasos del puente, 39 de la prueba anterior y la prueba en navegador, sin fallos, contra PostgreSQL local. La respuesta real de la IA no se pudo probar aquí (sin clave real ni salida a OpenRouter).
- **Hecho del lado de Oficina (27 nov):** panel/plataforma/puente-cliente.js (habla con el panel por dentro del servidor, lee la clave interna de /srv/zentralia/datos/panel-cliente.env, nunca la manda al navegador), rutas /api/central/panel-cliente/* en central.js (solo Programador, todo queda en el registro) y la pestaña **Empresas → Automatización → (cliente) → Panel del cliente** en panel/index.html: estado y conexión, crear cuenta o cambiar clave, programas encendidos, Guardar y enviar (redes, base de la IA armada en Oficina, modelo y clave de OpenRouter), pausar, suspender y reactivar, plantillas por aprobar, recibos con mensaje y enlace de pago, anuncios, chat con documentos. Campana de avisos en Oficina (revisa cada minuto).
- **Probado:** Oficina 31 de 31 pasos de API, botones en navegador, campana, y las 49 pruebas anteriores del panel sin fallos. Si el panel del cliente está apagado, Oficina lo dice claro (no se cae).
- **Instalación:** el mismo comando de siempre (actualizar-servidor.ps1). Si el paquete trae la carpeta panel-cliente, instala primero el panel del cliente y luego Oficina, en una sola conexión.

## PENDIENTE · UNA SOLA CUENTA DE EMPRESA CON TODOS SUS PROGRAMAS (pedido del dueño, 27 nov)
- **Problema:** hoy Oficina tiene dos fichas separadas para el mismo cliente: **Empresas** (tabla empresas: panel propio, cobro, anuncios, módulos, pausa) y **Automatización** (tabla automatizacion_clientes: redes, CRM, IA, plantillas, panel del cliente). Al crear varios programas para un cliente, quedan en fichas distintas.
- **Lo que quiere el dueño:** una sola cuenta por empresa y que cada programa (correo, operaciones, reservas, automatización de redes, panel del cliente, chat, recibos) sea un módulo que se enciende o se apaga dentro de esa misma cuenta. **Primer caso: Somos Viajes** — agregarle la automatización (redes, IA, plantillas) a su empresa existente sin crear otra ficha.
- **Idea técnica (sin decidir):** unir por empresa: agregar empresa_id a automatizacion_clientes, mostrar la automatización como una pestaña más dentro de la ficha de la empresa, y que "+ Automatización" sea "Agregar programa" dentro de la empresa. No borrar ni mover datos de Somos Viajes; su base y su panel siguen igual.
- **Respuestas del dueño (27 nov):** (1) todo, incluido el CRM; (2) como sección nueva dentro del panel actual de Somos Viajes, con los mismos usuarios; (3) IA con una base común y ajustes por sede, como ya funciona la Base del asistente; (4) un solo recibo mensual por empresa con todos sus programas.
- **Lo que ya tiene Somos Viajes (no se duplica):** CRM completo (crm.js, módulo crm + permiso ver_crm), conector de redes por sede con Chatwoot (redes.js: bandejas con canal, sede y modo de IA), Base del asistente por sede, chat con Oficina, anuncios, pausa y recordatorio de pago.
- **Lo que falta y se propuso (maqueta enviada, esperando visto bueno):** botón «📲 Automatización» en su panel con Redes (estado por sede y modo de la IA), Plantillas de WhatsApp (crear → «Por aprobar (Kaizen)» → aviso en la campana de Oficina) y Recibos (mensaje y enlace de pago); en Oficina, sección «Automatización» dentro de la tarjeta de la empresa (plantillas por aprobar, canales), mensaje y enlace de pago en el cobro, módulos nuevos (plantillas, recibos), y que la pausa por falta de pago también apague la IA de sus redes (hoy redes.js no mira la pausa).

## DECISIONES DEL DUEÑO · EMPRESAS UNIFICADAS Y PAUSA POR PAGO (27 nov)
- **Pausa por falta de pago (para todos los clientes):** la IA NO se apaga, sigue contestando. Lo que se pausa es el acceso: panel (correo/reservas) y chat, hasta que paguen. Con días de prórroga después del vencimiento. (Se descarta la idea anterior de apagar la IA al pausar.)
- **Unificar «+ Nueva empresa» y «+ Automatización»:** un solo formulario de empresa que pide todo (datos, programas, correo, conexiones, IA, CRM, panel del cliente, cobro), aunque no se use; se quita «+ Automatización». Una sola lista de empresas.
- **Lista de empresas compacta:** una franja por empresa (nombre, estado, programas, cobro, enlace) con una flecha; al tocarla se despliega todo (módulos, cobro, anuncio, conexiones, pausar, apagar).
- Maqueta enviada (maqueta-empresas.png). **Respuestas del dueño (27 nov), aprobado para construir:**
  1. Pausa **automática** al terminar los días de prórroga; Oficina avisa un día antes; se reactiva sola al marcar pagado.
  2. Durante la pausa se bloquea: el panel (correo, reservas, operaciones y cualquier otro programa), el chat del panel y la bandeja de Chatwoot de sus asesores. **La IA sigue contestando.** Lo de Chatwoot se prueba antes para no apagar la IA.
  3. «Kaizen Consulting IA» repetida (Empresas + Automatización): **unir en una sola ficha de Kaizen**.
  4. **Kaizen IA y Zentralia son empresas separadas** (Kaizen solo del dueño; Zentralia con socio, reparto). Misma base de datos, datos separados (ya existe en Oficina como «administraciones»: kaizen / centralia). En la lista única: **dos pestañas**, una «Kaizen IA» y otra «Zentralia», cada una con su lista.
  5. PEX Solutions y Premios Carrasco pasan a la lista de empresas en **Kaizen IA**.
  6. El **socio de Zentralia entra a Oficina** con su usuario y solo ve Zentralia (permiso oficina_admin_centralia ya existe).
  7. Lista: franjas cerradas, **una abierta a la vez**, con buscador.
  8. «+ Nueva empresa» con todo en un formulario; se quita «+ Automatización».

## DINERO EN OFICINA · DECISIONES DEL DUEÑO (27 nov, maqueta maqueta-caja.png enviada, esperando visto bueno)
- **Una sola caja por empresa** (Zentralia y Kaizen IA, cada una la suya). Hoy el dinero está en dos lados: «Clientes y cobros» (hace recibos) y «Creación de sistema» (proyectos.js; ahí están los US$ 1,890 de Somos Viajes y no hace recibos). Se unen sin perder nada.
- Entradas: cobros de todos los clientes y planes, **con recibo automático al cliente**. Salidas en 3 grupos que no se mezclan: **creación del sistema**, **gastos mensuales** (Claude, IA, servidor, programas) y **retiros de socios**.
- **Retiros de socios** (también los del dueño): cada uno genera recibo y sale en la lista de salidas como «Retiro de socio»; se descuenta solo de la parte de ese socio (no baja lo que queda para repartir). **Nadie retira más de lo que le toca ni más de lo que hay en caja; no hay adelantos con dinero del mes siguiente.**
- Si un socio ya retiró todo y luego hay un gasto, se paga con la parte del otro: **la empresa le queda debiendo** ese monto; en el próximo cobro primero se le devuelve y lo que queda se reparte por porcentaje (ej.: gasto 300 → José pone su 40 % = 120).
- **Planes por cliente** (ej. Somos Viajes: Plan de panel de correo 750/mes, Plan de reservas y operaciones 350/mes): cada plan con precio de creación, mensualidad y día de cobro; opción de cobrar en un solo paquete. Gastos cargables a un plan o a General; se ve cuánto costó y cuánto deja cada plan.
- **Recibo al cliente con detalle por línea** (cada plan, consumo extra de IA/tokens, etc.) y guardado en la base como historial.
- Mismo repositorio; esta parte va en su propio paquete de instalación.
- **Diseño compacto (dueño, 27 nov, maqueta aprobada con este cambio):** que no ocupe espacio. Recibos: lista corta por fecha y número; al tocar uno se abre en grande. Planes: fichitas pequeñas; al tocar una se abre en grande. Movimientos: resumen con total y saldo que va quedando; «ver todo» se abre en grande.
- **Préstamo de un socio (pendiente de confirmar):** se mantiene lo elegido antes (lo devuelve de su parte el socio que ya había retiró todo); la otra opción era que la empresa lo devuelva antes de repartir. Preguntar solo si hace falta.
- **REGLA DE ORO (dueño, 27 nov):** cuando se reparte la utilidad, la parte de cada socio es SUYA (cerrada), no de la empresa, aunque no la haya retirado. Ej.: se reparten 1,000 → Cristian 600 / José 400; si Cristian retira 400, sus 200 restantes siguen siendo suyos y los 400 de José también. El dinero de la empresa es solo el que se decide dejar como fondo (ej.: hay 1,200, se dejan 200 en la empresa y se reparten 1,000). Las emergencias salen del fondo de la empresa (gasto común). La parte de un socio solo se usa si ese socio autoriza prestarla; entonces la empresa (o el socio que ya retiró) le queda debiendo.
- **Regla decidida por el dueño para la emergencia (27 nov):** si un socio ya retiró su parte y luego hay un gasto, ese gasto lo paga **completo el socio que retiró** (no 60/40). Ejemplo para la prueba: mes 1 quedan 1,000 (Cristian 600 / José 400); José retira 400; emergencia 300 pagada con lo de Cristian → José le debe 300 a Cristian. Mes 2: 750 − 250 gastos fijos = 500 → Cristian 300 (60 %) + 300 de la deuda = 600; se lleva los 500 y José queda debiendo 100 para el mes siguiente (José cobra 0). Totales: Cristian 900, José 300. Mientras José deba, no retira.

## EMPRESAS UNIFICADAS · HECHO (27 nov, etapas 1-3)
- Una sola cuenta por empresa: cada automatización va dentro de su empresa (automatizacion_clientes.empresa_id). Empresas sin panel de reservas (sin_panel, sin base ni puerto; estado/programas/pagado en empresas.cuenta_central).
- Al instalar: PEX y Premios Carrasco pasan a empresas sin panel en Kaizen IA; Kaizen Consulting IA se junta en una ficha (por nombre). Se hace sola al arrancar Oficina.
- Lista compacta: pestañas por administración (Kaizen IA / Zentralia — nombre tomado de oficina_administraciones), buscador, una abierta a la vez; dentro: pertenece a, módulos, cobro, anuncio, correo e IA, automatización (Datos, Conexiones, IA, CRM, Panel del cliente), quitar/eliminar, pausar/apagar.
- «+ Automatización» quitado; lo general de Kaizen (Meta, números, plantillas, IA) en «Redes: general de Kaizen». «+ Nueva empresa» pide datos, a quién pertenece, programas (correo y reservas / redes-IA-CRM) y la automatización.
- Somos Viajes aparece en Zentralia (reparto 60/40 con José Betancourt).
- Pruebas: API 29/29, navegador 25/25, panel del cliente 40/40.
- **Falta:** pausa automática por prórroga (etapa 4), acceso del socio (etapa 5), plantillas y recibos dentro del panel de Somos Viajes.

## CORRECCIÓN · TARJETA «PARA REVISAR» (27 nov)
- La tarjeta contaba las reservas que alguien tenía abiertas en ese momento (lo mismo que la pestaña «En revisión ahora»), no las que muestran la etiqueta «Revisar». Por eso marcaba 0 con varias en rojo.
- Ahora «Para revisar» y «Pendientes de transcribir» cuentan lo que muestra la etiqueta de cada reserva: una pendiente sin día, cliente u hotel se ve como «Revisar» y cuenta ahí, no en Pendientes. El filtro de estado usa la misma regla y la tarjeta abre «Todas» filtrada por «Para revisar». La pestaña «En revisión ahora» sigue igual.

## Pendientes (en orden)
1. Confirmar la URL de Chatwoot y la URL de n8n.
2. Crear las rutas de los tres subdominios en el túnel pc-kaizen (kaizenconsulting-ia, pex-solution, premios-carrasco).
3. Confirmar el 'servicio' (URL local) de la ruta de oficina y usar el mismo para cada subdominio nuevo.
4. Crear la cuenta de Kaizen en Chatwoot y su bandeja de WhatsApp con los IDs de arriba.
5. Cambiar el webhook de Meta a Chatwoot (esto deja de enviar a Oficina). Decidir si se quita la sección de mensajes de la ficha.
6. Importar el flujo de n8n de Kaizen, crear credenciales, dejarlo inactivo y probar con un mensaje real (requiere app publicada para llegar desde clientes reales).
7. Vincular la bandeja en Oficina → Redes sociales.
8. Completar el test de business_management (ya hecho, esperar 24 h) y revisar el estado en Meta.
9. Decidir qué cuenta ve el revisor de Meta (demo recomendada).
10. Grabar videos de demostración (el panel con navegador de prueba; el inicio de sesión con Facebook lo graba el dueño).
11. Enviar la revisión a Meta.
12. Replicar con PEX, Premios Carrasco y Somos Viajes (con sus varios números).
13. Pendientes de proyecto anteriores: Hoja de operación del día (#47), API de Zentralia (#53), Etapa 2 de Oficina: correo propio (#28), página principal de kaizenia.app con pagos (#24).

## ARQUITECTURA APROBADA POR EL DUEÑO (decisión vigente)
- **Oficina** (oficina.kaizenia.app): control central. Solo el Programador configura empresas, conexiones, entrenamiento de la IA y reportes.
- **Chatwoot** (redes.kaizenia.app, CONFIRMADO por el dueño que es Chatwoot): bandeja única de chat, **una cuenta de Chatwoot por empresa**. Los clientes solo entran para chatear, nunca a configuración.
- **n8n** (automatizacion.kaizenia.app): un flujo por empresa, copiado de la plantilla. Solo el Programador entra.
- **Paneles de producto** (correo, operaciones, reservas): solo Somos Viajes por ahora. Un subdominio nuevo solo cuando un producto tenga panel propio.
- **No crear subdominio por cliente para el chat.** El subdominio kaizenconsulting-ia de la ficha no hace falta por ahora.
- Entrenamiento de la IA: se hace en Oficina (Base del asistente), no en un subdominio aparte.
- Plan en orden: (1) cuenta Kaizen en Chatwoot + bandeja WhatsApp; (2) webhook de Meta hacia Chatwoot + prueba con Test; (3) flujo n8n de Kaizen en nota privada; (4) revisión de Meta con textos actualizados a Chatwoot, videos y envío; (5) replicar con Somos Viajes (varios números), PEX y Premios Carrasco.

## ESTADO ACTUAL (actualizado)
- **Chatwoot · cuenta "Kaizen Consulting IA"** (administrador: dueño): creada.
- **Bandeja "Kaizen Consulting WhatsApp"** (WhatsApp manual, Nube de WhatsApp): creada con número +51 989 480 556, ID de número 1436733079519865, WABA 1126190176716418 y token de acceso nuevo (generado el 25-26 nov, guardado solo en Chatwoot).
- **Recepción probada:** llegó un mensaje real ("hola") a la bandeja de Kaizen.
- **Envío probado:** el mensaje de prueba "Prueba de Zentralia" salió desde Chatwoot y llegó al celular del dueño.
- **Canal de Messenger "Kaizen Consulting" que estaba en la cuenta de Somos Viajes:** es una conversación de prueba. El dueño autorizó borrarlo; pendiente de eliminarlo desde Somos Viajes → Ajustes → Bandejas.
- Pendiente inmediato: (1) agregar al dueño como agente en Kaizen Consulting IA; (2) verificar en Meta que el webhook apunte a Chatwoot; (3) importar el flujo de n8n de Kaizen inactivo, con la URL del webhook de Chatwoot, y probarlo en nota privada.
- **Webhook de la app Zentralia WB:** la URL general sigue siendo oficina.kaizenia.app/api/whatsapp/webhook. Los mensajes de Kaizen llegan a Chatwoot, probablemente por una suscripción propia de la cuenta de WhatsApp (WABA). **No cambiar la URL general sin revisar antes** para no romper la recepción.
- **Webhook de Chatwoot para la bandeja de Kaizen (no secreto):** https://redes.kaizenia.app/webhooks/whatsapp/+51989480556 . El token de verificación NO se guarda en el repositorio.

## DECISIÓN VIGENTE (dueño, 26 nov)
- Oficina se queda como está (recepción de WhatsApp de Kaizen ya llega a Chatwoot). No cambiar el webhook general de la app.
- Siguiente trabajo: **pruebas del flujo de n8n de Kaizen**, luego replicar con las otras empresas.
- Pasos de prueba: (1) importar el flujo en automatizacion.kaizenia.app, apagado; (2) credenciales: clave del asistente (Oficina → Clientes → IA) y token de acceso de Chatwoot (perfil del agente); (3) número de cuenta de Kaizen en Chatwoot; (4) en Chatwoot de Kaizen: Ajustes → Integraciones → Webhooks, usar la URL de prueba de n8n, evento message_created; (5) cargar contenido de prueba en la Base del asistente de Kaizen (Oficina); (6) probar: mensaje desde celular → nota privada en Chatwoot; (7) revisar y luego activar.
- Pendiente aparte: borrar el canal de Messenger "Kaizen Consulting" de la cuenta de Somos Viajes (el dueño lo confirmó).

## CAUSA DEL ERROR "Clave del asistente no válida" (verificada en el código)
- La ruta /api/conocimiento/responder valida la clave contra `empresas.conocimiento_token` (conocimiento.js, línea ~1304).
- La clave que se ve en Oficina → Base del asistente → Ajustes del asistente (formato kc_…) es la de cada EMPRESA. Se copia con "Copiar clave".
- "Ver clave para n8n" (Empresas y demo) es otra clave general de n8n: NO sirve para el asistente.
- Kaizen está en `automatizacion_clientes`, no en `empresas`, así que no tiene clave del asistente y no aparece en el selector de Base del asistente.
- Solución de hoy: crear Kaizen también como empresa (Empresas y demo → Nueva empresa, tipo Otro negocio) y usar su clave kc_… en la credencial de n8n ("Bearer " + clave).
- Pendiente a largo plazo: que la Base del asistente liste también los clientes de automatización (cambio de código en Oficina) y unificar ambos registros.

## PENDIENTES POSPUESTOS (26 nov)
- **Correo de soporte@kaizenia.app (reenvío a Gmail):** pendiente. Hay que activar la verificación en 2 pasos de la cuenta Gmail (aparece desactivada; al intentar activarla da error, por confirmar el texto exacto) y crear una contraseña de aplicación "Zentralia". En Oficina, el campo Usuario debe ser el Gmail completo, no soporte@. La cuenta tiene una llave de acceso (passkey) creada por error: se conserva.
- Mientras tanto: crear Kaizen como empresa en Oficina (Empresas y demo → Nueva empresa, tipo Otro negocio) y usar su clave del asistente en n8n.

## HITO: FLUJO DE KAIZEN FUNCIONANDO DE PUNTA A PUNTA (26 nov)
- Mensaje de WhatsApp al +51 989 480 556 → Chatwoot (cuenta Kaizen) → n8n (flujo de Kaizen, en modo prueba) → asistente de Oficina (empresa Kaizen Consulting IA) → respuesta llega al WhatsApp del dueño.
- Problemas resueltos: aplicación "Zentralia interno" de Cloudflare Access bloqueaba el webhook (se creó excepción "Webhooks n8n Kaizen" con Bypass para /webhook y /webhook-test); credencial de n8n equivocada (ahora "Clave asistente Kaizen" usa la clave kc_… de la empresa Kaizen).
- Pendientes de Kaizen: (1) cargar el documento de servicios (memoria/documentos/Servicios-Kaizen-para-el-asistente.docx) con los datos reales; (2) instrucciones y bienvenida ya puestas, ajustar tono; (3) cambiar "Responder en Chatwoot" a respuesta pública solo al activar para clientes; (4) correo soporte@ pendiente; (5) borrar canal de Messenger de Somos Viajes.

## DECISIÓN DE PUBLICACIÓN (26 nov)
- El dueño decidió: respuestas PÚBLICAS desde el inicio, porque por ahora solo él tiene el número +51 989 480 556. Revisar esta decisión antes de compartir el número con clientes.
- Canal de Messenger "Kaizen Consulting" borrado de la cuenta de Somos Viajes.
- Pasos de publicación: (1) Publish del flujo en n8n; (2) cambiar el webhook de Chatwoot (cuenta Kaizen) a la URL de producción /webhook/automatizacion/kaizenconsulting-ia/chatwoot; (3) probar con mensaje desde el celular.

## ETAPA: CORREO → OPERACIONES → CONTABILIDAD (27 nov)

**Idea central del dueño:** el panel de correo es la entrada de todo. Lo que se registra ahí alimenta a Operaciones (proforma, factura, boleta y envío al chofer) y al contador (ganancia, caja y cobros). Por eso el dato tiene que ser exacto desde el origen. El panel recibe la información, la guarda, y Operaciones decide cómo filtrarla y registrarla.

**Qué tipos de servicio existen (según el dueño):** crucero, actividad (con tiquete), interhotel, IN-OUT, salida independiente (solo sale del hotel al aeropuerto), IN (solo llegada) y servicio múltiple (una persona llega, hace actividades y se va; cada parte es un servicio).

**Reglas de llenado decididas:**
- Actividad: vuelo y aeropuerto = N/A. No es "pendiente".
- Interhotel: vuelo = N/A (viene de un hotel, no de un vuelo).
- Crucero: aeropuerto = nombre del puerto tal como aparece (por ejemplo "Puerto de Puerto Plata"); vuelo = N/A.
- Hora: no bloquea la reserva. Si no viene, se muestra "Por confirmar". No se marca como duda.
- Datos obligatorios de una reserva completa: día, nombre del pasajero y hotel donde se hospeda.
- Teléfono: no bloquea (decisión tomada por mí; el dueño no lo mencionó. Confirmar).
- Un servicio múltiple se guarda como varias filas; cada fila tiene sus propios N/A.
- Vocabulario: IF/OFF = IN/OUT; guagua = bus de 7 a 21 pasajeros; "velero con tortugas" = catamarán con snorkel; las actividades que no estén en el glosario se escriben tal cual vienen en el correo.

**Catálogo de agencias (decidido, sin construir):** tabla en la base `correos`, con país, idioma, tipo y dominios de correo de cada agencia. El flujo lo consulta antes de leer el correo. Solo el Programador lo edita desde Oficina. La carga inicial sale de los tarifarios ya importados (`op_agencias`, `op_tarifarios`, `op_tarifas`). Falta construirlo.

**Supervisor de la IA (decidido en parte):**
- Si hay error: solo marcar; un asesor lo aprueba. No corregir en silencio.
- A qué correos: todas las reservas y modificaciones.
- Dónde vive: en n8n.
- Formato: fijo desde ya, para que Operaciones y Facturas lo puedan leer.
- Pendiente de decidir: con qué casos se mide el acierto (correcciones de asesores, 20 correos nuevos, o ambos); cuánta IA supervisora (reglas en código + IA en casos dudosos, o IA en cada reserva); cómo tratar las capturas (clasificar antes o mandar todas).
- Recomendación de la IA: reglas de código en cada paso (fechas, aeropuertos, pax que sumen, número de vuelo que aparezca literal en el correo) y un juego de correos reales con respuesta correcta antes de cada cambio.

**Estado del código (rama `claude/wonderful-keller-4c8hoe`):**
- `4add937`: reglas de revisión para actividad, interhotel, crucero, IN/OUT y nombre del pasajero (`panel/revision.js` y `panel/index.html`).
- `06db1c3`: el panel muestra N/A cuando un campo no aplica, "Por confirmar" para la hora, y "Falta" solo si el dato sí aplica.
- `panel/revision.test.js`: 5 pruebas de esas reglas (`node --test panel/revision.test.js`).
- `n8n/nodos/limpiar-texto-v5.js`: nodo "Limpiar texto" v5. Lo guardó el dueño en n8n (glosario, reglas de llenado, texto hasta 30 000 caracteres, 8 000 tokens de salida, memoria de imágenes con versión 2).

**Pendientes de esta etapa:**
1. Desplegar el panel al servidor con `panel/servidor/actualizar-servidor.ps1` (se entrega paquete). Reinicia los paneles: los usuarios vuelven a entrar.
2. Confirmar en n8n (Executions) que el flujo corre en verde con el nodo v5.
3. Etiqueta "Crucero" en la columna de tipo (hoy aparece "Llegada (IN)").
4. Estado "Pendiente" a nivel de reserva: lo calcula el flujo de n8n (`estado = pendiente de transcribir` cuando hay fecha u hotel). Debe cambiar para que una reserva con día, nombre y hotel no quede pendiente.
5. Catálogo de agencias en la base `correos` (ver arriba).
6. Las tres decisiones del supervisor que faltan.

**Reglas de trabajo que quedaron del dueño (27 nov):**
- No mandar correos de prueba a operaciones. Para verificar, se revisan los datos que ya existen y el estado del flujo en Executions.
- Lo importante es que el sistema que recibe la información entienda lo que el panel de correo dice (N/A, crucero, actividad). No que el panel adivine el tipo de servicio.
- Cada paso del trabajo se deja en el repositorio: esta memoria, los nodos de n8n en `n8n/nodos/` y las pruebas en `panel/`.


## VENTANA DEL CORREO EN CUADROS (27 nov)
- Diseño aprobado por el dueño: ventana D3 (cuadros con icono y etiqueta, avioncitos en IN y OUT, correo grande, estados y botones abajo, historial plegado con "Mostrar").
- Implementado en `panel/index.html`: datos de la reserva en cuadros (`tarjetasDatos`), estados como botones (`pintarEstadoSeg`), historial plegado (`details`), botones de la ventana en círculo con símbolo (–, □, ✕) y notas al pasar el cursor.
- La lógica no cambió: editar datos, asignación, factura y los estados siguen con las mismas funciones.
- Prueba: `panel` cargado en navegador con datos de ejemplo (Maral Turismo, reserva con IN y OUT): 9 cuadros, tabla oculta, historial plegado, 6 estados y el correcto activo. No se probó con la base de datos real.
- Pendiente: el salto de ventana al pasar a la siguiente reserva (no está en este cambio).
- Pendiente: la etiqueta "Crucero" y el estado "Pendiente por registrar" en Operaciones y Control siguen como estaban.

## REGLA DE ENTREGA DE PAQUETES (27 nov)
- Cada paquete de instalación que se entrega va junto con el comando completo de instalación, sin que el dueño tenga que pedirlo.
- El comando está en `memoria/INSTALAR-PANEL.md`.
