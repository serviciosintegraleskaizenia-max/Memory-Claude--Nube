# Convierte el material de Somos Viaje (Excel + PDF) en una base de conocimiento por sede.
# Uso: python3 -I armar_kb.py <carpeta "Entrega sistema de IA"> <carpeta de salida>
import sys, os, re, json, subprocess, unicodedata
import openpyxl

ORIGEN, SALIDA = sys.argv[1], sys.argv[2]
DINERO = ('PVP', 'NET', 'PRECIO', 'COSTO', 'ONE WAY', 'ROUND', 'PAX', 'ADULTO', 'CHILD', 'TARIFA')
fragmentos = []  # [{sede, tipo, titulo, contenido, fuente}]


def limpio(v):
    if v is None:
        return ''
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return re.sub(r'\s+', ' ', str(v)).strip()


def formato(cab, v):
    t = limpio(v)
    if not t or t.upper() in ('N/A', 'X'):
        return 'no disponible' if t else ''
    C = cab.upper()
    if isinstance(v, (int, float)):
        if re.search(r'(^|[^A-Z])COM([^A-Z]|$)', C):
            return f'{round(v * 100, 2):g} %' if v < 1 else f'{v:g} %'
        if any(k in C for k in DINERO) and not any(k in C for k in ('DORMITORIOS', 'BAÑOS', 'OCUPACI')):
            return f'US$ {v:,.2f}'.replace('.00', '')
    return t


def leer_hoja(ws):
    filas = []
    for row in ws.iter_rows():
        celdas = {}
        for c in row:
            if c.value not in (None, ''):
                celdas[c.column] = (c.value, c.hyperlink.target if c.hyperlink else None)
        if celdas:
            filas.append(celdas)
    return filas


def es_cabecera(f):
    vals = [v for v, _ in f.values()]
    return len(vals) >= 3 and all(isinstance(v, str) for v in vals)


def hoja_a_texto(ws):
    """Devuelve líneas legibles: títulos, párrafos y una línea por fila de datos con 'Campo: valor'."""
    filas = leer_hoja(ws)
    lineas, cab, previas, arrastre = [], {}, [], {}
    for i, f in enumerate(filas):
        vals = [v for v, _ in f.values()]
        siguiente = filas[i + 1] if i + 1 < len(filas) else {}
        if len(f) == 1:
            t = limpio(vals[0])
            if len(t) > 60:
                lineas.append(t)
            elif t:
                lineas.append(f'### {t}')
            previas = []
            continue
        if es_cabecera(f) and (not cab or es_cabecera(siguiente) or not any(isinstance(v, (int, float)) for v, _ in f.values())):
            if siguiente and es_cabecera(siguiente) and len(siguiente) >= len(f) - 1:
                previas.append(f)  # cabecera de varias filas (categoría / pax / OW-RT)
                continue
            # Se arma el nombre de cada columna con las filas de cabecera de arriba (rellenando celdas combinadas).
            cab = {}
            etiquetas = sorted(f)[:2]  # las 2 primeras columnas son nombres (origen/destino, trayecto, producto…)
            for col in f:
                partes = []
                for p in ([] if col in etiquetas else previas[-2:]):
                    cols = sorted(c for c in p if c <= col)
                    if cols:
                        partes.append(limpio(p[cols[-1]][0]))
                partes.append(limpio(f[col][0]))
                cab[col] = ' · '.join(x for x in partes if x)
            previas, arrastre = [], {}
            continue
        if not cab:
            lineas.append(' | '.join(limpio(v) for v in vals))
            continue
        # Celdas combinadas hacia abajo (ej. "Buggies" vale para Individual / Doble / Familiar).
        primera = min(cab)
        if primera not in f and arrastre.get(primera):
            f = {primera: arrastre[primera], **f}
        if primera in f:
            arrastre[primera] = f[primera]
        partes = []
        for col, nombre in sorted(cab.items()):
            if col in f:
                v, enlace = f[col]
                txt = formato(nombre, v)
                if enlace:
                    txt = f'{txt} ({enlace})' if txt.lower() not in ('más detalles', 'ver aquí', 'ver aqui') else enlace
                if txt:
                    partes.append(f'{nombre.title() if nombre.isupper() else nombre}: {txt}')
        if partes:
            lineas.append('- ' + '; '.join(partes))
    return lineas


def guardar(ruta, titulo, lineas):
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    with open(ruta, 'w', encoding='utf-8') as fh:
        fh.write(f'# {titulo}\n\n' + '\n'.join(lineas) + '\n')


def sin_tildes(t):
    return ''.join(c for c in unicodedata.normalize('NFD', t) if unicodedata.category(c) != 'Mn')


def slug(t):
    return re.sub(r'[^a-z0-9]+', '-', sin_tildes(t).lower()).strip('-')


# ---------- Excel ----------
LIBROS = [
    ('orlando', 'SOMOS VIAJE ORLANDO 2026 ESP.xlsx'),
    ('punta-cana', 'Traslados SV-Punta Cana 2026.xlsx'),
    ('punta-cana', 'Somos Viaje Tours & Actividades 2026.xlsx'),
]
for sede, nombre in LIBROS:
    ruta = os.path.join(ORIGEN, nombre)
    if not os.path.exists(ruta):
        continue
    wb = openpyxl.load_workbook(ruta, data_only=True)
    for ws in wb.worksheets:
        lineas = hoja_a_texto(ws)
        if not lineas:
            continue
        base = 'actividades-' + slug(ws.title) if 'Tours' in nombre else ('traslados-' + slug(ws.title) if 'Traslados' in nombre else slug(ws.title))
        titulo = (f'Actividades con salida desde {ws.title.title()}' if 'Tours' in nombre
                  else f'Traslados Punta Cana · {ws.title.title()}' if 'Traslados' in nombre else f'Orlando · {ws.title.title()}')
        guardar(os.path.join(SALIDA, sede, base + '.md'), titulo, lineas)
        fragmentos.append({'sede': sede, 'tipo': 'tarifario', 'titulo': titulo, 'fuente': f'{nombre} › {ws.title}', 'contenido': '\n'.join(lineas)})

# ---------- PDF de actividades ----------
CABECERA = re.compile(r'^(Av\. Barcel|Distrito Municipal|Provincia La Altagracia|Atención al cliente|info@somosviaje|gerencia@somosviaje)', re.I)
SECCIONES = ('DESCRIPCIÓN', 'DATOS DE OPERACIÓN', 'RECOMENDACIONES', 'INCLUYE', 'NO INCLUYE', 'ITINERARIO', 'OBSERVACIONES', 'IMPORTANTE', 'REQUISITOS', 'POLÍTICAS', 'NOTA')
carpeta_pdf = next((os.path.join(ORIGEN, d) for d in os.listdir(ORIGEN) if d.startswith('Descriptivos')), None)
for archivo in sorted(os.listdir(carpeta_pdf) if carpeta_pdf else []):
    if not archivo.lower().endswith('.pdf'):
        continue
    texto = subprocess.run(['pdftotext', os.path.join(carpeta_pdf, archivo), '-'], capture_output=True, text=True).stdout
    texto = texto.replace('ﬁ', 'fi').replace('ﬂ', 'fl').replace('`', 'ff').replace('\f', '\n')
    lineas, actual = [], ''
    for l in texto.split('\n'):
        l = l.strip()
        if not l or CABECERA.match(l):
            if actual:
                lineas.append(actual); actual = ''
            continue
        nueva = l.upper() in SECCIONES or re.match(r'^(Ø|o|•|-|\*)\s', l)
        if nueva or not actual:
            if actual:
                lineas.append(actual)
            actual = re.sub(r'^(Ø|•)\s*', '- ', re.sub(r'^o\s+', '- ', l))
            if l.upper() in SECCIONES:
                lineas.append(f'## {l.title()}'); actual = ''
        else:
            actual += ' ' + l
    if actual:
        lineas.append(actual)
    titulo = re.sub(r'\s+ESP\s*$', '', archivo[:-4]).strip()
    guardar(os.path.join(SALIDA, 'punta-cana', 'fichas', slug(titulo) + '.md'), titulo, lineas)
    fragmentos.append({'sede': 'punta-cana', 'tipo': 'ficha', 'titulo': titulo, 'fuente': archivo, 'contenido': '\n'.join(lineas)})

with open(os.path.join(SALIDA, 'conocimiento.json'), 'w', encoding='utf-8') as fh:
    json.dump(fragmentos, fh, ensure_ascii=False, indent=1)
total = sum(len(f['contenido']) for f in fragmentos)
print(f'{len(fragmentos)} fragmentos · {total:,} caracteres (~{total // 4:,} tokens)')
for s in ('punta-cana', 'orlando'):
    print(s, sum(1 for f in fragmentos if f['sede'] == s), 'fragmentos')
