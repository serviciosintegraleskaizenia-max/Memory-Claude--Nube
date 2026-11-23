// Lectura de facturas de pago que llegan por correo (categoría FACTURA).
// La IA propone los datos; nada se registra en Operaciones hasta que una persona lo confirme.
//
// Piezas (sin base de datos, para poder probarlas):
//   promptFactura(correo)      -> texto que se le manda a la IA
//   parseFactura(respuesta)    -> datos ordenados, o { error } si la respuesta no sirve
//   validarFactura(datos)      -> lista de cosas que faltan o se ven mal

const MONEDAS = ['USD', 'DOP', 'EUR', 'CAD', 'MXN'];
const SEDES = ['Punta Cana', 'Orlando'];

function promptFactura(correo) {
  const asunto = String(correo.subject || '').slice(0, 300);
  const remitente = String(correo.from || '').slice(0, 200);
  const texto = String(correo.textPlain || '').replace(/\s+/g, ' ').slice(0, 9000);
  return `Este correo es una factura o comprobante de pago de una agencia de viajes a Somos Viaje (Punta Cana u Orlando).
Saca los datos y responde SOLO con un objeto JSON, sin texto antes ni después, con estas claves exactas:
{
  "es_factura": true o false,
  "agencia": nombre de la agencia que paga (texto),
  "monto": número con el total que paga (sin símbolo),
  "moneda": "USD", "DOP", "EUR", "CAD" o "MXN",
  "referencia": número de factura, comprobante o transferencia (texto),
  "reservas": lista de números de reserva o proforma que se pagan (solo números, puede estar vacía),
  "paquete": nombre del paquete o servicio principal (ej. "Orlando", "Saona", "Traslado"), o "",
  "tipo_reserva": "Paquete", "Tour", "Traslado", "Hotel" u "Otro",
  "sede": "Punta Cana" u "Orlando", o "" si no se sabe,
  "fecha_pago": "AAAA-MM-DD" o "",
  "notas": algo importante que no cupo arriba (texto corto),
  "confianza": "alta", "media" o "baja"
}
Si un dato no aparece en el correo, pon "" o [] o 0. No inventes números de reserva ni montos.

Asunto: ${asunto}
De: ${remitente}
Correo:
${texto}`;
}

// La IA a veces responde con ```json ... ``` o con texto alrededor. Sacamos el objeto y lo validamos.
function parseFactura(respuesta) {
  const texto = String(respuesta || '').trim();
  const ini = texto.indexOf('{'), fin = texto.lastIndexOf('}');
  if (ini < 0 || fin <= ini) return { error: 'La IA no devolvió un objeto de datos.' };
  let d;
  try { d = JSON.parse(texto.slice(ini, fin + 1)); }
  catch (e) { return { error: 'La respuesta de la IA no es JSON válido.' }; }
  // Acepta "1,250.50" (miles con coma), "1.250,50" (miles con punto) y "250,50" (decimal con coma).
  const num = v => {
    let t = String(v ?? '').replace(/[^\d.,-]/g, '');
    if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    else if (t.includes(',')) t = t.replace(',', '.');
    const n = Number(t);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const txt = (v, max) => String(v ?? '').trim().slice(0, max);
  const fecha = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const reservas = (Array.isArray(d.reservas) ? d.reservas : String(d.reservas || '').split(/[,;\s]+/))
    .map(x => String(x).replace(/\D/g, '')).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 30);
  const moneda = txt(d.moneda, 5).toUpperCase();
  const sede = SEDES.includes(txt(d.sede, 30)) ? txt(d.sede, 30) : '';
  const confianza = ['alta', 'media', 'baja'].includes(txt(d.confianza, 10)) ? txt(d.confianza, 10) : 'baja';
  return {
    es_factura: d.es_factura === true,
    agencia: txt(d.agencia, 120),
    monto: num(d.monto),
    moneda: MONEDAS.includes(moneda) ? moneda : (moneda || ''),
    referencia: txt(d.referencia, 80),
    reservas,
    paquete: txt(d.paquete, 120),
    tipo_reserva: txt(d.tipo_reserva, 30) || 'Otro',
    sede,
    fecha_pago: fecha(d.fecha_pago),
    notas: txt(d.notas, 300),
    confianza
  };
}

// Lo que falta o se ve raro. Una factura con problemas graves no se propone para registrar.
function validarFactura(f) {
  const problemas = [];
  const bloqueos = [];
  if (!f.es_factura) { bloqueos.push('no es factura'); problemas.push('La IA no la reconoce como factura de pago.'); }
  if (!f.agencia) { bloqueos.push('sin agencia'); problemas.push('No se encontró la agencia que paga.'); }
  if (!(f.monto > 0)) { bloqueos.push('sin monto'); problemas.push('No se encontró el monto.'); }
  if (!f.moneda) problemas.push('No se encontró la moneda.');
  else if (!MONEDAS.includes(f.moneda)) problemas.push(`Moneda no reconocida: ${f.moneda}.`);
  if (!f.reservas.length) problemas.push('No aparece ningún número de reserva o proforma: hay que elegir la reserva a mano.');
  if (f.confianza === 'baja') problemas.push('La IA tiene poca seguridad: revísala con calma.');
  return { problemas, listaParaRegistrar: bloqueos.length === 0 && f.reservas.length > 0 };
}

module.exports = { promptFactura, parseFactura, validarFactura, MONEDAS, SEDES };
