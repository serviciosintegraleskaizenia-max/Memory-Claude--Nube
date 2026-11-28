# Plan: mejorar «Entrenar la IA» del panel del cliente (PEX Solutions y los que sigan)

Pedido del dueño (28 nov), con captura de PEX → Entrenar la IA → Probar la IA.

## Lo que encontré en el código (panel-cliente/servidor.js)
- Los **archivos de entrenamiento se guardan pero la IA no los usa** (responderIA solo arma prompt_base + ajustes + bienvenida).
- El **chat de prueba manda solo el último mensaje** (sin la conversación): por eso no tiene memoria ni sigue el hilo.
- **max_tokens 600**: las respuestas largas se cortan.
- Límite de archivos **6 MB** (MAX_ARCHIVO).
- El recibo que llega al panel (Oficina → crearRecibo) solo lleva periodo, monto, vence, mensaje y enlace: no trae la cuenta bancaria ni las condiciones.

## Decisiones del dueño (respuestas)
- **Memoria con 👍/👎:** 👍 guarda la respuesta como ejemplo bueno que la IA usa desde ahí; 👎 pide cómo debió responder y esa corrección queda en su memoria. Pestaña «Memoria» para ver, editar o borrar lo aprendido.
- **Archivos y planos:** todo (PDF, Word, Excel, fotos y planos) hasta **24 MB**. Los planos/imágenes los mira un modelo con visión (Claude Sonnet) para entenderlos y cotizar; cuesta más por mensaje con plano.
- **Uso real:** lo aprendido (memoria, correcciones, archivos) se usa también cuando la IA responde a los clientes reales por WhatsApp.
- **Recibos en su panel:** los mismos de Oficina (aviso AP y recibo RC con cuenta en dólares, CCI, titular y condiciones).
- Chat de prueba **como WhatsApp**: emojis, adjuntar documentos/planos, **«Nueva conversación»** para no mezclar, e **historial** de conversaciones para volver a una que le gustó.

## Pasos
- [x] P1 Chat de prueba: conversaciones (nueva / historial), manda la conversación completa, respuestas sin cortarse (max_tokens 2000), emojis y adjuntos (imagen, PDF, Word, Excel).
- [x] P2 Memoria 👍/👎 con corrección, pestaña Memoria (ver, editar, borrar), y la IA la usa en cada respuesta.
- [x] P3 Archivos de entrenamiento hasta 24 MB y que la IA los lea (texto de PDF/Word/Excel; imágenes y planos con visión).
- [x] P4 Que las respuestas reales (WhatsApp) usen lo mismo (revisar por dónde responde hoy: n8n / Oficina).
- [x] P5 Recibos y avisos en «Pagos y recibos» del panel: el AP/RC de Oficina con la cuenta y condiciones.

## Cómo quedó (28 nov) · probado 31/31 (prueba-entreno-pc.js, con un OpenRouter de mentira)
- Tablas nuevas (esquema.sql): `prueba_conversaciones`, `prueba_mensajes` (con archivo y voto), `ia_memoria` (bien / correccion, activo); `archivos_entrenamiento.tipo` y `.texto`; `recibos.documento_url` y `.recibo_url`.
- Rutas: `/api/prueba/conversaciones` (lista, nueva, abrir, borrar), `/api/prueba/enviar` (manda los últimos 30 mensajes; max_tokens 2000; si trae imagen o PDF usa `anthropic/claude-sonnet-5.5` y se lo manda como image_url / file), `/api/prueba/voto` (👍 guarda; 👎 exige la corrección), `/api/memoria` (ver, crear, editar/apagar, borrar), `/api/interno/ia-contexto`.
- Instrucciones de la IA = base de Kaizen + ajustes + bienvenida + memoria (80 últimos) + texto de archivos (hasta 80.000 caracteres). Texto de PDF (pdf-parse si está), Word (.docx), Excel (.xlsx, con lector-xlsx.js copiado al panel) y texto. Los archivos viejos se leen solos al arrancar.
- Respuestas reales: `/api/n8n/automatizacion` (central.js) suma `ia-contexto` del panel al prompt.
- Límite 24 MB por archivo (cuerpo hasta 34 MB). Si la respuesta se corta (finish_reason length) se avisa «pídele continúa».
- Recibos: en Oficina, el aviso (AP) y el recibo (RC) de un cliente con panel tienen «📲 Enviar a su panel»: el aviso crea el cobro en «Pagos y recibos» con «Ver aviso y cuenta para pagar»; el RC lo marca Pagado con «Ver recibo».
- Pantalla: Entrenar la IA → «Probar la IA» como WhatsApp (historial, + Nueva conversación, 😊 emojis, 📎 adjuntar, Enter envía) y pestaña «Memoria 🧠».
- Para probar: `PANEL_CLIENTE_OPENROUTER` cambia la dirección de OpenRouter (solo pruebas).
- Pendiente de revisar en el servidor real: si hay un proxy delante (Cloudflare/nginx) con límite de subida menor a 34 MB.
