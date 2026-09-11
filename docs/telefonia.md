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

1. En *Phone Numbers*, importar cada número con la clave API de Twilio.
2. Configurar el agente con LLM propio apuntando a `/v1/chat/completions` de este
   servicio.

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

Escribir los destinos en las reglas del agente:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/admin/agente/sincronizar"
```

### Prueba de aceptación

1. Llamar a un teléfono del equipo y recorrer el guion completo.
2. Decir un síntoma de alarma y verificar que la llamada llega al destino de
   alarma y que el operador oye el aviso con el código de llamada.
3. Revisar que la traza aparece en `/auditoria/<idLlamada>`.

## Por confirmar antes de producción

Nada de esto lo resuelve el código:

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
