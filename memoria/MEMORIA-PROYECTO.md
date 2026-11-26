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
- Subdominios por empresa previstos: kaizenconsulting-ia, pex-solution, premios-carrasco (todos en kaizenia.app). Pendiente de crear en Cloudflare como registros tipo A con DNS only.
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
2. Crear los registros DNS en Cloudflare (kaizenconsulting-ia, pex-solution, premios-carrasco) con DNS only.
3. Configurar el servidor para responder a esos subdominios con HTTPS (pendiente: confirmar cómo está montado el servidor web).
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
