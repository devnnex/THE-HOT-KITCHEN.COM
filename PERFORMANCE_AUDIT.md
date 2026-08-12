# Auditoría de rendimiento

## Hallazgos

- La carta pública ya se obtenía en una sola solicitud HTTP, pero cada solicitud ejecutaba dos lecturas de Google Sheets y reconstruía también el panel administrativo oculto.
- Las recargas concurrentes podían crear solicitudes GET duplicadas.
- Cada render de categorías, catálogo, carrito y listas administrativas creaba listeners individuales para sus elementos.
- Después de una escritura, la copia local de la carta podía seguir representando el estado anterior.

## Cambios aplicados

- `Code.gs` conserva el contrato público `doGet?action=menu|read` y añade caché de servidor de 15 segundos para la respuesta consolidada. Las escrituras `upsert`, eliminación y `setup` invalidan el caché inmediatamente.
- `app.js` deduplica solicitudes GET en curso, conserva una carta local válida durante la actualización y la invalida después de una escritura confirmada.
- El render inicial ya no procesa las listas administrativas si la sesión no está abierta.
- Los eventos repetitivos usan delegación en los contenedores, reduciendo listeners creados por render.
- La búsqueda del catálogo agrupa renders dentro del siguiente frame de animación.

## Comparación verificable por código

| Área | Antes | Después |
|---|---|---|
| Solicitudes GET simultáneas | Una por llamada | Una compartida mientras está en curso |
| Lecturas de Sheets en caché | Dos por solicitud | Cero durante el TTL |
| Lecturas de Sheets sin caché | Dos por carta (`productos`, `extras`) | Dos por carta; no se cambió el contrato ni la estructura |
| Render administrativo inicial | Siempre | Solo con sesión administrativa |
| Listeners de tarjetas/listas | Uno por elemento en cada render | Uno por contenedor |
| Escritura seguida de lectura local | Podía conservar datos anteriores | Invalidación inmediata y nueva lectura |

## Verificación

- `node --check app.js`: correcto.
- `Code.gs` validado con el parser JavaScript de Node vía stdin: correcto.
- Se conservaron las acciones públicas existentes: `menu`, `read`, `ping`, `upsertProduct`, `addProduct`, `editProduct`, `upsertExtra`, `addExtra`, `editExtra`, `deleteProduct`, `deleteExtra` y `setup`.

La medición real de latencia, tamaño de respuestas y ejecuciones de Apps Script requiere publicar `Code.gs` y observar una carga real; no se inventaron cifras de red que no pueden medirse desde este workspace.
