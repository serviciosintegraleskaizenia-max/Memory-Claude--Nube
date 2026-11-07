# Tarifas del cotizador

El panel muestra una **cotización sugerida** en la ventana de cada reserva, con los
tarifarios de la base de conocimiento.

## Poner o actualizar las tarifas

1. Copia `conocimiento.json` (de la base de conocimiento) en esta carpeta `panel/tarifas/`.
2. En la carpeta `panel`, ejecuta:

   ```
   node tarifas/generar-tarifas.js
   ```

3. Se crea `tarifas.json`. El panel lo vuelve a leer solo, sin reiniciar.

`conocimiento.json` y `tarifas.json` **no se suben al repositorio**: tienen precios netos y
comisiones, y el repositorio es público. Están en `.gitignore`.

## Qué cotiza

- **Traslados República Dominicana**: compartido (por persona), privado (por vehículo
  según pax) y luxury. La zona sale del listado de hoteles; si el hotel no está, del nombre
  (Bávaro, Uvero Alto, Cap Cana, Bayahibe, ...).
- **Actividades República Dominicana**: PVP y neto según la zona de salida del hotel.
- **Traslados Orlando**: por vehículo (Express, Comfort, XL, Coach) desde MCO, SFB o MIA.

## Lo que falta en la base de conocimiento

- Rutas que se perdieron al exportar el Excel: PUJ - HTL CABARETE y las del aeropuerto de
  Puerto Plata (POP).
- Orlando: las hojas *Park Tickets* y *Guía de referencia* llegaron vacías.
