// Importador de los Excel de Somos Viaje → Operaciones.
// Reconoce solo cada formato por sus columnas:
//   • Traslados por mercado (hoja TARIFA/RATES: RUTA | ADULTOS | MENORES | P1_6 | P7_21 | P22_33 | P34_54,
//     LUXURY: TRAYECTO | P1_5 | P6_15, AGREGADOS/UPGRADE: SERVICIO | COSTO, HOTEL: HOTEL | ZONA).
//   • Actividades por zona de origen (PRODUCTO | TIPO | ... | PVP / NET ADULTO | PVP / NET MENOR).
//   • Actividades Hotelbeds (Destino | Nombre del servicio | Modalidad | ... | Neta Adulto | Neta Menor).
// Cada archivo crea (o reemplaza) su propio tarifario: así se puede volver a subir cuando cambien los precios.
const { leerExcel } = require('./lector-xlsx');

const sinTildes = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = s => sinTildes(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const num = v => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };

// Zonas con el mismo nombre en hoteles, rutas y tiempos de viaje.
const ZONAS = [
  [/uvero alto/, 'Uvero Alto'], [/cap cana/, 'Cap Cana'], [/puerto de la romana|\blrm\b/, 'Puerto La Romana'], [/la romana/, 'La Romana'],
  [/bayahibe|bayahibe/, 'Bayahíbe'], [/juan dolio/, 'Juan Dolio'], [/boca chica/, 'Boca Chica'], [/santo domingo/, 'Santo Domingo'],
  [/samana/, 'Samaná'], [/santiago|stgo/, 'Santiago'], [/puerto plata/, 'Puerto Plata'], [/cabarete/, 'Cabarete'], [/miches/, 'Miches'],
  [/bavaro|arena gorda|cabeza de toro|punta cana|macao/, 'Punta Cana']
];
// Solo si el texto nombra una zona conocida (para hoteles que no están en la lista).
function zonaConocida(texto) { const n = norm(texto); for (const [re, z] of ZONAS) if (re.test(n)) return z; return ''; }
function zonaCanonica(texto) {
  const n = norm(texto);
  for (const [re, z] of ZONAS) if (re.test(n)) return z;
  return texto ? String(texto).trim().replace(/^ht[le]\s+/i, '') : '';
}
const AEROPUERTOS = { puj: 'PUJ', sdq: 'SDQ', pop: 'POP', lrm: 'LRM', lrn: 'LRM', sti: 'STI', azs: 'AZS' };
// "PUNTA CANA AIRPORT (PUJ)" → { aeropuerto: 'PUJ' }; "HTL UVERO ALTO" → { zona: 'Uvero Alto' }
function punto(texto) {
  const t = String(texto || '').trim();
  const cod = (t.match(/\(([A-Z]{3})\)/) || [])[1];
  if (/airport|aeropuerto|apto/i.test(t) && cod) return { aeropuerto: AEROPUERTOS[cod.toLowerCase()] || cod };
  if (/puerto de la romana/i.test(t)) return { aeropuerto: 'LRM', zona: 'Puerto La Romana' };
  return { zona: zonaCanonica(t) };
}
// Mercado y tipo de agencia a partir del nombre del archivo.
function mercadoDe(archivo) {
  const n = norm(archivo);
  const tipo = /mayorista/.test(n) ? 'mayorista' : /minorista/.test(n) ? 'minorista' : '';
  const PAISES = [['brazil', 'Brasil'], ['brasil', 'Brasil'], ['colombia', 'Colombia'], ['costa rica', 'Costa Rica, Guatemala'], ['ecuador', 'Ecuador'], ['paraguay', 'Paraguay'],
    ['peru', 'Perú'], ['uruguay', 'Uruguay'], ['argentina', 'Argentina'], ['chile', 'Chile'], ['mexico', 'México'], ['panama', 'Panamá'], ['venezuela', 'Venezuela'], ['bolivia', 'Bolivia']];
  const p = PAISES.find(([k]) => n.includes(k));
  return { mercado: p ? p[1] : '', tipo };
}
const titulo = s => String(s || '').toLowerCase().replace(/(^|\s|-|\()\S/g, c => c.toUpperCase());

module.exports = function crearImportador({ client }) {
  // Filas de una hoja como arrays de valores (columna 1 = índice 0).
  const valores = fila => { const max = Math.max(0, ...Object.keys(fila).map(Number)); return Array.from({ length: max }, (_, i) => fila[i + 1] ? fila[i + 1].v : ''); };
  const hojaDatos = h => h.filas.map(valores).filter(f => f.some(v => v !== '' && v !== null && v !== undefined));
  // Busca la fila de encabezado que tenga todas estas palabras.
  function encabezado(filas, palabras) {
    for (let i = 0; i < Math.min(filas.length, 15); i++) {
      const n = filas[i].map(norm);
      if (palabras.every(p => n.some(c => c === p || c.startsWith(p)))) return { i, cols: n };
    }
    return null;
  }

  async function tarifario(nombre, { tipo = 'venta', mercado = '', tipo_agencia = '', agencia = '', notas = '' }) {
    let agenciaId = null;
    if (agencia) {
      const a = (await client.query('SELECT id FROM op_agencias WHERE lower(nombre) = lower($1) LIMIT 1', [agencia])).rows[0];
      agenciaId = a ? a.id : (await client.query("INSERT INTO op_agencias (nombre, modalidad) VALUES ($1, '') RETURNING id", [agencia])).rows[0].id;
    }
    const t = (await client.query('SELECT id FROM op_tarifarios WHERE nombre = $1 LIMIT 1', [nombre])).rows[0];
    if (t) {
      await client.query('UPDATE op_tarifarios SET tipo = $1, mercado = $2, tipo_agencia = $3, agencia_id = $4, notas = $5, activo = TRUE WHERE id = $6', [tipo, mercado, tipo_agencia, agenciaId, notas, t.id]);
      await client.query('DELETE FROM op_tarifas WHERE tarifario_id = $1', [t.id]);
      return t.id;
    }
    return (await client.query('INSERT INTO op_tarifarios (nombre, tipo, mercado, tipo_agencia, agencia_id, notas) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [nombre, tipo, mercado, tipo_agencia, agenciaId, notas])).rows[0].id;
  }
  const tarifa = (id, d) => client.query(`INSERT INTO op_tarifas (tarifario_id, servicio, nombre, aeropuerto, zona, origen, modalidad, cobro, pax_desde, pax_hasta, precio_vehiculo, precio_adulto, precio_nino, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [id, d.servicio, d.nombre || '', d.aeropuerto || '', d.zona || '', d.origen || '', d.modalidad || '', d.cobro || 'vehiculo',
    d.pax_desde || 1, d.pax_hasta || 99, d.precio_vehiculo || 0, d.precio_adulto || 0, d.precio_nino || 0, d.notas || '']);

  // ---------- Traslados por mercado ----------
  async function traslados(archivo, hojas) {
    const { mercado, tipo } = mercadoDe(archivo);
    const nombre = `Traslados ${mercado || titulo(archivo.replace(/\.xlsx$/i, ''))}${tipo ? ' · ' + tipo + 's' : ''}`;
    const id = await tarifario(nombre, { mercado, tipo_agencia: tipo, notas: `Importado de ${archivo}` });
    const r = { tarifario: nombre, mercado, tipo, tarifas: 0, hoteles: 0, agregados: 0 };
    for (const h of hojas) {
      const filas = hojaDatos(h);
      const ruta = encabezado(filas, ['ruta']) || encabezado(filas, ['trayecto']) || encabezado(filas, ['route']);
      // Tarifa regular (por persona, In/Out) y privada por ruta (por vehículo, según pax).
      if (ruta && filas[ruta.i].map(norm).some(c => /^p\d+ \d+$/.test(c))) {
        const cols = filas[ruta.i].map(norm);
        const iAd = cols.findIndex(c => c.startsWith('adult')), iMe = cols.findIndex(c => c.startsWith('menor') || c.startsWith('child') || c.startsWith('nino'));
        const rangos = cols.map((c, i) => { const m = c.match(/^p(\d+) (\d+)$/); return m ? { i, desde: Number(m[1]), hasta: Number(m[2]) } : null; }).filter(Boolean);
        const lujo = norm(h.nombre).includes('luxury') || iAd < 0;
        for (const f of filas.slice(ruta.i + 1)) {
          const partes = String(f[Math.max(0, ruta.cols.findIndex(c => c === 'ruta' || c === 'trayecto' || c === 'route'))] || '').split(/\s+-\s+/);
          if (partes.length < 2) continue;
          const a = punto(partes[0]), b = punto(partes.slice(1).join(' - '));
          const base = a.aeropuerto ? { servicio: 'TRASLADO', aeropuerto: a.aeropuerto, zona: b.zona } : b.aeropuerto && !b.zona ? { servicio: 'TRASLADO', aeropuerto: b.aeropuerto, zona: a.zona } : { servicio: 'INTERHOTEL', origen: a.zona, zona: b.zona };
          if (a.aeropuerto && b.aeropuerto) Object.assign(base, { zona: b.zona || b.aeropuerto });
          const notas = String(f[0]).replace(/\s+/g, ' ').trim();
          if (!lujo && iAd >= 0 && num(f[iAd]) > 0 && base.servicio === 'TRASLADO') {
            await tarifa(id, { ...base, servicio: 'INOUT', modalidad: 'compartido', cobro: 'persona', precio_adulto: num(f[iAd]), precio_nino: iMe >= 0 ? num(f[iMe]) : 0, notas: 'Regular In/Out · ' + notas }); r.tarifas++;
          }
          for (const g of rangos) if (num(f[g.i]) > 0) {
            await tarifa(id, { ...base, modalidad: lujo ? 'luxury' : 'privado', cobro: 'vehiculo', pax_desde: g.desde, pax_hasta: g.hasta, precio_vehiculo: num(f[g.i]), notas: (lujo ? 'Luxury · ' : 'Privado · ') + notas }); r.tarifas++;
          }
        }
        continue;
      }
      // Agregados → cortesías con costo.
      const agr = encabezado(filas, ['servicio']) || encabezado(filas, ['service']);
      if (agr && filas[agr.i].map(norm).some(c => c.startsWith('cost') || c.startsWith('precio') || c.startsWith('price'))) {
        const iP = filas[agr.i].map(norm).findIndex(c => c.startsWith('cost') || c.startsWith('precio') || c.startsWith('price'));
        for (const f of filas.slice(agr.i + 1)) {
          const nom = String(f[agr.cols.findIndex(c => c === 'servicio' || c === 'service')] || '').trim();
          if (!nom || !num(f[iP])) continue;
          const ya = (await client.query('SELECT id FROM op_cortesias WHERE lower(nombre) = lower($1)', [titulo(nom)])).rows[0];
          if (ya) await client.query('UPDATE op_cortesias SET precio = $1, cobra = TRUE, activo = TRUE WHERE id = $2', [num(f[iP]), ya.id]);
          else await client.query('INSERT INTO op_cortesias (nombre, precio, cobra, orden) VALUES ($1, $2, TRUE, 50)', [titulo(nom), num(f[iP])]);
          r.agregados++;
        }
        continue;
      }
      // Hoteles con su zona.
      const hot = encabezado(filas, ['hotel', 'zona']) || encabezado(filas, ['hotel', 'area']);
      if (hot) {
        const iH = hot.cols.indexOf('hotel'), iZ = hot.cols.indexOf('zona') >= 0 ? hot.cols.indexOf('zona') : hot.cols.indexOf('area');
        for (const f of filas.slice(hot.i + 1)) {
          const hotel = titulo(String(f[iH] || '').trim()); if (!hotel) continue;
          await client.query('INSERT INTO op_hoteles (hotel, zona, sede) VALUES ($1, $2, $3) ON CONFLICT (hotel) DO UPDATE SET zona = EXCLUDED.zona, sede = EXCLUDED.sede', [hotel, zonaCanonica(f[iZ]), 'Punta Cana']);
          r.hoteles++;
        }
      }
    }
    return r;
  }

  // ---------- Actividades por zona de origen ----------
  async function actividades(archivo, hojas, formato) {
    const n = norm(archivo);
    const { mercado, tipo } = mercadoDe(archivo);
    const salidas = [];
    // Neto agencias trae PVP (público), COM y NET: el neto es para las agencias y el PVP para el cliente directo.
    const destinos = formato === 'neto_pvp' ? [['Actividades · neto agencias', { notas: 'Precio neto para agencias' }, 'net'], ['Actividades · precio público (directo)', { agencia: 'Directo (oficina)', notas: 'PVP para clientes directos' }, 'pvp']]
      : formato === 'costo' ? [['Actividades · lo que paga Somos Viaje (netos)', { tipo: 'costo', notas: 'Costo por proveedor y capacidad' }, 'net']]
      : formato === 'hotelbeds' ? [['Actividades · Hotelbeds', { agencia: 'Hotelbeds', notas: 'Netas Hotelbeds' }, 'net']]
      : /live aqua/.test(n) ? [['Actividades · Live Aqua', { agencia: 'Live Aqua', notas: 'Tarifas Live Aqua' }, 'pvp']]
      : [[`Actividades ${mercado || titulo(archivo.replace(/\.xlsx$/i, ''))}${tipo ? ' · ' + tipo + 's' : ''}`, { mercado, tipo_agencia: tipo }, 'pvp']];
    for (const [nombre, opc, cual] of destinos) {
      const id = await tarifario(nombre, { ...opc, notas: (opc.notas ? opc.notas + ' · ' : '') + `Importado de ${archivo}` });
      let total = 0;
      for (const h of hojas) {
        const filas = hojaDatos(h);
        const cab = encabezado(filas, ['producto']) || encabezado(filas, ['nombre del servicio']);
        if (!cab) continue;
        const c = cab.cols, idx = p => c.findIndex(x => x.startsWith(p));
        const iProd = idx('producto') >= 0 ? idx('producto') : idx('nombre del servicio'), iTipo = idx('tipo') >= 0 ? idx('tipo') : idx('modalidad');
        const iDest = idx('destino');
        const iAd = cual === 'pvp' ? (idx('pvp adulto') >= 0 ? idx('pvp adulto') : idx('adulto')) : (idx('net adulto') >= 0 ? idx('net adulto') : idx('neta adulto'));
        const iMe = cual === 'pvp' ? (idx('pvp menor') >= 0 ? idx('pvp menor') : idx('menor')) : (idx('net menor') >= 0 ? idx('net menor') : idx('neta menor'));
        if (iAd < 0) continue;
        // Zona de origen: de la fila "ZONAS DE ORIGEN: X", o del nombre de la hoja.
        let zonas = norm(h.nombre).includes('sheet') ? [''] : String(h.nombre).split(/\s+-\s+/).map(zonaCanonica);
        let producto = '';
        for (const f of filas.slice(cab.i + 1)) {
          const textoFila = f.map(v => String(v ?? '')).join(' ');
          const zo = textoFila.match(/zonas? de origen:\s*(.+)/i);
          if (zo) { zonas = [...new Set(zo[1].split(/\s+-\s+/).map(zonaCanonica))]; continue; }
          if (f[iProd]) producto = String(f[iProd]).replace(/\s+/g, ' ').trim();
          if (!producto || /no incluye|cotizar/i.test(producto)) continue;
          const ad = num(f[iAd]), me = iMe >= 0 ? num(f[iMe]) : 0;
          if (!ad && !me) continue;
          const variante = iTipo >= 0 && f[iTipo] ? String(f[iTipo]).trim() : '';
          const zonaFila = iDest >= 0 && f[iDest] ? [zonaCanonica(f[iDest])] : zonas;
          for (const z of zonaFila) {
            await tarifa(id, { servicio: 'ACTIVIDAD', nombre: [producto, variante].filter(Boolean).join(' · '), zona: z, cobro: 'persona', precio_adulto: ad, precio_nino: me, notas: h.nombre });
            total++;
          }
        }
      }
      salidas.push({ tarifario: nombre, tarifas: total });
    }
    return { actividades: salidas };
  }

  // Reconoce el formato y lo importa.
  // Cabecera de traslados: una fila con ADULTOS y con TRAYECTO o RUTA (en las primeras 15 filas).
  function cabTraslado(filas) {
    for (let i = 0; i < Math.min(filas.length, 15); i++) {
      const n = filas[i].map(norm);
      if (n.some(c => c.startsWith('adult')) && n.some(c => c === 'trayecto' || c === 'ruta' || c.startsWith('trayecto'))) return { i, cols: n };
    }
    return null;
  }
  // Precio en el formato del Excel: 359,00 · 1.250,00 · 45 · X (no disponible) → número o null.
  const precioTxt = v => {
    if (v === null || v === undefined) return null;
    let t = String(v).trim();
    if (!t || /^x$/i.test(t) || t === '-') return null;
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
    const n = Number(t.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // Tarifario de traslados (hoja TARIFA): TRAYECTO | ADULTOS | CHILDS | rangos de vehículo privado (1-6, 7-21, ...).
  // Tarifa regular: precio por persona, igual en ida y vuelta. Tarifa privada: precio por vehículo y rango de pasajeros.
  async function traslados(archivo, hojas) {
    const hoja = hojas.find(h => cabTraslado(hojaDatos(h)));
    if (!hoja) return { error: 'No encontré la hoja de traslados (TRAYECTO / ADULTOS).' };
    const filas = hojaDatos(hoja);
    const cab = cabTraslado(filas);
    const raw = filas[cab.i].map(v => String(v ?? '').trim());
    const iT = raw.findIndex(c => /trayecto|ruta/i.test(c));
    const iA = raw.findIndex(c => /adult/i.test(c));
    const iN = raw.findIndex(c => /child|ni[nñ]o|menor/i.test(c));
    const rangos = raw.map((c, i) => { const m = c.match(/p?(\d+)\s*[_\- ]\s*(\d+)/i); return m && i !== iT && i !== iA && i !== iN ? { i, desde: Number(m[1]), hasta: Number(m[2]) } : null; }).filter(Boolean);
    const base = archivo.split(/[\\/]/).pop().replace(/\.xlsx?$/i, '');
    const nombre = (/^traslados/i.test(base) ? base : 'Traslados ' + base) + ' · regular y privado';
    const id = await tarifario(nombre, { tipo: 'venta', notas: `Importado de ${archivo} (hoja ${hoja.nombre || 'TARIFA'})` });
    let total = 0, interhotel = 0;
    const omitidas = [];
    for (const f of filas.slice(cab.i + 1)) {
      const trayecto = String(f[iT] ?? '').trim();
      const partes = trayecto.split(/\s+-\s+/);
      if (partes.length < 2) continue;
      const origen = punto(partes[0]);
      const destino = punto(partes.slice(1).join(' - '));
      // Aeropuerto/puerto → hotel: TRASLADO (IN). Hotel → hotel: INTERHOTEL (origen = zona de salida, zona = destino).
      // Hotel → aeropuerto no aparece en este archivo; si llega, se cuenta en vez de perderse en silencio.
      let ruta;
      if (origen.aeropuerto) ruta = { servicio: 'TRASLADO', aeropuerto: origen.aeropuerto, origen: '', zona: destino.zona || destino.aeropuerto || '', nota: 'IN/OUT' };
      else if (origen.zona && destino.zona && !destino.aeropuerto) ruta = { servicio: 'INTERHOTEL', aeropuerto: '', origen: origen.zona, zona: destino.zona, nota: 'inter-hotel' };
      else { omitidas.push(trayecto); continue; }
      const adulto = precioTxt(f[iA]), nino = precioTxt(f[iN]);
      if (adulto !== null) {
        // nombre queda vacío: el motor descarta una tarifa con nombre si el servicio no tiene actividad (traslados se casan por aeropuerto/origen/zona).
        await tarifa(id, { servicio: ruta.servicio, nombre: '', aeropuerto: ruta.aeropuerto, origen: ruta.origen, zona: ruta.zona, cobro: 'persona', pax_desde: 1, pax_hasta: 99, precio_adulto: adulto, precio_nino: nino || 0, modalidad: 'compartido', notas: `Regular por persona · ${trayecto} · ${ruta.nota}` });
        total++;
        if (ruta.servicio === 'INTERHOTEL') interhotel++;
      }
      for (const g of rangos) {
        const pv = precioTxt(f[g.i]);
        if (pv === null) continue;
        await tarifa(id, { servicio: ruta.servicio, nombre: '', aeropuerto: ruta.aeropuerto, origen: ruta.origen, zona: ruta.zona, cobro: 'vehiculo', pax_desde: g.desde, pax_hasta: g.hasta, precio_vehiculo: pv, modalidad: 'privado', notas: `Privado por ruta · ${trayecto} · ${raw[g.i]}` });
        total++;
        if (ruta.servicio === 'INTERHOTEL') interhotel++;
      }
    }
    return { tarifario: nombre, tarifas: total, interhotel, omitidas: omitidas.length, omitidasEjemplos: omitidas.slice(0, 5) };
  }

  async function importar(archivo, buf) {
    const hojas = leerExcel(buf);
    const todas = hojas.map(h => ({ h, filas: hojaDatos(h) }));
    const tiene = (...p) => todas.some(({ filas }) => encabezado(filas, p));
    if (todas.some(({ filas }) => { const e = encabezado(filas, ['ruta']) || encabezado(filas, ['route']) || encabezado(filas, ['trayecto']); return e && e.cols.some(c => /^p\d+ \d+$/.test(c)); })) return { archivo, ...(await traslados(archivo, hojas)) };
    if (todas.some(({ filas }) => cabTraslado(filas))) return { archivo, ...(await traslados(archivo, hojas)) };
    if (tiene('producto', 'pvp adulto', 'net adulto')) return { archivo, ...(await actividades(archivo, hojas, 'neto_pvp')) };
    if (tiene('producto', 'net adulto')) return { archivo, ...(await actividades(archivo, hojas, 'costo')) };
    if (tiene('destino', 'nombre del servicio')) return { archivo, ...(await actividades(archivo, hojas, 'hotelbeds')) };
    if (tiene('producto', 'pvp adulto') || tiene('producto', 'adulto')) return { archivo, ...(await actividades(archivo, hojas, 'pvp')) };
    return { archivo, error: 'No reconozco el formato de este Excel (busco RUTA + P1_6, o PRODUCTO + precios de adulto).' };
  }

  return { importar, zonaCanonica, zonaConocida };
};
