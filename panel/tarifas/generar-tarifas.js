// Convierte la base de conocimiento (conocimiento.json) en tarifas.json, que usa el cotizador del panel.
// Uso: node tarifas/generar-tarifas.js [ruta/a/conocimiento.json]
// Sin ruta, busca tarifas/conocimiento.json. Ninguno de los dos archivos se sube al repositorio.
const fs = require('fs');
const path = require('path');

const entrada = process.argv[2] || path.join(__dirname, 'conocimiento.json');
const salida = path.join(__dirname, 'tarifas.json');

// Zona del listado de hoteles -> zona de los tarifarios (HTL ...).
function zonaTarifa(zonaHotel) {
  const z = zonaHotel.toUpperCase();
  if (z.includes('UVERO ALTO')) return 'UVERO ALTO';
  if (z.includes('CAP CANA')) return 'CAP CANA';
  if (z.includes('PUNTA CANA')) return 'PUNTA CANA';
  if (z.includes('SANTIAGO')) return 'STGO DE LOS CABALLEROS';
  return z.replace(/\s+/g, ' ').trim();
}

// "US$ 47.20" -> 47.2, "319,00" -> 319, "no disponible" -> null
function dinero(valor) {
  const v = String(valor || '').trim();
  if (!v || /no disponible|^x$/i.test(v)) return null;
  let n = v.replace(/[^0-9.,]/g, '');
  if (!n) return null;
  if (/^\d+,\d{1,2}$/.test(n)) n = n.replace(',', '.');
  else n = n.replace(/,/g, '');
  const numero = Number(n);
  return Number.isFinite(numero) ? numero : null;
}

function porcentaje(valor) {
  const m = String(valor || '').match(/[\d.]+/);
  return m ? Number(m[0]) : null;
}

// "- a: 1; b: 2" -> [{ etiqueta: 'a', valor: '1' }, ...]
function filas(contenido) {
  return contenido.split('\n')
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).split('; ').map(parte => {
      const i = parte.indexOf(': ');
      return i < 0 ? { etiqueta: '', valor: parte.trim() } : { etiqueta: parte.slice(0, i).trim(), valor: parte.slice(i + 2).trim() };
    }));
}

function nombreRuta(texto) {
  return texto.toUpperCase().replace(/\bHLT\b/g, 'HTL').replace(/\s+/g, ' ').trim();
}

function partirRuta(texto) {
  const [origen, destino] = nombreRuta(texto).split(' - ');
  return { origen: (origen || '').trim(), destino: (destino || '').trim() };
}

const base = JSON.parse(fs.readFileSync(entrada, 'utf8'));
const tarifas = {
  generado: new Date().toISOString(),
  fuente: path.basename(entrada),
  rd: { traslados: [], luxury: [], hoteles: [], actividades: {}, agregados: [] },
  orlando: { traslados: [], opcionales: [] },
  avisos: []
};

for (const hoja of base) {
  const titulo = hoja.titulo || '';

  if (titulo === 'Traslados Punta Cana · Tarifa') {
    // Algunas cabeceras del Excel salieron mezcladas: los valores se leen por posición.
    for (const f of filas(hoja.contenido)) {
      if (f.length < 7) continue;
      const [adulto, nino, p1, p7, p22, p34] = f.slice(1, 7).map(x => dinero(x.valor));
      tarifas.rd.traslados.push({ ...partirRuta(f[0].valor), adulto, nino, privado: [
        { min: 1, max: 6, precio: p1 }, { min: 7, max: 21, precio: p7 },
        { min: 22, max: 33, precio: p22 }, { min: 34, max: 54, precio: p34 }
      ] });
    }
    tarifas.avisos.push('En "Traslados Punta Cana · Tarifa" se perdieron las rutas que quedaron como cabecera al exportar el Excel (por ejemplo PUJ - HTL CABARETE y las salidas desde el aeropuerto de Puerto Plata, POP).');
  }

  if (titulo === 'Traslados Punta Cana · Luxury') {
    for (const f of filas(hoja.contenido)) {
      if (f.length < 3) continue;
      tarifas.rd.luxury.push({ ...partirRuta(f[0].valor), privado: [
        { min: 1, max: 5, precio: dinero(f[1].valor) }, { min: 6, max: 15, precio: dinero(f[2].valor) }
      ] });
    }
  }

  if (titulo === 'Traslados Punta Cana · Hotel') {
    for (const linea of hoja.contenido.split('\n')) {
      const [hotel, zona] = linea.split(' | ').map(x => (x || '').trim());
      if (!hotel || !zona || hotel === 'HOTEL') continue;
      tarifas.rd.hoteles.push({ hotel: hotel.toUpperCase(), zona: zonaTarifa(zona), zonaOriginal: zona });
    }
  }

  if (titulo === 'Traslados Punta Cana · Agregados') {
    for (const linea of hoja.contenido.split('\n')) {
      const [servicio, costo] = linea.split(' | ').map(x => (x || '').trim());
      if (!servicio || servicio === 'SERVICIO' || dinero(costo) === null) continue;
      tarifas.rd.agregados.push({ servicio, precio: dinero(costo) });
    }
  }

  const actividad = titulo.match(/^Actividades con salida desde (.+)$/);
  if (actividad) {
    tarifas.rd.actividades[actividad[1]] = filas(hoja.contenido).map(f => {
      const c = Object.fromEntries(f.map(x => [x.etiqueta, x.valor]));
      return {
        producto: c['Producto'] || '', tipo: c['Tipo'] || '',
        dias: c['Días De Operación'] || '', duracion: c['Duración'] || '',
        pvpAdulto: dinero(c['Pvp Adulto']), comAdulto: porcentaje(c['Com Adulto']), netAdulto: dinero(c['Net Adulto']),
        pvpMenor: dinero(c['Pvp Menor']), comMenor: porcentaje(c['Com Menor']), netMenor: dinero(c['Net Menor'])
      };
    }).filter(a => a.producto);
  }

  if (titulo === 'Orlando · Traslados') {
    for (const f of filas(hoja.contenido)) {
      const c = Object.fromEntries(f.map(x => [x.etiqueta, x.valor]));
      const vehiculos = new Map();
      for (const { etiqueta, valor } of f) {
        const m = etiqueta.match(/Somos Viaje (\w+) · (\d+) - (\d+) Pax · (One Way|Round-Tr\w*)/i);
        if (!m) continue;
        const v = vehiculos.get(m[1]) || { vehiculo: m[1], min: Number(m[2]), max: Number(m[3]), ida: null, idaYVuelta: null };
        if (/one way/i.test(m[4])) v.ida = dinero(valor); else v.idaYVuelta = dinero(valor);
        vehiculos.set(m[1], v);
      }
      tarifas.orlando.traslados.push({
        origen: nombreRuta(c['Origen'] || ''), destino: nombreRuta(c['Destino'] || ''),
        vehiculos: [...vehiculos.values()].sort((a, b) => a.max - b.max)
      });
    }
  }

  if (titulo === 'Orlando · Servicios Opcionales') {
    for (const f of filas(hoja.contenido)) {
      const c = Object.fromEntries(f.map(x => [x.etiqueta, x.valor]));
      tarifas.orlando.opcionales.push({ nombre: c['Nombre'] || '', tipo: c['Tipo De Servicio'] || '', precio: dinero(c['Precio']) });
    }
  }

  if (/Park Tickets|Guía De Referencia/.test(titulo) && !filas(hoja.contenido).length) {
    tarifas.avisos.push(`La hoja "${titulo}" llegó vacía en la base de conocimiento.`);
  }
}

fs.writeFileSync(salida, JSON.stringify(tarifas, null, 1));
console.log(`Listo: ${salida}`);
console.log(`  Punta Cana: ${tarifas.rd.traslados.length} rutas, ${tarifas.rd.luxury.length} rutas luxury, ${tarifas.rd.hoteles.length} hoteles, ` +
  `${Object.values(tarifas.rd.actividades).reduce((n, a) => n + a.length, 0)} actividades en ${Object.keys(tarifas.rd.actividades).length} zonas`);
console.log(`  Orlando: ${tarifas.orlando.traslados.length} rutas, ${tarifas.orlando.opcionales.length} servicios opcionales`);
for (const a of tarifas.avisos) console.log(`  Aviso: ${a}`);
