# Integración con sistemas clientes

Cómo programa una llamada y lee su desenlace un sistema externo: la agenda, la
ficha clínica o un asistente como **Catalina Ejecutiva**. Este servicio es el
único que habla con el paciente; el cliente entrega la indicación ya emitida y
recibe un resumen estructurado.

## Principios

- **El cliente no conversa.** Entrega la indicación y consulta el estado. El
  guion, los guardrails y la evaluación viven aquí.
- **La llamada no bloquea al cliente.** Programar devuelve de inmediato; el
  estado se consulta después, cuando el cliente quiera. Varias llamadas pueden
  estar en curso a la vez, dentro de la capacidad configurada.
- **Nada clínico sin token.** Con `INTEGRACION_TOKEN` definido, todas las rutas
  de esta página exigen `Authorization: Bearer <token>`. En producción el
  servicio no arranca sin él.
- **El resumen no incluye lo que dijo el paciente.** Solo el desenlace, los
  criterios y qué hacer. La transcripción de transiciones está en `/auditoria`,
  para revisión clínica.

## Programar una llamada

```
POST /llamadas
Authorization: Bearer <INTEGRACION_TOKEN>
Content-Type: application/json
```

```json
{
  "idPaciente": "pac-001",
  "telefono": "+56911111111",
  "inmediata": true,
  "contexto": {
    "idLlamada": "opcional; si falta se genera. Si se da, debe ser único: repetirlo es 409",
    "idPaciente": "pac-001",
    "servicio": "endoscopia",
    "verificacion": { "nombrePaciente": "María", "rutUltimosCuatro": "4821", "diaMesProcedimiento": "15-04" },
    "indicacion": {
      "idIndicacion": "ind-77",
      "emitidaPor": "Dra. Silva",
      "emitidaEn": "2026-04-10T14:00:00.000Z",
      "fechaProcedimiento": "2026-04-15",
      "horaInicioAyuno": "22:00",
      "horaLlegada": "07:30",
      "farmacosASuspender": [{ "nombre": "acenocumarol", "instruccion": "Debe suspender el acenocumarol desde el lunes en la mañana." }],
      "examenesRequeridos": ["hemograma"],
      "requiereAcompanante": true
    }
  }
}
```

- `inmediata: true` intenta originar la llamada en la misma petición. Se
  respetan la ventana horaria (9 a 20 h de Chile, salvo domingo) y la
  capacidad; si no se puede, la llamada queda en cola y la respuesta lo dice.
- Una indicación sin `emitidaPor` se rechaza con `422`: no es lícito
  comunicarla.
- `programadoPara` (ISO 8601) programa para más tarde.
- `422` si la indicación es inválida; `409` si `idLlamada` ya existe.

Respuesta `201`:

```json
{ "ok": true, "idTrabajo": "…", "error": null,
  "despacho": { "intentado": true, "originada": true, "motivo": "La llamada se originó." } }
```

## Consultar una llamada

```
GET /llamadas/:id
Authorization: Bearer <INTEGRACION_TOKEN>
```

```json
{
  "id": "…", "idPaciente": "pac-001", "telefono": "+56911111111",
  "estado": "terminada",
  "detalle": "El paciente confirmó toda la preparación.",
  "programadaPara": "…", "idConversacion": "…",
  "resultado": {
    "estadoFinal": "terminada_ok",
    "requiereRevisionHumana": false,
    "motivoRevision": "",
    "resumen": "El paciente confirmó toda la preparación.",
    "criterios": [{ "id": "identidad_verificada", "veredicto": "cumplido" }],
    "datos": {
      "identidad_confirmada": true, "hora_ayuno_repetida": "22:00", "farmacos_no_confirmados": "",
      "acompanante_confirmado": true, "sintomas_alarma_mencionados": false, "solicito_persona": false,
      "rechazo_grabacion": false, "requiere_revision_humana": false, "motivo_revision": ""
    }
  }
}
```

`criterios` trae solo identificador y veredicto, y `datos` solo los campos
anteriores. Las justificaciones y los campos que transcriben al paciente
(síntoma, consulta, exámenes faltantes) no viajan: están en `/auditoria`.

| `estado` | Significa | Qué hace el cliente |
|---|---|---|
| `programada` | En cola, o programada para más tarde | Esperar |
| `en_curso` | Originada hace menos de 30 minutos y sin cierre | Esperar; consultar cada 10 a 20 s |
| `terminada` | Hay resultado; `resultado.resumen` lo cuenta | Informar. Si `requiereRevisionHumana`, avisar al equipo |
| `fallida` | No se pudo originar o no se estableció | Reintentar más tarde o avisar |
| `sin_resultado` | Se originó y no hay resultado clínico: no llegó cierre, o llegó sin que el checklist terminara (el paciente cortó, silencio, tiempo agotado) | Avisar: alguien tiene que verificar con el paciente |

`resultado.estadoFinal` toma los valores de la máquina de estados:
`terminada_ok`, `terminada_sin_verificar`, `terminada_rechazo`,
`terminada_buzon`, `transferida_alarma`, `transferida_consulta`,
`transferida_incomprension`.

## Otras rutas

| Ruta | Para qué |
|---|---|
| `GET /revision` | Llamadas que requieren revisión humana y nadie ha revisado |
| `GET /auditoria/:id` | Traza completa de una llamada, transición por transición. Contiene lo que dijo el paciente |
| `GET /conciliacion` | Llamadas originadas sin resultado recibido |
| `GET /salud` | Estado del servicio. Sin token |

## Recomendaciones para un asistente conversacional

Un asistente de voz que programe llamadas debe:

1. Confirmar con la persona el número, el nombre del paciente y la indicación
   antes de programar. La indicación es contenido clínico y la emite un
   profesional; el asistente solo la transporta.
2. Programar con `inmediata: true` y **seguir con lo suyo**: no sondear el
   estado dentro de la conversación. Un sondeo por turno bloquea al asistente
   y no acelera la llamada.
3. Vigilar la llamada fuera del hilo de conversación, cada 10 a 20 segundos,
   y avisar cuando el estado sea `terminada`, `fallida` o `sin_resultado`.
4. Contar el desenlace con `resultado.resumen`, y nunca inventar lo que se
   dijo en la llamada: eso no viaja en el resumen.
