# Voz

Cómo suena el agente: la voz, el idioma, el teclado que se oye de fondo y las
expresiones con que cubre las pausas. Todo se define en este servicio y se
escribe en el agente de ElevenLabs con una sincronización. Lo que se edite a
mano en el panel se sobrescribe en la siguiente.

## Qué se oye en una llamada

```
AGENTE    ¿Hablo con María?
PACIENTE  sí, soy yo
AGENTE    Ya, déjeme ver acá...        ← se pronuncia de inmediato
          (teclado de fondo)           ← mientras este servicio clasifica
          Antes de continuar necesito confirmar su identidad. ¿Me puede decir
          los últimos cuatro dígitos de su RUT, sin el dígito verificador?
```

Tres capas producen ese efecto, y cada una vive en un sitio distinto:

| Capa | Qué es | Dónde se define | Quién la ejecuta |
|---|---|---|---|
| Voz | «Catalina» por nombre o por identificador, modelo de síntesis, estabilidad, velocidad, idioma | `ELEVENLABS_VOICE_*`, `ELEVENLABS_TTS_MODELO`, `VOZ_*` | ElevenLabs |
| Teclado de fondo | Preset `typing` mezclado bajo la voz durante toda la llamada | `FONDO_SONIDO`, `FONDO_VOLUMEN` | ElevenLabs |
| Expresiones de pausa | «Ya, un segundito...» antes de la línea del guion | `src/dominio/checklist/pausas.ts` | Este servicio |

Las dos primeras forman parte de la definición completa del agente
(`src/telefonia/agente.ts`) y se escriben con `npm run aprovisionar` o
`POST /admin/agente/sincronizar`, junto con el LLM propio, la privacidad y las
herramientas. Ver [`telefonia.md`](telefonia.md#el-agente-lo-define-este-servicio).

## Expresiones de pausa

Son las muletillas que dice una persona en Chile mientras revisa algo antes de
responder. Cubren el silencio entre que el paciente termina de hablar y el
agente tiene lista su línea, que es el tiempo que tarda el clasificador.

El conjunto actual, en trato de usted:

```
Ya.
Ya, un segundito...
Mmm, ya.
Ya, déjeme ver acá...
```

Cuatro reglas las mantienen dentro del modelo de contenido cerrado del proyecto:

1. **Conjunto cerrado.** Ninguna la redacta un modelo. Cambiar una es un *pull
   request*, igual que cambiar una línea del guion.
2. **Neutras.** Se eligen **antes** de clasificar lo que dijo el paciente, así
   que no pueden afirmar ni valorar nada. Un «ya» chileno solo acusa recibo.
   «Perfecto» o «muy bien» valorarían una respuesta que todavía no se leyó, y
   por eso están excluidas y una prueba lo verifica.
3. **Deterministas.** La expresión de cada turno sale de un hash del
   identificador de llamada y del número de turno. La misma llamada reproduce
   siempre las mismas expresiones, y dos turnos seguidos nunca repiten.
4. **Auditadas y en lista blanca.** La expresión queda en la tabla de auditoría
   como parte literal de la línea, y la validación de contenido cerrado admite
   cada línea del guion sola o precedida por una expresión del conjunto. Nada
   más pasa.

### Cuándo no hay expresión

- **Bandera roja léxica.** «Estoy sangrando» se detecta de forma síncrona antes
  de clasificar, y la transferencia sale al instante. Un «ya, un segundito» ahí
  sería un segundo perdido.
- **Turno de apertura.** El agente habla primero; no hay nada que esperar.
- **Silencio del paciente.** Sin texto no hay clasificación que cubrir.
- **`EXPRESIONES_PAUSA=no`.** Las desactiva sin tocar el guion ni la lista blanca.

Una alarma que solo detecta el modelo («me siento rarísimo desde ayer») sí lleva
expresión previa, porque el servicio no sabe que es alarma hasta que el
clasificador responde. La transferencia ocurre igual.

### Cómo se emite

El endpoint de LLM responde en *streaming*. La expresión viaja en el primer
fragmento, antes de invocar al clasificador; la línea del guion viaja cuando la
máquina la decide. La capa de voz empieza a hablar con el primer fragmento, así
que el paciente oye la expresión mientras el servicio sigue trabajando. Una
prueba libera el clasificador a mano y comprueba que la expresión ya salió.

## Teclado de fondo

ElevenLabs mezcla un preset de sonido bajo la voz durante toda la conversación.
`typing` es un teclado. Hace verosímil la pausa: el paciente oye que hay alguien
escribiendo. El agente no lo oye y no entra al reconocimiento de voz.

Se escribe en `conversation_config.conversation.background_sound` con volumen
`0,15`, que es el valor que la plataforma recomienda desde agosto de 2026, y
con `crossfade_loop` activo para que no se oiga un clic cuando el bucle
reinicia. Alternativas: `office1`, `office2` (oficina) o `ninguno`.

Dos límites de la plataforma que conviene saber:

- El fondo **no se puede cambiar por llamada**. Es configuración del agente.
- El fondo **sigue sonando cuando el paciente interrumpe**. No se detiene con
  el turno del agente.

## Voz y modelo

| Variable | Por defecto | Para qué |
|---|---|---|
| `ELEVENLABS_VOICE_NOMBRE` | `Catalina` | Se busca en el workspace por nombre exacto y único |
| `ELEVENLABS_VOICE_ID` | vacío | Fija la voz por identificador. Manda sobre el nombre |
| `ELEVENLABS_TTS_MODELO` | `eleven_flash_v2_5` | Modelo de síntesis. El de menor latencia con español |
| `ELEVENLABS_IDIOMA` | `es` | Ajusta síntesis y reconocimiento. El acento chileno lo aporta la voz, no el idioma |
| `VOZ_ESTABILIDAD` | `0,6` | Bajo: más expresiva y variable. Alto: más plana y predecible |
| `VOZ_SIMILITUD` | `0,8` | Cuánto se parece a la voz original |
| `VOZ_VELOCIDAD` | `0,95` | 1 es la nominal. Algo menos ayuda a pacientes mayores |

`eleven_v3_conversational` es más expresivo y admite etiquetas de audio entre
corchetes, pero es más lento y menos estable. Para un checklist clínico la
comprensión exacta importa más que la expresividad; por eso el defecto es
`flash`. Cambiar el modelo es cambiar una variable y sincronizar.

## Puesta en marcha

1. Tener la voz «Catalina» en la biblioteca del workspace, o fijar otra con
   `ELEVENLABS_VOICE_ID`. Escuchar el guion completo con ella antes de decidir.
2. Definir `ADMIN_TOKEN`, `ELEVENLABS_API_KEY`, `SERVICIO_URL_PUBLICA` y, si el
   agente ya existe, `ELEVENLABS_AGENT_ID`. Ajustar `FONDO_*` y `VOZ_*` si hace
   falta.
3. Comprobar qué diferencia hay entre el agente de la plataforma y esta
   definición. Un fondo o una velocidad cambiados a mano aparecen aquí:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/admin/agente"
```

4. Escribir la definición completa en el agente:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/admin/agente/sincronizar"
```

5. Sin tocar la plataforma, escuchar el guion con expresiones en consola:

```bash
npm run simular -- normal
```

## Por confirmar antes del piloto

- **Nombre del campo del fondo.** El cuerpo se arma según la documentación
  pública de la plataforma (`source_type`, `source_id`, `volume`,
  `crossfade_loop`). La primera sincronización contra un agente real es la
  prueba definitiva: un `422` nombraría el campo que no coincide.
- **Retención cero y fondo.** Confirmar con ElevenLabs que el preset de fondo
  opera bajo retención cero. No hay razón para que no, pero no está documentado.
- **Validación clínica de las expresiones.** Son texto que oye el paciente. Las
  revisa el mismo responsable clínico que valida el guion, y con pacientes
  reales durante la selección de voz. Pueden quitarse con una variable.
- **Volumen del teclado en teléfono.** `0,15` está pensado para audio de
  calidad. Por línea telefónica a 8 kHz puede sonar más alto o más bajo;
  ajustar tras la prueba de aceptación.
