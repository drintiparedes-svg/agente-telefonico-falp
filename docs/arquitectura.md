# Arquitectura

## Reparto de responsabilidades

```
   ┌──────────────┐   indicación ya emitida   ┌───────────────────────────┐
   │ Sistema      │ ────────────────────────► │ ESTE SERVICIO             │
   │ clínico FALP │      POST /llamadas       │                           │
   └──────────────┘                           │  • valida la indicación   │
          ▲                                   │  • precarga la sesión     │
          │ resultado estructurado            │  • origina la llamada     │
          └────────────────────────────────── │                           │
                                              └────────────┬──────────────┘
                                                           │ origina
                                                           ▼
                              ┌───────────────────────────────────────┐
                              │ Plataforma de voz (ElevenLabs)        │
                              │  voz · telefonía · gestión de turnos  │
                              └───────────┬───────────────────────────┘
                                          │ POST /v1/chat/completions
                                          │ (un turno = una petición)
                                          ▼
                              ┌───────────────────────────────────────┐
                              │ ESTE SERVICIO — máquina de estados    │
                              │  clasifica → transiciona → responde   │
                              └───────────────────────────────────────┘
```

La plataforma cree estar hablando con un modelo de lenguaje. En realidad habla
con una máquina de estados determinista. Esa inversión es lo que hace auditable
el sistema.

## El flujo de un turno

1. La plataforma transcribe lo que dijo el paciente y llama al endpoint.
2. Se recupera la sesión por identificador de conversación. **Si no hay sesión no
   hay indicación clínica verificada**, y entonces no hay nada lícito que decir:
   la llamada se corta en vez de improvisar.
3. Se clasifica la intervención del paciente. Es el único momento en que
   interviene un modelo, y su salida es una etiqueta de un conjunto cerrado más
   fragmentos literales.
4. Se evalúan los guardrails en orden estricto de precedencia.
5. Si ninguno interviene, la máquina transiciona y elige la línea del guion.
6. La línea se valida contra la lista blanca antes de entregarse a la voz.
7. Se persiste el estado y la transición queda en la tabla de auditoría.
8. Se responde en formato de streaming, con *function calling* cuando hay que
   transferir o colgar.

## Por qué el modelo solo clasifica

Un modelo que redacta puede redactar cualquier cosa. Un modelo que elige entre
once etiquetas solo puede equivocarse de etiqueta, y de ese error se defiende la
máquina: ante duda o baja confianza, la etiqueta se degrada a «no entiende» y,
tras dos intentos, la llamada pasa a una persona.

Esto tiene un costo real y conviene reconocerlo: el agente suena más rígido que
uno generativo. En un checklist de preparación quirúrgica eso no es un defecto.
La comprensión exacta importa más que la naturalidad, y el paciente que necesita
una conversación de verdad debe llegar a una persona, no a una imitación mejor.

## Precedencia de los guardrails

El orden no es arbitrario:

1. **Bandera roja clínica** — en cualquier estado, incluso antes de verificar
   identidad. Un paciente que dice «estoy sangrando» antes de identificarse sigue
   siendo un paciente que sangra.
2. **Solicitud de hablar con una persona** — se acata sin objetar.
3. **Pregunta clínica fuera del guion** — no se responde: se transfiere.
4. **Compuerta de identidad** — sin dos factores, cero contenido clínico.
5. **Incomprensión reiterada** — dos intentos y pasa a una persona.

## Doble red en la detección de alarmas

La evidencia publicada documenta que la sensibilidad de un agente de voz se
degrada con el tiempo: en una validación, pasó de detectar el 100 % en la semana 1
a no detectar el 4,1 % de los pacientes en la semana 4. Por eso hay dos capas
independientes:

- **Léxica y determinista.** No depende del modelo, no se degrada, no cambia entre
  versiones. Es el piso que no se mueve. Maneja negaciones («no tengo fiebre» no
  dispara) sin dejar que la negación cruce un punto o un «pero».
- **Clasificación del modelo.** Cubre lo que el léxico no anticipó: «me siento
  rarísimo desde ayer» no contiene ningún término de la lista.

Basta que una dispare. Es deliberadamente asimétrico: se prefiere transferir de
más a detectar de menos.

## Persistir antes de procesar

Bajo retención cero la plataforma **no reintenta webhooks fallidos y no guarda
copia del evento**. Cualquier excepción entre la recepción y el guardado destruye
el resultado de esa llamada de forma irrecuperable.

Por eso el receptor hace exactamente tres cosas: verifica la firma, escribe en la
cola y devuelve 200. Todo el procesamiento ocurre después, en un trabajador que sí
puede reintentar. La base se abre con `synchronous = FULL`: se paga la latencia de
`fsync` porque no hay segunda oportunidad.

Y aun así puede fallar. Por eso existe la conciliación: cuenta llamadas originadas
contra resultados recibidos. Cada hueco es un paciente cuya preparación nadie
verificó, y se escala a revisión humana en lugar de quedar como una métrica.

## Evaluación determinista

La plataforma ofrece evaluar cada llamada pasando la transcripción a un segundo
modelo. Aquí los criterios se derivan del estado final y del registro de
auditoría. El mismo recorrido produce siempre el mismo veredicto.

Importa por una razón concreta: cuando un comité clínico pregunte «¿por qué el
sistema dio por buena esta llamada?», la respuesta es una traza de transiciones,
no la opinión de un modelo sobre un texto.

Cada criterio devuelve además una justificación en lenguaje natural, pensada para
que la lea una persona del equipo clínico y no un ingeniero.

## Por qué es un proyecto separado

La institución tiene otras iniciativas de agentes. Este servicio no comparte
repositorio, infraestructura ni workspace de plataforma con ninguna, y la razón es
técnica antes que organizativa:

Activar retención cero en un workspace compartido **deshabilita MCP para todos los
agentes de ese workspace**, reduce las analíticas a metadatos y restringe el
catálogo de modelos. Un agente que no trata datos clínicos no tiene por qué pagar
ese precio, y uno que sí los trata no puede eludirlo.

Son regímenes de cumplimiento distintos porque tratan datos distintos. Mezclarlos
degrada al que no lo necesita y contamina al que sí.

## Decisiones que quedaron fuera

- **No hay memoria entre llamadas.** Cada llamada arranca de la indicación vigente.
  Recordar lo que un paciente dijo la vez anterior es tratamiento adicional de
  datos sensibles sin finalidad declarada.
- **No hay biometría de voz.** Activaría el art. 16 ter y exigiría consentimiento
  expreso específico. La verificación se hace por contraste de datos no clínicos.
- **No se almacena audio en este servicio.** La política de conservación se define
  y publica según el art. 14 ter i) y se aplica en la plataforma.
- **No se registra el contenido de las conversaciones en el log de aplicación.** La
  trazabilidad clínica vive en la tabla de auditoría, con control de acceso propio.
