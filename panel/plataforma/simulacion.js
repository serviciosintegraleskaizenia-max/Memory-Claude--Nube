// Simulación de ventas del asistente (Oficina → Base del asistente → 🧪 Simulación).
// Una IA hace de CLIENTE (15 perfiles: Punta Cana y Orlando, familias, parejas, grupos, regateo, otros idiomas...) y conversa
// con el asistente REAL de la empresa (sus tarifarios, su búsqueda en internet) usando el prompt de VENDEDOR y el modelo elegido.
// Mide por conversación: tokens, costo en US$, búsquedas en internet, si dio precio y cómo terminó (venta lista para el
// depósito, pasó a un asesor o no compró). Con eso la Oficina calcula el costo por conversación y el ROI contra asesores.
// Nada de esto cambia los ajustes del asistente hasta que se pulsa "Usar este vendedor".

const MODELOS = [
  { id: 'anthropic/claude-haiku-5.5', nombre: 'Claude Haiku 5.5', nota: 'rápido y económico' },
  { id: 'anthropic/claude-sonnet-5.5', nombre: 'Claude Sonnet 5.5', nota: 'más criterio para vender' }
];
const MODELO_CLIENTE = 'anthropic/claude-haiku-5.5';
const MAX_TURNOS = 10;       // mensajes del cliente por conversación
const A_LA_VEZ = 3;          // conversaciones en paralelo
const COSTO_BUSQUEDA = 0.008; // US$ por búsqueda en internet (Exa, 2 resultados) si OpenRouter no informa el costo

const PROMPT_VENDEDOR = `PAPEL: eres ejecutivo/a de ventas y asesor/a de viajes. Tu meta es entender qué busca el cliente, recomendarle lo mejor para su viaje y dejar la venta lista para que un asesor cobre el depósito. Amable, seguro/a y servicial: un experto que aconseja, no un robot que da listas de precios.

CÓMO VENDES (en este orden, una pregunta a la vez)
1. Descubre: fechas, cuántos adultos y niños (con edades), hotel o zona, aeropuerto y hora del vuelo, y qué les gusta (playa, aventura, relax, fiesta, parques, compras). Si el cliente ya dio un dato, no lo vuelvas a pedir.
2. Recomienda como experto: 2 o 3 opciones de la INFORMACIÓN que encajen con su perfil, cada una con una línea de por qué le conviene. Familia con niños: actividades seguras y traslado privado. Pareja: experiencias románticas o exclusivas. Grupo: van o traslado privado y actividades de fiesta o aventura. Orlando: traslado desde/hacia MCO o SFB y parques.
3. Arma el paquete: traslado aeropuerto ida y vuelta + excursiones + extras que necesite (silla de bebé, booster, silla de ruedas...). Sugiere privado si son 4 o más, llegan de noche o viajan con niños; compartido si buscan ahorrar.
4. Precio: cuando tengas fechas y cantidad de personas, da el TOTAL con el desglose (cada servicio × personas = subtotal) y el total final, como estimado sujeto a confirmación y disponibilidad. Si insiste en precio antes, da el precio por persona y pide lo que falta.
5. Cierra: termina cada propuesta con una pregunta de cierre suave ("¿Te lo dejo apartado para esas fechas?", "¿Prefieres la opción privada o la compartida?"). Si dice que sí, pide en un solo mensaje nombre completo, fechas, adultos y niños con edades, hotel y vuelo, y pásalo a un asesor (motivo "reservar") para el depósito y el pago.
6. Objeciones: si le parece caro, ofrece la alternativa más económica de la INFORMACIÓN (compartido, otro tour, menos días) sin inventar descuentos. Si "lo va a pensar", resume en una línea por qué le conviene y ofrece dejarlo apartado con un asesor. Si compara con otra agencia, destaca el valor (puntualidad, seguridad, atención en español, choferes con licencia) sin criticar a nadie.
7. Venta cruzada con medida: como máximo una sugerencia extra por mensaje y nunca insistas más de dos veces en lo mismo.

NUNCA
- Inventar descuentos, promociones, disponibilidad ni precios que no estén en la INFORMACIÓN.
- Pedir datos de tarjeta ni cobrar por el chat: el depósito y el pago los hace el asesor.
- Presionar o ser insistente: si no quiere, despídete con amabilidad y deja la puerta abierta.`;

// Los 15 clientes simulados. sede: 'pc' = Punta Cana / República Dominicana, 'orl' = Orlando.
const ESCENARIOS = [
  { id: 1, sede: 'pc', titulo: 'Luna de miel en Bávaro', idioma: 'español', perfil: 'Pareja de recién casados de Colombia (2 adultos). Llegan a PUJ el 14 del próximo mes a las 3 p. m., hotel en Bávaro, 6 noches.', objetivo: 'Traslado privado ida y vuelta y 1 o 2 excursiones románticas.', conducta: 'Entusiasta, hace preguntas sobre qué es más romántico. Si el precio total parece razonable, decide reservar.' },
  { id: 2, sede: 'pc', titulo: 'Familia con niños al Nickelodeon (SDQ)', idioma: 'español', perfil: 'Familia de Puerto Rico: 2 adultos y 2 niños de 5 y 9 años. Llegan a Santo Domingo (SDQ) y se quedan en el Nickelodeon (Uvero Alto) 5 noches.', objetivo: 'Traslado SDQ al hotel ida y vuelta, silla de bebé o booster, y una actividad para niños.', conducta: 'Cuida el presupuesto: pregunta si hay opción más barata. Reserva si le explican bien la diferencia entre privado y compartido.' },
  { id: 3, sede: 'pc', titulo: 'Despedida de soltero (8 amigos)', idioma: 'español', perfil: 'Grupo de 8 amigos de Miami, hotel en Uvero Alto, 4 noches, llegan a PUJ un viernes a las 11 a. m.', objetivo: 'Traslado para el grupo y una excursión de fiesta (party boat o similar).', conducta: 'Informal, usa jerga, quiere algo divertido. Si le arman el paquete completo, reserva.' },
  { id: 4, sede: 'pc', titulo: 'Solo quiere un traslado, con prisa', idioma: 'español', perfil: 'Ejecutivo que viaja solo, aterriza mañana en PUJ a las 9 p. m., va a un hotel Riu en Bávaro.', objetivo: 'Solo el traslado de llegada, rápido.', conducta: 'Escribe muy corto, quiere el precio YA. Si le dan precio claro, reserva. No le interesan excursiones (dilo si insisten).' },
  { id: 5, sede: 'pc', titulo: 'Canadiense en inglés: clima + tours', idioma: 'inglés', perfil: 'Couple from Toronto (2 adults), traveling to Punta Cana in July, staying in Cap Cana, 7 nights.', objetivo: 'Know the weather in July (hurricanes?), airport transfer and the best 2 tours.', conducta: 'Asks about weather first, then about tours. Books if the answers are confident and clear.' },
  { id: 6, sede: 'pc', titulo: 'Pareja de Brasil en portugués', idioma: 'portugués de Brasil', perfil: 'Casal de São Paulo (2 adultos), hotel em Bávaro, 5 noites, chegam no PUJ.', objetivo: 'Passeio à Ilha Saona e talvez Samaná, mais o traslado.', conducta: 'Simpático, compara os dois passeios. Reserva o que for recomendado se o preço total for claro.' },
  { id: 7, sede: 'pc', titulo: 'Regatea: "otra agencia es más barata"', idioma: 'español', perfil: 'Señora de Santo Domingo, 3 adultos, hotel en Bávaro, quiere Isla Saona.', objetivo: 'Isla Saona para 3 adultos al mejor precio.', conducta: 'Dice que otra agencia le da más barato y pide descuento. Si no le dan descuento pero le explican el valor, duda y al final decide que lo va a pensar (no reserva).' },
  { id: 8, sede: 'pc', titulo: 'Preguntas fuera de la base', idioma: 'español', perfil: 'Viajero de Venezuela, viaja solo a Punta Cana en dos meses.', objetivo: 'Saber qué documentos necesita para entrar a RD, si conviene seguro de viaje, cuál es la mejor playa, y después el traslado.', conducta: 'Hace varias preguntas generales antes de hablar de servicios. Si le resuelven, pide precio del traslado y reserva.' },
  { id: 9, sede: 'orl', titulo: 'Familia a Disney 5 días', idioma: 'español', perfil: 'Familia de México: 2 adultos y 2 niños (6 y 11). Llegan a Orlando (MCO), hotel en International Drive, 6 noches.', objetivo: 'Traslado MCO ida y vuelta, entradas a Disney 4 días y consejos de qué parques ver.', conducta: 'Pregunta mucho por los parques. Si le dan el paquete con precio del traslado (y le dicen cómo cotizar las entradas), reserva.' },
  { id: 10, sede: 'orl', titulo: 'Universal + Kennedy en inglés', idioma: 'inglés', perfil: 'Couple from London (2 adults), 5 nights in Orlando, hotel near Universal.', objetivo: 'Universal tickets, a day trip to Kennedy Space Center and transfers.', conducta: 'Practical, wants a clear itinerary. Books if the plan makes sense.' },
  { id: 11, sede: 'orl', titulo: 'Quinceañera: grupo de 12', idioma: 'español', perfil: 'Mamá organizando viaje de quinceañera: 12 personas (8 adolescentes y 4 adultos), Orlando 4 noches, hotel en Kissimmee.', objetivo: 'Transporte para el grupo (van) a parques y a los outlets de compras.', conducta: 'Organizada, pide todo por escrito y el total. Reserva si le dan transporte para 12 con precio.' },
  { id: 12, sede: 'orl', titulo: 'Abuelos con silla de ruedas', idioma: 'español', perfil: 'Pareja de 72 años, ella usa silla de ruedas. Llegan a MCO, hotel en Lake Buena Vista, 5 noches.', objetivo: 'Traslado accesible y alguna actividad tranquila.', conducta: 'Preocupado por la accesibilidad, pregunta detalles. Reserva si le confirman que un asesor verifica el vehículo accesible.' },
  { id: 13, sede: 'orl', titulo: '"Solo estoy mirando"', idioma: 'español', perfil: 'Persona curiosa, todavía no tiene fechas ni sabe cuántos van.', objetivo: 'Ver precios en general de traslados y parques.', conducta: 'Responde vago, no da fechas. Al final dice que todavía no decide y se despide (no reserva).' },
  { id: 14, sede: 'pc', titulo: 'Quiere hablar con una persona', idioma: 'español', perfil: 'Cliente mayor que desconfía de los chats, 2 adultos, hotel en Bávaro.', objetivo: 'Traslado y una excursión, pero prefiere hablar con un humano.', conducta: 'Después de 1 o 2 mensajes pide hablar con una persona de verdad.' },
  { id: 15, sede: 'pc', titulo: 'Llega de madrugada con bebé', idioma: 'español', perfil: 'Mamá sola con un bebé de 1 año, vuelo que aterriza en PUJ a la 1:30 a. m., hotel en Bávaro, 7 noches.', objetivo: 'Traslado seguro de madrugada con silla de bebé, ida y vuelta.', conducta: 'Pregunta por la seguridad a esa hora y por la silla de bebé. Reserva si le dan confianza y el precio.' }
];

module.exports = function crearSimulacion({ client, registrar, central, claveIA, responder, empresa, sedesDe, error }) {
  const enCurso = new Map(); // id de simulación -> true (para no correr dos a la vez por empresa)
  let precios = null, preciosHora = 0;

  async function preparar() {
    await client.query(`CREATE TABLE IF NOT EXISTS conocimiento_simulaciones (
      id SERIAL PRIMARY KEY, empresa_id INTEGER NOT NULL, creado TIMESTAMPTZ NOT NULL DEFAULT NOW(), autor TEXT NOT NULL DEFAULT '',
      estado VARCHAR(12) NOT NULL DEFAULT 'corriendo', ajustes JSONB NOT NULL DEFAULT '{}', progreso JSONB NOT NULL DEFAULT '{}',
      resultado JSONB NOT NULL DEFAULT '{}', terminado TIMESTAMPTZ)`);
    // Si el panel se reinició a mitad de una simulación, queda marcada como interrumpida.
    await client.query("UPDATE conocimiento_simulaciones SET estado = 'interrumpida' WHERE estado = 'corriendo'");
  }

  // Precio por token de cada modelo (de OpenRouter), por si la respuesta no trae el costo.
  async function precioDe(modelo) {
    if (!precios || Date.now() - preciosHora > 6 * 3600 * 1000) {
      try {
        const r = await fetch(central.ayudantes.OPENROUTER + '/models');
        const d = await r.json();
        precios = new Map((d.data || []).map(m => [m.id, { entrada: Number(m.pricing && m.pricing.prompt) || 0, salida: Number(m.pricing && m.pricing.completion) || 0 }]));
        preciosHora = Date.now();
      } catch (e) { precios = precios || new Map(); }
    }
    return precios.get(modelo) || null;
  }
  async function costoDe(modelo, tokens, conWeb) {
    if (tokens && tokens.costo) return tokens.costo;
    const p = await precioDe(modelo);
    const base = p && tokens ? tokens.entrada * p.entrada + tokens.salida * p.salida : 0;
    return base + (conWeb ? COSTO_BUSQUEDA : 0);
  }

  // El cliente simulado: otra IA que escribe como una persona real por WhatsApp.
  async function hablaCliente(apiKey, esc, mensajes) {
    const sistema = `Eres un CLIENTE REAL que escribe por WhatsApp a una agencia de viajes. No eres una IA ni un asistente: nunca lo digas.
Tu perfil: ${esc.perfil}
Lo que quieres: ${esc.objetivo}
Cómo te comportas: ${esc.conducta}
Reglas:
- Escribe SIEMPRE en ${esc.idioma}, como en WhatsApp: 1 a 3 líneas, natural, a veces informal. Sin listas ni formato.
- Da tus datos solo cuando te los pidan (o si es natural darlos). No inventes datos que contradigan tu perfil.
- Reacciona a lo que te dice la agencia (precios, recomendaciones) como lo haría tu personaje.
- Cuando ya decidiste (reservar, pensarlo o no comprar) y lo dijiste, termina tu mensaje con [FIN].
- Si ya escribiste ${MAX_TURNOS - 1} mensajes, decide en este y termina con [FIN].
Escribe SOLO el texto de tu mensaje.`;
    // Desde el punto de vista del cliente: la agencia es "user" y él es "assistant".
    const historial = mensajes.map(m => ({ role: m.rol === 'cliente' ? 'assistant' : 'user', content: m.texto }));
    if (!historial.length) historial.push({ role: 'user', content: '(Empieza tú la conversación: escribe tu primer mensaje a la agencia.)' });
    const r = await fetch(central.ayudantes.OPENROUTER + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'X-Title': 'Kaizen IA - simulacion de ventas' },
      body: JSON.stringify({ model: MODELO_CLIENTE, max_tokens: 300, temperature: 0.8, usage: { include: true }, messages: [{ role: 'system', content: sistema }, ...historial] })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw error('El cliente simulado falló: ' + ((d.error && d.error.message) || r.status), 502);
    const c = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    const t = Array.isArray(c) ? c.map(p => p.text || '').join('') : String(c || '');
    const u = d.usage || {};
    const costo = Number(u.cost) || await (async () => { const p = await precioDe(MODELO_CLIENTE); return p ? (u.prompt_tokens || 0) * p.entrada + (u.completion_tokens || 0) * p.salida : 0; })();
    return { texto: t.trim(), fin: /\[FIN\]/i.test(t), costo };
  }

  // Una conversación completa entre el cliente simulado y el vendedor.
  async function conversar(e, apiKey, sedes, esc, modelo, instrucciones) {
    const sede = esc.sede === 'orl' ? (sedes.find(s => /orlando/i.test(s)) || '') : (sedes.find(s => !/orlando/i.test(s)) || '');
    const mensajes = [];
    const c = { escenario: esc.id, titulo: esc.titulo, modelo, sede: sede || 'Todas', mensajes: [], resultado: 'limite', turnos: 0,
      tokens_entrada: 0, tokens_salida: 0, costo: 0, costo_cliente: 0, busquedas_web: 0, dio_precio: false, motivo: '', resumen_para_asesor: '', error: '' };
    try {
      for (let turno = 0; turno < MAX_TURNOS; turno++) {
        const cl = await hablaCliente(apiKey, esc, mensajes);
        c.costo_cliente += cl.costo;
        const textoCliente = cl.texto.replace(/\[FIN\]/gi, '').trim();
        if (textoCliente) { mensajes.push({ rol: 'cliente', texto: textoCliente }); c.mensajes.push({ rol: 'cliente', texto: textoCliente }); }
        // Si el cliente se despide o decide ("resérvamelo [FIN]"), el vendedor igual contesta ese último mensaje
        // (ahí es donde pasa la venta al asesor); después se termina.
        if (!textoCliente) { c.resultado = 'sin_venta'; break; }
        c.turnos++;
        const t0 = Date.now();
        const r = await responder(e.id, { sede, mensajes, modelo, instrucciones });
        const conWeb = Boolean(r.web && r.web.usada);
        const costo = await costoDe(r.modelo || modelo, r.tokens, conWeb);
        c.tokens_entrada += (r.tokens && r.tokens.entrada) || 0;
        c.tokens_salida += (r.tokens && r.tokens.salida) || 0;
        c.costo += costo;
        if (conWeb) c.busquedas_web++;
        if (/US\$\s?\d|\$\s?\d/.test(r.respuesta)) c.dio_precio = true;
        mensajes.push({ rol: 'asistente', texto: r.respuesta });
        c.mensajes.push({ rol: 'asistente', texto: r.respuesta, costo, tokens: r.tokens, web: conWeb, segundos: Math.round((Date.now() - t0) / 100) / 10, motivo: r.motivo || '' });
        if (r.pasar_a_asesor) {
          c.motivo = r.motivo || 'humano';
          c.resumen_para_asesor = r.resumen_para_asesor || '';
          c.resultado = c.motivo === 'reservar' ? 'venta' : 'asesor';
          break;
        }
        if (cl.fin) { c.resultado = 'sin_venta'; break; }
      }
    } catch (err) { c.error = err.message; c.resultado = 'error'; }
    return c;
  }

  function resumir(conversaciones) {
    const porModelo = {};
    for (const c of conversaciones) {
      const m = porModelo[c.modelo] = porModelo[c.modelo] || { modelo: c.modelo, conversaciones: 0, ventas: 0, asesor: 0, sin_venta: 0, limite: 0, errores: 0,
        costo: 0, costo_cliente: 0, tokens_entrada: 0, tokens_salida: 0, turnos: 0, busquedas_web: 0, con_web: 0, dieron_precio: 0, costo_max: 0 };
      m.conversaciones++;
      m[c.resultado === 'venta' ? 'ventas' : c.resultado === 'asesor' ? 'asesor' : c.resultado === 'sin_venta' ? 'sin_venta' : c.resultado === 'error' ? 'errores' : 'limite']++;
      m.costo += c.costo; m.costo_cliente += c.costo_cliente; m.tokens_entrada += c.tokens_entrada; m.tokens_salida += c.tokens_salida;
      m.turnos += c.turnos; m.busquedas_web += c.busquedas_web; if (c.busquedas_web) m.con_web++; if (c.dio_precio) m.dieron_precio++;
      m.costo_max = Math.max(m.costo_max, c.costo);
    }
    for (const m of Object.values(porModelo)) {
      const n = Math.max(1, m.conversaciones - m.errores);
      m.costo_promedio = m.costo / n;
      m.tokens_promedio = (m.tokens_entrada + m.tokens_salida) / n;
      m.turnos_promedio = m.turnos / n;
      m.costo_por_mensaje = m.turnos ? m.costo / m.turnos : 0;
    }
    return porModelo;
  }

  async function correr(id, e, apiKey, modelos, instrucciones, escenarios) {
    const sedes = sedesDe(e);
    const tareas = [];
    for (const modelo of modelos) for (const esc of escenarios) tareas.push({ modelo, esc });
    const conversaciones = [];
    let hechas = 0, siguiente = 0;
    const guardarProgreso = () => client.query('UPDATE conocimiento_simulaciones SET progreso = $1 WHERE id = $2',
      [JSON.stringify({ hechas, total: tareas.length }), id]).catch(() => {});
    async function trabajador() {
      while (siguiente < tareas.length) {
        const t = tareas[siguiente++];
        conversaciones.push(await conversar(e, apiKey, sedes, t.esc, t.modelo, instrucciones));
        hechas++;
        await guardarProgreso();
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(A_LA_VEZ, tareas.length) }, trabajador));
      conversaciones.sort((a, b) => a.modelo.localeCompare(b.modelo) || a.escenario - b.escenario);
      const resultado = { conversaciones, resumen: resumir(conversaciones) };
      await client.query("UPDATE conocimiento_simulaciones SET estado = 'lista', resultado = $1, progreso = $2, terminado = NOW() WHERE id = $3",
        [JSON.stringify(resultado), JSON.stringify({ hechas, total: tareas.length }), id]);
    } catch (err) {
      await client.query("UPDATE conocimiento_simulaciones SET estado = 'error', resultado = $1, terminado = NOW() WHERE id = $2",
        [JSON.stringify({ error: err.message, conversaciones }), id]).catch(() => {});
    } finally { enCurso.delete(e.id); }
  }

  async function manejar(req, res, url, u, { json, leerCuerpo }) {
    const p = new URL(req.url, 'http://localhost').searchParams;
    if (req.method === 'GET' && url === '/api/oficina/conocimiento/simulaciones') {
      const e = await empresa(p.get('empresa_id'));
      const lista = (await client.query(`SELECT id, creado, autor, estado, ajustes, progreso, terminado,
          CASE WHEN estado = 'lista' THEN resultado->'resumen' ELSE NULL END AS resumen
        FROM conocimiento_simulaciones WHERE empresa_id = $1 ORDER BY id DESC LIMIT 15`, [e.id])).rows;
      return json(res, 200, { simulaciones: lista, prompt: PROMPT_VENDEDOR, modelos: MODELOS, escenarios: ESCENARIOS, sedes: sedesDe(e), maxTurnos: MAX_TURNOS });
    }
    if (req.method === 'GET' && url === '/api/oficina/conocimiento/simulacion') {
      const s = (await client.query('SELECT * FROM conocimiento_simulaciones WHERE id = $1', [Number(p.get('id'))])).rows[0];
      if (!s) return json(res, 404, { error: 'No existe esa simulación.' });
      return json(res, 200, s);
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/simular') {
      const f = await leerCuerpo(req);
      const e = await empresa(f.empresa_id);
      if (enCurso.has(e.id)) return json(res, 409, { error: 'Ya hay una simulación corriendo para esta empresa.' });
      const fila = (await client.query('SELECT * FROM empresas WHERE id = $1', [e.id])).rows[0];
      const apiKey = claveIA ? claveIA(fila) : '';
      if (!apiKey) return json(res, 400, { error: 'Esta empresa no tiene clave de IA (OpenRouter).' });
      const modelos = (Array.isArray(f.modelos) ? f.modelos : []).map(m => String(m).trim()).filter(m => /^[\w.\-]+\/[\w.:\-]+$/.test(m)).slice(0, 3);
      if (!modelos.length) return json(res, 400, { error: 'Elige al menos un modelo.' });
      const ids = new Set((Array.isArray(f.escenarios) ? f.escenarios : ESCENARIOS.map(x => x.id)).map(Number));
      const escenarios = ESCENARIOS.filter(x => ids.has(x.id));
      if (!escenarios.length) return json(res, 400, { error: 'Elige al menos un cliente simulado.' });
      const instrucciones = String(f.instrucciones ?? PROMPT_VENDEDOR).trim().slice(0, 6000);
      const ajustes = { modelos, escenarios: escenarios.map(x => x.id), instrucciones, modeloCliente: MODELO_CLIENTE, maxTurnos: MAX_TURNOS };
      const id = (await client.query("INSERT INTO conocimiento_simulaciones (empresa_id, autor, ajustes, progreso) VALUES ($1, $2, $3, $4) RETURNING id",
        [e.id, u.usuario, JSON.stringify(ajustes), JSON.stringify({ hechas: 0, total: modelos.length * escenarios.length })])).rows[0].id;
      enCurso.set(e.id, id);
      await registrar(u, 'simulacion_ventas', 'empresa', e.slug, '', '', `${modelos.join(', ')} · ${escenarios.length} clientes`);
      correr(id, e, apiKey, modelos, instrucciones, escenarios); // en segundo plano
      return json(res, 200, { ok: true, id });
    }
    if (req.method === 'POST' && url === '/api/oficina/conocimiento/simulacion/usar') {
      // Pone el prompt de esa simulación (y el modelo elegido) como instrucciones generales del asistente.
      const f = await leerCuerpo(req);
      const s = (await client.query('SELECT * FROM conocimiento_simulaciones WHERE id = $1', [Number(f.id)])).rows[0];
      if (!s) throw error('No existe esa simulación.', 404);
      const modelo = String(f.modelo || '').trim();
      if (modelo && !s.ajustes.modelos.includes(modelo)) throw error('Ese modelo no estaba en la simulación.');
      const e = await empresa(s.empresa_id);
      const aj = { ...(e.conocimiento_ajustes || {}), instrucciones: s.ajustes.instrucciones };
      if (modelo) aj.modelo = modelo;
      await client.query('UPDATE empresas SET conocimiento_ajustes = $1 WHERE id = $2', [JSON.stringify(aj), e.id]);
      await registrar(u, 'simulacion_usar', 'empresa', e.slug, '', '', `simulación ${s.id}${modelo ? ' · ' + modelo : ''}`);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Ruta no encontrada' });
  }

  return { preparar, manejar, PROMPT_VENDEDOR, ESCENARIOS, MODELOS };
};
