# Telefonía

Cómo sale una llamada, desde qué número, a quién se transfiere y cuánto escala.
El servicio usa la **integración nativa de Twilio con ElevenLabs**.

## Estado actual

**No hay ningún número real configurado.** El servicio corre con un número
simulado. Un número real existe cuando se cumplen tres condiciones:

1. FALP tiene una cuenta de Twilio con números chilenos, o con su número
   institucional verificado como identificador de llamada.
2. Esos números están importados en ElevenLabs.
3. Están sincronizados y activados en este servicio.

La sección [Puesta en marcha](#puesta-en-marcha) describe los pasos.

## Por qué Twilio nativo

| Capacidad | Twilio nativo | SIP trunk |
|---|---|---|
| Aviso al operador antes de recibir al paciente | Sí | No |
| Transferencia ciega que conserva el número del paciente | Sí | No |
| Marcación de extensión tras transferir | Sí | No |
| Usar el número institucional existente solo para salida | Sí, como *Verified Caller ID* | Depende del proveedor |

El aviso al operador importa en una alarma. Quien contesta sabe el motivo y el
código de llamada antes de hablar con el paciente.

SIP sigue disponible por número. Cada número del grupo declara su proveedor.

## Modelo

Tres conceptos, todos administrables sin tocar código:

- **Números de salida.** Un grupo de números. Cada llamada sale por el número
  menos ocupado. Un número recién sincronizado entra inactivo, porque activarlo
  es decidir que se llame a pacientes con él.
- **Destinos de transferencia.** Cada destino atiende un motivo (`alarma`,
  `consulta`, `incomprension`, `fuera_de_guion` o `general`), opcionalmente un
  servicio, en un horario y unos días.
- **Número de respaldo.** Es `NUMERO_TRANSFERENCIA`. Se usa cuando ningún destino
  aplica. En producción el servicio no arranca sin él.

Elección del destino: motivo exacto antes que `general`, servicio exacto antes
que genérico, y después la prioridad.

ElevenLabs solo transfiere a números precargados en las reglas del agente. Por
eso, después de cambiar destinos, hay que sincronizar el agente. El servicio
escribe las herramientas `end_call` y `transfer_to_number` del agente. Si alguien
agrega otras herramientas de sistema en el panel, hay que verificar que la
sincronización no las borre.

## Cómo escala

La capacidad es el menor de tres techos:

| Techo | Dónde se fija | Qué lo sube |
|---|---|---|
| Concurrencia del workspace de ElevenLabs | `CONCURRENCIA_MAX` | Plan de ElevenLabs. Dejar margen para llamadas entrantes |
| Llamadas simultáneas por número | `concurrenciaMax` de cada número | Agregar números al grupo |
| Llamadas por segundo de Twilio | `TWILIO_CPS` | Perfil de negocio aprobado en Twilio |

Twilio parte en 1 llamada por segundo por cuenta. Con un perfil de negocio
aprobado se sube hasta 5 desde su consola. El despachador espacia las llamadas a
ese ritmo para que la cola quede a la vista de este servicio.

El techo por número existe por reputación. Los operadores marcan como posible
spam los números que originan mucho volumen, y un paciente que ve esa etiqueta
no contesta.

Estimación del volumen diario:

```
llamadas por hora = concurrencia × 60 / duración media en minutos
```

Con 10 llamadas simultáneas y una duración supuesta de 5 minutos salen unas 120
llamadas por hora. En la ventana de 9 a 20 horas son unas 1.300 al día. La
duración real hay que medirla en el piloto.

Dos opciones de la plataforma que **no** sirven aquí:

- **Llamadas por lote.** ElevenLabs no las permite con retención cero. El
  servicio origina una por una, que es lo compatible.
- **Ráfagas de concurrencia.** Permiten triplicar la concurrencia a doble tarifa,
  pero con prioridad reducida en voz y más latencia. En una llamada clínica esa
  latencia no conviene.

## Puesta en marcha

### En Twilio

1. Crear la cuenta de FALP y completar el perfil de negocio en Trust Hub. Sin él
   el techo es 1 llamada por segundo.
2. Conseguir los números. Hay dos vías:
   - Comprar números chilenos en Twilio. Sirven para entrada y salida.
   - Verificar el número institucional como *Verified Caller ID*. Solo sirve
     para salida, y el paciente ve el número que ya conoce.
3. Crear una clave API con permisos limitados. No usar el token de la cuenta.
4. Revisar la región de enrutamiento del número. Ver
   [Por confirmar](#por-confirmar-antes-de-producción).

### En ElevenLabs

1. Crear una clave API del workspace con permisos sobre agentes, voces,
   secretos, webhooks y números.
2. Tener la voz en la biblioteca del workspace. La voz elegida es **Catalina**,
   español chileno; el servicio la busca por ese nombre
   (`ELEVENLABS_VOICE_NOMBRE`) y exige una coincidencia exacta y única. Si hay
   varias voces con ese nombre, fijar la correcta con `ELEVENLABS_VOICE_ID`. La
   selección definitiva se valida con pacientes.
3. En *Phone Numbers*, importar cada número con la clave API de Twilio.

El agente se llama **Catalina AI** (`ELEVENLABS_AGENTE_NOMBRE`). Si ya existe en
el workspace, el aprovisionamiento y `/admin/agente` lo localizan por nombre; si
no existe, `npm run aprovisionar` lo crea. Para originar llamadas hace falta su
identificador en `ELEVENLABS_AGENT_ID`, y en producción es obligatorio. El
agente **no se configura en el panel**: lo escribe este servicio. Ver la
sección siguiente.

### El agente lo define este servicio

La plataforma es solo la capa de voz. Para que eso sea verificable y no una
intención, la definición completa del agente vive en
`src/telefonia/agente.ts` y se escribe desde código:

| Aspecto | Valor que escribe el servicio | Por qué |
|---|---|---|
| Modelo | `custom-llm` apuntando a `<SERVICIO_URL_PUBLICA>/v1` | Cada turno lo resuelve la máquina de estados |
| Autenticación | Secreto del workspace con `LLM_TOKEN`, presentado como Bearer | El endpoint rechaza cualquier otro origen |
| Personalidad por defecto | Desactivada | La plataforma no antepone su propio prompt |
| Prompt | Texto explicativo más `conversation_id={{system__conversation_id}}` | No instruye a ningún modelo; transporta el id de conversación |
| Primer mensaje | Vacío | Un mensaje fijo saldría sin pasar por la lista blanca ni la auditoría |
| Herramientas | Solo `end_call` y `transfer_to_number` | Sin bases de conocimiento, MCP ni herramientas externas |
| Nombre | `ELEVENLABS_AGENTE_NOMBRE`, «Catalina AI» | Se localiza por nombre si no hay id |
| Voz | «Catalina» por nombre o `ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODELO`, idioma `es`, velocidad 0,95 | Paciente oncológico, a menudo mayor |
| Normalización de texto | De la plataforma | El guion entrega «22:00» y confía en que se lea como hora |
| Turnos | 10 s de espera, modo paciente, corte a los 30 s de silencio | No interrumpir a quien habla despacio |
| Duración máxima | 15 minutos | Un checklist no dura más |
| Privacidad | Sin grabación, sin audio, retención 0 días, retención cero | Condición del análisis de factibilidad |
| Evaluación por modelo | Apagada | La evaluación es determinista y ocurre aquí |
| Webhook post-llamada | `ELEVENLABS_POSTCALL_WEBHOOK_ID`, eventos de transcripción y fallo de originación, sin audio | Cierre de trabajos y conciliación |

Cualquier cambio hecho a mano en el panel aparece como discrepancia en
`GET /admin/agente` y se revierte con `POST /admin/agente/sincronizar`.

**Primer turno.** Con el primer mensaje vacío, la plataforma espera a que el
interlocutor hable y recién entonces consulta al endpoint. Lo primero que llega
es un «aló», que no es una respuesta al guion: el endpoint lo ignora y abre con
la línea de apertura. La única excepción es una bandera roja dicha antes de que
el agente hable, que transfiere igual. Si la plataforma consultara sin texto del
interlocutor, el endpoint también abre. Está cubierto por pruebas.

**Identificador de conversación.** La plataforma asigna su propio id al originar
la llamada, y el despachador reindexa la sesión con ese id. El endpoint lo
recibe por tres vías y usa la primera que tenga sesión: cabecera propia, el
marcador del prompt de sistema, y el cuerpo extra que la plataforma reenvía
desde la originación. Sin sesión, la llamada se corta sin contenido clínico.

### Aprovisionar el agente

Definir `ELEVENLABS_API_KEY`, `SERVICIO_URL_PUBLICA`, `LLM_TOKEN` y
`NUMERO_TRANSFERENCIA`. Los nombres del agente y de la voz ya vienen por
defecto («Catalina AI» y «Catalina»). Luego, la primera vez:

```bash
npm run aprovisionar -- --webhook
```

Busca la voz por nombre, crea el secreto del token y el webhook post-llamada,
localiza el agente por nombre o lo crea, y lo reescribe. Imprime
`ELEVENLABS_VOICE_ID`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_POSTCALL_WEBHOOK_ID`
y `WEBHOOK_SECRETO` para fijarlos en el entorno.
El secreto de firma **no vuelve a mostrarse**: guardarlo en ese momento. Con
esas variables definidas, cada ejecución posterior reescribe el agente y
muestra qué corrigió:

```bash
npm run aprovisionar
```

Sin `--webhook` y sin `ELEVENLABS_POSTCALL_WEBHOOK_ID`, el agente queda sin
notificación de cierre: los trabajos no se completan y la conciliación los
reporta a todos. El script lo advierte.

Con retención cero el workspace debe tener plan Enterprise; si no lo tiene, la
plataforma rechaza la escritura y el script termina con el error. Para probar
en un workspace sin ese plan, `ELEVENLABS_RETENCION_CERO=false`, solo fuera de
producción: con plataforma real y `NODE_ENV=production` el servicio no arranca
con ese valor.

### En este servicio

Definir `ADMIN_TOKEN`, `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` y
`NUMERO_TRANSFERENCIA`. Luego, con el servicio arriba:

Traer los números importados. Entran inactivos:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/admin/numeros/sincronizar"
```

Revisar el grupo y su ocupación:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/admin/numeros"
```

Activar un número y fijar su techo:

```bash
curl -X PATCH -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"activo":true,"concurrenciaMax":5}' "$URL/admin/numeros/<phone_number_id>"
```

Crear un destino de transferencia para alarmas en horario hábil:

```bash
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" -d '{"e164":"+56221234567","motivo":"alarma","etiqueta":"Enfermería de turno","horaDesde":8,"horaHasta":20,"dias":"123456"}' "$URL/admin/destinos/alarma-diurna"
```

Escribir los destinos en las reglas del agente, sin tocar el resto:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/admin/agente/sincronizar-destinos"
```

Comprobar que el agente coincide con la definición, y reescribirlo entero si no:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/admin/agente"
```

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/admin/agente/sincronizar"
```

### QA sin credenciales

`scripts/simulador-elevenlabs.mjs` emula las rutas de la plataforma que usa
este servicio y valida los puntos del contrato que importan (discriminador de
los secretos, LLM propio, reglas de transferencia, retención cero, no grabar en
la originación). Sirve para ensayar el aprovisionamiento, la sincronización y
una llamada completa sin clave ni número reales:

```bash
node scripts/simulador-elevenlabs.mjs
```

```bash
ELEVENLABS_BASE_URL=http://127.0.0.1:9099 ELEVENLABS_API_KEY=clave-de-prueba SERVICIO_URL_PUBLICA=https://agente.ejemplo npm run aprovisionar -- --webhook
```

Con el agente creado (`agent_1`), arrancar el servicio con las mismas
variables más `ELEVENLABS_AGENT_ID=agent_1`, sincronizar el número `phnum_1` en
`/admin/numeros`, programar una llamada con `inmediata: true` y conducir los
turnos contra `/v1/chat/completions` con un mensaje de sistema que contenga
`conversation_id=conv_plat_1`. Es lo que hace la verificación de este
repositorio antes de cada entrega. No sustituye la primera llamada real.

### Prueba de aceptación

1. Llamar a un teléfono del equipo y recorrer el guion completo.
2. Decir un síntoma de alarma y verificar que la llamada llega al destino de
   alarma y que el operador oye el aviso con el código de llamada.
3. Revisar que la traza aparece en `/auditoria/<idLlamada>`.

## Por confirmar antes de producción

Nada de esto lo resuelve el código:

- **Contrato de la API de la plataforma.** Los nombres de campo de la definición
  del agente se tomaron de la especificación que acompaña al SDK oficial
  `@elevenlabs/elevenlabs-js` 2.68, no de la documentación web. Tres
  comportamientos quedan por confirmar en la primera llamada de prueba, y las
  pruebas del endpoint cubren ambas alternativas de cada uno: que con primer
  mensaje vacío la plataforma espere al interlocutor; que el prompt de sistema
  llegue al endpoint con `{{system__conversation_id}}` sustituido; y que la
  plataforma componga la URL del LLM como `<url>/chat/completions`.
- **Plan Enterprise.** Sin él, `zero_retention_mode` se rechaza y el agente no
  se puede aprovisionar en modo producción.

- **Numeración 600.** Confirmar con SUBTEL si esta llamada debe presentarse con
  numeración 600 según la Res. Ex. 1319/2026. Si corresponde, confirmar con
  Twilio que ese número puede verificarse como identificador de llamada y que el
  operador chileno lo presenta intacto.
- **Retención cero con Twilio.** Confirmar con ElevenLabs que las llamadas por la
  integración nativa de Twilio operan bajo retención cero. El servicio pide a
  Twilio no grabar en cada llamada.
- **Región de Twilio.** Por defecto Twilio enruta por Estados Unidos aunque el
  número sea chileno. El audio cruza la frontera, y eso entra en la
  transferencia internacional del art. 27. Ver [`cumplimiento.md`](cumplimiento.md).
- **Quién contesta.** Cada destino necesita un equipo y un horario reales.
- **Persistencia.** Números y destinos viven en la base. En Vercel la base es
  efímera y esa configuración se pierde. Producción necesita una base persistente.
