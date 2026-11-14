// Datos que Viator (bookings@) manda en "Notes" y que la IA no siempre separa:
//   Inclusions: --- Roundtrip Transportation to your Hotel Horse-back Riding Use of Buggies Zip Line Quick Jump ---
//   Questions and answers: --- Date of Birth : 2000-11-14, 1998-10-12 --- Booking languages: --- GUIDE : English  Viator amount: USD 154.4
// En parques como La Hacienda, las "Inclusions" son las actividades que el cliente compró: hay que verlas en la reserva.
// El correo se guarda en una sola línea, así que las actividades se separan reconociendo sus nombres.

// SQL para traer solo esos trozos (sin cargar el correo completo).
const ES_VIATOR = "(strpos(c.cuerpo, 'nclusions') > 0 OR strpos(c.cuerpo, 'Viator amount') > 0)";
const SQL = [
  `substr(substring(c.cuerpo from '(?i)inclusions\\s*:(.*)$'), 1, 1200) AS viator_incluye`,
  `(regexp_match(c.cuerpo, 'GUIDE\\s*:\\s*([A-Za-zÀ-ÿ]+)', 'i'))[1] AS viator_guia`,
  `(regexp_match(c.cuerpo, 'Viator amount\\s*:?\\s*(USD|US\\$|\\$)?\\s*([0-9][0-9.,]*)', 'i'))[2] AS viator_monto`,
  `(regexp_match(c.cuerpo, 'Date of Birth\\s*:\\s*([0-9][0-9 ,/-]{7,120})', 'i'))[1] AS viator_nacimientos`
].map(x => x.replace(/^(.*) AS (\w+)$/, `CASE WHEN ${ES_VIATOR} THEN $1 END AS $2`)).join(',\n  ');

// Nombre en inglés (como lo escribe Viator) → como lo leen el asesor y el chofer.
const ACTIVIDADES = [
  [/round\s*-?\s*trip transportation( to (your|the) hotel)?|hotel pick-?up and drop-?off|round\s*-?\s*trip transfers?/, 'Transporte ida y vuelta al hotel'],
  [/horse\s*-?\s*back riding|horse riding|horseback/, 'Paseo a caballo'],
  [/use of buggies|buggy ride|buggies|buggy/, 'Buggies'],
  [/zip\s*-?\s*lines?|ziplining/, 'Tirolesa (zip line)'],
  [/quick jump/, 'Quick Jump'],
  [/river tubing|tubing/, 'Tubing en el río'],
  [/swim(ming)? with (the )?dolphins?|dolphin encounter|dolphins?/, 'Delfines'],
  [/snorkel(l)?(ing)?/, 'Snorkel'],
  [/atv|four\s*-?\s*wheel(er)?s?|quad bikes?/, 'Four wheel (ATV)'],
  [/safari( tour)?/, 'Safari'],
  [/caves?|cenotes?/, 'Cueva'],
  [/kayak(ing)?/, 'Kayak'],
  [/paddle\s*-?\s*board(ing)?/, 'Paddle board'],
  [/rappel(l)?(ing)?/, 'Rappel'],
  [/water ?park|water slides?/, 'Parque acuático'],
  [/speed\s*-?\s*boat/, 'Lancha rápida'],
  [/catamaran( cruise)?/, 'Catamarán'],
  [/party boat/, 'Party boat'],
  [/buffet lunch|lunch/, 'Almuerzo'],
  [/open bar|alcoholic beverages|soft drinks|bottled water|drinks|beverages/, 'Bebidas'],
  [/snacks?/, 'Snacks'],
  [/entrance fees?|admission( ticket)?|entry tickets?|park entrance/, 'Entrada'],
  [/(local |professional |bilingual )?guide/, 'Guía'],
  [/insurance/, 'Seguro'],
  [/towels?/, 'Toalla'],
  [/photos?|pictures/, 'Fotos'],
  [/helmets?|safety equipment|equipment/, 'Equipo de seguridad'],
  [/segway/, 'Segway'],
  [/bikes?|bicycles?/, 'Bicicleta']
];
const RELLENO = /\b(use of|to (your|the)|and|the|with|of|for|a|an|all|included?|includes)\b/g;

function actividadesDe(texto) {
  // Solo la parte de "Inclusions" (lo que sigue es otra sección).
  const original = String(texto || '').replace(/^[\s-]+/, '').split(/\s-{2,}\s*|questions and answers|booking languages|viator amount|exclusions|additional info/i)[0].trim();
  if (!original) return { lista: [], texto: '' };
  let resto = ' ' + original.toLowerCase() + ' ';
  const hallados = [];
  for (const [re, nombre] of ACTIVIDADES) {
    const m = resto.match(new RegExp(re.source));
    if (!m) continue;
    hallados.push({ pos: m.index, nombre });
    resto = resto.slice(0, m.index) + ' '.repeat(m[0].length) + resto.slice(m.index + m[0].length);
  }
  const lista = [...new Set(hallados.sort((a, b) => a.pos - b.pos).map(h => h.nombre))];
  // Lo que no se reconoció se deja tal cual, para no perder nada.
  const sobra = resto.replace(RELLENO, ' ').replace(/[^a-záéíóúñü0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
  if (sobra.length >= 4) lista.push(sobra.replace(/\b\w/g, c => c.toUpperCase()));
  return { lista, texto: original };
}

const IDIOMAS = { english: 'Inglés', spanish: 'Español', espanol: 'Español', español: 'Español', portuguese: 'Portugués', french: 'Francés', german: 'Alemán', italian: 'Italiano', russian: 'Ruso' };

// fila: una fila con viator_incluye, viator_guia, viator_monto, viator_nacimientos (del SQL de arriba).
function detalles(fila) {
  if (!fila || !(fila.viator_incluye || fila.viator_guia || fila.viator_monto)) return null;
  const a = actividadesDe(fila.viator_incluye);
  const monto = fila.viator_monto ? Number(String(fila.viator_monto).replace(/,/g, '')) : null;
  const guia = fila.viator_guia ? (IDIOMAS[String(fila.viator_guia).toLowerCase()] || fila.viator_guia) : '';
  const nacimientos = String(fila.viator_nacimientos || '').split(/[,\s]+/).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
  return { incluye: a.lista, incluye_texto: a.texto, guia, monto: Number.isFinite(monto) ? monto : null, nacimientos };
}

module.exports = { SQL, detalles, actividadesDe };
