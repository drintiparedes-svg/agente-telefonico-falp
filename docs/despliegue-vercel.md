# Despliegue en Vercel

Este documento describe cómo publicar el servicio en Vercel y, sobre todo, **qué
no puede hacer ahí**. Léalo entero antes de conectar la plataforma de voz.

## Qué es y qué no es este despliegue

El servicio está diseñado como **un proceso persistente**: SQLite en disco con
`synchronous = FULL`, una cola durable de eventos y tres bucles de fondo (cola,
despacho de llamadas, conciliación). Vercel ejecuta **funciones sin estado**: no
hay proceso residente, no hay temporizadores y el disco es efímero.

El adaptador de `api/index.js` resuelve lo segundo y documenta lo primero:

| Aspecto | En un servidor propio | En Vercel |
|---|---|---|
| Base de datos | Archivo SQLite en volumen persistente | SQLite en `/tmp` de la instancia. **Se pierde** al reciclarse la instancia y **no se comparte** entre instancias |
| Cola de eventos | Trabajador cada 5 s | Endpoint `GET /tareas/cola` disparado por cron o a mano |
| Despacho de llamadas | Cada 15 s dentro de ventana horaria | Endpoint `GET /tareas/despacho` |
| Conciliación | Cada hora | Endpoint `GET /tareas/conciliacion` |
| Cron | No aplica | Plan Hobby: una vez al día. Plan Pro: cada minuto |

Consecuencia práctica: **sirve como superficie pública de prueba** (verificar el
contrato del endpoint de LLM, la firma de webhooks, el flujo con la plataforma
de voz en una llamada de demostración). **No sirve para operar con pacientes**:
la garantía «persistir antes de procesar» no se cumple si el disco es efímero.

Para un piloto real hacen falta un proceso persistente con volumen (Fly.io,
Railway, una VM propia) o sustituir SQLite por una base externa compartida.

## Requisitos

- Cuenta de Vercel con acceso al repositorio de GitHub.
- CLI: `npm install -g vercel` (ya instalado en el iMac de desarrollo).
- Node 22. Vercel lo toma del campo `engines` y de la configuración del proyecto.

## Variables de entorno obligatorias

Vercel arranca con `NODE_ENV=production`, y en producción el servicio **se niega
a arrancar** sin estos valores. Es deliberado: un agente clínico sin ruta de
transferencia a persona no debe operar.

| Variable | Para qué |
|---|---|
| `WEBHOOK_SECRETO` | Clave HMAC con la que la plataforma firma los webhooks. Mínimo 16 caracteres |
| `LLM_TOKEN` | Token que la plataforma presenta al invocar `/v1/chat/completions`. Mínimo 8 caracteres |
| `NUMERO_TRANSFERENCIA` | Número al que se transfieren las llamadas que requieren una persona |
| `INTEGRACION_TOKEN` | Bearer de `/llamadas`, `/auditoria`, `/revision`, `/conciliacion`, `/informes` y `/consola/api`. Mínimo 16 caracteres |
| `CRON_SECRET` | Activa `/tareas/*`. Vercel envía `Authorization: Bearer <CRON_SECRET>` en cada invocación de cron |
| `ELEVENLABS_AGENT_ID` | Obligatorio **si** `ELEVENLABS_API_KEY` está definido: sin él la plataforma rechaza cada originación |

Si falta cualquiera de estas, la función arranca, falla al cargar la
configuración y **toda petición responde 500**, incluida `/salud`. Antes de
pasar a producción conviene reproducir el arranque en local con las mismas
variables (`NODE_ENV=production VERCEL=1 node api/index.js` envuelto en un
servidor HTTP) y comprobar que `/salud` responde `200`.

Opcionales: `CLASIFICADOR=anthropic` con `ANTHROPIC_API_KEY`, y las variables
`ELEVENLABS_*` para originar llamadas reales. Sin ellas el servicio usa el
clasificador por reglas y el cliente de voz simulado. Para escribir el agente
desde este despliegue hacen falta además `SERVICIO_URL_PUBLICA` (el dominio de
Vercel, con `https://`) y `ADMIN_TOKEN`; la voz «Catalina» se busca por nombre,
o se fija con `ELEVENLABS_VOICE_ID`; ver
[`telefonia.md`](telefonia.md#el-agente-lo-define-este-servicio).

## Protección de despliegues

Vercel Authentication (*Deployment Protection*) protege por defecto todos los
despliegues sin dominio propio, incluida producción en `*.vercel.app`. Con esa
protección activa, **ElevenLabs no puede alcanzar `/v1/chat/completions`** ni
entregar webhooks: recibe una página de inicio de sesión de Vercel en vez del
servicio. Para validar el modelo de llamado hay que limitar la protección a
*Preview* (Settings → Deployment Protection → Vercel Authentication → *Only
Preview Deployments*) o usar un dominio propio. El servicio tiene su propia
autenticación en todas las rutas que tratan datos; la única ruta pública sin
datos es `/consola`, que es solo la página.

## Límite de cuerpo

Las funciones de Vercel aceptan cuerpos de hasta 4,5 MB. Una planilla de la
consola viaja en base64, así que el archivo no debe superar unos 3 MB: son
miles de filas. Para más, dividir la planilla.

Los números de salida y los destinos que se configuran en `/admin/*` viven en la
base, y aquí la base es efímera: se pierden al reciclarse la instancia. Para una
prueba en Vercel, fije el número con `ELEVENLABS_PHONE_NUMBER_ID`. Ver
[`telefonia.md`](telefonia.md).

## Pasos

Desde la carpeta del proyecto, la primera vez:

```bash
vercel login
```

```bash
vercel link
```

Definir las variables (cada comando pide el valor de forma interactiva):

```bash
vercel env add WEBHOOK_SECRETO production
```

```bash
vercel env add LLM_TOKEN production
```

```bash
vercel env add NUMERO_TRANSFERENCIA production
```

```bash
vercel env add CRON_SECRET production
```

Desplegar a producción:

```bash
vercel --prod
```

Alternativa sin CLI: en el panel de Vercel, *Add New → Project → Import* el
repositorio `drintiparedes-svg/agente-telefonico-falp`. `vercel.json` ya trae el
comando de build, el enrutado y los cron. Las variables se definen en
*Settings → Environment Variables*.

## Verificación

```bash
curl https://<dominio>.vercel.app/salud
```

Debe responder `{"ok":true,"eventosPendientes":0,...}`. Para disparar una tarea a
mano:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<dominio>.vercel.app/tareas/cola
```

## Cron

`vercel.json` programa las tres tareas **una vez al día** porque el plan Hobby
rechaza cualquier expresión más frecuente en el despliegue. Con plan Pro,
cambie los horarios a `* * * * *` (cola y despacho) y `0 * * * *` (conciliación).
Con plan Hobby, dispare las tareas a mano durante una demostración.

## Notas técnicas

- `api/index.js` importa la app compilada en `dist/`. `npm run build` copia
  `esquema.sql` junto a `db.js`; sin esa copia la migración inicial falla.
- Todas las rutas se reescriben a la única función. Fastify atiende la petición
  emitiendo `request` sobre su servidor interno, el patrón que recomienda su
  documentación para Vercel.
- `better-sqlite3` es un módulo nativo que obtiene su binario en un script de
  instalación. npm 12, el que usa Vercel, **bloquea esos scripts por defecto** y
  los omite en silencio; por eso `package.json` los autoriza en `allowScripts`.
  Sin esa entrada el despliegue termina bien y la función falla al arrancar.
- `engines.node` está fijado en `22.x`. Con un rango abierto Vercel avisa de que
  cambiará de versión mayor por su cuenta.
- `public/` existe solo porque Vercel exige un directorio de salida estático
  cuando hay `buildCommand`, aunque el proyecto sea solo API.
- `.vercel/` está en `.gitignore`: contiene los identificadores del proyecto
  enlazado y no debe subirse.
