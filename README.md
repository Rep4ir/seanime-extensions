# Anime Online Ninja - Seanime Extension

Extensión de streaming de anime en español para Seanime.

## Características

- **Búsqueda de anime**: Busca anime por título en español, romaji o inglés
- **Múltiples opciones de audio**:
  - Subtitulado (Sub)
  - Latino
  - Castellano
- **Múltiples servidores de video**:
  - Streamtape
  - Netu
  - Filemoon
  - Voe
  - Doodstream
  - Uqload
- **Bypass de Cloudflare**: Utiliza el bypass integrado de Seanime.

## Instalación

### Opción 1: Usando el Playground (Recomendado para pruebas)

1. Abre Seanime y ve a `Extensions` > `Playground`
2. Selecciona `Online Streaming Provider`
3. Copia y pega el contenido de `animeonline-ninja.ts`
4. Prueba las funciones disponibles

### Opción 2: Instalación permanente

1. Copia el contenido de `animeonline-ninja.ts` en el campo `payload` del archivo `animeonline-ninja.json`
2. Coloca el archivo JSON en el directorio `extensions` de tu directorio de datos de Seanime
3. Reinicia Seanime
4. La extensión aparecerá en la lista de proveedores de streaming

## Uso

1. **Buscar anime**: La extensión buscará en ww3.animeonline.ninja
2. **Seleccionar episodio**: Se mostrarán todos los episodios disponibles
3. **Elegir servidor**: Cada episodio tiene múltiples servidores en 3 idiomas

## Archivos

| Archivo | Descripción |
|---------|-------------|
| `animeonline-ninja.ts` | Código principal de la extensión |
| `animeonline-ninja.json` | Manifiesto de la extensión |
| `online-streaming-provider.d.ts` | Tipos para proveedores de streaming |
| `core.d.ts` | APIs core de Seanime |

## Notas Técnicas

- La página usa WordPress con el tema dooplay
- Los videos se obtienen via API: `/wp-json/dooplayer/v1/post/{id}`
- El reproductor multiserver está en `saidochesto.top`
- No se utiliza ChromeDP - todo se hace mediante peticiones HTTP

## Licencia

MIT

Hecho por Rep4ir
