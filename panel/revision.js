// Revisión automática de reservas: marca lo que una asesora apurada puede no ver.
// No usa IA (es gratis e instantánea) y solo AVISA: no cambia estados ni datos.
//
// Revisa: datos que faltan, PAX que no cuadran con el asunto, aeropuerto lejos del hotel,
// fechas que ya pasaron o salida antes que llegada, posible duplicado y servicio urgente (< 48 h).

const ABIERTOS = ['pendiente de transcribir', 'revisar', 'actualizada'];

function normal(t) {
  return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Zonas de República Dominicana y los aeropuertos que tienen sentido para cada una.
const ZONAS = [
  { zona: 'Punta Cana', aeropuertos: ['PUJ'], claves: ['punta cana', 'bavaro', 'cap cana', 'uvero alto', 'macao', 'arena gorda', 'cabeza de toro', 'cortecito', 'los corales', 'playa blanca', ' puj'] },
  { zona: 'Santo Domingo', aeropuertos: ['SDQ', 'JBQ'], claves: ['santo domingo', 'boca chica', 'juan dolio', 'zona colonial', 'piantini', 'malecon', ' sdq'] },
  { zona: 'Puerto Plata', aeropuertos: ['POP', 'STI'], claves: ['puerto plata', 'sosua', 'cabarete', 'playa dorada', 'costa dorada', 'cofresi', 'maimon', 'luperon', ' pop'] },
  { zona: 'La Romana / Bayahíbe', aeropuertos: ['LRM', 'PUJ', 'SDQ'], claves: ['la romana', 'bayahibe', 'dominicus', 'casa de campo'] },
  { zona: 'Samaná', aeropuertos: ['AZS', 'SDQ', 'PUJ'], claves: ['samana', 'las terrenas', 'las galeras', 'el portillo'] }
];

function zonaDe(...textos) {
  const t = ' ' + normal(textos.filter(Boolean).join(' ')) + ' ';
  for (const z of ZONAS) if (z.claves.some(k => t.includes(k))) return z;
  return null;
}

// PAX que dice el asunto: "X 2", "X2", "PAX MEDINA X 09", "2 ADL + 1 INF".
function paxDelAsunto(asunto) {
  const a = normal(asunto);
  const parte = (re) => { const m = a.match(re); return m ? Number(m[1]) : null; };
  const adl = parte(/(\d{1,2})\s*(?:adl|adt|adult|adultos?|pax adultos?)\b/);
  const chd = parte(/(\d{1,2})\s*(?:chd|ninos?|menores?|child)\b/);
  const inf = parte(/(\d{1,2})\s*(?:inf|infantes?|bebes?)\b/);
  if (adl !== null || chd !== null || inf !== null) return { detalle: true, adultos: adl, ninos: chd, infantes: inf };
  const x = a.match(/\bx\s*0?(\d{1,2})\b/);
  return x ? { detalle: false, total: Number(x[1]) } : null;
}

const esTraslado = f => /traslad|transfer|shuttle|aeropuerto|airport|llegada|salida|in\/out|in-out/.test(normal([f.tipo_servicio, f.actividad, f.punto_partida, f.punto_llegada].join(' '))) || Boolean(f.aeropuerto);
const esLlegada = f => /llegada|arrival|\bin\b|entrada/.test(normal(f.actividad + ' ' + f.tipo_servicio)) || /aeropuerto|airport/.test(normal(f.punto_partida));
const esSalida = f => /salida|departure|\bout\b|regreso/.test(normal(f.actividad + ' ' + f.tipo_servicio)) || /aeropuerto|airport/.test(normal(f.punto_llegada));
const fechaCorta = iso => (iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '');

// filas: las filas de clasificacion (una por servicio). isoDe(fila) da la fecha del servicio AAAA-MM-DD.
// claveDe(fila) agrupa los servicios del mismo correo. hoy: AAAA-MM-DD en hora de la oficina.
function revisarReservas(filas, { isoDe, claveDe, hoy }) {
  const resultado = new Map();
  const hoyMs = Date.parse(hoy + 'T00:00:00Z');
  const porCorreo = new Map();
  for (const f of filas) {
    if (!['RESERVA', 'MODIFICACION'].includes(f.categoria) || f.error_ia) continue;
    const k = claveDe(f);
    if (!porCorreo.has(k)) porCorreo.set(k, []);
    porCorreo.get(k).push(f);
  }
  // Para duplicados: cliente + fecha en reservas de otros correos.
  const vistos = new Map();
  for (const [k, lista] of porCorreo) {
    for (const f of lista) {
      const nombre = normal(f.nombre_cliente);
      const iso = isoDe(f);
      if (f.categoria !== 'RESERVA' || nombre.length < 5 || !iso) continue;
      const llave = nombre + '|' + iso;
      if (!vistos.has(llave)) vistos.set(llave, []);
      if (!vistos.get(llave).some(x => x.k === k)) vistos.get(llave).push({ k, id: f.id });
    }
  }

  for (const [k, lista] of porCorreo) {
    const abiertos = lista.filter(f => ABIERTOS.includes(f.estado));
    if (!abiertos.length) continue;
    const primera = lista[0];
    const delCorreo = [];

    // PAX del asunto contra los de la reserva.
    const pax = paxDelAsunto(primera.asunto);
    const ad = Number(primera.adultos) || 0, ni = Number(primera.ninos) || 0, inf = Number(primera.infantes) || 0;
    if (pax && ad + ni + inf > 0) {
      if (pax.detalle) {
        const dif = [];
        if (pax.adultos !== null && pax.adultos !== ad) dif.push(`${pax.adultos} adultos (la reserva tiene ${ad})`);
        if (pax.ninos !== null && pax.ninos !== ni) dif.push(`${pax.ninos} niños (la reserva tiene ${ni})`);
        if (pax.infantes !== null && pax.infantes !== inf) dif.push(`${pax.infantes} infantes (la reserva tiene ${inf})`);
        if (dif.length) delCorreo.push({ tipo: 'pax', texto: 'El asunto dice ' + dif.join(', ') + '.' });
      } else if (pax.total !== ad + ni + inf) {
        delCorreo.push({ tipo: 'pax', texto: `El asunto dice X ${pax.total} pero la reserva tiene ${ad + ni + inf} pasajero(s).` });
      }
    }

    // Llegada después de la salida.
    const llegadas = lista.filter(esLlegada).map(isoDe).filter(Boolean).sort();
    const salidas = lista.filter(f => esSalida(f) && !esLlegada(f)).map(isoDe).filter(Boolean).sort();
    if (llegadas.length && salidas.length && salidas[salidas.length - 1] < llegadas[0]) {
      delCorreo.push({ tipo: 'fechas', texto: `La salida (${fechaCorta(salidas[salidas.length - 1])}) es antes que la llegada (${fechaCorta(llegadas[0])}).` });
    }

    for (const f of lista) {
      const puntos = [...delCorreo];
      if (!ABIERTOS.includes(f.estado)) { resultado.set(f.id, { puntos: [], urgente: false }); continue; }
      const iso = isoDe(f);
      const traslado = esTraslado(f);
      if (!iso) puntos.push({ tipo: 'falta', texto: 'Falta la fecha del servicio.' });
      if (traslado && !String(f.vuelo || '').trim()) puntos.push({ tipo: 'falta', texto: 'Falta el número de vuelo.' });
      if (traslado && !String(f.hora_servicio || '').trim()) puntos.push({ tipo: 'falta', texto: 'Falta la hora (del vuelo o de recogida).' });
      if (!f.hotel && !f.punto_llegada && !f.punto_partida) puntos.push({ tipo: 'falta', texto: 'Falta el hotel o el lugar del servicio.' });
      if (ad + ni + inf === 0) puntos.push({ tipo: 'falta', texto: 'Falta la cantidad de pasajeros.' });
      if (!String(f.telefono || '').trim()) puntos.push({ tipo: 'falta', texto: 'Falta el teléfono del pasajero.' });

      // Aeropuerto que no corresponde con la zona del hotel.
      const aeropuerto = String(f.aeropuerto || '').toUpperCase().trim();
      const zona = zonaDe(f.hotel, f.punto_llegada, f.punto_partida, primera.asunto);
      if (aeropuerto && zona && !zona.aeropuertos.includes(aeropuerto)) {
        puntos.push({ tipo: 'contradiccion', texto: `El aeropuerto es ${aeropuerto} pero el hotel parece estar en ${zona.zona} (${zona.aeropuertos[0]}). Confírmalo con la agencia.` });
      }

      let urgente = false;
      if (iso) {
        const dias = Math.round((Date.parse(iso + 'T00:00:00Z') - hoyMs) / 86400000);
        if (dias < 0) puntos.push({ tipo: 'fechas', texto: `La fecha del servicio (${fechaCorta(iso)}) ya pasó.` });
        else if (dias <= 2) urgente = true;
      }

      if (f.categoria === 'RESERVA' && iso) {
        const otros = (vistos.get(normal(f.nombre_cliente) + '|' + iso) || []).filter(x => x.k !== k);
        if (otros.length) puntos.push({ tipo: 'duplicado', texto: `Posible duplicado: el mismo cliente y la misma fecha están en la reserva #${otros.map(x => x.id).join(', #')}.` });
      }
      resultado.set(f.id, { puntos, urgente });
    }
  }
  return resultado;
}

module.exports = { revisarReservas, paxDelAsunto, zonaDe };
