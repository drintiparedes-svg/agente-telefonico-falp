# Consola del equipo

Cómo el equipo carga pacientes para que se generen las llamadas, por texto, por
voz o desde una planilla, y cómo revisa después cada llamada tabulada:
educación entregada, protocolo cumplido, transcripción e información faltante.

La consola vive en `GET /consola`. Es una página sin dependencias que habla con
las rutas de este mismo servicio. Todo lo que trata datos de pacientes exige
`INTEGRACION_TOKEN`; la página lo pide una vez y lo guarda en el navegador
durante la sesión.

## Principio

La consola **no conversa con el paciente ni decide nada clínico**. Captura la
indicación que ya emitió el equipo tratante, la valida con las mismas reglas
que `POST /llamadas`, y muestra lo que la llamada dejó. Hay tres entradas y
una sola validación:

```
texto o voz ─┐
formulario ──┼─▶ borrador ─▶ misma validación que POST /llamadas ─▶ programar
planilla ────┘
```

## Cargar un paciente por texto o voz

En la pestaña **Nueva llamada** se escribe o dicta la información como se diría
en voz alta:

> Paciente María Pérez, ficha 12345, teléfono 9 1111 1111, RUT termina en 4821.
> Endoscopía el 15 de abril, llega a las 7:30 con acompañante. Ayuno desde las
> 22 horas. Suspender el acenocumarol desde el lunes en la mañana, tres días
> antes. Traer hemograma y perfil de coagulación. Indica la Dra. Silva.

**Interpretar** propone un borrador y lo vuelca al formulario. La persona lo
revisa campo por campo, corrige lo que haga falta y programa. Tres reglas del
intérprete:

1. **Propone; no decide.** Nada se programa sin que la persona confirme el
   formulario y el diálogo de confirmación.
2. **Las instrucciones de fármacos se copian literales.** Son contenido clínico
   emitido por el equipo tratante y el agente las leerá tal cual. Ni el modelo
   ni las reglas las redactan ni completan. Un aviso lo recuerda cada vez.
3. **Lo que no está en el texto queda vacío.** Nada se infiere ni se rellena con
   valores típicos. El formulario marca los faltantes.

Hay dos intérpretes, igual que hay dos clasificadores:

| `CLASIFICADOR` | Intérprete | Red |
|---|---|---|
| `simulado` | Reglas: expresiones regulares y el mismo extractor de horas del guion | No |
| `anthropic` | Modelo que solo estructura, con las reglas como respaldo ante cualquier fallo | Sí |

Con reglas, lo que se reconoce: nombre después de «paciente», ficha o
identificador, teléfono chileno en cualquier formato, RUT completo o sus
últimos cuatro dígitos, fecha del procedimiento en cifras o en palabras (sin
año se asume el próximo en que la fecha cae en el futuro), hora de ayuno junto
a «ayuno», hora de llegada junto a «llega» o «presentarse», cada oración con
«suspender» como un fármaco, lista de exámenes después de «traer», acompañante,
servicio por palabra clave y profesional con su título.

### Dictado

El botón **Dictar** usa el reconocimiento de voz del navegador (Chrome y Edge,
idioma `es-CL`) y va agregando lo reconocido al cuadro de texto. Ningún audio
llega a este servicio.

**Advertencia de datos.** Ese reconocimiento lo procesa el proveedor del
navegador en sus servidores. Antes de dictar datos de pacientes reales hay que
confirmar que ese tratamiento está cubierto, o sustituirlo por un
reconocedor bajo contrato de encargo. La página lo avisa la primera vez.

## Cargar desde una planilla

En la pestaña **Planilla**: descargar la plantilla, completarla y subirla
(`.xlsx` o `.csv`). El archivo viaja en base64 dentro del JSON; no hay
subida de archivos aparte. Cada fila se valida con las mismas reglas que el
formulario y se muestra con su número, sus faltantes y sus errores. Solo las
filas válidas se programan, y solo al pulsar **Programar filas válidas**.

Columnas de la plantilla (`GET /consola/api/plantilla`):

| Columna | Obligatoria | Formato |
|---|---|---|
| `id_paciente` | sí | Identificador en el sistema clínico |
| `nombre` | sí | Nombre con que se saluda |
| `telefono` | sí | Nueve dígitos, con o sin `+56` |
| `rut_ultimos4` | sí | Cuatro dígitos, sin dígito verificador |
| `fecha_procedimiento` | sí | `AAAA-MM-DD`, `DD/MM/AAAA` o celda de fecha |
| `hora_llegada` | sí | `HH:MM` o celda de hora |
| `hora_inicio_ayuno` | sí | `HH:MM` o celda de hora |
| `farmacos` | no | `nombre: instrucción literal`, varios separados por `\|` |
| `examenes` | no | Separados por `;` o `,` |
| `requiere_acompanante` | sí | `sí` / `no` |
| `servicio` | no | Enruta las transferencias |
| `emitida_por` | sí | Profesional que emitió la indicación |
| `emitida_en` | no | Fecha de emisión. Vacío: hoy |
| `id_indicacion` | no | Vacío: se genera |
| `programado_para` | no | ISO 8601 para llamar más tarde |

Se aceptan títulos parecidos («Ficha», «Celular», «RUT», «Profesional»). Las
columnas que no se reconocen se ignoran y se informan.

## Revisar las llamadas

La pestaña **Llamadas** tabula cada llamada:

| Columna | Qué muestra |
|---|---|
| Estado | `programada`, `en_curso`, `terminada`, `fallida`, `sin_resultado` |
| Desenlace | Una frase con lo que pasó |
| Educación | Bloques del checklist confirmados y entregados, sobre el total |
| Protocolo | Criterios cumplidos sobre el total |
| Faltante | Si hay información pendiente, o si alguien ya la completó |
| Revisión | Si requiere revisión humana y si ya se hizo |

Al pulsar una fila se abre el detalle con cuatro bloques:

**Educación entregada.** Un renglón por bloque del checklist: divulgación,
identidad, ayuno, cada fármaco por separado, exámenes, logística y cierre. Para
cada uno, si el agente lo pronunció y si el paciente lo confirmó según la regla
de ese bloque (la hora de ayuno se confirma repitiéndola; un fármaco, uno a uno).

**Protocolo.** Los criterios de la evaluación determinista con su veredicto y
la justificación escrita para el revisor clínico. Si la llamada requiere
revisión humana, aquí se marca como revisada.

**Información faltante.** Lo que quedó sin confirmar, derivado del resultado:
hora de ayuno no repetida, fármacos sin confirmar, exámenes que faltan,
acompañante no confirmado, contacto manual pendiente cuando la llamada pasó a
una persona, no se estableció o no dejó resultado. Cada faltante tiene un cuadro
para **completarlo a mano**: el valor, una nota opcional y el nombre de quien
lo registra. La anotación se guarda aparte, con autor y fecha, y el informe
muestra ambas cosas: lo que dijo el paciente y lo que completó la persona.
Nunca se sobrescribe el dato original.

**Transcripción.** Los turnos de la llamada tal como quedaron en la tabla de
auditoría: lo que dijo el paciente y lo que pronunció el agente, con el
guardrail que intervino si hubo uno. Es la misma traza de `GET /auditoria/:id`,
presentada para leerla.

**Exportar .xlsx** descarga la tabla completa. La transcripción no viaja en la
planilla: se consulta llamada por llamada.

## Rutas

| Método | Ruta | Para qué |
|---|---|---|
| `GET` | `/consola` | La página. Sin token: no lleva datos |
| `POST` | `/consola/api/interpretar` | `{ texto, base? }` → borrador propuesto, faltantes, avisos |
| `POST` | `/consola/api/validar` | `{ borrador }` → normalizado, faltantes, errores |
| `POST` | `/consola/api/planilla` | `{ nombre, base64 }` → filas validadas, sin programar |
| `GET` | `/consola/api/plantilla` | Plantilla `.xlsx` |
| `GET` | `/consola/api/columnas` | Definición de las columnas |
| `POST` | `/llamadas/lote` | `{ borradores[], inmediata? }` → programa cada uno; `201` si al menos uno |
| `GET` | `/informes/llamadas` | Tabla. Filtros `limite`, `desde`, `hasta`, `idPaciente` |
| `GET` | `/informes/llamadas.xlsx` | La tabla exportada |
| `GET` | `/llamadas/:id/informe` | Detalle: educación, protocolo, transcripción, faltantes, anotaciones |
| `POST` | `/llamadas/:id/anotaciones` | `{ campo, valor, nota?, autor }`. Campos: `acompanante_confirmado`, `examenes_faltantes`, `farmacos_no_confirmados`, `hora_ayuno_repetida`, `educacion_reforzada`, `contacto_manual`, `telefono_alternativo`, `observacion` |
| `POST` | `/llamadas/:id/revisar` | `{ revisor }` cierra la revisión humana |

Salvo la página, todas exigen `Authorization: Bearer <INTEGRACION_TOKEN>`.
`POST /llamadas` y `GET /llamadas/:id` no cambian: ver
[`integracion.md`](integracion.md).

## Lo que la consola no hace

- No reagenda ni cancela procedimientos: registra que alguien debe hacerlo.
- No modifica una indicación ya programada. Si cambió, se programa otra llamada.
- No genera contenido clínico. Un fármaco sin instrucción escrita por el equipo
  tratante no se puede programar.
- No guarda audio. El dictado ocurre en el navegador y solo entrega texto.

## Por confirmar antes del piloto

- **Reconocedor de voz para el dictado.** Ver la advertencia de datos arriba.
- **Quién anota.** Las anotaciones llevan el nombre que la persona escribe. En
  un piloto con varias personas conviene que ese nombre venga de una
  autenticación institucional y no de un cuadro de texto.
- **Base persistente.** En Vercel la base es efímera: las anotaciones y los
  informes se pierden al reciclarse la instancia. Ver
  [`despliegue-vercel.md`](despliegue-vercel.md).
