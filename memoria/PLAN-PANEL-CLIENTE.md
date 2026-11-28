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
- [ ] P1 Chat de prueba: conversaciones (nueva / historial), manda la conversación completa, respuestas sin cortarse (max_tokens 2000), emojis y adjuntos (imagen, PDF, Word, Excel).
- [ ] P2 Memoria 👍/👎 con corrección, pestaña Memoria (ver, editar, borrar), y la IA la usa en cada respuesta.
- [ ] P3 Archivos de entrenamiento hasta 24 MB y que la IA los lea (texto de PDF/Word/Excel; imágenes y planos con visión).
- [ ] P4 Que las respuestas reales (WhatsApp) usen lo mismo (revisar por dónde responde hoy: n8n / Oficina).
- [ ] P5 Recibos y avisos en «Pagos y recibos» del panel: el AP/RC de Oficina con la cuenta y condiciones.
