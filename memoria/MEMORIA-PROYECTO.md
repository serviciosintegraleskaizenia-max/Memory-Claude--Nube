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
- **Revisión de la aplicación:** 4 permisos **sin enviar**: whatsapp_business_messaging, whatsapp_business_management, business_management, public_profile.
- **Pruebas (Tests):** whatsapp_business_messaging COMPLETADA. whatsapp_business_management COMPLETADA. business_management: llamada hecha (me/businesses) con respuesta, puede tardar 24 h en reflejarse. public_profile: llamada hecha (me?fields=id,name) con respuesta.
- **Lo que NO está hecho:** envío de la revisión, videos de demostración, cuenta fija de prueba para el revisor, publicación de la app. Los mensajes reales de clientes no llegan mientras la app no esté publicada (aviso de Meta).
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
