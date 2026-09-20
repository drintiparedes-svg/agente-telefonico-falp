# Agente telefónico de preparación pre-procedimiento — FALP

Servicio que conduce llamadas telefónicas a pacientes para verificar que llegan
correctamente preparados a su procedimiento: ayuno, suspensión de fármacos,
exámenes, acompañante y logística de llegada.

**El núcleo cognitivo vive aquí.** ElevenLabs opera únicamente como capa de voz y
telefonía. Ninguna decisión clínica ocurre fuera de este proceso.

Proyecto independiente. No comparte código, infraestructura ni workspace con
ningún otro agente de la institución, por las razones que se explican en
[`docs/arquitectura.md`](docs/arquitectura.md#por-qué-es-un-proyecto-separado).

---

## Por qué esta arquitectura

El análisis de factibilidad que precede a este repositorio llegó a una conclusión
que determina todo el diseño: para tratar datos de pacientes reales hace falta el
modo de **retención cero** de la plataforma, y ese modo **deshabilita MCP,
restringe el catálogo de modelos y reduce las analíticas a metadatos**. La vía de
escape documentada por el proveedor es exponer un **endpoint de LLM propio**.

Esa restricción, que parecía una limitación, resultó ser la mejor decisión de
diseño disponible:

| Si el guion vive en el prompt de la plataforma | Si el guion vive en este código |
|---|---|
| El modelo redacta lo que dice el agente | Las líneas son plantillas; el modelo solo clasifica |
| Los guardrails son peticiones al modelo | Los guardrails son condiciones del programa |
| La evaluación la hace un segundo modelo | La evaluación es determinista y reproducible |
| Auditar es leer transcripciones | Auditar es leer la tabla de transiciones |
| Cambiar el guion es editar texto libre | Cambiar el guion es un *pull request* revisable |

La diferencia práctica: un prompt le **pide** a un sistema que se porte bien;
este código hace que **no pueda** portarse mal.

---

## Los cinco invariantes

Están implementados como código y cubiertos por pruebas con umbral del 100 %.

1. **Sin verificación de identidad no se entrega ningún contenido clínico.** Se
   exigen dos factores no clínicos. Sin ellos, solo un mensaje neutro pidiendo
   devolver la llamada. No se usa biometría de voz: activaría el art. 16 ter y
   exigiría consentimiento expreso adicional.
2. **El agente nunca genera contenido clínico.** Toda línea proviene de plantillas
   alimentadas por la indicación que ya emitió el equipo tratante. Antes de llegar
   a la voz, cada salida se valida contra una lista blanca; si no coincide, la
   llamada se transfiere en vez de pronunciarla.
3. **Un síntoma de alarma interrumpe todo.** Se evalúa en cada intervención del
   paciente y en cualquier estado, incluso antes de verificar identidad. Hay doble
   red: detección léxica determinista y clasificación del modelo. Basta que una
   dispare.
4. **El agente informa y registra; nunca decide.** No reagenda, no cancela, no
   responde consultas clínicas. Cualquiera de esas situaciones transfiere a una
   persona.
5. **Un criterio indeterminado se trata como no cumplido.** «No logré determinar
   si entendió» y «no entendió» llevan a la misma acción: revisión humana.

---

## Puesta en marcha

```bash
npm install
npm test                  # 93 pruebas, sin red
npm run simular -- alarma # recorre un escenario completo en consola
npm run dev               # servicio en :8080
npm run aprovisionar      # crea o reescribe el agente en la plataforma de voz
```

El servicio arranca sin credenciales: usa un clasificador determinista por reglas
y un cliente de voz simulado. Sirve para desarrollar y para revisar el guion con
el equipo clínico sin tocar la plataforma.

### Escenarios del simulador

```
normal    recorrido completo hasta el cierre
alarma    el paciente menciona fiebre a mitad del checklist
familiar  contesta alguien que no puede confirmar los datos
consulta  el paciente hace una pregunta clínica
persona   el paciente pide hablar con alguien
repite    el paciente pide repetir la indicación
```

---

## Superficie HTTP

| Método | Ruta | Para qué |
|---|---|---|
| `POST` | `/llamadas` | El sistema clínico empuja una indicación ya emitida y programa la llamada |
| `POST` | `/v1/chat/completions` | Lo invoca la plataforma de voz en cada turno. Es la máquina de estados vestida de LLM |
| `POST` | `/webhooks/postcall` | Recibe el cierre de llamada. Verifica HMAC y encola antes de procesar |
| `GET` | `/revision` | Cola de revisión humana. Es la bandeja del equipo clínico |
| `GET` | `/auditoria/:idLlamada` | Traza completa de una llamada, transición por transición |
| `GET` | `/conciliacion` | Llamadas originadas sin resultado recibido |
| `GET` | `/salud` | Estado del servicio y profundidad de la cola |
| `GET` | `/admin/numeros` | Grupo de números de salida y su ocupación. Requiere `ADMIN_TOKEN` |
| `POST` | `/admin/numeros/sincronizar` | Lee los números importados en la plataforma. Los nuevos quedan inactivos |
| `PATCH` | `/admin/numeros/:id` | Activa, desactiva o cambia el techo de un número |
| `GET` | `/admin/destinos` | Destinos de transferencia y número de respaldo |
| `PUT` | `/admin/destinos/:id` | Crea o cambia un destino por motivo, servicio y horario |
| `GET` | `/admin/agente` | Compara el agente de la plataforma con la definición de este servicio. Lista cambios manuales |
| `POST` | `/admin/agente/sincronizar` | Reescribe la definición completa del agente: LLM propio, voz, privacidad, herramientas y reglas |
| `POST` | `/admin/agente/sincronizar-destinos` | Solo las reglas de transferencia. Más barato tras cambiar un destino |

---

## Estructura

```
src/
  dominio/           Lógica clínica. Sin dependencias de infraestructura.
    tipos.ts         Esquemas. Una indicación incompleta no pasa de aquí.
    checklist/
      guion.ts       TODAS las líneas que el agente puede pronunciar.
      maquina.ts     Máquina de estados determinista.
    guardrails/      Compuertas de seguridad como condiciones del programa.
    criterios/       Evaluación determinista y extracción estructurada.
  llm/
    clasificador.ts  Único punto donde interviene un modelo. Solo clasifica.
    servidor.ts      Endpoint compatible OpenAI con SSE.
  telefonia/         Cliente de voz, definición del agente, grupo de números,
                     despachador y transferencias.
  webhooks/          Recepción firmada y cola durable.
  persistencia/      SQLite con WAL. Repositorios aislados del dominio.
  conciliacion/      Cuenta llamadas originadas contra resultados recibidos.
```

---

## Estado actual y qué falta

**Funciona hoy:** máquina de estados completa, guardrails, evaluación determinista,
endpoint de LLM con streaming y function calling, recepción firmada de webhooks,
cola durable, despachador con ventana horaria y control de concurrencia,
conciliación, auditoría y simulador.

**Falta antes de un piloto con pacientes reales:**

- Integración con la agenda y la ficha clínica. Hoy la indicación entra por API.
- Cuenta de Twilio con números importados en ElevenLabs, y numeración 600
  confirmada con SUBTEL. Ver [`docs/telefonia.md`](docs/telefonia.md).
- Conversión a plan Enterprise con retención cero y contrato de encargo firmado.
- Evaluación de impacto en protección de datos, previa y obligatoria.
- Validación del guion por el equipo tratante, con responsable clínico nombrado.
- Selección y validación de voz con pacientes reales.

Ver [`docs/cumplimiento.md`](docs/cumplimiento.md) para el detalle de lo que la
normativa exige y qué parte de eso resuelve este código.

### Telefonía y voz

Las llamadas salen por la integración nativa de Twilio con ElevenLabs. Los
números de salida son un grupo administrable, y las transferencias se enrutan por
motivo, servicio y horario. Hoy no hay ningún número real configurado.

El agente de la plataforma **lo define este servicio**, no el panel: LLM propio
apuntando a `/v1/chat/completions`, sin personalidad por defecto, sin
herramientas ajenas, sin grabación y con retención cero. `npm run aprovisionar`
lo crea o lo reescribe, y `GET /admin/agente` lista cualquier cambio manual.
Qué falta, cómo escala y cómo se pone en marcha:
[`docs/telefonia.md`](docs/telefonia.md).

### Despliegue en Vercel

Hay un adaptador serverless en `api/index.js` y configuración en `vercel.json`.
Sirve como **superficie pública de prueba**: la base SQLite vive en `/tmp` y es
efímera, y las tareas de fondo se disparan por cron HTTP o a mano en
`/tareas/*`. No es un entorno apto para pacientes. Detalle y pasos en
[`docs/despliegue-vercel.md`](docs/despliegue-vercel.md).

---

## Advertencia

Este servicio **no puede operar con datos de pacientes reales** hasta que se
cumplan las condiciones de la sección anterior. El código las implementa; no las
sustituye.
