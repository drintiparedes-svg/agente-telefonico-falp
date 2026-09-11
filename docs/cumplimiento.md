# Cumplimiento

Qué exige la normativa chilena, qué parte resuelve este código y qué queda fuera
de su alcance. **Este documento no es una opinión legal.**

## Estado del reloj

La Ley 21.719 entra en vigencia el **1 de diciembre de 2026**. La Agencia de
Protección de Datos Personales no estaba constituida a agosto de 2026, lo que no
suspende la vigencia: elimina la vía administrativa para resolver la transferencia
internacional, que pasa a depender de instrumentos contractuales propios.

## Obligaciones y cobertura

| Obligación | Norma | Qué hace el código | Qué queda fuera |
|---|---|---|---|
| Base de licitud para datos de salud | Art. 16 bis | La indicación exige `emitidaPor` y `emitidaEn`: sin profesional emisor la llamada se rechaza al programarla | Documentar por escrito la calificación de la llamada como gestión asistencial |
| No usar biometría | Art. 16 ter | Verificación por dos factores no clínicos. No hay ninguna ruta de código que use la voz para identificar | — |
| Evaluación de impacto previa | Art. 15 ter | — | **Obligatoria antes de operar.** Automatizado + masivo + datos sensibles: los tres criterios se cumplen |
| Contrato de encargo | Art. 15 bis | — | Contrato con la plataforma y cada subencargado, con prohibición expresa de uso para entrenamiento |
| Transferencia internacional | Art. 27 | El núcleo cognitivo corre en infraestructura de FALP: cruza frontera el audio y la transcripción, no la lógica clínica ni el resultado estructurado | Instrumento contractual con garantías adecuadas |
| Medidas de seguridad | Art. 14 quinquies | HMAC en webhooks con comparación en tiempo constante, autenticación por token en el endpoint de LLM, SRTP obligatorio en el trunk, redacción de credenciales en logs | Gestión de secretos, cifrado en reposo, control de acceso a la base |
| Ruta a intervención humana | Art. 8 bis | El agente no tiene ninguna transición que reagende, cancele o decida. Solo informa, registra y escala | Definir el equipo y el horario que atiende las transferencias |
| Verificación de identidad | Ley 20.584 art. 13 | Dos factores obligatorios antes de cualquier contenido clínico. Cubierto por pruebas al 100 % | — |
| Divulgación de que es IA | Circular SERNAC 33/2022 | La primera línea del guion lo declara, antes de cualquier contenido clínico | — |
| Consentimiento de grabación | Código Penal art. 161-A | El aviso va en la apertura. Si el paciente lo rechaza, la llamada continúa sin grabar: el consentimiento de grabación es separable del de la llamada | Configurar la no grabación efectiva en la plataforma |
| Registro en ficha | Ley 20.584 art. 12 | Resultado estructurado y traza completa disponibles por API | Integración con la ficha clínica |
| Numeración 600 | Res. Ex. SUBTEL 1319/2026 | Grupo de números de salida administrable: el número presentado se cambia sin tocar código | Confirmar con SUBTEL si corresponde y si puede presentarse vía Twilio. Ver [`telefonia.md`](telefonia.md) |
| Conservación de audio | Art. 14 ter i) | Este servicio no almacena audio; descarta el evento de audio explícitamente y pide a Twilio no grabar en cada llamada | Definir, justificar y publicar el plazo |

## La línea que no se cruza

El art. 14 de la Ley 20.584 exige que la información para el consentimiento
informado la entregue **el profesional tratante**, y por escrito en cirugías y
procedimientos invasivos. **Un agente de voz no es profesional tratante.**

Comunicar instrucciones de preparación ya emitidas es distinto: es ejecución de una
indicación clínica, no un acto de consentimiento. Esa distinción se sostiene
mientras el agente **no genere contenido clínico nuevo** — y por eso el invariante
de contenido cerrado no es una preferencia de ingeniería, es lo que mantiene el
proyecto en su categoría regulatoria.

El momento en que el agente improvisa una respuesta clínica es el momento en que
el proyecto cambia de categoría.

## Finalidad prevista

El control de dispositivos médicos en Chile opera por incorporación progresiva
mediante decreto, y este tipo de software no ha sido incorporado. Pero la
definición del D.S. 825 incluye expresamente el software, y los dos únicos
productos que Chile está incorporando al régimen son de ámbito oncológico.

Bajo el D.S. 825 la **finalidad prevista por el fabricante** es el criterio
determinante de la calificación. Por eso queda declarada aquí:

> La finalidad prevista de este sistema es **comunicación logística de
> instrucciones de preparación ya emitidas por el equipo tratante y registro
> estructurado de su recepción**. No realiza diagnóstico, triage, evaluación de
> aptitud del paciente ni recomendación individualizada de tratamiento.

Cualquier evolución hacia triage sintomático o evaluación clínica exige rehacer
esta calificación antes de escribir la primera línea de ese código.

## Lo que este código no resuelve

Un servicio bien construido no sustituye una evaluación de impacto, un contrato de
encargo ni la validación clínica del guion. Los implementa; no los reemplaza.
