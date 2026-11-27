# Cómo instalar el paquete del panel

Cada paquete que se entrega viene con este comando. Se pega una sola vez en PowerShell, en la PC del dueño.

1. Descargar el archivo `zentralia-actualizacion.zip` (el último que se entregó).
2. Abrir PowerShell y pegar esta línea:

```bash
cd "$env:USERPROFILE\Downloads"; Expand-Archive -Force zentralia-actualizacion.zip -DestinationPath .; cd zentralia-actualizacion; powershell -ExecutionPolicy Bypass -File .\actualizar-servidor.ps1
```

3. Pedirá la frase de la llave del servidor una sola vez (sube e instala en la misma conexión).
   Si el paquete trae la carpeta `panel-cliente`, instala primero el panel del cliente (puerto 3110) y luego Oficina.
4. Al terminar muestra "Listo" en verde. Si sale en rojo, mandar lo que aparece arriba. Los paneles se reinician: los usuarios conectados deben volver a entrar.

Si el zip se llama distinto (por ejemplo `zentralia-actualizacion (1).zip`), cambiar el nombre en la primera parte del comando.
